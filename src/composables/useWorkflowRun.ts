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

/** 单步状态：pending/running/done/skip/fail；失败标红停住保留弹窗，成功自动关 */
export type WfStepState = { state: "pending" | "running" | "done" | "skip" | "fail"; note: string };

/** 批次里一个仓库的状态。done/fail 与 WfRunState 里的步骤状态并存：
    整行失败时步骤状态仍保留，用来指出卡在哪一步 */
export type WfBatchRowState = "pending" | "running" | "done" | "fail" | "skipped";

export interface WfBatchRow extends WfRunState {
  path: string;
  name: string;
  /**
   * 该仓库起始分支，`$起始分支` 与「切回起始分支」都靠它。
   * `null` = 还没取过。**不能用空串当哨兵**：游离 HEAD 的仓库分支本来就是空串，
   * 那会让「重试不重取起始分支」这条规矩在这个场景失效，还会把 `checkout("")` 打出去
   */
  startBranch: string | null;
  state: WfBatchRowState;
}

export interface WfBatchTarget {
  path: string;
  name: string;
}

/** 一次执行的进度（单仓库与批次里的单行同一形状） */
export interface WfRunState {
  states: WfStepState[];
  error: string;
  failIndex: number;
  repoChanged: boolean;
}

export function useWorkflowRun(opts: {
  repo: Ref<string>;
  status: Ref<Status | null>;
  busy: Ref<boolean>;
  runningAction: Ref<string>;
  refresh: () => Promise<void>;
  /** 批次跑完后回调（App 用来重取「所有仓库」总览行；单仓库入口不需要） */
  onBatchDone?: () => void | Promise<void>;
}) {
  // 执行确认：解析步骤预览 + 运行时输入当场填；起始分支在执行开始时记录。
  // 每个需要输入的步骤各占一个输入框 —— 早前所有步骤共用同一个值，
  // 「先切到 A、再合并 B」这种流程根本配不出来
  const wfConfirm = ref<{ wf: Workflow; slots: InputSlot[]; targets?: WfBatchTarget[] } | null>(null);
  // 批次专用：某个仓库失败就停止后面的仓库。默认不勾 —— 一次点击尽量把能做的都做掉，
  // 个别仓库失败（比如同名分支已存在）不该连累其余的
  const wfStopOnFail = ref(false);
  const wfInputs = ref<Record<number, string>>({});
  // 每个「新建分支」槽当前选中的前缀。候选来自「个性化 → 分支前缀」——
  // 用户不该在流程里手写前缀，那是设置里配过一次的东西。
  // 初始值取管理里给该步骤配的前缀；没配就用设置里的第一个（与「创建分支」弹窗同规矩）
  const wfPrefixes = ref<Record<number, string>>({});
  function runFlow(wf: Workflow) {
    if (!opts.repo.value || opts.busy.value) return;
    openConfirm(wf, undefined);
  }
  /** 多仓库入口：先选流程，再对选中的仓库逐个执行（确认框里当场填输入） */
  function runFlowForRepos(wf: Workflow, targets: WfBatchTarget[]) {
    if (opts.busy.value || !targets.length) return;
    openConfirm(wf, targets);
  }
  function openConfirm(wf: Workflow, targets?: WfBatchTarget[]) {
    const slots = flowInputSlots(wf);
    const configured = parseBranchPrefixes(settings.branchPrefix);
    wfInputs.value = {};
    wfPrefixes.value = {};
    wfStopOnFail.value = false;
    for (const s of slots) {
      if (s.branch) wfPrefixes.value[s.index] = defaultBranchPrefix(s.branch.prefix, configured);
    }
    wfConfirm.value = targets ? { wf, slots, targets } : { wf, slots };
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
    if (c.targets?.length) {
      void runFlowBatch(c.wf, c.targets, { ...wfInputs.value }, { ...wfPrefixes.value }, wfStopOnFail.value);
      return;
    }
    void executeFlow(c.wf, { ...wfInputs.value }, { ...wfPrefixes.value });
  }

  // 进度：pending/running/done/skip/fail；失败标红停住保留弹窗，成功自动关
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

  /**
   * 在**指定仓库**上顺序跑流程步骤：不读 opts.repo / opts.status，起点分支由调用方给。
   * 单仓库入口与「多仓库批次」共用这一份内核 —— 前者靠 guard 拦「执行期间切走仓库」，
   * 后者传恒 null（批次在启动时就锁定了 path 列表，用户切 tab 不该中止它）。
   * 返回 false = 有步骤失败（失败下标与文案写在 run 上）。
   */
  async function runSteps(
    path: string,
    wf: Workflow,
    run: WfRunState,
    inputs: Record<number, string>,
    prefixes: Record<number, string>,
    startBranch: string,
    fromIndex: number,
    guard: () => string | null,
  ): Promise<boolean> {
    for (let i = fromIndex; i < wf.steps.length; i++) {
      const st = run.states[i]!;
      // 每步开始前校验仓库身份：切走即中止，否则后续步骤会在别的仓库上 commit/push
      const blocked = guard();
      if (blocked) {
        st.state = "fail";
        run.error = blocked;
        run.repoChanged = true;
        return false;
      }
      st.state = "running";
      try {
        const note = await execStep(
          path,
          wf.steps[i]!,
          inputs[i] ?? "",
          prefixes[i] ?? "",
          startBranch,
          () => guard() === null,
        );
        st.note = note ?? "";
        st.state = note ? "skip" : "done";
      } catch (e) {
        st.state = "fail";
        const h = humanize(String(e));
        run.error = h.msg + (h.detail ? `\n${h.detail}` : "");
        run.failIndex = i;
        return false; // 出错即停：后续保持 pending；merge 冲突正好停在目标分支待处理
      }
    }
    return true;
  }

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
    // 刚切仓库时 status 还是 null，这时取起始分支会拿到空串、被当成「游离 HEAD」报错；
    // 先拉一次，让「未知」不要伪装成「没有分支」
    if (!resume && !opts.status.value) await opts.refresh();
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
    // 循环里一律用这个局部引用，不再读 wfRun.value：那个 ref 会被界面置空（关弹窗），
    // 而循环体在 await 之后还要继续写状态。run 是同一个响应式代理，界面照常更新。
    const run = wfRun.value;
    let ok = true;
    try {
      ok = await runSteps(path, wf, run, inputs, prefixes, startBranch, fromIndex, () =>
        opts.repo.value !== path ? "执行期间切换了仓库，工作流已中止" : null,
      );
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
      // 执行期间被关掉了，但失败了得让用户看见。把 run 挂回去：它可能已被置空
      wfRun.value = run;
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
  // 这样中途切了仓库也不会把 git 操作落到别的仓库上。
  // alive()：这一步跑完（可能等了 30s AI）之后，本次执行是否仍有效 —— 单仓库靠它拦切走，
  // 批次里恒 true（批次的仓库列表在启动时固定）。
  async function execStep(
    path: string,
    step: WorkflowStep,
    inputBranch: string,
    inputPrefix: string,
    startBranch: string,
    alive: () => boolean = () => true,
  ): Promise<string | undefined> {
    const refName = (r: BranchRef) =>
      r.mode === "fixed" ? (r.name ?? "") : r.mode === "start" ? startBranch : inputBranch;
    // 前端先拦：空分支名会被后端 check_positional 挡成「分支名不能为空」，
    // 前端知道空的原因（游离 HEAD），能说清该怎么办
    const usesStart = step.kind === "switchBack" || ("ref" in step && step.ref?.mode === "start");
    if (usesStart && !startBranch) {
      throw new Error(
        "仓库处于游离 HEAD（不在任何分支上），取不到「起始分支」：请先切到一个分支，或在流程里把分支写成具体名字",
      );
    }
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
      case "switchBack": {
        // 起始分支可能已经被前面的「删除分支」步骤删掉：那时 checkout 只会甩一句英文
        // pathspec，而且删除已经发生、重试永远停在这一步
        const list = await api.branches(path);
        if (!list.some((b) => !b.remote && b.name === startBranch)) {
          throw new Error(
            `起始分支「${startBranch}」已不存在（可能被前面的步骤删掉了），无法切回`,
          );
        }
        await api.checkout(path, startBranch);
        return;
      }
      case "deleteBranch": {
        const name = step.name.trim();
        if (!name) throw new Error("删除分支：分支名不能为空");
        // 用分支列表把名字解析成「规范名」再删：git 的 -D 对大小写不敏感（Windows 上
        // feature/x 能删掉 Feature/X 的同一个 ref 文件），而 status.branch 是原始大小写，
        // 直接字符串比较会漏掉这种情况 —— 删掉当前分支后 HEAD 变 unborn，后续提交直接断历史
        const list = await api.branches(path);
        const local = list.filter((b) => !b.remote);
        const exact = local.find((b) => b.name === name);
        const ci = local.filter((b) => b.name.toLowerCase() === name.toLowerCase());
        const hit = exact ?? (ci.length === 1 ? ci[0] : undefined);
        if (!hit) throw new Error(`分支「${name}」不存在：检查名字拼写（大小写也要一致）`);
        const st = await api.status(path);
        if (hit.name === st.branch) {
          throw new Error(
            `不能删除当前所在的分支「${hit.name}」：请在这之前切到别的分支（或显式加一步「切回起始分支」）`,
          );
        }
        if (hit.name === startBranch) {
          throw new Error(
            `「${hit.name}」是本次流程的起始分支，删掉后无法切回：请改成这一步之前先切走的流程`,
          );
        }
        await api.branchDelete(path, hit.name, true);
        return;
      }
      case "deleteRemoteBranch": {
        // 远程删除只作用于 origin：push --delete 找不到分支时会直接报错，不会静默成功。
        // 分支名前面有人会照抄描述里的 origin/ 前缀，这里顺手剥掉
        const name = step.name.trim().replace(/^origin\//, "");
        if (!name) throw new Error("删除远程分支：分支名不能为空");
        await api.pushDelete(path, "origin", name);
        return;
      }
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
        // AI 生成最长 30s，是最容易被切仓库的窗口：提交前再校验一次本次执行是否仍有效
        if (step.msgSource === "ai" && !alive()) {
          throw new Error("执行期间切换了仓库，工作流已中止");
        }
        if (!msg) throw new Error("提交信息为空");
        await api.commit(path, msg);
        await api.push(path, st.branch); // 无上游自动 -u
        return;
      }
      default:
        // 加了新的步骤原语却漏了执行分支：这里报出来，不要静默「什么都没做」
        throw new Error(`未知的步骤类型：${(step as { kind: string }).kind}`);
    }
  }

  // ---------- 多仓库批次 ----------

  // 批次状态与单仓库的 wfRun 完全独立：两者不会同时跑（共用 busy 锁），
  // 但共用同一个内核 runSteps。cur 指向「正在跑的仓库」，弹窗用它决定默认展开哪一行
  const wfBatch = ref<{
    wf: Workflow;
    rows: WfBatchRow[];
    inputs: Record<number, string>;
    prefixes: Record<number, string>;
    stopOnFail: boolean;
    cur: number;
    done: boolean;
  } | null>(null);
  const wfBatchOpen = ref(false);

  function rowOf(t: WfBatchTarget): WfBatchRow {
    return {
      path: t.path,
      name: t.name,
      startBranch: null,
      states: [],
      error: "",
      failIndex: -1,
      repoChanged: false,
      state: "pending",
    };
  }

  /** 跑一行；返回是否成功。startBranch 现取（总览里的分支可能已经过时） */
  async function runBatchRow(wf: Workflow, row: WfBatchRow, fromIndex: number, batch: {
    inputs: Record<number, string>;
    prefixes: Record<number, string>;
  }): Promise<boolean> {
    row.state = "running";
    row.error = "";
    row.failIndex = -1;
    if (row.startBranch === null) {
      try {
        row.startBranch = (await api.status(row.path)).branch;
      } catch (e) {
        row.state = "fail";
        row.error = humanize(String(e)).msg;
        return false;
      }
    }
    // 重试时保留已完成的步骤，其余回到 pending
    row.states = wf.steps.map((_, i) =>
      i < fromIndex ? row.states[i] ?? { state: "done" as const, note: "" } : { state: "pending" as const, note: "" },
    );
    try {
      // guard 恒 null：批次启动时就固定了仓库列表，用户切 tab 不该中止它
      const ok = await runSteps(
        row.path,
        wf,
        row,
        batch.inputs,
        batch.prefixes,
        row.startBranch ?? "",
        fromIndex,
        () => null,
      );
      row.state = ok ? "done" : "fail";
      return ok;
    } catch (e) {
      row.state = "fail";
      row.error = humanize(String(e)).msg;
      return false;
    }
  }

  /**
   * 对多个仓库串行执行同一个流程。
   * 为什么串行：共用一套 git 索引锁与同一条网络，并发只会让失败更难归因；
   * 「全部拉取」也是这个做法（App.vue 的 pullAllRepos）。
   */
  async function runFlowBatch(
    wf: Workflow,
    targets: WfBatchTarget[],
    inputs: Record<number, string>,
    prefixes: Record<number, string>,
    stopOnFail: boolean,
  ) {
    if (opts.busy.value || !targets.length) return;
    opts.busy.value = true;
    opts.runningAction.value = "workflow";
    wfBatch.value = {
      wf,
      rows: targets.map(rowOf),
      inputs: { ...inputs },
      prefixes: { ...prefixes },
      stopOnFail,
      cur: -1,
      done: false,
    };
    wfBatchOpen.value = true;
    const batch = wfBatch.value;
    try {
      for (let i = 0; i < batch.rows.length; i++) {
        const row = batch.rows[i]!;
        batch.cur = i;
        const ok = await runBatchRow(wf, row, 0, batch);
        if (!ok && stopOnFail) {
          for (let j = i + 1; j < batch.rows.length; j++) batch.rows[j]!.state = "skipped";
          break;
        }
      }
      // 弹窗可能在跑的时候就被关掉了（长批次很常见），所以结果也给一条 toast
      reportBatch(batch);
    } finally {
      batch.cur = -1;
      batch.done = true;
      opts.busy.value = false;
      opts.runningAction.value = "";
    }
    // 当前仓库的行也刷新一次（批次可能就改了它）
    await afterBatch();
  }

  /**
   * 批次收尾的结果可见性：有失败/跳过就把弹窗重新打开（否则失败原因、失败步骤、
   * 重试入口全在看不见的地方，只剩一条数不出是谁挂了的 toast），并报一条带仓库名的 toast。
   * 首跑、单行重试、继续剩余三个入口都走这里 —— 规则只有一套，入口不同不该有不同待遇。
   */
  function reportBatch(batch: { wf: Workflow; rows: WfBatchRow[] }, kind: "run" | "retry" | "resume" = "run") {
    const done = batch.rows.filter((r) => r.state === "done").length;
    const failRows = batch.rows.filter((r) => r.state === "fail");
    const skipped = batch.rows.filter((r) => r.state === "skipped").length;
    if (!failRows.length && !skipped) {
      // 重试/继续只动了少部分行，不能说成「整批又跑了一遍」
      toast(
        kind === "run"
          ? `「${batch.wf.name}」已在 ${done} 个仓库上执行完成`
          : `「${batch.wf.name}」补跑完成，${done} 个仓库全部通过`,
      );
      return;
    }
    wfBatchOpen.value = true;
    const names = failRows.map((r) => r.name);
    const bits = [`${done} 个成功`];
    if (failRows.length) {
      bits.push(`${failRows.length} 个失败（${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}）`);
    }
    if (skipped) bits.push(`${skipped} 个未执行`);
    toast(`「${batch.wf.name}」批量执行：${bits.join("，")}`, "warn");
  }

  // 收尾：刷新当前仓库 + 让总览重取行。失败不该盖掉已经跑完的批次结果
  async function afterBatch() {
    try {
      await opts.refresh();
      await opts.onBatchDone?.();
    } catch {
      /* 收尾失败静默：批次结果已经写在 wfBatch 上了 */
    }
  }

  /** 单个仓库重跑（只重跑它自己，不影响已完成的其它行） */
  async function retryBatchRow(index: number) {
    const batch = wfBatch.value;
    if (!batch || opts.busy.value) return;
    const row = batch.rows[index];
    if (!row || row.state === "pending" || row.state === "running") return;
    opts.busy.value = true;
    opts.runningAction.value = "workflow";
    batch.done = false;
    batch.cur = index;
    try {
      // 从头重跑，但起始分支沿用首轮记录：失败点可能已在切分支之后，
      // 这时现取会记成「失败现场所在的分支」，$起始分支与「切回起始分支」都会指错
      await runBatchRow(batch.wf, row, 0, batch);
    } finally {
      batch.cur = -1;
      batch.done = true;
      opts.busy.value = false;
      opts.runningAction.value = "";
    }
    reportBatch(batch);
    await afterBatch();
  }

  /** 把「失败即停」跳过的仓库接着跑完；说好顺序跑，所以一次一个 */
  async function resumeBatchSkipped() {
    const batch = wfBatch.value;
    if (!batch || opts.busy.value) return;
    const rest = batch.rows.filter((r) => r.state === "skipped");
    if (!rest.length) return;
    opts.busy.value = true;
    opts.runningAction.value = "workflow";
    batch.done = false;
    try {
      for (const row of rest) {
        batch.cur = batch.rows.indexOf(row);
        const ok = await runBatchRow(batch.wf, row, 0, batch);
        // 剩下仍是 skipped 的行保持原样，按钮会再出现一次
        if (!ok && batch.stopOnFail) break;
      }
    } finally {
      batch.cur = -1;
      batch.done = true;
      opts.busy.value = false;
      opts.runningAction.value = "";
    }
    reportBatch(batch, "resume");
    await afterBatch();
  }

  // 关弹窗：执行中只是隐藏（状态留在 wfBatch 里继续更新），跑完才真正清空
  function closeWfBatch() {
    wfBatchOpen.value = false;
    if (!opts.busy.value) wfBatch.value = null;
  }

  return {
    wfConfirm,
    wfInputs,
    wfPrefixes,
    wfStopOnFail,
    runFlowForRepos,
    wfRun,
    wfRunOpen,
    runFlow,
    flowInputsReady,
    slotPlaceholder,
    confirmFlow,
    closeWfRun,
    retryFlow,
    wfBatch,
    wfBatchOpen,
    runFlowBatch,
    retryBatchRow,
    resumeBatchSkipped,
    closeWfBatch,
  };
}
