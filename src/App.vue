<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FolderOpen,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpFromLine,
  Search,
  Settings as SettingsIcon,
  ChevronDown,
  GitBranch,
  GitBranchPlus,
  Cloud,
  X,
  Bot,
  ExternalLink,
} from "@lucide/vue";
import * as api from "./gitApi";
import { AI_PROMPTS, aiComplete, clipForAI, aiCacheRead, aiCacheWrite, aiCacheDelete } from "./ai";
import type { Status, LogEntry, Branch } from "./gitApi";
import { settings } from "./settings";
import { Button, Input, Spinner, Md, Select } from "@/components/ui";
import { Badge } from "@/components/ui";
import HistoryGraph from "./components/HistoryGraph.vue";
import ChangesPanel from "./components/ChangesPanel.vue";
import DiffViewer from "./components/DiffViewer.vue";
import type { DiffTarget, CommitTarget } from "./components/DiffViewer.vue";
import SettingsModal from "./components/SettingsModal.vue";
import FileHistoryModal from "./components/FileHistoryModal.vue";
import BranchTree from "./components/BranchTree.vue";
import { VueDraggable } from "vue-draggable-plus";
import { buildNodes } from "./branchTree";
import type { BNode } from "./branchTree";

const repo = ref(localStorage.getItem("gz.repo") ?? "");
const status = ref<Status | null>(null);
const commits = ref<LogEntry[]>([]);
const branchList = ref<Branch[]>([]);
const busy = ref(false);
const error = ref("");

// ---- 错误确认框（替代 toast）：点确认才关 ----
const errDetail = ref("");

function showError(msg: string) {
  const h = humanize(msg);
  error.value = h.msg;
  errDetail.value = h.detail ?? "";
}

// git stderr -> 人话；匹配不到就原文展示
function humanize(raw: string): { msg: string; detail?: string } {
  const s = String(raw);
  const rules: [RegExp, string][] = [
    [/has no upstream|no tracking information/i, "当前分支没有上游，先在终端执行一次：git push -u origin <分支名>"],
    [/rejected.*fetch first|non-fast-forward/i, "远程有新提交，先 Pull 再 Push"],
    [/nothing to commit/i, "没有可提交的内容：先暂存文件"],
    [/authentication|permission denied|could not read Username|403/i, "认证失败：请检查系统 git 凭据（credential helper / ssh key）"],
    [/not a git repository/i, "所选目录不是 Git 仓库"],
    [/does not have any commits yet/i, "空仓库：还没有任何提交"],
    [/conflict/i, "产生合并冲突，请在终端解决后再试"],
    [/failed to connect|connection timed out|could not resolve host/i, "网络不通：无法连接远程仓库"],
    [/not fully merged|used as worktree/i, "该分支尚未合并或有其他占用，为防误删请到终端确认处理"],
  ];
  const hit = rules.find(([re]) => re.test(s));
  return hit ? { msg: hit[1], detail: s } : { msg: s };
}

// 刷新按钮动画 + 整页刷新遮罩
const refreshing = ref(false);
async function doRefresh() {
  refreshing.value = true;
  try {
    await refresh();
  } finally {
    refreshing.value = false;
  }
}

// ---- 仓库数据 LRU 缓存（最多 5 个）：切回最近访问的仓库秒开 ----
interface RepoCache {
  status: Status;
  commits: LogEntry[];
  branchList: Branch[];
}
const repoCache = new Map<string, RepoCache>();
function cacheGet(path: string): RepoCache | null {
  const c = repoCache.get(path);
  if (!c) return null;
  repoCache.delete(path);
  repoCache.set(path, c); // 触摸，保 LRU 顺序
  return c;
}
function cachePut(path: string, data: RepoCache) {
  repoCache.delete(path);
  repoCache.set(path, data);
  while (repoCache.size > 5) {
    repoCache.delete(repoCache.keys().next().value!);
  }
}

// 历史视图范围：当前分支 / 所有分支
const historyMode = ref<"current" | "all">("current");
// 文件变更历史弹窗（单文件 --follow）
const fileHistoryModal = ref<string | null>(null);
const remoteRaw = ref(""); // origin 的 URL（git remote get-url）
const remoteLink = ref(""); // 用户在设置里自定义的网页链接（留空自动推断）

// 统一的历史拉取入口：带上 视图范围（--all）与文件历史（--follow -- path）
function fetchLog(skip = 0) {
  return api.log(repo.value, skip, historyMode.value === "all" ? true : undefined);
}

async function refresh() {
  if (!repo.value) return;
  remoteLink.value =
    (JSON.parse(localStorage.getItem("gz.remoteLinks") ?? "{}") as Record<string, string>)[repo.value] ?? "";
  try {
    const [s, l, b] = await Promise.all([
      api.status(repo.value),
      fetchLog(0),
      api.branches(repo.value),
    ]);
    status.value = s;
    commits.value = l;
    branchList.value = b;
    canLoadMore.value = l.length >= 300;
    cachePut(repo.value, { status: s, commits: l, branchList: b });
  } catch (e) {
    showError(String(e));
  }
}

