#!/usr/bin/env node
// git-zen 对比度检查（纯 Node 内置模块，无第三方依赖）
//
// 守的是 WCAG 2.1 AA 的静态底线：独占一套主题 token 的「前景 / 背景」配对，
// 正文类 ≥ 4.5:1、非文本图形（泳道连线、开关滑块）≥ 3:1。
// 为什么需要脚本而不是肉眼看：task-10 之前 6 套主题的 Badge（半透明底 + 同色系文字）
// 和 4 套主题的次要文字都低于 4.5:1，其中 catppuccin-latte 的 muted-foreground 只有 2.56，
// 单看某套主题永远发现不了——只有把所有主题 × 所有配对一次算完才暴露。
//
// 用法：node scripts/check-contrast.mjs
// 退出码：0 = 全部达标；1 = 有不达标项（可直接挂 CI / pre-commit）

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STYLE_CSS = join(ROOT, "src", "style.css");
const GRAPH_TS = join(ROOT, "src", "graph.ts");

// ---------- 颜色工具 ----------

// 支持 #rgb / #rrggbb / rgb(r,g,b)；解析不了返回 null
function parseColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const hex = v.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function relLum([r, g, b]) {
  const lin = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG 对比度：(亮 + 0.05) / (暗 + 0.05)
function contrast(fg, bg) {
  const [hi, lo] = [relLum(fg), relLum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------- 解析 src/style.css 的主题块 ----------

// :root 是默认主题（settings.ts 里 id = "dark"），其余按 [data-theme="…"] 取名；
// light / github-light 共用一块 CSS，所以一个块可能产出多个主题名。
function parseThemes(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ""); // 先掐掉注释，避免注释里的 #hex 混进来
  const themes = new Map();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // 选择器前可能挂着上一条语句（`:root` 前是 `@import "tailwindcss";`），按最后一个 ; 截断
    const selector = m[1].split(";").pop().trim();
    const names = [...selector.matchAll(/\[data-theme="([^"]+)"\]/g)].map((x) => x[1]);
    if (!names.length) {
      if (selector !== ":root") continue; // @theme inline / @keyframes / body 等一律跳过
      names.push("dark");
    }
    const tokens = new Map();
    for (const t of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(t[1], t[2].trim());
    if (tokens.size === 0) continue;
    for (const name of names) {
      if (!themes.has(name)) themes.set(name, new Map());
      for (const [k, v] of tokens) themes.get(name).set(k, v);
    }
  }
  return themes;
}

// 跟随 var(--other) 间接引用（light 块的 --badge-info-bg 这类可能写成别名）
function resolveToken(tokens, name, seen = new Set()) {
  const raw = tokens.get(name);
  if (raw == null || seen.has(name)) return null;
  const ref = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (!ref) return raw;
  seen.add(name);
  return resolveToken(tokens, ref[1], seen);
}

// ---------- 解析 src/graph.ts 的泳道色 ----------

function parseLaneColors(src) {
  const block = src.match(/export const LANE_COLORS\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  return [...block[1].matchAll(/"(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
}

// ---------- 检查项定义 ----------

// 文字对：正文 / 次要文字 / 状态变化行，阈值 4.5:1
const TEXT_PAIRS = [
  ["--foreground", "--background"],
  ["--foreground", "--card"],
  ["--foreground", "--elevated"],
  ["--muted-foreground", "--background"],
  ["--muted-foreground", "--card"],
  ["--muted-foreground", "--elevated"],
  ["--muted-foreground", "--muted"],
  // 表单控件底：输入框里的正文与 placeholder 都要够（--input-bg 因此不能随便调亮）
  ["--foreground", "--input-bg"],
  ["--muted-foreground", "--input-bg"],
  ["--secondary-foreground", "--secondary"],
  ["--primary-foreground", "--primary"],
  ["--diff-add-text", "--diff-add-bg"],
  ["--diff-del-text", "--diff-del-bg"],
];
const BADGE_VARIANTS = ["default", "info", "warning", "danger"];
// 危险按钮：normal 与 hover 两个状态都要够
const DANGER_PAIRS = [
  ["--btn-danger-fg", "--btn-danger-bg"],
  ["--btn-danger-fg", "--btn-danger-bg-hover"],
];
const TEXT_MIN = 4.5;
const GRAPH_MIN = 3;

// ---------- 开始检查 ----------

const themes = parseThemes(readFileSync(STYLE_CSS, "utf8"));
const laneColors = parseLaneColors(readFileSync(GRAPH_TS, "utf8"));

const fatal = [];

// 解析器先把「解析出来的条目数」断言掉：漏认一个主题块会让整张表静默少一套主题（假绿）
const EXPECTED_THEMES = 7; // settings.ts THEMES 里除 system 外：dark + light + github-light + 4 套配色
if (themes.size < EXPECTED_THEMES) {
  fatal.push(
    `只解析出 ${themes.size} 套主题（期望 ${EXPECTED_THEMES} 套）：${[...themes.keys()].join(" / ") || "（空）"}\n` +
      "      src/style.css 的主题块结构变了吗？（:root 是默认主题 dark）",
  );
}
if (laneColors.length !== 7) {
  fatal.push(`解析 src/graph.ts 的 LANE_COLORS 拿到 ${laneColors.length} 个色（期望 7 个），解析可能失效。`);
}

// 记录表：失败项 → { theme, fg, bg, value, min }
const failures = [];
const notes = [];

function check(theme, fgLabel, bgLabel, fg, bg, min) {
  const c = contrast(fg, bg);
  const ok = c >= min;
  if (!ok) failures.push({ theme, fgLabel, bgLabel, value: c.toFixed(2), min: min.toFixed(1) });
  return ok;
}

// 每套主题都要有全部检查项要用的 token，缺了直接算失败（避免「漏定义 token 就跳过」的假绿）
function requireTokens(themeName, tokens, names) {
  const missing = names.filter((n) => resolveToken(tokens, n) == null);
  if (missing.length) {
    failures.push({
      theme: themeName,
      fgLabel: missing.join(" / "),
      bgLabel: "（token 缺失）",
      value: "—",
      min: "存在",
    });
    return false;
  }
  return true;
}

let textChecks = 0;
let badgeChecks = 0;
let graphChecks = 0;
let dangerChecks = 0;

for (const [themeName, tokens] of themes) {
  // 1) 文字对
  const textTokens = [...new Set(TEXT_PAIRS.flat())];
  if (requireTokens(themeName, tokens, textTokens)) {
    for (const [fgName, bgName] of TEXT_PAIRS) {
      const fg = parseColor(resolveToken(tokens, fgName));
      const bg = parseColor(resolveToken(tokens, bgName));
      if (!fg || !bg) {
        failures.push({ theme: themeName, fgLabel: fgName, bgLabel: bgName, value: "—", min: "可解析" });
        continue;
      }
      textChecks++;
      check(themeName, fgName, bgName, fg, bg, TEXT_MIN);
    }
  }

  // 2) 徽标实心色对
  const badgeTokens = BADGE_VARIANTS.flatMap((v) => [`--badge-${v}-fg`, `--badge-${v}-bg`]);
  if (requireTokens(themeName, tokens, badgeTokens)) {
    for (const v of BADGE_VARIANTS) {
      const fg = parseColor(resolveToken(tokens, `--badge-${v}-fg`));
      const bg = parseColor(resolveToken(tokens, `--badge-${v}-bg`));
      if (!fg || !bg) {
        failures.push({ theme: themeName, fgLabel: `--badge-${v}-fg`, bgLabel: `--badge-${v}-bg`, value: "—", min: "可解析" });
        continue;
      }
      badgeChecks++;
      check(themeName, `--badge-${v}-fg`, `--badge-${v}-bg`, fg, bg, TEXT_MIN);
    }
  }

  // 3) 危险按钮
  const dangerTokens = [...new Set(DANGER_PAIRS.flat())];
  if (requireTokens(themeName, tokens, dangerTokens)) {
    for (const [fgName, bgName] of DANGER_PAIRS) {
      const fg = parseColor(resolveToken(tokens, fgName));
      const bg = parseColor(resolveToken(tokens, bgName));
      if (!fg || !bg) {
        failures.push({ theme: themeName, fgLabel: fgName, bgLabel: bgName, value: "—", min: "可解析" });
        continue;
      }
      dangerChecks++;
      check(themeName, fgName, bgName, fg, bg, TEXT_MIN);
    }
  }

  // 4) 非文本图形：泳道连线 + 7 个泳道色 + 开关滑块，阈值 3:1
  const bg = parseColor(resolveToken(tokens, "--background"));
  const line = parseColor(resolveToken(tokens, "--graph-line"));
  if (bg && line) {
    graphChecks++;
    check(themeName, "--graph-line", "--background", line, bg, GRAPH_MIN);
  } else {
    failures.push({ theme: themeName, fgLabel: "--graph-line", bgLabel: "--background", value: "—", min: "可解析" });
  }
  if (bg) {
    laneColors.forEach((hex, i) => {
      const c = parseColor(hex);
      if (!c) return;
      graphChecks++;
      check(themeName, `LANE_COLORS[${i}] ${hex}`, "--background", c, bg, GRAPH_MIN);
    });
  }
  // 开关滑块是 ui/Switch.vue 的 bg-white，压在 --switch-off-bg 轨道上
  const offTrack = parseColor(resolveToken(tokens, "--switch-off-bg"));
  if (offTrack) {
    graphChecks++;
    check(themeName, "ui/Switch 滑块 #ffffff", "--switch-off-bg", [255, 255, 255], offTrack, GRAPH_MIN);
  } else {
    failures.push({ theme: themeName, fgLabel: "--switch-off-bg", bgLabel: "（token 缺失）", value: "—", min: "存在" });
  }
}

// ---------- 输出 ----------

const total = textChecks + badgeChecks + dangerChecks + graphChecks;
const themeNames = [...themes.keys()].join(" / ");

if (failures.length === 0 && fatal.length === 0) {
  console.log(
    `✓ 对比度检查通过：${themes.size} 套主题（${themeNames}）共 ${total} 项 —— ` +
      `文字对 ${textChecks}（≥${TEXT_MIN}）、徽标 ${badgeChecks}（≥${TEXT_MIN}）、` +
      `危险按钮 ${dangerChecks}（≥${TEXT_MIN}）、图形 ${graphChecks}（≥${GRAPH_MIN}）。`,
  );
  if (notes.length) for (const n of notes) console.log(`  ! ${n}`);
  process.exit(0);
}

console.error("✗ 对比度检查未通过：\n");
if (fatal.length) for (const [i, f] of fatal.entries()) console.error(`${i + 1}. ${f}\n`);
if (failures.length) {
  console.error("主题 / 前景 / 背景 / 实测值 / 阈值");
  for (const f of failures) {
    console.error(`  ${f.theme} | ${f.fgLabel} | ${f.bgLabel} | ${f.value} | ${f.min}`);
  }
  console.error("");
  console.error(
    `统计：${themes.size} 套主题，检查 ${total} 项，不达标 ${failures.length} 项` +
      (fatal.length ? `，另有解析失败 ${fatal.length} 条` : "") +
      "。",
  );
}
process.exit(1);
