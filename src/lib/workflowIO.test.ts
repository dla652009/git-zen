// workflowIO.ts 自检：node --experimental-strip-types src/lib/workflowIO.test.ts
//
// 导入的是别人给的文件，形状不可信。这里守两类事：
// 1. 合法的流程必须原样（语义上）进来 —— 少字段、多字段都不该让导入失败
// 2. 非法内容必须被挡住 —— 尤其未知步骤类型：硬导进来会在执行时跑出意外的 git 命令
import assert from "node:assert";
import {
  buildExportDoc,
  EXPORT_KIND,
  exportFileName,
  parseWorkflowFile,
  toFileText,
  uniqueName,
} from "./workflowIO.ts";
import type { Workflow } from "./workflow.ts";

let seq = 0;
const makeId = () => `wf-test-${++seq}`;

const flow = (steps: Workflow["steps"], name = "测试流程"): Workflow => ({
  id: "orig-id",
  name,
  steps,
});

// ---- 导出：形状稳定、带格式标记 ----
const doc = buildExportDoc([flow([{ kind: "pull" }])]);
assert.equal(doc.kind, EXPORT_KIND, "导出带 kind");
assert.equal(doc.version, 1, "导出带 version");
assert.equal(doc.workflows[0]!.steps.length, 1, "步骤保留");
// 导出不该夹带运行时状态：pinned 是配置，保留；其它多余字段一律不出现
assert.deepEqual(Object.keys(doc.workflows[0]!).sort(), ["id", "name", "pinned", "steps"], "只导出配置字段");

const text = toFileText([flow([{ kind: "pull" }])]);
assert(text.endsWith("\n"), "文件以换行结束");
assert(text.includes("\n  "), "缩进便于人读");

// ---- 导入：完整导出文档 ----
const r1 = parseWorkflowFile(text, makeId);
assert(r1.ok, "导出文档能导回来");
if (r1.ok) {
  assert.equal(r1.workflows.length, 1, "一个流程");
  assert.equal(r1.workflows[0]!.steps[0]!.kind, "pull", "步骤类型保留");
  assert.notEqual(r1.workflows[0]!.id, "orig-id", "id 重新生成，不与文件里的撞");
  assert.equal(r1.workflows[0]!.pinned, false, "导入不占钉住名额");
}

// ---- 导入：裸数组 / 单个对象都认 ----
const r2 = parseWorkflowFile(JSON.stringify([{ name: "a", steps: [] }]), makeId);
assert(r2.ok && r2.workflows.length === 1, "裸数组");
const r3 = parseWorkflowFile(JSON.stringify({ name: "b", steps: [] }), makeId);
assert(r3.ok && r3.workflows[0]!.name === "b", "单个对象");

// ---- 导入：各种步骤类型都要能过 ----
const allKinds = parseWorkflowFile(
  JSON.stringify([
    {
      name: "全类型",
      steps: [
        { kind: "checkout", ref: { mode: "fixed", name: "master" } },
        { kind: "checkoutRemote", name: "release/dev" },
        { kind: "pull" },
        { kind: "push" },
        { kind: "merge", ref: { mode: "start" } },
        { kind: "createBranch", prefix: "feat/", name: "x" },
        { kind: "deleteBranch", name: "feat/x", skipIfMissing: true },
        { kind: "deleteRemoteBranch", name: "feat/x" },
        { kind: "switchBack" },
        { kind: "commitPush", msgSource: "ai" },
        { kind: "commitPush", msgSource: "fixed", message: "chore: x" },
      ],
    },
  ]),
  makeId,
);
assert(allKinds.ok && allKinds.workflows[0]!.steps.length === 11, "全部步骤类型都能导入");
// 旧文件里的 skipIfMissing 已不是配置项（语义写死为「不存在就跳过」），
// 但多一个字段不该让导入失败——兼容旧导出文件
if (allKinds.ok) {
  const del = allKinds.workflows[0]!.steps[6] as { kind: string; skipIfMissing?: boolean };
  assert(del.kind === "deleteBranch", "删除步骤类型正确");
  assert(del.skipIfMissing === undefined, "旧字段被丢弃，不留在步骤里");
}

// ---- 非法内容：必须挡住 ----
assert(!parseWorkflowFile("不是 json", makeId).ok, "非 JSON");
assert(!parseWorkflowFile("123", makeId).ok, "数字");
assert(!parseWorkflowFile("null", makeId).ok, "null");
assert(!parseWorkflowFile("{}", makeId).ok, "空对象没有 name/steps");
assert(!parseWorkflowFile(JSON.stringify({ name: "x" }), makeId).ok, "缺 steps");
assert(!parseWorkflowFile(JSON.stringify({ steps: [] }), makeId).ok, "缺 name");
assert(!parseWorkflowFile(JSON.stringify({ name: "  ", steps: [] }), makeId).ok, "空名字");
// 单个对象里带 kind 但字段形状是工作流：不猜，按工作流解析（上层已按 kind 拦别家格式）
assert(
  parseWorkflowFile(JSON.stringify({ name: "x", steps: [], kind: "other/thing" }), makeId).ok,
  "无 workflows 字段时不按 kind 拦截，按工作流解析",
);