// 窗口标题显示未推送数
function updateTitle() {
  const a = status.value?.ahead ?? 0;
  getCurrentWindow().setTitle(a > 0 ? `(↑${a}) git-zen` : "git-zen");
}
watch(status, updateTitle);

const canLoadMore = ref(false);
const loadingMore = ref(false);

async function loadMorePage() {
  if (!repo.value || !canLoadMore.value || filter.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const next = await fetchLog(commits.value.length);
    commits.value.push(...next);
    canLoadMore.value = next.length >= 300;
  } catch (e) {
    showError(String(e));
  } finally {
    loadingMore.value = false;
  }
}

// 滚动到底自动加载下一页
function onHistoryScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) loadMorePage();
}

// 打开仓库时后台 fetch 一次刷 ahead/behind，静默失败
function fetchOnce() {
  if (!repo.value) return;
  api.fetchAll(repo.value)
    .then(() => api.branches(repo.value))
    .catch(() => {});
  api.remoteUrl(repo.value)
    .then((u) => (remoteRaw.value = u))
    .catch(() => {});
}

// 视图范围 / 文件历史变化 → 重载当前历史（两段式：遮罩先盖）
watch(historyMode, () => {
  if (!repo.value) return;
  historyLoading.value = true;
  nextTick().then(async () => {
    try {
      const l = await fetchLog(0);
      commits.value = l;
      canLoadMore.value = l.length >= 300;
    } finally {
      historyLoading.value = false;
    }
  });
});

// 远程网页链接：自定义优先，否则从 origin URL 推断（git@host:path → https://host/path）
const remoteWebUrl = computed(() => {
  const link = remoteLink.value.trim();
  if (link) return link;
  const u = remoteRaw.value;
  if (!u) return "";
  let m = u.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = u.match(/^(https?:\/\/\S+?)(?:\.git)?$/);
  return m ? m[1] : "";
});
function openRemote() {
  if (remoteWebUrl.value) openUrl(remoteWebUrl.value).catch(() => {});
}

const runningAction = ref("");

async function run(fn: () => Promise<unknown>, name = "") {
  busy.value = true;
  runningAction.value = name;
  try {
    await fn();
    await refresh();
    // 推送成功 → 清掉该分支的 AI Review 缓存（已推送不再保留）
    if (name === "push") aiCacheDelete(REVIEW_BUCKET, reviewKey());
  } catch (e) {
    showError(String(e));
  } finally {
    busy.value = false;
    runningAction.value = "";
  }
}

async function openRepo() {
  const dir = await open({ directory: true });
  if (!dir) return;
  addRepo(dir);
  switchRepo(dir);
}

// ---- 仓库选项卡：持久化所有导入过的仓库，支持重命名/删除/拖动排序 ----
interface RepoTab {
  path: string;
  name: string;
}
const repos = ref<RepoTab[]>(JSON.parse(localStorage.getItem("gz.repos") ?? "[]"));
watch(repos, (v) => localStorage.setItem("gz.repos", JSON.stringify(v)), { deep: true });

// 启动时确保当前仓库在列表里
if (repo.value && !repos.value.some((r) => r.path === repo.value)) {
  repos.value.push({ path: repo.value, name: repo.value.split(/[\\/]/).pop() || repo.value });
}

function addRepo(path: string) {
  if (!repos.value.some((r) => r.path === path)) {
    repos.value.push({ path, name: path.split(/[\\/]/).pop() || path });
  }
}

function switchRepo(path: string) {
  if (path === repo.value || busy.value) return;
  activate(path);
}

// 切换仓库：两段式刷新——先拉轻量数据（status/branches）让侧栏/状态栏立即就位，
// 再拉 log 渲染泳道图，期间盖 loading 遮罩。避免等全部数据才响应。
// seq token：频繁切换时旧请求直接作废，不互相覆盖（防抖+防竞态）
let activateSeq = 0;
async function activate(path: string) {
  const seq = ++activateSeq;
  repo.value = path;
  localStorage.setItem("gz.repo", path);
  filter.value = "";
  // 先切换：立刻清掉旧仓库数据，UI 马上呈现新选项卡的空态+loading
  status.value = null;
  commits.value = [];
  branchList.value = [];
  canLoadMore.value = false;
  fileHistoryModal.value = null;
  remoteRaw.value = "";
  remoteLink.value = "";

  // LRU 命中：秒开缓存快照，后台静默刷新轻量数据
  const cached = cacheGet(path);
  if (cached) {
    status.value = cached.status;
    commits.value = cached.commits;
    branchList.value = cached.branchList;
    canLoadMore.value = cached.commits.length >= 300;
    fetchOnce();
    api.branches(path)
      .then((b) => seq === activateSeq && (branchList.value = b))
      .catch(() => {});
    return;
  }

  historyLoading.value = true;
  await nextTick();
  if (seq !== activateSeq) return;
  try {
    const [s, b] = await Promise.all([api.status(path), api.branches(path)]);
    if (seq !== activateSeq) return;
    status.value = s;
    branchList.value = b;
    commits.value = [];
    canLoadMore.value = false;
    await nextTick();
    const l = await fetchLog(0);
    if (seq !== activateSeq) return;
    commits.value = l;
    canLoadMore.value = l.length >= 300;
  } catch (e) {
    if (seq === activateSeq) showError(String(e));
  } finally {
    if (seq === activateSeq) historyLoading.value = false;
  }
  fetchOnce();
}

