// worktree.ts 自检：node --experimental-strip-types src/lib/worktree.test.ts
//
// 守三件事：
// 1. 路径判等要吃掉斜杠方向与盘符大小写 —— 否则同一个工作树会同时出现在
//    「当前」和「另一个」两个位置，用户看到的列表是自相矛盾的。
// 2. detached / 空仓库的展示不能出现「0000000」或把 detached 说成分支。
// 3. branchOwners 是切分支前置判断的唯一依据，撞键时不能崩、不能丢第一条。
import assert from "node:assert";
import {
  branchOwners,
  findSelf,
  FLAG_LABEL,
  normPath,
  samePath,
  tailName,
  toRows,
  ZERO_HASH,
} from "./worktree.ts";
import type { WorktreeEntry } from "../gitApi.ts";

const ZERO = "0".repeat(40);
const HASH = "456a9fd3ca706b0c96d39d2760a2e024c72b1f00";

const wt = (over: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  path: "C:/work/main",
  head: HASH,
  branch: "master",
  detached: false,
  locked: false,
  lock_reason: "",
  prunable: false,
  prunable_reason: "",
  is_main: false,
  missing: false,
  ...over,
});

// ---- 路径工具 ----

assert.equal(tailName("C:/work/my app"), "my app", "末段可以有空格");
assert.equal(tailName("C:\\work\\fix"), "fix", "反斜杠也认");
assert.equal(tailName("C:/work/工作 树/"), "工作 树", "尾斜杠不能产生空末段");
assert.equal(tailName("/"), "/", "根路径兜底返回原文");
assert.equal(tailName(""), "", "空串不崩");

assert.ok(samePath("C:\\work\\main", "C:/work/main"), "斜杠方向不影响判等");
assert.ok(samePath("c:/work/main", "C:/work/main"), "盘符大小写不影响判等");
assert.ok(samePath("C:/work/main/", "C:/work/main"), "尾斜杠不影响判等");
assert.ok(!samePath("C:/work/main", "C:/work/main2"), "同前缀不能误判");
assert.ok(!samePath("C:/work/a", "D:/work/a"), "不同盘符是不同的路径");
// 非盘符路径（POSIX）不做小写化：/Work 与 /work 是两回事
assert.equal(normPath("/Work/X"), "/Work/X", "非 Windows 路径保持大小写");

// ---- toRows：四种形态 ----

const rows = toRows([
  wt({ is_main: true }),
  wt({ path: "C:/work/fix", branch: "feature/x" }),
  wt({ path: "C:/work/工作 树", head: ZERO, detached: true, branch: "", locked: true, lock_reason: "usb" }),
  wt({ path: "C:/work/gone", branch: "old", prunable: true, missing: true }),
]);

assert.equal(rows[0]!.name, "main");
assert.ok(rows[0]!.flags.includes("main"), "主工作树有 main 标");
assert.equal(rows[0]!.shortHead, "456a9fd", "短 hash 取前 7 位");
assert.equal(rows[0]!.occupiedBranch, "master");
assert.ok(!rows[0]!.broken);

assert.equal(rows[1]!.name, "fix");
assert.equal(rows[1]!.occupiedBranch, "feature/x", "嵌套分支名完整保留");

// detached + 空仓库：hash 是"—"而不是 0000000，且不占分支
assert.equal(rows[2]!.shortHead, "—", "全 0 hash 显示 —");
assert.equal(rows[2]!.occupiedBranch, null, "detached 不占用分支");
assert.ok(rows[2]!.flags.includes("detached"));
assert.ok(rows[2]!.flags.includes("locked"));
assert.ok(!rows[2]!.flags.includes("main"));
assert.ok(!rows[2]!.broken, "只是 locked 不算失效");

// prunable + missing：同一件事只说一次
assert.ok(rows[3]!.broken);
assert.ok(rows[3]!.flags.includes("missing"));
assert.ok(!rows[3]!.flags.includes("prunable"), "目录已丢失时不再重复标「可清理」");

// 目录消失但 git 还没标 prunable：同样算失效
const goneOnly = toRows([wt({ missing: true })])[0]!;
assert.ok(goneOnly.broken, "missing 单独出现也算失效");
assert.ok(goneOnly.flags.includes("missing"));

// prunable 但目录还在（gitdir 反向指针坏了）：保留 prunable 标
const prunableOnly = toRows([wt({ prunable: true })])[0]!;
assert.ok(prunableOnly.broken);
assert.ok(prunableOnly.flags.includes("prunable"));
assert.ok(!prunableOnly.flags.includes("missing"));

// 每个 flag 都有文案，漏了会渲染出 undefined
for (const f of ["main", "detached", "locked", "missing", "prunable"] as const) {
  assert.ok(FLAG_LABEL[f] && FLAG_LABEL[f].length > 0, `flag ${f} 必须有文案`);
}

// ZERO_HASH 边界：非全 0 但含 0 的 hash 不能被当成空仓库
assert.ok(ZERO_HASH.test(ZERO));
assert.ok(!ZERO_HASH.test("0".repeat(39) + "a"));
assert.ok(ZERO_HASH.test(""), "空串也归入「没有 hash」");

// ---- branchOwners ----

const entries = [
  wt({ is_main: true, branch: "master" }),
  wt({ path: "C:/work/fix", branch: "feat/x" }),
  wt({ path: "C:/work/det", branch: "", detached: true }),
];
const owners = branchOwners(entries);
assert.equal(owners.get("master"), "C:/work/main");
assert.equal(owners.get("feat/x"), "C:/work/fix");
assert.equal(owners.size, 2, "detached 不产生条目");

// 撞键（手工改过 .git/worktrees 才可能）：保留第一条，不崩
const dup = branchOwners([wt({ branch: "same" }), wt({ path: "C:/other", branch: "same" })]);
assert.equal(dup.get("same"), "C:/work/main", "撞键取第一条");

// ---- findSelf ----

const self1 = findSelf(entries, "C:\\work\\fix");
assert.equal(self1?.path, "C:/work/fix", "反斜杠输入也能找到自己");
assert.equal(findSelf(entries, "C:/nope"), undefined, "不在列表里返回 undefined");
assert.equal(findSelf(entries, "")?.path, undefined, "空路径不该误命中");

console.log("worktree.test.ts: all assertions passed");
