// 工作流导入 / 导出（纯函数，无 Vue / Tauri 依赖，便于 node 自检）。
//
// 文件是给「不同的人 / 不同的机器」用的，所以两条要求：
// 1. 导出的形状要稳定 —— 不夹带 runtime 字段，人肉看一眼也读得懂
// 2. 导入的文件一律不可信 —— 手改过、别的版本导出的、干脆不是工作流的 JSON，
//    都必须挡在外面，否则一个坏字段会让整个设置页白屏
//
// 导入时不复用文件里的 id：两个不同来源的工作流很可能是同一个 id（都从种子模板
// 复制出去的），撞了之后 App 侧按 id 找流程会拿到错的。

import type { BranchRef, Workflow, WorkflowStep } from "../workflow";

/** 导出文件的格式标记：将来要换格式靠它分辨，而不是猜字段 */
export const EXPORT_KIND = "git-zen/workflows";
export const EXPORT_VERSION = 1;

export interface ExportDoc {
  kind: string;
  version: number;
  workflows: Workflow[];
}

/** 导入结果：成功给出可直接合并进 store 的流程；失败给出能展示给用户的原因 */
export type ImportResult =
  | { ok: true; workflows: Workflow[]; /** 跳过的坏条目数（数组里混了非法项） */ skipped: number }
  | { ok: false; error: string };

const STEP_KINDS = [
  "checkout",
  "checkoutRemote",
  "pull",
  "push",
  "merge",
  "createBranch",
  "deleteBranch",
  "deleteRemoteBranch",
  "switchBack",
  "createMr",
  "commitPush",
] as const;