function closeTab(i: number) {
  const wasActive = repos.value[i].path === repo.value;
  repoCache.delete(repos.value[i].path); // 关闭的选项卡不占 LRU 名额
  repos.value.splice(i, 1);
  if (wasActive) {
    const next = repos.value[0]?.path ?? "";
    repo.value = next;
    localStorage.setItem("gz.repo", next);
    filter.value = "";
    if (next) {
      historyLoading.value = true;
      nextTick().then(async () => {
        try {
          await refresh();
        } finally {
          historyLoading.value = false;
        }
      });
    } else {
      status.value = null;
      commits.value = [];
      branchList.value = [];
    }
  }
}

// 选项卡重命名（右键菜单 → 弹窗输入）、右键菜单；拖动排序交给 vue-draggable-plus
const renameTarget = ref(-1);
const renameDraft = ref("");
const tabCtx = ref<{ x: number; y: number; i: number } | null>(null);

function openRenameModal() {
  const i = tabCtx.value!.i;
  renameTarget.value = i;
  renameDraft.value = repos.value[i].name;
  tabCtx.value = null;
}
function confirmRename() {
  const name = renameDraft.value.trim();
  if (renameTarget.value >= 0 && name) repos.value[renameTarget.value].name = name;
  renameTarget.value = -1;
}
function closeOthers(i: number) {
  const keep = repos.value[i];
  repos.value = [keep];
  if (keep.path !== repo.value) activate(keep.path);
  tabCtx.value = null;
}

// 窗口聚焦时自动刷新
const filter = ref("");
type DiffState = { kind: "file"; target: DiffTarget } | { kind: "commit"; target: CommitTarget };
const diffState = ref<DiffState | null>(null);
const showSettings = ref(false);
const showSettingsTab = ref<string | undefined>(undefined);

// 历史行右键菜单：复制 hash / checkout / revert
const commitCtx = ref<{ x: number; y: number; c: LogEntry } | null>(null);
function copyHash(hash: string) {
  navigator.clipboard.writeText(hash).catch(() => showError("复制失败"));
}
function onCommitMenu(p: { x: number; y: number; c: LogEntry }) {
  commitCtx.value = p;
}

// ---- AI Review 未推送提交（ahead>0 时工具栏出按钮）----
// 结果按 repo+分支 临时保存：切回来能二次查看；推送成功后清除
const reviewBusy = ref(false);
const reviewOpen = ref(false);
const reviewText = ref("");
const reviewErr = ref("");
// 结果持久化在 localStorage（gz.ai.review），重启后仍可二次查看
const REVIEW_BUCKET = "review";
function reviewCacheGet(key: string): string | undefined {
  return aiCacheRead(REVIEW_BUCKET, key);
}
function reviewCacheSet(key: string, text: string) {
  aiCacheWrite(REVIEW_BUCKET, key, text);
}
function reviewKey(): string {
  return `${repo.value}::${status.value?.branch ?? ""}`;
}
function aiConfigured(): boolean {
  if (settings.aiEnabled !== "on") return false; // AI 总开关关闭时全部入口引导去设置
  return !!(settings.aiBaseUrl.trim() && (settings.aiApiKey.trim() || settings.aiBaseUrl.includes("localhost")));
}
async function startReview(regen: boolean | Event = false) {
  // 注意：模板 @click 不带参时会把 MouseEvent 传进来，只有显式传 true 才算强制重生成
  const forceRegen = regen === true;
  if (!aiConfigured()) {
    // 未配置 → 直接引导到设置 AI 页
    showSettingsTab.value = "ai";
    showSettings.value = true;
    return;
  }
  if (reviewBusy.value || !status.value?.ahead) return;
  const key = reviewKey();
  const cached = reviewCacheGet(key);
  if (!forceRegen && cached !== undefined) {
    // 已有报告直接展示，附重新生成按钮
    reviewText.value = cached;
    reviewErr.value = "";
    reviewOpen.value = true;
    return;
  }
  reviewOpen.value = true;
  reviewBusy.value = true;
  reviewText.value = "";
  reviewErr.value = "";
  try {
    const d = await api.diffUnpushed(repo.value);
    reviewText.value = await aiComplete(
      AI_PROMPTS.reviewUnpushed.system,
      clipForAI(d),
    );
    reviewCacheSet(key, reviewText.value);
  } catch (e) {
    reviewErr.value = String(e).replace(/^Error: /, "");
  } finally {
    reviewBusy.value = false;
  }
}

