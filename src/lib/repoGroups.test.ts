// repoGroups.ts 自检：node --experimental-strip-types src/lib/repoGroups.test.ts
//
// 守的是分组切分的三条规则：顺序照抄选项卡、未知组不丢、未分组放最后。
// 写错任何一条的症状都是「总览和标签栏对不上号」，而这种错不会报错，只能靠断言兜。
import assert from "node:assert";
import { pickState, splitByGroup, togglePaths, UNGROUPED_KEY } from "./repoGroups.ts";

const row = (path: string, group?: string) => ({ path, group });

// ---- 基本分组：顺序照抄 groupOrder ----
const r1 = splitByGroup(
  [row("/a", "work"), row("/b", "personal"), row("/c", "work")],
  ["personal", "work"],
);
assert.equal(r1.length, 2, "两组");
assert.equal(r1[0]!.label, "personal", "按 groupOrder 顺序：personal 在前");
assert.equal(r1[1]!.label, "work", "work 在后");
assert.deepEqual(r1[1]!.rows.map((x) => x.path), ["/a", "/c"], "同组内保持输入顺序");

// ---- 组名不在 groupOrder 里：按字母接在后面，绝不丢行 ----
const r2 = splitByGroup(
  [row("/a", "zeta"), row("/b", "alpha"), row("/c", "known")],
  ["known", "removed"],
);
assert.deepEqual(
  r2.map((s) => s.label),
  ["known", "alpha", "zeta"],
  "未知组按字母接在后面",
);
assert.equal(
  r2.reduce((n, s) => n + s.rows.length, 0),
  3,
  "任何组都不能丢行",
);

// ---- 未分组：放最后一节，key 用哨兵值不与真实组名冲突 ----
const r3 = splitByGroup([row("/a", "work"), row("/b"), row("/c", "  ")], ["work"]);
assert.equal(r3.length, 2, "有未分组时应多一节");
assert.equal(r3[1]!.label, "未分组", "未分组放最后");
assert.equal(r3[1]!.key, UNGROUPED_KEY, "未分组用哨兵 key");
assert.deepEqual(r3[1]!.rows.map((x) => x.path), ["/b", "/c"], "空白组名视同未分组");

// ---- 全未分组：只有一节 ----
const r4 = splitByGroup([row("/a"), row("/b")], ["work"]);
assert.equal(r4.length, 1, "全未分组时只有一节");
assert.equal(r4[0]!.key, UNGROUPED_KEY, "那一节是未分组");

// ---- 没有未分组：不出现空的未分组节 ----
const r5 = splitByGroup([row("/a", "work")], ["work"]);
assert.equal(r5.length, 1, "没有未分组时不出现空节");
assert.equal(r5[0]!.label, "work", "只有实际存在的组");

// ---- 空输入 ----
assert.deepEqual(splitByGroup([], ["x"]), [], "空仓库列表返回空数组");

// ---- 组名两端空白：trim 后分组，且用 trim 后的名字作为 key ----
const r6 = splitByGroup([row("/a", " work ")], ["work"]);
assert.equal(r6.length, 1, "trim 后归入 work 组");
assert.equal(r6[0]!.key, "work", "key 用 trim 后的名字");

// ---- pickState：三态判定的边界 ----
assert.equal(pickState([], []), "none", "空集合既不是全选也不是部分");
assert.equal(pickState([], ["a"]), "none", "空路径列表恒为 none");
assert.equal(pickState(["/a"], []), "none", "一个都没选");
assert.equal(pickState(["/a"], ["/a"]), "all", "全选");
assert.equal(pickState(["/a", "/b"], ["/a"]), "some", "选了一部分");
assert.equal(pickState(["/a", "/b"], ["/a", "/b"]), "all", "全选了");
// 集合里有已不存在的 path 时，按「是否覆盖全部」判断而不是比数量
assert.equal(
  pickState(["/a", "/b"], ["/a", "/b", "/gone"]),
  "all",
  "多余 path 不影响判定（按覆盖算，不按数量）",
);
assert.equal(pickState(["/a", "/b"], new Set(["/a", "/b"])), "all", "接受 Set");

// ---- togglePaths：只动这一批，其余保持 ----
assert.deepEqual(togglePaths([], ["/a", "/b"]), ["/a", "/b"], "从空开始全选这一批");
assert.deepEqual(
  togglePaths(["/a", "/b"], ["/a", "/b"]),
  [],
  "已全选则整批取消",
);
// 无 order 时保持集合插入序：已有的在前，新加的追加
assert.deepEqual(
  togglePaths(["/a", "/x"], ["/a", "/b"]),
  ["/a", "/x", "/b"],
  "部分选中时补满这一批，别的组不动",
);
assert.deepEqual(
  togglePaths(["/a", "/b", "/x"], ["/a", "/b"]),
  ["/x"],
  "整批取消时别的组不受影响",
);
// 有 order 时按 order 重排，稳定批量派发顺序
assert.deepEqual(
  togglePaths(["/c"], ["/a"], ["/a", "/b", "/c"]),
  ["/a", "/c"],
  "按 order 排序",
);
// order 里没有的 path 不能被静默丢掉
assert.deepEqual(
  togglePaths(["/zzz"], ["/a"], ["/a"]),
  ["/a", "/zzz"],
  "order 之外的勾选保留在末尾",
);

console.log("repoGroups tests passed");
