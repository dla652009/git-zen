// 设置：localStorage 持久化，保存后立即生效
import { reactive, watch } from "vue";

export interface Settings {
  theme: string; // system / light / dark / catppuccin-mocha / ...
  fontFamily: string;
  fontSize: number;
  branchPrefix: string;
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
  fontFamily: '"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
  fontSize: 13,
  branchPrefix: "",
};

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      ...DEFAULTS,
      ...saved,
      diffAddBg: undefined,
      diffAddText: undefined,
      diffDelBg: undefined,
      diffDelText: undefined,
    } as Settings;
  } catch {
    return { ...DEFAULTS };
  }
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
