// graph.ts 泳道布局自检：node --experimental-strip-types src/graph.test.ts
import assert from "node:assert";
import { layout, LANE_COLORS } from "./graph.ts";
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

// 泳道色亮度带不变式：圆点不跟主题 token，只能靠亮度带保证对 8 套主题的任意背景都 ≥3:1。
// WCAG 2.1 相对亮度 L，对比度 = (L亮+0.05)/(L暗+0.05)，非文本图形阈值 3.0。对比度对背景亮度在上下界
// 各自方向上单调，所以只需钉住两个最坏背景（都是「离前景最近」的那个，不是最深/最亮的那个）：
//   下界：最亮的暗色背景 one-dark #282c34（L=0.0250）→ L ≥ 3×(0.0250+0.05) − 0.05 = 0.1750
//   上界：最暗的浅色背景 catppuccin-latte #eff1f5（L=0.8785）→ L ≤ (0.8785+0.05)/3 − 0.05 = 0.2595
const relLum = (hex: string): number => {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const WORST_LIGHT_BG = "#eff1f5"; // catppuccin-latte --background
const WORST_DARK_BG = "#282c34"; // one-dark --background
for (const col of LANE_COLORS) {
  const L = relLum(col);
  assert.ok(L >= 0.175 && L <= 0.259, `泳道色 ${col} 亮度 ${L.toFixed(4)} 越出亮度带 [0.175, 0.259]`);
  assert.ok(contrast(col, WORST_LIGHT_BG) >= 3, `泳道色 ${col} 对最暗浅色底不足 3:1`);
  assert.ok(contrast(col, WORST_DARK_BG) >= 3, `泳道色 ${col} 对最亮暗色底不足 3:1`);
}
assert.equal(new Set(LANE_COLORS).size, LANE_COLORS.length, "泳道色必须互不相同");

console.log("graph layout tests passed");
