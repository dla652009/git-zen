// M12 最小工作流引擎的数据层：固定原语 + 顺序执行 + 出错即停。
// 刻意不做条件/循环/变量赋值——那是一键流与自动化平台的分界线（见 TASKS.md「明确不做」）。
// 执行器在 App.vue（依赖 api/status/AI），本文件只放可独立自检的纯逻辑。

// 分支引用：固定名 / $起始分支（进入工作流时记录的当前分支）/ 运行时输入（确认阶段填写）
export type BranchRefMode = "fixed" | "start" | "ask";
export interface BranchRef {
  mode: BranchRefMode;
  name?: string; // 仅 mode === "fixed" 需要
  /** 仅 mode === "ask"：填给用户看的说明，用作输入框的标签与占位符 */
  label?: string;
}

// 步骤原语（全部复用现有 git 命令，零新增 Rust）
export type WorkflowStep =
  | { kind: "checkout"; ref: BranchRef }
  | { kind: "pull" }
  // 有未提交改动时自动全部暂存再提交推送；工作区干净时跳过。
  // AI 生成信息失败 = 步骤失败中止（可重跑）
  | { kind: "commitPush"; msgSource: "ai" | "fixed"; message?: string }
  | { kind: "push" } // 推送当前分支（发布类流程在 merge 之后需要独立推送）
  | { kind: "merge"; ref: BranchRef } // 合并目标到当前分支；冲突即失败停留
  | { kind: "createBranch"; prefix?: string } // 分支名运行时输入
  | { kind: "switchBack" };

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  /** 钉在工具栏上：常用流程不必每次展开下拉（最多 3 个，见 App.vue 的 pinnedFlows） */
  pinned?: boolean;
}

export function newFlowId(): string {
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// 步骤的人话描述（确认框 / 进度 / 管理弹窗共用）；startBranch 提供时展示实际分支名
export function describeStep(s: WorkflowStep, startBranch?: string): string {
  const refLabel = (r: BranchRef) =>
    r.mode === "fixed"
      ? r.name || "（未填分支名）"
      : r.mode === "start"
        ? `起始分支${startBranch ? `（${startBranch}）` : ""}`
        : r.label?.trim() || "运行时输入的分支";
  switch (s.kind) {
    case "checkout":
      return `切换到 ${refLabel(s.ref)}`;
    case "pull":
      return "拉取远程更新";
    case "push":
      return "推送当前分支";
    case "merge":
      return `合并 ${refLabel(s.ref)} 到当前分支`;
    case "createBranch":
      return `新建分支（运行时输入名称${s.prefix ? `，前缀 ${s.prefix}` : ""}）`;
    case "switchBack":
      return `切回起始分支${startBranch ? `（${startBranch}）` : ""}`;
    case "commitPush":
      return s.msgSource === "ai"
        ? "提交并推送（AI 生成信息，无改动跳过）"
        : `提交并推送（固定信息：${s.message || "未填"}，无改动跳过）`;
  }
}

// 运行时输入的槽位：每个需要输入的步骤一个，按步骤下标定位。
// 早期版本只有一个共享输入值，于是「切到 X 分支 → 合并 Y 分支」这种流程配不出来
// （两个 ask 引用只能填同一个名字），只能把其中一个改成写死的分支名。
export interface InputSlot {
  /** 步骤下标，执行时用它把填的值取回来 */
  index: number;
  /** 输入框的短标签 */
  label: string;
  placeholder: string;
}

export function flowInputSlots(wf: Workflow): InputSlot[] {
  const slots: InputSlot[] = [];
  wf.steps.forEach((s, index) => {
    const at = `第 ${index + 1} 步`;
    if (s.kind === "createBranch") {
      const prefix = s.prefix?.trim() ?? "";
      slots.push({ index, label: `${at} 新建分支名`, placeholder: `${prefix}分支名` });
    } else if ((s.kind === "checkout" || s.kind === "merge") && s.ref.mode === "ask") {
      slots.push({
        index,
        label: `${at} ${s.kind === "checkout" ? "切换到" : "合并到当前分支"}`,
        placeholder: s.ref.label?.trim() || "分支名",
      });
    }
  });
  return slots;
}

// 是否需要运行时输入
export function flowNeedsInput(wf: Workflow): boolean {
  return flowInputSlots(wf).length > 0;
}

// 首次启动种子模板（深拷贝：用户编辑不能改到种子常量）
const SEEDS: Workflow[] = [
  {
    id: "seed-new-branch",
    name: "起新分支",
    steps: [
      { kind: "checkout", ref: { mode: "fixed", name: "master" } },
      { kind: "pull" },
      { kind: "createBranch" },
    ],
  },
  {
    id: "seed-release-dev",
    name: "发布到 dev",
    steps: [
      { kind: "commitPush", msgSource: "ai" },
      { kind: "checkout", ref: { mode: "fixed", name: "release/dev" } },
      { kind: "merge", ref: { mode: "start" } },
      { kind: "push" },
      { kind: "switchBack" },
    ],
  },
];

export function seedWorkflows(): Workflow[] {
  return JSON.parse(JSON.stringify(SEEDS)) as Workflow[];
}
