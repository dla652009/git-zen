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

const DEFAULTS: Settings = {
  theme: "dark",
  fontFamily:
    '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
  fontSize: 13,
  branchPrefix: "",
  repoCacheSize: 5,
  aiBaseUrl: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiCommitLang: "中文",
  aiEnabled: "on",
};

const pickStr = (v: unknown, dflt: string): string =>
  typeof v === "string" ? v : dflt;
const pickNum = (v: unknown, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : dflt;

// 逐字段取值 + 校验类型，缺省/类型不对的字段回退默认值。
// 原来写法是 `{ ...DEFAULTS, ...saved } as Settings`——`as` 只是让编译器闭嘴，
// 存坏的值（例如 fontSize: "big"）照样进 reactive 并生效。
// 已废弃的历史字段（diffAddBg 等）不再读取，历史值由下一次 persist 自然清掉。
function load(): Settings {
  const saved = readJsonObject<Record<string, unknown>>(KEY, {});
  return {
    theme: pickStr(saved.theme, DEFAULTS.theme),
    fontFamily: pickStr(saved.fontFamily, DEFAULTS.fontFamily),
    fontSize: pickNum(saved.fontSize, DEFAULTS.fontSize),
    branchPrefix: pickStr(saved.branchPrefix, DEFAULTS.branchPrefix),
    repoCacheSize: pickNum(saved.repoCacheSize, DEFAULTS.repoCacheSize),
    aiBaseUrl: pickStr(saved.aiBaseUrl, DEFAULTS.aiBaseUrl),
    aiApiKey: pickStr(saved.aiApiKey, DEFAULTS.aiApiKey),
    aiModel: pickStr(saved.aiModel, DEFAULTS.aiModel),
    aiCommitLang: pickStr(saved.aiCommitLang, DEFAULTS.aiCommitLang),
    aiEnabled: pickStr(saved.aiEnabled, DEFAULTS.aiEnabled),
  };
}

export const settings = reactive<Settings>(load());

// 任何字段变更：持久化 + 立即生效（保存按钮把 draft 写回这里即可）
watch(
  settings,
  () => {
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
  root.style.fontSize = settings.fontSize + "px";
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
