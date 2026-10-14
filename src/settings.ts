// 设置：localStorage 持久化，保存后立即生效
import { reactive, watch } from "vue";
import { readJsonObject } from "./lib/safeJson";

export interface Settings {
  theme: string; // system / light / dark / catppuccin-mocha / ...
  fontFamily: string;
  fontSize: number;
  branchPrefix: string;
  repoCacheSize: number; // 仓库切换 LRU 缓存容量（个），大仓库多时调大切换更顺
  aiBaseUrl: string; // OpenAI 兼容入口，如 https://api.openai.com/v1 或 http://localhost:11434/v1
  aiApiKey: string;
  aiModel: string;
  aiCommitLang: string; // AI 生成提交信息的语言：中文 / English
  aiEnabled: string; // "on" / "off"，AI 功能总开关
  /** 变更列表视图：目录树 / 平铺。放在设置里而不是组件内，这样能跨重启保留 */
  changeView: "tree" | "flat";
}

export const THEMES = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "catppuccin-latte", label: "Catppuccin Latte" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { id: "one-dark", label: "One Dark" },
  { id: "github-light", label: "GitHub Light" },
  { id: "github-dark", label: "GitHub Dark" },
];

const KEY = "gz.settings";

// 字号上下限。
// 下限 14px：再小的中文小字在 Windows 上发虚。
// 上限 20px：这是「把界面放大」的极端值。再大就不只是字大了 —— 侧栏与弹窗的宽度是 px
// （刻意不随字号缩放，见 `--container-dlg-*`），字号继续涨只会让里面的文字先挤起来。
// 注意 `src/style.css` 的 `--text-fixed: 14px` 与本下限同值 —— 提交信息框钉在这个下限上，
// 不跟着「设置 → 字号」放大，所以两处要一起改。
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 20;

const DEFAULTS: Settings = {
  theme: "dark",
  fontFamily:
    '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
  fontSize: FONT_SIZE_MIN,
  branchPrefix: "",
  repoCacheSize: 5,
  aiBaseUrl: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiCommitLang: "中文",
  aiEnabled: "on",
  changeView: "flat",
};

const pickStr = (v: unknown, dflt: string): string =>
  typeof v === "string" ? v : dflt;
const pickNum = (v: unknown, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : dflt;

/// 把字号夹回合法区间。历史版本允许 11-13，手改 localStorage 也可能写进越界值，
/// 不夹的话下限就是摆设（数字输入框的 min 只约束箭头，手输照样能提交）。
export function clampFontSize(n: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

// 逐字段取值 + 校验类型，缺省/类型不对的字段回退默认值。
// 原来写法是 `{ ...DEFAULTS, ...saved } as Settings`——`as` 只是让编译器闭嘴，
// 存坏的值（例如 fontSize: "big"）照样进 reactive 并生效。
// 已废弃的历史字段（diffAddBg 等）不再读取，历史值由下一次 persist 自然清掉。
function load(): Settings {
  const saved = readJsonObject<Record<string, unknown>>(KEY, {});
  return {
    theme: pickStr(saved.theme, DEFAULTS.theme),
    fontFamily: pickStr(saved.fontFamily, DEFAULTS.fontFamily),
    fontSize: clampFontSize(pickNum(saved.fontSize, DEFAULTS.fontSize)),
    branchPrefix: pickStr(saved.branchPrefix, DEFAULTS.branchPrefix),
    repoCacheSize: pickNum(saved.repoCacheSize, DEFAULTS.repoCacheSize),
    aiBaseUrl: pickStr(saved.aiBaseUrl, DEFAULTS.aiBaseUrl),
    aiApiKey: pickStr(saved.aiApiKey, DEFAULTS.aiApiKey),
    aiModel: pickStr(saved.aiModel, DEFAULTS.aiModel),
    aiCommitLang: pickStr(saved.aiCommitLang, DEFAULTS.aiCommitLang),
    aiEnabled: pickStr(saved.aiEnabled, DEFAULTS.aiEnabled),
    // 只认这两个值，其余（历史值、手改的脏值）回退默认值 —— 别在这里写死，
    // 否则改 DEFAULTS 的时候会悄悄不生效
    changeView:
      saved.changeView === "flat" || saved.changeView === "tree"
        ? saved.changeView
        : DEFAULTS.changeView,
  };
}

export const settings = reactive<Settings>(load());

/**
 * 「个性化 → 分支前缀」存的是一个逗号分隔的字符串（中英文逗号都认），
 * 这里统一解析成列表 —— 创建分支弹窗、设置里的标签编辑器、工作流的运行时前缀下拉
 * 都要它，各写一份迟早会分叉。
 */
export function parseBranchPrefixes(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 任何字段变更：持久化 + 立即生效（保存按钮把 draft 写回这里即可）
watch(
  settings,
  () => {
    // 越界只在真的发生时才回写，否则赋值同值不会触发响应式，也就不会自激
    const fixed = clampFontSize(settings.fontSize);
    if (fixed !== settings.fontSize) settings.fontSize = fixed;
    persist();
    applySettings();
  },
  { deep: true },
);

function persist() {
  localStorage.setItem(KEY, JSON.stringify({ ...settings }));
}

const mql = window.matchMedia("(prefers-color-scheme: dark)");
mql.addEventListener("change", applyTheme);

function resolvedTheme(): string {
  if (settings.theme !== "system") return settings.theme;
  return mql.matches ? "dark" : "light";
}

export function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  root.style.fontFamily = settings.fontFamily;
  root.style.fontSize = clampFontSize(settings.fontSize) + "px";
  // 清掉历史版本可能写入的 diff 覆盖，回归主题默认
  [
    "--diff-add-bg",
    "--diff-add-text",
    "--diff-del-bg",
    "--diff-del-text",
  ].forEach((k) => root.style.removeProperty(k));
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}
