// 工作流执行：确认弹窗（运行时输入）→ 逐步 execStep → 进度弹窗与失败重试。
// 从 App.vue 抽出来的第三批：外部只注入「当前仓库、状态、busy、刷新」这几个 App 状态，
// git 调用、AI 提示词、设置都是无状态模块，直接 import。

import { ref, type Ref } from "vue";
import * as api from "../gitApi";
import type { Status } from "../gitApi";
import { AI_PROMPTS, aiComplete, clipForAI } from "../ai";
import { parseBranchPrefixes, settings } from "../settings";
import { defaultBranchPrefix, flowInputSlots } from "../workflow";
import type { BranchRef, InputSlot, Workflow, WorkflowStep } from "../workflow";
import { humanize } from "../lib/errors";
import { toast } from "../components/ui";

export function useWorkflowRun(opts: {
  repo: Ref<string>;
  status: Ref<Status | null>;
  busy: Ref<boolean>;
  runningAction: Ref<string>;
  refresh: () => Promise<void>;
}) {
  // 执行确认：解析步骤预览 + 运行时输入当场填；起始分支在执行开始时记录。
  // 每个需要输入的步骤各占一个输入框 —— 早前所有步骤共用同一个值，
  // 「先切到 A、再合并 B」这种流程根本配不出来
  const wfConfirm = ref<{ wf: Workflow; slots: InputSlot[] } | null>(null);
  const wfInputs = ref<Record<number, string>>({});
  // 每个「新建分支」槽当前选中的前缀。候选来自「个性化 → 分支前缀」——
  // 用户不该在流程里手写前缀，那是设置里配过一次的东西。
  // 初始值取管理里给该步骤配的前缀；没配就用设置里的第一个（与「创建分支」弹窗同规矩）
  const wfPrefixes = ref<Record<number, string>>({});
  function runFlow(wf: Workflow) {
    if (!opts.repo.value || opts.busy.value) return;
    const slots = flowInputSlots(wf);
    const configured = parseBranchPrefixes(settings.branchPrefix);
    wfInputs.value = {};
    wfPrefixes.value = {};
    for (const s of slots) {
      if (s.branch) wfPrefixes.value[s.index] = defaultBranchPrefix(s.branch.prefix, configured);
    }
    wfConfirm.value = { wf, slots };
  }
  // 新建分支槽的占位符跟着选中的前缀走：选了 feat/ 就该看到「feat/分支名」
  function slotPlaceholder(s: InputSlot): string {
    return s.branch ? `${wfPrefixes.value[s.index] ?? ""}分支名` : s.placeholder;
  }
  // 有任一必填槽为空就不放行（按钮同时置灰，这里是回车路径的兜底）
  function flowInputsReady(): boolean {
    return (wfConfirm.value?.slots ?? []).every((s) => (wfInputs.value[s.index] ?? "").trim());
  }
  function confirmFlow() {
    const c = wfConfirm.value;
    if (!c) return;
    if (!flowInputsReady()) return;
    wfConfirm.value = null;
    void executeFlow(c.wf, { ...wfInputs.value }, { ...wfPrefixes.value });
  }

  // 进度：pending/running/done/skip/fail；失败标红停住保留弹窗，成功自动关
  type WfStepState = { state: "pending" | "running" | "done" | "skip" | "fail"; note: string };
  const wfRun = ref<{
    wf: Workflow;
    start: string;
    states: WfStepState[];
    error: string;
    /** 失败步骤的下标；-1 = 没失败 */
    failIndex: number;
    /** 因切走仓库而中止：不给「重试」，起点分支属于另一个仓库，重试没有意义 */
    repoChanged: boolean;
    /** 本次执行用的运行时输入，重试时原样复用 */
    inputs: Record<number, string>;
    /** 本次执行选中的分支前缀（按步骤下标），重试时同样原样复用 ——
        重试可能发生在很久之后，那时设置里的前缀列表可能已经变了 */
    prefixes: Record<number, string>;
  } | null>(null);
  // 进度弹窗是否可见。执行期间允许把它关掉（多步操作可能跑很久），
  // 状态本身留在 wfRun 里继续更新 —— 早前直接把 wfRun 置空，下一步循环就会读到 null 崩掉
  const wfRunOpen = ref(false);

  // resume：从失败的那一步接着跑。startBranch 必须沿用第一次的 —— 流程可能已经切走了分支，
  // 重新记录会把「切回起始分支」指到错误的目标上
  async function executeFlow(
    wf: Workflow,
    inputs: Record<number, string>,
    prefixes: Record<number, string>,
    resume?: { fromIndex: number; startBranch: string },
  ) {
    if (opts.busy.value || !opts.repo.value) return;
    // 锁定仓库：多步执行期间用户可能切走（Ctrl+Tab / 关标签都不看 busy）
    const path = opts.repo.value;
    const startBranch = resume?.startBranch ?? opts.status.value?.branch ?? "";
    const fromIndex = resume?.fromIndex ?? 0;
    opts.busy.value = true;
    opts.runningAction.value = "workflow";
    const prev = wfRun.value;
    wfRun.value = {
      wf,
      start: startBranch,
      // 重试时保留已完成的步骤，只把它们之后的重置为 pending
      states:
        resume && prev
          ? prev.states.map((s, i) => (i >= fromIndex ? { state: "pending" as const, note: "" } : s))
          : wf.steps.map(() => ({ state: "pending" as const, note: "" })),
      error: "",
      failIndex: -1,
      repoChanged: false,
      inputs: { ...inputs },
      prefixes: { ...prefixes },
    };
    wfRunOpen.value = true;
    let ok = true;
    try {
      for (let i = fromIndex; i < wf.steps.length; i++) {
        const st = wfRun.value.states[i]!;
        // 每步开始前校验仓库身份：切走即中止，否则后续步骤会在别的仓库上 commit/push
        if (opts.repo.value !== path) {
          st.state = "fail";
          wfRun.value.error = "执行期间切换了仓库，工作流已中止";
          wfRun.value.repoChanged = true;
          ok = false;
          break;
        }
        st.state = "running";
        try {
          const note = await execStep(
            path,
            wf.steps[i]!,
            inputs[i] ?? "",
            prefixes[i] ?? "",
            startBranch,
          );
          st.note = note ?? "";
          st.state = note ? "skip" : "done";
        } catch (e) {
          st.state = "fail";
          const h = humanize(String(e));
          wfRun.value.error = h.msg + (h.detail ? `\n${h.detail}` : "");
          wfRun.value.failIndex = i;
          ok = false;
          break; // 出错即停：后续保持 pending；merge 冲突正好停在目标分支待处理
        }
      }
      await opts.refresh();
    } finally {
      opts.busy.value = false;
      opts.runningAction.value = "";
    }
    if (ok) {
      wfRun.value = null;
      wfRunOpen.value = false;
      toast("工作流已完成");
    } else if (!wfRunOpen.value) {
      // 执行期间被关掉了，但失败了得让用户看见
      wfRunOpen.value = true;
    }
  }

  // 关掉进度弹窗：执行中只是把它藏起来（状态继续更新），空闲时才真的清掉
  function closeWfRun() {
    wfRunOpen.value = false;
    if (!opts.busy.value) wfRun.value = null;
  }

  // 从失败的那一步接着跑：前面的 checkout/merge 已经生效，不必重做
  function retryFlow() {
    const r = wfRun.value;
    if (!r || r.failIndex < 0 || opts.busy.value) return;
    void executeFlow(r.wf, r.inputs, r.prefixes, { fromIndex: r.failIndex, startBranch: r.start });
  }

  // path = 流程启动时锁定的仓库：每步都用它，而不是现读 repo.value，
  // 这样中途切了仓库也不会把 git 操作落到别的仓库上
  async function execStep(
    path: string,
    step: WorkflowStep,
    inputBranch: string,
    inputPrefix: string,
    startBranch: string,
  ): Promise<string | undefined> {
    const refName = (r: BranchRef) =>
      r.mode === "fixed" ? (r.name ?? "") : r.mode === "start" ? startBranch : inputBranch;
    switch (step.kind) {
      case "checkout":
        // 目标不存在 → git 报错中止（要建分支就在流程里放"新建分支"原语）
        await api.checkout(path, refName(step.ref));
        return;
      case "pull":
        await api.pull(path);
        return;
      case "push": {
        // 现读分支名：流程里前面的 checkout 步骤已经切走了，status.value 还停在流程开始时的值，
        // 拿它当参数会让 git_push 的「无上游自动 -u」给一个不相干的分支建立跟踪
        const st = await api.status(path);
        await api.push(path, st.branch);
        return;
      }
      case "merge":
        await api.merge(path, refName(step.ref)); // 冲突 → 报错停留，后续步骤不执行
        return;
      case "createBranch": {
        // 前缀用确认弹窗里当场选的那个（候选来自「个性化 → 分支前缀」），
        // 步骤里写的 prefix 只作为下拉的初始选中项 —— 用户不必每次手写前缀。
        // 名字已含前缀时不重复加：完全可能有人直接把全名粘进来
        let name = inputBranch;
        const p = inputPrefix.trim();
        if (p && !name.startsWith(p)) name = p + name;
        await api.branchCreate(path, name);
        return;
      }
      case "switchBack":
        await api.checkout(path, startBranch);
        return;
      case "commitPush": {
        const st = await api.status(path);
        if (!st.files.length) return "无改动，跳过";
        // 自动全部暂存（git add . 连删除/重命名一起收，免解析 porcelain 路径）
        await api.stage(path, ["."]);
        let msg = step.msgSource === "fixed" ? (step.message ?? "").trim() : "";
        if (step.msgSource === "ai") {
          const diff = await api.diff(path, ["."], true);
          const recent = (await api.log(path))
            .slice(0, 10)
            .map((c) => c.subject)
            .join("\n");
          // 生成失败 = 步骤中止（可重跑），不用固定文本兜底
          msg = await aiComplete(
            AI_PROMPTS.commitMessage.system(settings.aiCommitLang),
            `【仓库近期提交风格】\n${recent || "（无历史提交）"}\n\n【暂存区 diff】\n${clipForAI(diff)}`,
          );
        }
        // AI 生成最长 30s，是最容易被切仓库的窗口：提交前再校验一次仓库身份
        if (step.msgSource === "ai" && opts.repo.value !== path) {
          throw new Error("执行期间切换了仓库，工作流已中止");
        }
        if (!msg) throw new Error("提交信息为空");
        await api.commit(path, msg);
        await api.push(path, st.branch); // 无上游自动 -u
        return;
      }
    }
  }

  return {
    wfConfirm,
    wfInputs,
    wfPrefixes,
    wfRun,
    wfRunOpen,
    runFlow,
    flowInputsReady,
    slotPlaceholder,
    confirmFlow,
    closeWfRun,
    retryFlow,
  };
}