// kind 不是工作流文件时明确拒绝，而不是硬导入
const wrongKind = parseWorkflowFile(
  JSON.stringify({ kind: "some-other-tool", workflows: [{ name: "x", steps: [] }] }),
  makeId,
);
assert(!wrongKind.ok, "别的工具的 kind 要拒绝");
if (!wrongKind.ok) assert(wrongKind.error.includes("some-other-tool"), "错误里带上实际 kind");

// 未知步骤类型：整条流程不要（少一步会静默少做事）
const badStep = parseWorkflowFile(
  JSON.stringify([{ name: "x", steps: [{ kind: "rm -rf" }] }]),
  makeId,
);
assert(!badStep.ok, "未知步骤类型被挡");

// fixed 分支名为空 / commitPush 固定信息为空：这类步骤执行必失败，导入时就挡
assert(
  !parseWorkflowFile(
    JSON.stringify([{ name: "x", steps: [{ kind: "checkout", ref: { mode: "fixed", name: "" } }] }]),
    makeId,
  ).ok,
  "fixed 引用必须有名字",
);
assert(
  !parseWorkflowFile(
    JSON.stringify([{ name: "x", steps: [{ kind: "commitPush", msgSource: "fixed" }] }]),
    makeId,
  ).ok,
  "固定提交信息不能为空",
);
assert(
  !parseWorkflowFile(
    JSON.stringify([{ name: "x", steps: [{ kind: "deleteBranch", name: "" }] }]),
    makeId,
  ).ok,
  "删除分支必须有名字",
);

// ---- 数组里混坏项：好的保留，坏的计入 skipped ----
const partial = parseWorkflowFile(
  JSON.stringify([{ name: "好的", steps: [] }, { name: "", steps: [] }, 42]),
  makeId,
);
assert(partial.ok, "有好的就成功");
if (partial.ok) {
  assert.equal(partial.workflows.length, 1, "只留好的");
  assert.equal(partial.skipped, 2, "坏的两条计入 skipped");
}

// ---- 1. 导出后原样导入，语义一致（往返测试）----
const original: Workflow[] = [
  {
    id: "a",
    name: "发布到 dev",
    steps: [
      { kind: "commitPush", msgSource: "ai" },
      { kind: "checkout", ref: { mode: "fixed", name: "release/dev" } },
      { kind: "merge", ref: { mode: "start" } },
    ],
  },
];
const round = parseWorkflowFile(toFileText(original), makeId);
assert(round.ok, "往返成功");
if (round.ok) {
  assert.equal(round.workflows[0]!.name, "发布到 dev", "名字一致");
  assert.deepEqual(
    round.workflows[0]!.steps,
    original[0]!.steps,
    "步骤逐个一致（含嵌套的 ref）",
  );
}

// ---- 新节点往返：checkoutRemote 带 name，导出后能原样读回来 ----
const crRound = parseWorkflowFile(
  toFileText([{ id: "x", name: "cr", steps: [{ kind: "checkoutRemote", name: "release/dev" }] }]),
  makeId,
);
assert(crRound.ok, "checkoutRemote 往返成功");
if (crRound.ok) {
  const s = crRound.workflows[0]!.steps[0]!;
  assert.equal(s.kind, "checkoutRemote", "类型保留");
  assert.equal((s as { name: string }).name, "release/dev", "分支名保留");
}

// ---- 名字去重 ----
assert.equal(uniqueName("a", []), "a", "无冲突不变");
assert.equal(uniqueName("a", ["a"]), "a (2)", "冲突加后缀");
assert.equal(uniqueName("a", ["a", "a (2)"]), "a (3)", "后缀递增");
assert.equal(uniqueName("  ", []), "未命名工作流", "空名字给默认名");

// ---- 导出文件名 ----
assert.equal(exportFileName([flow([], "发布 dev")]), "发布 dev.json", "单个用流程名");
assert.equal(
  exportFileName([flow([], "a/b:c")]),
  "a_b_c.json",
  "文件名非法字符替换掉",
);
const two = exportFileName([flow([], "a"), flow([], "b")], new Date(2026, 10, 16));
assert.equal(two, "workflows-20261116.json", "多个用日期");

console.log("workflowIO tests passed");