const REF_MODES = ["fixed", "start", "ask"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** 分支引用：mode 必须是三种之一；fixed 必须有非空 name */
function parseRef(v: unknown): BranchRef | null {
  if (!isRecord(v)) return null;
  const mode = str(v.mode);
  if (!mode || !(REF_MODES as readonly string[]).includes(mode)) return null;
  const name = str(v.name)?.trim();
  if (mode === "fixed" && !name) return null;
  const label = str(v.label)?.trim();
  return {
    mode: mode as BranchRef["mode"],
    ...(name ? { name } : {}),
    ...(label ? { label } : {}),
  };
}

/** 单个步骤：未知 kind 一律判非法（宁可跳过这一步所属的流程，也不要跑出意外的 git 命令） */
function parseStep(v: unknown): WorkflowStep | null {
  if (!isRecord(v)) return null;
  const kind = str(v.kind);
  if (!kind || !(STEP_KINDS as readonly string[]).includes(kind)) return null;

  switch (kind) {
    case "checkout":
    case "merge": {
      const ref = parseRef(v.ref);
      return ref ? { kind: kind as "checkout" | "merge", ref } : null;
    }
    case "checkoutRemote": {
      const name = str(v.name)?.trim();
      return name ? { kind: "checkoutRemote", name } : null;
    }
    case "createMr": {
      // 目标分支必填（没有目标的 MR 页没有意义）；src / title 可选，空就直接不写
      const dst = str(v.dst)?.trim();
      if (!dst) return null;
      const src = str(v.src)?.trim();
      const title = str(v.title)?.trim();
      return {
        kind: "createMr",
        dst,
        ...(src ? { src } : {}),
        ...(title ? { title } : {}),
      };
    }
    case "pull":
      return { kind: "pull" };
    case "push":
      return { kind: "push" };
    case "switchBack":
      return { kind: "switchBack" };
    case "createBranch": {
      const prefix = str(v.prefix)?.trim();
      const name = str(v.name)?.trim();
      return {
        kind: "createBranch",
        ...(prefix ? { prefix } : {}),
        ...(name ? { name } : {}),
      };
    }
    case "deleteBranch":
    case "deleteRemoteBranch": {
      const name = str(v.name)?.trim();
      if (!name) return null;
      // 「不存在就跳过」已写死成默认语义，旧文件里带的 skipIfMissing 字段直接忽略，
      // 不必因为多了个字段就拒绝导入
      return { kind: kind as "deleteBranch" | "deleteRemoteBranch", name };
    }
    case "commitPush": {
      const src = str(v.msgSource);
      if (src !== "ai" && src !== "fixed") return null;
      const message = str(v.message)?.trim();
      // 固定信息必须有内容，否则这一步必然在执行时失败，不如导入时就挡掉
      if (src === "fixed" && !message) return null;
      return {
        kind: "commitPush",
        msgSource: src,
        ...(message ? { message } : {}),
      };
    }
  }
  return null;
}

/** 单个工作流：id 一律重新生成（见文件头说明）；名字空则判非法 */
export function parseWorkflow(v: unknown, makeId: () => string): Workflow | null {
  if (!isRecord(v)) return null;
  const name = str(v.name)?.trim();
  if (!name) return null;
  const rawSteps = v.steps;
  if (!Array.isArray(rawSteps)) return null;
  const steps: WorkflowStep[] = [];
  for (const s of rawSteps) {
    const step = parseStep(s);
    // 步骤有坏项就整条流程不要：少一步会跑出「少做了某事」的静默错误，
    // 而工作流的价值恰恰是「完整地跑完一套固定动作」
    if (!step) return null;
    steps.push(step);
  }
  return { id: makeId(), name, steps, pinned: false };
}

/**
 * 从文件文本解析出可导入的流程。
 * 接受三种形状：完整导出文档（{kind, version, workflows}）/ 裸数组 / 单个工作流对象 ——
 * 手写一个或从别的工具里抠出来都能直接喂进来，不必先套一层壳。
 */
export function parseWorkflowFile(text: string, makeId: () => string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "文件不是合法的 JSON" };
  }

  let list: unknown[];
  if (isRecord(data) && Array.isArray(data.workflows)) {
    // 带 kind 时校验一下：认得出是别的东西就直说，别硬当工作流导入
    const kind = str(data.kind);
    if (kind && kind !== EXPORT_KIND) {
      return { ok: false, error: `不是工作流文件（kind：${kind}）` };
    }
    list = data.workflows;
  } else if (Array.isArray(data)) {
    list = data;
  } else if (isRecord(data)) {
    list = [data];
  } else {
    return { ok: false, error: "文件内容既不是工作流，也不是工作流列表" };
  }

  const out: Workflow[] = [];
  let skipped = 0;
  for (const item of list) {
    const wf = parseWorkflow(item, makeId);
    if (wf) out.push(wf);
    else skipped += 1;
  }
  if (!out.length) {
    return {
      ok: false,
      error: skipped ? `文件里的 ${skipped} 个工作流都无法识别` : "文件里没有工作流",
    };
  }
  return { ok: true, workflows: out, skipped };
}

/** 名字去重：与已存在的重名时加「(2)」「(3)」…，而不是默默覆盖 */
export function uniqueName(name: string, taken: string[]): string {
  const base = name.trim() || "未命名工作流";
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/** 导出文档：只要持久化字段，不夹带任何运行时状态 */
export function buildExportDoc(list: Workflow[]): ExportDoc {
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    workflows: list.map((w) => ({
      id: w.id,
      name: w.name,
      pinned: !!w.pinned,
      steps: w.steps,
    })),
  };
}

/** 导出成文件文本。缩进 2 空格：这份文件人是会打开看的 */
export function toFileText(list: Workflow[]): string {
  return JSON.stringify(buildExportDoc(list), null, 2) + "\n";
}

/** 导出文件名：单个流程用流程名（去掉文件名非法字符），多个用 workflows-<日期> */
export function exportFileName(list: Workflow[], now = new Date()): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim() || "workflow";
  if (list.length === 1 && list[0]) return `${safe(list[0].name)}.json`;
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `workflows-${d}.json`;
}