const reviewSaved = ref(false);
async function saveReviewToFile() {
  if (!reviewText.value) return;
  const target = await saveDialog({
    title: "保存 AI Review 报告",
    defaultPath: `AI-review-${status.value?.branch ?? "branch"}-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!target) return;
  try {
    await api.writeTextFile(target, reviewText.value);
    reviewSaved.value = true;
    setTimeout(() => (reviewSaved.value = false), 2000);
  } catch (e) {
    showError(String(e));
  }
}

// ---- 分支树：本地 / 按远程前缀分组，可折叠 ----
const collapsedGroups = ref(new Set<string>());
function toggleGroup(g: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(g)) next.delete(g);
  else next.add(g);
  collapsedGroups.value = next;
}
// 分支模糊搜索：过滤后建树（匹配叶子保留，祖先自动带上）
const branchFilter = ref("");
function matchBranches(list: Branch[]): Branch[] {
  const q = branchFilter.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((b) => b.name.toLowerCase().includes(q));
}
const localBranches = computed(() => matchBranches(branchList.value.filter((b) => !b.remote)));
// 当前分支在远程不存在（无上游）→ 状态栏提示，Push 时也会自动 -u 建立跟踪
const currentBranchNoUpstream = computed(() => {
  const b = branchList.value.find((x) => x.current && !x.remote);
  return !!b && !b.upstream;
});
const localNodes = computed(() => buildNodes(localBranches.value, "local:"));
const remoteGroups = computed(() => {
  const map = new Map<string, Branch[]>();
  for (const b of matchBranches(branchList.value).filter((x) => x.remote)) {
    // 过滤 origin/HEAD 符号引用和无效名（曾导致空分支项，切换报 empty pathspec）
    if (!b.name.includes("/") || b.name.endsWith("/HEAD")) continue;
    const p = b.name.split("/")[0];
    if (!map.has(p)) map.set(p, []);
    map.get(p)!.push(b);
  }
  return [...map.entries()].filter(([, list]) => list.length > 0);
});
// 远程组默认收起：记「展开」集合而不是折叠集合
const openRemotes = ref(new Set<string>());
function toggleRemote(p: string) {
  const next = new Set(openRemotes.value);
  if (next.has(p)) next.delete(p);
  else next.add(p);
  openRemotes.value = next;
}
// 远程组内去掉远程前缀再建树，避免顶层重复出现 origin
function remoteNodes(prefix: string): BNode[] {
  const list = remoteGroups.value.find(([p]) => p === prefix)?.[1] ?? [];
  return buildNodes(
    list.map((b) => ({ ...b, name: b.name.slice(prefix.length + 1) })),
    `remote:${prefix}:`,
  );
}

// ---- 创建分支：工具栏按钮 → 弹窗（可选前缀，基于当前分支，创建即切换）----
const prefixes = computed(() =>
  settings.branchPrefix
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
);
const showCreateBranch = ref(false);
const newBranchPrefix = ref("");
const newBranchName = ref("");

function openCreateBranch() {
  if (!repo.value) return;
  newBranchName.value = "";
  newBranchPrefix.value = prefixes.value[0] ?? "";
  showCreateBranch.value = true;
}
function confirmCreateBranch() {
  const raw = newBranchName.value.trim();
  if (!raw || busy.value) return;
  const p = newBranchPrefix.value;
  const full = p && !raw.startsWith(p) ? p + raw : raw;
  showCreateBranch.value = false;
  run(() => api.branchCreate(repo.value, full));
}

// ---- 切换分支：乐观更新选中态 + 历史区 loading，失败由 refresh 回滚真实状态 ----
const historyLoading = ref(false);
function targetName(b: Branch): string {
  return b.remote ? b.name.replace(/^[^/]+\//, "") : b.name;
}
async function switchBranch(b: Branch) {
  if (b.current || busy.value) return;
  if (status.value && !b.remote) status.value.branch = targetName(b);
  branchList.value.forEach((x) => (x.current = x.name === b.name));
  historyLoading.value = true;
  try {
    await run(() => api.checkout(repo.value, targetName(b)));
  } finally {
    historyLoading.value = false;
  }
}

// ---- 危险操作确认框（删分支/合并），支持强制删除勾选项 ----
interface ConfirmState {
  title: string;
  body: string;
  checkbox?: string;
  ok: (checked: boolean) => Promise<unknown>;
}
const confirmState = ref<ConfirmState | null>(null);
const confirmChecked = ref(false);

function openConfirm(s: ConfirmState) {
  confirmChecked.value = false;
  confirmState.value = s;
}

function askDelete(b: Branch) {
  if (b.remote) {
    const remote = b.name.split("/")[0];
    const short = b.name.replace(/^[^/]+\//, "");
    openConfirm({
      title: "删除远程分支",
      body: `确认删除远程分支 ${b.name}？该操作直接作用于远程仓库。`,
      ok: () => api.pushDelete(repo.value, remote, short),
    });
    return;
  }
  openConfirm({
    title: "删除分支",
    body: `确认删除本地分支 ${b.name}？`,
    checkbox: "强制删除（-D，未合并的提交将丢失）",
    ok: (force) => api.branchDelete(repo.value, b.name, force),
  });
}
function doRename(b: Branch, newName: string) {
  run(() => api.branchRename(repo.value, b.name, newName));
}
function askMerge(b: Branch) {
  openConfirm({
    title: "合并分支",
    body: `将 ${targetName(b)} 合并到当前分支 ${status.value?.branch ?? ""}？`,
    ok: () => api.merge(repo.value, targetName(b)),
  });
}
// 把当前分支合并进目标分支：切过去合并后就留在目标分支（用户要求不切回）
function askMergeInto(b: Branch) {
  const target = b.name;
  const cur = status.value?.branch ?? "";
  if (!cur || cur === target) return;
  openConfirm({
    title: "合并当前分支到目标分支",
    body: `将把当前分支 ${cur} 合并到 ${target}，完成后停留在 ${target}。若冲突请在解决后重新提交。`,
    ok: async () => {
      await api.checkout(repo.value, target);
      await api.merge(repo.value, cur);
    },
  });
}

// ---- 全局快捷键 ----
// Ctrl+Tab / Ctrl+Shift+Tab：下一个/上一个仓库选项卡
// Ctrl+1..9：跳到第 N 个选项卡
// F5：刷新
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    const n = repos.value.length;
    if (!n) return;
    const i = repos.value.findIndex((r) => r.path === repo.value);
    const d = e.shiftKey ? -1 : 1;
    activate(repos.value[(i + d + n) % n].path);
  } else if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const t = repos.value[Number(e.key) - 1];
    if (t) activate(t.path);
  } else if (e.key === "F5") {
    e.preventDefault();
    refresh();
  }
}

// ---- 侧边栏拖宽 + 持久化 ----
const leftW = ref(Number(localStorage.getItem("gz.w.left")) || 208);
const rightW = ref(Number(localStorage.getItem("gz.w.right")) || 320);
let resizing: "l" | "r" | null = null;

function startResize(side: "l" | "r") {
  resizing = side;
  document.body.style.cursor = "col-resize";
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", endResize);
}
function onResizeMove(e: MouseEvent) {
  if (resizing === "l") leftW.value = Math.min(420, Math.max(140, e.clientX));
  else rightW.value = Math.min(520, Math.max(240, window.innerWidth - e.clientX));
}
function endResize() {
  window.removeEventListener("mousemove", onResizeMove);
  window.removeEventListener("mouseup", endResize);
  if (resizing) localStorage.setItem(resizing === "l" ? "gz.w.left" : "gz.w.right", String(resizing === "l" ? leftW.value : rightW.value));
  document.body.style.cursor = "";
  resizing = null;
}

// v-focus：选项卡重命名输入框自动聚焦
const vFocus = { mounted: (el: HTMLElement) => el.focus() };

onMounted(async () => {
  window.addEventListener("focus", () => refresh());
  window.addEventListener("keydown", onGlobalKeydown);
  if (repo.value) {
    await refresh();
    fetchOnce();
  }
});
</script>

<template>
  <div class="relative flex h-full flex-col">
    <!-- 整页刷新遮罩（点刷新按钮时盖全页，替代仅按钮动画） -->
    <Transition name="fade">
      <div
        v-if="refreshing"
        class="absolute inset-0 z-20 grid place-items-center bg-background/50 text-sm"
      >
        <Spinner label="刷新中…" />
      </div>
    </Transition>
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <Button variant="ghost" size="sm" title="打开仓库" @click="openRepo">
        <FolderOpen class="size-4" />
        打开
      </Button>
      <span class="max-w-[340px] truncate text-muted-foreground" :title="repo">
        {{ repo || "未选择仓库" }}
      </span>
      <span class="flex-1" />
      <Badge v-if="status?.behind" variant="warning">↓{{ status.behind }}</Badge>
      <Badge v-if="status?.ahead" variant="info">↑{{ status.ahead }}</Badge>
      <Button size="sm" title="拉取远程更新并合并到当前分支" :disabled="!repo || busy" @click="run(() => api.pull(repo), 'pull')">
        <Spinner v-if="runningAction === 'pull'" :size="14" />
        <ArrowDownToLine v-else class="size-3.5" />
        Pull
      </Button>
      <Button size="sm" title="推送本地提交到远程（无上游时自动建立跟踪）" :disabled="!repo || busy" @click="run(() => api.push(repo, status?.branch ?? ''), 'push')">
        <Spinner v-if="runningAction === 'push'" :size="14" />
        <ArrowUpFromLine v-else class="size-3.5" />
        Push
      </Button>
      <Button
        v-if="status?.ahead && settings.aiEnabled === 'on'"
        size="sm"
        :disabled="busy || reviewBusy"
        title="AI Review 未推送的提交"
        @click="startReview"
      >
        <Spinner v-if="reviewBusy" :size="14" />
        <Bot v-else class="size-3.5 text-primary" />
        Review {{ status.ahead }}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="刷新"
        :disabled="!repo || busy || refreshing"
        @click="doRefresh"
      >
        <RefreshCw class="size-4" :class="refreshing && 'animate-spin'" />
      </Button>
      <Button variant="ghost" size="icon" title="新建分支" :disabled="!repo || busy" @click="openCreateBranch">
        <GitBranchPlus class="size-4" />
      </Button>
      <Button variant="ghost" size="icon" title="设置" @click="showSettings = true">
        <SettingsIcon class="size-4" />
      </Button>
    </header>

    <!-- 仓库选项卡（vue-draggable-plus 拖动排序，带动画） -->
    <VueDraggable
      v-model="repos"
      :animation="150"
      :force-fallback="true"
      fallback-class="opacity-70"
      tag="div"
      class="flex items-end gap-0.5 overflow-x-auto border-b border-border px-2"
    >
      <div
        v-for="(r, i) in repos"
        :key="r.path"
        class="group/tab flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs whitespace-nowrap transition-colors select-none"
        :class="[
          r.path === repo
            ? 'border-border bg-card font-medium text-foreground shadow-sm hover:bg-card'
            : 'border-transparent text-muted-foreground',
        ]"
        :title="r.path + '（右键更多操作，拖动排序）'"
        @click="switchRepo(r.path)"
        @contextmenu.prevent="tabCtx = { x: $event.clientX, y: $event.clientY, i }"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="r.path === repo ? 'bg-primary' : 'bg-border group-hover/tab:bg-muted-foreground'"
        />
        {{ r.name }}
        <X
          class="size-3 opacity-0 transition-opacity group-hover/tab:opacity-60 hover:!opacity-100 hover:text-destructive"
          title="关闭"
          @mousedown.stop
          @click.stop="closeTab(i)"
        />
      </div>
    </VueDraggable>

    <div class="flex min-h-0 flex-1">
      <!-- 分支侧栏（可拖宽） -->
      <aside
        class="shrink-0 overflow-y-auto border-r border-border"
        :style="{ width: leftW + 'px' }"
      >
        <div class="px-3 pt-3 pb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          分支
        </div>
        <!-- 分支模糊搜索（创建分支在工具栏按钮） -->
        <div class="relative px-2.5 pb-2">
          <Search
            class="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input v-model="branchFilter" placeholder="搜索分支…" class="h-7 pl-7 text-xs" />
        </div>
        <!-- 本地分支组：一级栏，图标+强调 -->
        <div
          class="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium select-none hover:bg-muted"
          @click="toggleGroup('local')"
        >
          <ChevronDown class="size-3 transition-transform" :class="collapsedGroups.has('local') && '-rotate-90'" />
          <GitBranch class="size-3.5" />
          本地
          <span class="text-[11px] font-normal text-muted-foreground">{{ localBranches.length }}</span>
        </div>
        <BranchTree
          v-if="!collapsedGroups.has('local')"
          v-model="collapsedGroups"
          :nodes="localNodes"
          manage
          @switch="switchBranch"
          @delete="askDelete"
          @rename="doRename"
          @merge="askMerge"
          @merge-into="askMergeInto"
        />

        <!-- 远程分组：一级栏图标+强调，默认收起 -->
        <template v-for="[prefix, list] in remoteGroups" :key="prefix">
          <div
            class="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium select-none hover:bg-muted"
            @click="toggleRemote(prefix)"
          >
            <ChevronDown class="size-3 transition-transform" :class="!openRemotes.has(prefix) && '-rotate-90'" />
            <Cloud class="size-3.5" />
            {{ prefix }}
            <span class="text-[11px] font-normal text-muted-foreground">{{ list.length }}</span>
          </div>
          <BranchTree
            v-if="openRemotes.has(prefix)"
            v-model="collapsedGroups"
            :nodes="remoteNodes(prefix)"
            manage
            @switch="switchBranch"
            @delete="askDelete"
          />
        </template>
      </aside>

      <!-- 左拖宽把手 -->
      <div class="w-1 shrink-0 cursor-col-resize hover:bg-primary/40" @mousedown="startResize('l')" />

      <!-- 历史 -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2 border-b border-border px-2 py-1.5">
          <!-- 视图范围：当前分支 / 所有分支 -->
          <Select
            v-model="historyMode"
            class="h-7 w-24 shrink-0 text-xs"
            :options="[
              { value: 'current', label: '当前分支' },
              { value: 'all', label: '所有分支' },
            ]"
          />
          <div class="relative min-w-0 flex-1">
            <Search class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="filter" placeholder="搜索提交信息 / 作者…" class="h-7 pl-8 text-xs" />
          </div>
        </div>
        <div class="relative min-h-0 flex-1 overflow-y-auto" @scroll="onHistoryScroll">
          <!-- 切换分支时的 loading 遮罩 -->
          <Transition name="fade">
            <div
              v-if="historyLoading"
              class="absolute inset-0 z-10 grid place-items-center bg-background/60 text-sm"
            >
              <Spinner label="加载中…" />
            </div>
          </Transition>
          <HistoryGraph
            v-if="commits.length"
            :commits="commits"
            :filter="filter"
            @open-commit="(c: LogEntry) => (diffState = { kind: 'commit', target: c })"
            @commit-menu="onCommitMenu"
          />
          <div v-else-if="repo" class="grid h-full place-items-center text-muted-foreground">
            暂无提交
          </div>
          <div v-else class="grid h-full place-items-center text-muted-foreground">
            先打开一个 Git 仓库
          </div>
        </div>
      </section>

      <!-- 右拖宽把手 -->
      <div class="w-1 shrink-0 cursor-col-resize hover:bg-primary/40" @mousedown="startResize('r')" />

      <!-- 变更 -->
      <aside
        class="shrink-0 overflow-y-auto border-l border-border"
        :style="{ width: rightW + 'px' }"
      >
        <ChangesPanel
          :repo="repo"
          :status="status"
          :busy="busy"
          @action="(fn: () => Promise<unknown>) => run(fn)"
          @open-diff="(t: DiffTarget) => (diffState = { kind: 'file', target: t })"
          @file-history="(p: string) => (fileHistoryModal = p)"
          @discard="(t: DiffTarget) =>
            openConfirm({
              title: t.untracked ? '删除未跟踪文件' : '丢弃更改',
              body: `确认${t.untracked ? '删除' : '丢弃'} ${t.path}？此操作不可恢复。`,
              ok: () => api.discard(repo, t.path, t.untracked),
            })"
        />
      </aside>
    </div>

    <!-- 创建分支弹窗 -->
    <div
      v-if="showCreateBranch"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="showCreateBranch = false"
    >
      <div class="w-[400px] rounded-lg border border-border bg-card p-4 shadow-xl">
        <div class="mb-2 font-medium">新建分支</div>
        <div class="flex gap-2">
          <Select
            v-model="newBranchPrefix"
            class="w-32 shrink-0"
            :options="[
              { value: '', label: '无前缀' },
              ...prefixes.map((p: string) => ({ value: p, label: p })),
            ]"
          />
          <Input v-model="newBranchName" placeholder="分支名" @keyup.enter="confirmCreateBranch" />
        </div>
        <p class="mt-2 text-[11px] text-muted-foreground">
          基于当前分支 {{ status?.branch || "—" }} 创建并自动切换。
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="showCreateBranch = false">取消</Button>
          <Button variant="default" size="sm" :disabled="!newBranchName.trim() || busy" @click="confirmCreateBranch">
            创建
          </Button>
        </div>
      </div>
    </div>

    <!-- 历史行右键菜单 -->
    <div v-if="commitCtx" class="fixed inset-0 z-40" @click="commitCtx = null" @contextmenu.prevent="commitCtx = null">
      <div
        class="fixed min-w-[170px] rounded-md border border-border bg-card py-1 shadow-xl"
        :style="{ left: commitCtx.x + 'px', top: commitCtx.y + 'px' }"
      >
        <button
          v-for="item in [
            { label: '复制 hash', fn: () => copyHash(commitCtx!.c.hash) },
            {
              label: 'Checkout 到该提交',
              fn: () =>
                openConfirm({
                  title: 'Checkout 提交',
                  body: `将进入 detached HEAD 状态（${commitCtx!.c.hash.slice(0, 10)}），后续可切回任意分支。`,
                  ok: () => api.checkout(repo, commitCtx!.c.hash.slice(0, 10)),
                }),
            },
            {
              label: 'Revert 该提交',
              fn: () =>
                openConfirm({
                  title: 'Revert 提交',
                  body: `确认 revert「${commitCtx!.c.subject}」？会生成一个反向提交。`,
                  ok: () => api.revert(repo, commitCtx!.c.hash),
                }),
            },
          ]"
          :key="item.label"
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs hover:bg-muted"
          @click.stop="
            () => {
              item.fn();
              commitCtx = null;
            }
          "
        >
          {{ item.label }}
        </button>
      </div>
    </div>

    <!-- 设置弹窗 -->
    <!-- 文件变更历史弹窗（左提交列表 / 右文件diff） -->
    <FileHistoryModal
      v-if="fileHistoryModal"
      :repo="repo"
      :path="fileHistoryModal"
      @close="fileHistoryModal = null"
    />

    <!-- AI Review 报告弹窗 -->
    <div
      v-if="reviewOpen"
      class="fixed inset-0 z-30 flex items-center justify-center bg-black/50"
      @click.self="reviewOpen = false"
    >
      <div class="flex max-h-[80vh] w-[640px] flex-col rounded-lg border border-border bg-card shadow-xl">
        <header class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <Bot class="size-4 text-primary" />
          <span class="font-medium">AI Review · 未推送的 {{ status?.ahead }} 个提交</span>
          <span class="flex-1" />
          <Button variant="ghost" size="icon" @click="reviewOpen = false"><X class="size-4" /></Button>
        </header>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[13px] leading-relaxed">
          <Spinner v-if="reviewBusy" label="AI 正在审查未推送的变更…" />
          <div v-else-if="reviewErr" class="text-destructive">{{ reviewErr }}</div>
          <Md v-else :source="reviewText" />
        </div>
        <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <span v-if="reviewSaved" class="mr-auto text-[11px] text-primary">已保存 ✓</span>
          <Button variant="secondary" size="sm" :disabled="reviewBusy || !reviewText" @click="saveReviewToFile">保存到本地</Button>
          <Button variant="secondary" size="sm" :disabled="reviewBusy || !status?.ahead" @click="startReview(true)">
            重新生成
          </Button>
          <Button variant="secondary" size="sm" @click="reviewOpen = false">关闭</Button>
        </footer>
      </div>
    </div>

    <SettingsModal
      v-if="showSettings"
      :repo="repo"
      :initial-tab="showSettingsTab"
      @close="showSettings = false"
    />

    <footer class="flex items-center gap-3 border-t border-border px-3 py-1 text-xs text-muted-foreground">
      <span>{{ status?.branch ?? "—" }}</span>
      <span class="flex-1" />
      <span v-if="status">{{ status.files.length }} 个变更文件</span>
      <Button
        v-if="remoteWebUrl"
        variant="ghost"
        size="sm"
        class="h-5 gap-1 px-1.5 text-[11px]"
        :title="`打开远程仓库网页：${remoteWebUrl}`"
        @click="openRemote"
      >
        <ExternalLink class="size-3" />
        远程
      </Button>
      <Badge v-if="currentBranchNoUpstream" variant="warning" class="cursor-default">
        当前分支尚未推送到远程
      </Badge>
    </footer>

    <!-- diff 弹层 -->
    <DiffViewer
      v-if="diffState?.kind === 'file'"
      :key="diffState.target.path + diffState.target.cached"
      :repo="repo"
      :file="diffState.target"
      @close="diffState = null"
    />
    <DiffViewer
      v-else-if="diffState?.kind === 'commit'"
      :key="diffState.target.hash"
      :repo="repo"
      :commit="diffState.target"
      @close="diffState = null"
    />

    <!-- 选项卡右键菜单 -->
    <div v-if="tabCtx" class="fixed inset-0 z-40" @click="tabCtx = null" @contextmenu.prevent="tabCtx = null">
      <div
        class="fixed min-w-[140px] rounded-md border border-border bg-card py-1 shadow-xl"
        :style="{ left: tabCtx.x + 'px', top: tabCtx.y + 'px' }"
      >
        <button
          v-for="item in [
            { label: '重命名…', fn: openRenameModal },
            { label: '关闭', fn: () => closeTab(tabCtx!.i) },
            { label: '关闭其他', fn: () => closeOthers(tabCtx!.i) },
          ]"
          :key="item.label"
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs hover:bg-muted"
          @click.stop="
            () => {
              item.fn();
              tabCtx = null;
            }
          "
        >
          {{ item.label }}
        </button>
      </div>
    </div>

    <!-- 选项卡重命名弹窗 -->
    <div
      v-if="renameTarget >= 0"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="renameTarget = -1"
    >
      <div class="w-[360px] rounded-lg border border-border bg-card p-4 shadow-xl">
        <div class="mb-2 font-medium">重命名仓库选项卡</div>
        <Input
          v-model="renameDraft"
          v-focus
          @keyup.enter="confirmRename"
          @keyup.esc="renameTarget = -1"
        />
        <p class="mt-1.5 truncate text-[11px] text-muted-foreground">{{ repos[renameTarget]?.path }}</p>
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="renameTarget = -1">取消</Button>
          <Button variant="default" size="sm" @click="confirmRename">确定</Button>
        </div>
      </div>
    </div>

    <!-- 错误确认框：居中展示，点确认才关 -->
    <div
      v-if="error"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="error = ''"
    >
      <div class="w-[460px] rounded-lg border border-destructive/50 bg-card p-4 shadow-xl">
        <div class="mb-1.5 font-medium text-destructive">操作失败</div>
        <div>{{ error }}</div>
        <details v-if="errDetail" class="mt-2">
          <summary class="cursor-pointer text-xs text-muted-foreground">详细信息</summary>
          <pre class="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{{ errDetail }}</pre>
        </details>
        <div class="mt-3 flex justify-end">
          <Button variant="secondary" size="sm" @click="error = ''">确认</Button>
        </div>
      </div>
    </div>

    <!-- 危险操作确认框（删除分支/合并） -->
    <div
      v-if="confirmState"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="confirmState = null"
    >
      <div class="w-[420px] rounded-lg border border-border bg-card p-4 shadow-xl">
        <div class="mb-1.5 font-medium">{{ confirmState.title }}</div>
        <div>{{ confirmState.body }}</div>
        <label v-if="confirmState.checkbox" class="mt-2 flex cursor-pointer items-center gap-2 text-xs">
          <input v-model="confirmChecked" type="checkbox" class="accent-[var(--primary)]" />
          {{ confirmState.checkbox }}
        </label>
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="confirmState = null">取消</Button>
          <Button
            variant="destructive"
            size="sm"
            @click="
              () => {
                const ok = confirmState!.ok;
                confirmState = null;
                run(() => ok(confirmChecked));
              }
            "
          >
            确认
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
