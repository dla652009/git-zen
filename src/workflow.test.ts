// 工作流数据层自检（node --experimental-strip-types src/workflow.test.ts）
import {
  describeStep,
  flowNeedsInput,
  seedWorkflows,
  newFlowId,
  type Workflow,
} from "./workflow.ts";

// describeStep：各原语的标签
const d = (s: Parameters<typeof describeStep>[0], start?: string) => describeStep(s, start);
assert(
  d({ kind: "checkout", ref: { mode: "fixed", name: "release/dev" } }) === "切换到 release/dev",
  "checkout fixed",
);
assert(
  d({ kind: "checkout", ref: { mode: "start" } }, "feat/a") === "切换到 起始分支（feat/a）",
  "checkout start 带实际分支",
);
assert(
  d({ kind: "checkout", ref: { mode: "ask" } }) === "切换到 运行时输入的分支",
  "checkout ask",
);
assert(d({ kind: "pull" }) === "拉取远程更新", "pull");
assert(d({ kind: "push" }) === "推送当前分支", "push");
assert(
  d({ kind: "merge", ref: { mode: "start" } }, "feat/a") === "合并 起始分支（feat/a） 到当前分支",
  "merge start",
);
assert(
  d({ kind: "createBranch", prefix: "feat/" }).includes("前缀 feat/"),
  "createBranch 前缀",
);
assert(d({ kind: "switchBack" }, "feat/a") === "切回起始分支（feat/a）", "switchBack");
assert(
  d({ kind: "commitPush", msgSource: "fixed", message: "x" }).includes("固定信息：x"),
  "commitPush fixed",
);
assert(
  d({ kind: "commitPush", msgSource: "ai" }).includes("AI 生成信息"),
  "commitPush ai",
);

// flowNeedsInput：ask 引用与新建分支需要输入，纯固定名流程不需要
assert(flowNeedsInput({ id: "x", name: "x", steps: [{ kind: "pull" }] }) === false, "无需输入");
assert(
  flowNeedsInput({
    id: "x",
    name: "x",
    steps: [{ kind: "checkout", ref: { mode: "fixed", name: "main" } }, { kind: "pull" }],
  }) === false,
  "固定名流程无需输入",
);
assert(
  flowNeedsInput({
    id: "x",
    name: "x",
    steps: [{ kind: "checkout", ref: { mode: "ask" } }],
  }) === true,
  "ask 需要输入",
);
assert(
  flowNeedsInput({ id: "x", name: "x", steps: [{ kind: "createBranch" }] }) === true,
  "新建分支需要输入",
);
assert(
  flowNeedsInput({
    id: "x",
    name: "x",
    steps: [{ kind: "merge", ref: { mode: "start" } }],
  }) === false,
  "merge 起始分支无需输入",
);

// 种子：两个模板、深拷贝互不影响
const seeds = seedWorkflows();
assert(seeds.length === 2, "两个种子模板");
assert(seeds[0]!.name === "起新分支" && seeds[1]!.name === "发布到 dev", "种子名称");
seeds[0]!.steps.push({ kind: "pull" });
assert(seedWorkflows()[0]!.steps.length === 3, "种子深拷贝不被污染");
assert(
  seeds[1]!.steps.some((s) => s.kind === "merge") &&
    seeds[1]!.steps.some((s) => s.kind === "switchBack"),
  "发布模板含合并与切回",
);

// id 生成不重复
assert(newFlowId() !== newFlowId(), "id 唯一");

console.log("workflow tests passed");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`workflow 自检失败: ${msg}`);
}
