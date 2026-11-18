// 设置：localStorage 持久化，保存后立即生效
import { reactive, watch } from "vue";
import { readJsonObject } from "./lib/safeJson";

export interface Settings {
  /**
   * 明暗模式：light / dark / system。
   * 与配色方案分开存，因为「跟随系统」是一个独立于配色的意图 ——
   * 存成一个字符串时没法表达「跟随系统，但系统变深色时用 Mocha」。
   */
  themeMode: "light" | "dark" | "system";
  /**
   * 配色方案 id（light / xp / catppuccin-mocha…）。
   * 只在该方案的 `mode` 与当前生效模式一致时使用；不一致就退回该模式的第一个方案 ——
   * 比如用户先选 XP（浅色）、再选深色模式，`themeScheme` 仍是 xp，
   * 这时必须自动换成深色组里的默认方案，否则会拿 XP 令牌去渲染深色模式。
   */
  themeScheme: string;
  fontFamily: string;
  fontSize: number;
  branchPrefix: string;
  repoCacheSize: number; // 仓库切换 LRU 缓存容量（个），大仓库多时调大切换更顺
  aiBaseUrl: string; // OpenAI 兼容入口，如 https://api.openai.com/v1 或 http://localhost:11434/v1
  aiApiKey: string;
  aiModel: string;
  aiCommitLang: string; // AI 生成提交信息的语言：中文 / English
  aiEnabled: string; // "on" / "off"，AI 功能总开关
  /** 新建 MR 前是否先用 AI 生成标题与描述（开 = 弹预览确认框；关 = 直接跳转） */
  mrAiGen: "on" | "off";
  /** 变更列表视图：目录树 / 平铺。放在设置里而不是组件内，这样能跨重启保留 */
  changeView: "tree" | "flat";
  /** 分支面板视图：目录树（按 / 分层折叠）/ 平铺（完整分支名一行一条）。
   *  与 changeView 同理放设置里，跨重启保留；两者互相独立 —— 变更列表想平铺、
   *  分支想分层是常见组合，不该被同一个开关绑住 */
  branchView: "tree" | "flat";
  /** 所有仓库总览的视图：按分组 / 平铺。
   *  分组时顺序与选项卡一致（选项卡的分组是用户亲手排的，总览照抄才不违和）；
   *  平铺时按未分组在前、组名排序列出全部仓库 */
  repoView: "group" | "flat";
  /** 推送前先列出这次要推哪些提交。推送是唯一一个「做了就收不回」的日常操作，
   *  也是工具栏上唯一没有确认的按钮；嫌烦可在 设置 › 个性化 关掉 */
  pushPreview: boolean;
}

/**
 * 主题 = 「明暗模式」×「配色方案」两个维度。
 *
 * 为什么拆成两维：全部平铺时用户得在 6 个混排的选项里找「那个深色的」，
 * 而人挑主题的动作顺序本来就是「先定深浅，再挑风格」。拆开后每张卡片还能展示
 * 核心配色，比纯文字标签好认得多。
 *
 * 每个方案声明自己的 `mode`：切模式时用它筛可选项（深色模式下列出所有深色方案）。
 * 只有一套方案的极端模式（比如以后加「纯黑白」）也不会出现空列表 —— 过滤后为空时
 * 界面自动显示「该模式暂无方案」，但当前这两组都不会触发。
 */
export type ThemeMode = "light" | "dark";

export interface ThemeScheme {
  id: string;
  label: string;
  /** 这套方案属于浅色还是深色 —— 决定它在哪个模式下出现 */
  mode: ThemeMode;
  /**
   * 卡片上展示的核心色块（依次为：画布 / 卡片 / 主色 / 前景 / 成功 / 修改）。
   * 值必须与 style.css 里该主题的变量一致，否则卡片和真实效果对不上，
   * 用户会以为选错了。改了主题色记得同步这里。
   */
  swatches: [string, string, string, string, string, string];
}

export const THEME_SCHEMES: ThemeScheme[] = [
  {
    id: "light",
    label: "默认浅色",
    mode: "light",
    swatches: ["#fafafa", "#ffffff", "#6b5cf0", "#1c1c23", "#1a7f37", "#1a6fb5"],
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    swatches: ["#eff1f5", "#e6e9ef", "#5e4eef", "#4c4f69", "#1a7f37", "#1a6fb5"],
  },
  {
    id: "win7",
    label: "Windows 7",
    mode: "light",
    swatches: ["#eef2f6", "#f7f9fb", "#2f6f9f", "#1b1f24", "#1a7f37", "#1668a8"],
  },
  {
    id: "xp",
    label: "Windows XP",
    mode: "light",
    swatches: ["#e3e5e9", "#f1f2f4", "#2a4fbd", "#1a1d21", "#1a7f37", "#1a6fb5"],
  },
  {
    id: "dark",
    label: "默认深色",
    mode: "dark",
    swatches: ["#101014", "#17171d", "#8b7ff5", "#e8e8ee", "#5cb87a", "#5f9fd8"],
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    mode: "dark",
    swatches: ["#1e1e2e", "#181825", "#8b7ff5", "#cdd6f4", "#5cb87a", "#5f9fd8"],
  },
];

/** 兼容旧代码：只需要 id + label 的地方（如“当前主题”文案）继续用它 */
export const THEMES = [
  { id: "system", label: "跟随系统" },
  ...THEME_SCHEMES.map((s) => ({ id: s.id, label: s.label })),
];

