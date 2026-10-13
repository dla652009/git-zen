// conflict.ts 冲突判定自检：node --experimental-strip-types src/lib/conflict.test.ts
//
// 这个谓词值得单独守：porcelain 的未合并状态码有 7 种（UU AA DD AU UA DU UD），
// 少判一种的后果不是「显示错了」，而是合并冲突时**不出现任何提示** —— 用户以为没冲突。
import assert from "node:assert";
import { isUnmerged } from "./conflict.ts";

const f = (x: string, y: string) => ({ path: "p", x, y });

// ---- 7 种未合并形态，一种都不能漏 ----
for (const [x, y] of [
  ["U", "U"], // 双方都改
  ["A", "A"], // 双方都新增
  ["D", "D"], // 双方都删除
  ["A", "U"], // 我方新增、对方修改
  ["U", "A"], // 我方修改、对方新增
  ["D", "U"], // 我方删除、对方修改
  ["U", "D"], // 我方修改、对方删除
]) {
  assert.equal(isUnmerged(f(x, y)), true, `${x}${y} 应当判为冲突`);
}

// ---- 普通状态不能被误判成冲突（否则会一直挂个「放弃合并」按钮）----
for (const [x, y] of [
  [" ", " "], // 干净
  ["M", " "], // 已暂存的修改
  [" ", "M"], // 未暂存的修改
  ["A", " "], // 已暂存的新增
  [" ", "D"], // 未暂存的删除
  ["A", "D"], // 暂存新增后又从工作区删掉：不是冲突
  ["R", " "], // 重命名
  ["?", "?"], // 未跟踪
  ["M", "M"], // 两边都改了但已解决
]) {
  assert.equal(isUnmerged(f(x, y)), false, `${x}${y} 不该判为冲突`);
}

console.log("conflict tests passed");
