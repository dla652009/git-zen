// graph.ts 泳道布局自检：node --experimental-strip-types src/graph.test.ts
import assert from "node:assert";
import { layout } from "./graph.ts";
import type { LogEntry } from "./gitApi";

const h = (n: string | number) => "h" + n;
const c = (hash: string, parents: string[]): LogEntry => ({
  hash,
  parents,
  subject: "",
  author: "",
  date: "",
  refs: [],
});

// 线性历史
let r = layout([c(h(1), [h(0)]), c(h(0), [])]);
assert.equal(r.cols, 1);
assert.equal(r.colOf.get(h(0)), 0);

// 分叉再合并: main 0-1-3, feat 0-2-3
r = layout([
  c(h(3), [h(1), h(2)]), // merge
  c(h(2), [h(0)]),
  c(h(1), [h(0)]),
  c(h(0), []),
]);
assert.equal(r.cols, 2);
const c1 = r.colOf.get(h(1));
const c2 = r.colOf.get(h(2));
assert.ok(new Set([c1, c2]).size === 2, "两个父在不同列");
assert.ok(r.edges.length === 4, "4 条连线");

console.log("graph layout tests passed");