/** 某模式下可选的配色方案 */
export function schemesForMode(mode: ThemeMode): ThemeScheme[] {
  return THEME_SCHEMES.filter((s) => s.mode === mode);
}

/** 从主题 id 反推它属于哪个模式；认不出（含 system）时返回 null */
export function modeOfTheme(id: string): ThemeMode | null {
  return THEME_SCHEMES.find((s) => s.id === id)?.mode ?? null;
}

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
  themeMode: "dark",
  themeScheme: "dark",
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
  mrAiGen: "off",
  changeView: "flat",
  branchView: "tree",
  repoView: "group",
  pushPreview: true,
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
  // 旧版本只存一个 theme 字符串（system / light / xp / catppuccin-mocha…）。
  // 迁移规则：system → 跟随系统 + 默认浅色；其余 id 若能对上方案就按它的 mode 归位。
  // 认不出（已下线的主题 id）就整组退回默认，别让界面落进无 token 的空档。
  const legacy = pickStr(saved.theme, "");
  const legacyScheme = legacy && legacy !== "system" ? modeOfTheme(legacy) : null;
  const themeMode: Settings["themeMode"] =
    saved.themeMode === "light" || saved.themeMode === "dark" || saved.themeMode === "system"
      ? saved.themeMode
      : legacy === "system"
        ? "system"
        : (legacyScheme ?? DEFAULTS.themeMode);
  // 方案必须属于「当前生效模式」，否则解析时会退回该模式第一个方案（见 resolveScheme）
  const savedScheme = pickStr(saved.themeScheme, "");
  const themeScheme =
    savedScheme && THEME_SCHEMES.some((s) => s.id === savedScheme)
      ? savedScheme
      : legacyScheme
        ? legacy!
        : DEFAULTS.themeScheme;

  return {
    themeMode,
    themeScheme,
    fontFamily: pickStr(saved.fontFamily, DEFAULTS.fontFamily),
    fontSize: clampFontSize(pickNum(saved.fontSize, DEFAULTS.fontSize)),
    branchPrefix: pickStr(saved.branchPrefix, DEFAULTS.branchPrefix),
    repoCacheSize: pickNum(saved.repoCacheSize, DEFAULTS.repoCacheSize),
    aiBaseUrl: pickStr(saved.aiBaseUrl, DEFAULTS.aiBaseUrl),
    aiApiKey: pickStr(saved.aiApiKey, DEFAULTS.aiApiKey),
    aiModel: pickStr(saved.aiModel, DEFAULTS.aiModel),
    aiCommitLang: pickStr(saved.aiCommitLang, DEFAULTS.aiCommitLang),
    aiEnabled: pickStr(saved.aiEnabled, DEFAULTS.aiEnabled),
    // 新功能默认关：老用户升级后行为不变，想要的人在设置里显式打开
    mrAiGen: saved.mrAiGen === "on" ? "on" : "off",
    // 只认这两个值，其余（历史值、手改的脏值）回退默认值 —— 别在这里写死，
    // 否则改 DEFAULTS 的时候会悄悄不生效
    changeView:
      saved.changeView === "flat" || saved.changeView === "tree"
        ? saved.changeView
        : DEFAULTS.changeView,
    branchView:
      saved.branchView === "flat" || saved.branchView === "tree"
        ? saved.branchView
        : DEFAULTS.branchView,
    repoView:
      saved.repoView === "flat" || saved.repoView === "group"
        ? saved.repoView
        : DEFAULTS.repoView,
    // 缺省即开：老用户的 localStorage 里没有这个键，不该因此少掉预览
    pushPreview: saved.pushPreview !== false,
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

/** 当前应生效的明暗模式（跟随系统时取系统偏好） */
export function effectiveMode(): ThemeMode {
  if (settings.themeMode === "system") return mql.matches ? "dark" : "light";
  return settings.themeMode;
}

/**
 * 当前应生效的方案 id。
 * 存的方案若不属于生效模式（选了 XP 又切到深色模式），退回该模式第一个方案 ——
 * 宁可用默认深色，也不能拿 XP 的浅色令牌去渲染深色界面（对比度全崩）。
 */
export function resolveScheme(
  mode: ThemeMode = effectiveMode(),
  schemeId: string = settings.themeScheme,
): string {
  const list = schemesForMode(mode);
  return list.some((s) => s.id === schemeId) ? schemeId : (list[0]?.id ?? DEFAULTS.themeScheme);
}

function resolvedTheme(): string {
  return resolveScheme();
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

/**
 * 把一组「外观」值直接画到 DOM 上，**不写 settings**。
 *
 * 用途是设置页的实时预览：用户点一下主题/字体就该马上看到效果，但不能因为点错了
 * 就被持久化 —— settings 的 deep watch 会把任何变更立刻写进 localStorage。
 * 所以预览只碰 DOM，取消时调 restoreSettings() 用已保存的值覆盖回去。
 */
export function previewAppearance(
  p: Pick<Settings, "themeMode" | "themeScheme" | "fontFamily" | "fontSize">,
) {
  const root = document.documentElement;
  const mode: ThemeMode = p.themeMode === "system" ? (mql.matches ? "dark" : "light") : p.themeMode;
  root.dataset.theme = resolveScheme(mode, p.themeScheme);
  root.style.fontFamily = p.fontFamily;
  root.style.fontSize = clampFontSize(p.fontSize) + "px";
}

/** 用已保存的 settings 覆盖 DOM —— 取消预览时调 */
export function restoreSettings() {
  applySettings();
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
}
