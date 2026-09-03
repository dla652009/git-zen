<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FolderOpen,
  Folder,
  FolderPlus,
  Plus,
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
import { Button, Input, Spinner, Md, Select, Tooltip } from "@/components/ui";
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
// group：可选分组名（Chrome 标签组风格），扁平存进 gz.repos，无该字段 = 未分组
interface RepoTab {
  path: string;
  name: string;
  group?: string;
}
const repos = ref<RepoTab[]>(JSON.parse(localStorage.getItem("gz.repos") ?? "[]"));
watch(repos, (v) => localStorage.setItem("gz.repos", JSON.stringify(v)), { deep: true });

// 启动时确保当前仓库在列表里
if (repo.value && !repos.value.some((r) => r.path === repo.value)) {
  repos.value.push({ path: repo.value, name: repo.value.split(/[\\/]/).pop() || repo.value });
}

// ---- 选项卡分组（书签文件夹模式）----
// 分组以文件夹形式常驻标签栏，组内仓库只在点击文件夹弹出的下拉里出现；
// 分组名录 gz.groups，标签栏顺序（文件夹+未分组仓库）存 gz.barOrder，管理集中在标签栏右侧按钮的弹窗
const groupList = ref<string[]>(JSON.parse(localStorage.getItem("gz.groups") ?? "[]"));
watch(groupList, (v) => localStorage.setItem("gz.groups", JSON.stringify(v)));

interface BarGroup {
  kind: "group";
  name: string;
}
interface BarRepo {
  kind: "repo";
  path: string;
}
type BarEntry = BarGroup | BarRepo;
const barOrder = ref<BarEntry[]>(JSON.parse(localStorage.getItem("gz.barOrder") ?? "[]"));
watch(barOrder, (v) => localStorage.setItem("gz.barOrder", JSON.stringify(v)), { deep: true });

// 自愈同步：修剪已关闭仓库/已删除分组的条目，补上漏掉的新分组/新仓库（放末尾）。
// barOrder 与渲染列表 1:1，拖拽映射始终成立
function syncBar() {
  const groups = new Set(groupList.value);
  const byPath = new Map(repos.value.map((r) => [r.path, r]));
  const next = barOrder.value.filter((e) =>
    e.kind === "group" ? groups.has(e.name) : byPath.has(e.path) && !byPath.get(e.path)!.group,
  );
  for (const g of groupList.value) {
    if (!next.some((e) => e.kind === "group" && e.name === g)) next.push({ kind: "group", name: g });
  }
  for (const r of repos.value) {
    if (!r.group && !next.some((e) => e.kind === "repo" && e.path === r.path)) {
      next.push({ kind: "repo", path: r.path });
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(barOrder.value)) barOrder.value = next;
}
watch([repos, groupList], syncBar, { deep: true });
localStorage.removeItem("gz.tabGroupsCollapsed"); // 旧版折叠状态键，废弃
syncBar();

const repoByPath = computed(() => new Map(repos.value.map((r) => [r.path, r])));
const groupCount = (g: string) => repos.value.filter((r) => r.group === g).length;
const isGroupActive = (g: string) => repos.value.some((r) => r.group === g && r.path === repo.value);

// ---- 分组 CRUD（管理弹窗调用；成员变动后 syncBar 自动修标签栏）----
function createGroup(name: string): boolean {
  const n = name.trim();
  if (!n || groupList.value.includes(n)) return false;
  groupList.value = [...groupList.value, n];
  return true;
}
function renameGroup(from: string, to: string): boolean {
  const n = to.trim();
  if (!n || (n !== from && groupList.value.includes(n))) return false;
  groupList.value = groupList.value.map((g) => (g === from ? n : g));
  repos.value.forEach((r) => {
    if (r.group === from) r.group = n;
  });
  const e = barOrder.value.find((x): x is BarGroup => x.kind === "group" && x.name === from);
  if (e) e.name = n;
  return true;
}
function deleteGroup(name: string) {
  groupList.value = groupList.value.filter((g) => g !== name);
  repos.value.forEach((r) => {
    if (r.group === name) r.group = undefined; // syncBar 把成员补回标签栏末尾
  });
}
function addMember(group: string, path: string) {
  const r = repoByPath.value.get(path);
  if (r) r.group = group; // 一个仓库只属一个分组；syncBar 把它从标签栏移除
}
function removeMember(path: string) {
  const r = repoByPath.value.get(path);
  if (r) r.group = undefined;
}

// 分组命名弹窗（新建 / 重命名共用）
const groupModal = ref<{ mode: "create" } | { mode: "rename"; from: string } | null>(null);
const groupNameDraft = ref("");
const groupModalErr = ref("");
function openGroupCreate() {
  groupNameDraft.value = "";
  groupModalErr.value = "";
  groupModal.value = { mode: "create" };
}
function openGroupRename(from: string) {
  groupNameDraft.value = from;
  groupModalErr.value = "";
  groupModal.value = { mode: "rename", from };
}
function confirmGroupModal() {
  const name = groupNameDraft.value.trim();
  const m = groupModal.value;
  if (!m || !name) return;
  const ok = m.mode === "create" ? createGroup(name) : renameGroup(m.from, name);
  if (!ok) {
    groupModalErr.value = "该分组名已存在";
    return;
  }
  groupModal.value = null;
}

// 分组管理弹窗 + 文件夹下拉
const showGroupMgr = ref(false);
const mgrExpanded = ref("");
const folderDd = ref<{ x: number; y: number; group: string } | null>(null);
function openGroupMgr() {
  folderDd.value = null;
  mgrExpanded.value = "";
  showGroupMgr.value = true;
}
function toggleFolder(g: string, ev: MouseEvent) {
  if (folderDd.value?.group === g) {
    folderDd.value = null;
    return;
  }
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  folderDd.value = {
    x: Math.min(rect.left, window.innerWidth - 268),
    y: rect.bottom + 4,
    group: g,
  };
}
const folderMembers = computed(() =>
  folderDd.value ? repos.value.filter((r) => r.group === folderDd.value!.group) : [],
);
function openFromFolder(path: string) {
  folderDd.value = null;
  switchRepo(path);
}
function askDeleteGroup(g: string) {
  openConfirm({
    title: "删除分组",
    body: `确认删除分组「${g}」？组内 ${groupCount(g)} 个仓库将回到选项卡栏（不会关闭任何仓库）。`,
    ok: async () => {
      deleteGroup(g);
      if (mgrExpanded.value === g) mgrExpanded.value = "";
    },
  });
}

function addRepo(path: string) {
  if (!repos.value.some((r) => r.path === path)) {
    repos.value.push({ path, name: path.split(/[\\/]/).pop() || path });
  }
}

// ---- 仓库快速切换器（Ctrl+P）：模糊搜索 + 最近使用排序，多仓库时的主要跳转方式 ----
const mruPaths = ref<string[]>([]);
const showSwitcher = ref(false);
const switcherQuery = ref("");
const switcherIndex = ref(0);

const switcherResults = computed(() => {
  const q = switcherQuery.value.trim().toLowerCase();
  const mru = (p: string) => {
    const i = mruPaths.value.indexOf(p);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const list = [...repos.value];
  if (!q) return list.sort((a, b) => mru(a.path) - mru(b.path));
  return list
    .filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(q)) -
          Number(a.name.toLowerCase().startsWith(q)) ||
        mru(a.path) - mru(b.path),
    );
});
function openSwitcher() {
  switcherQuery.value = "";
  switcherIndex.value = 0;
  showSwitcher.value = true;
}
function pickSwitcher(path: string) {
  showSwitcher.value = false;
  switchRepo(path); // busy 时静默忽略，与点选项卡行为一致
}
function onSwitcherKeydown(e: KeyboardEvent) {
  const n = switcherResults.value.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    switcherIndex.value = n ? (switcherIndex.value + 1) % n : 0;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    switcherIndex.value = n ? (switcherIndex.value - 1 + n) % n : 0;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const r = switcherResults.value[switcherIndex.value];
    if (r) pickSwitcher(r.path);
  } else if (e.key === "Escape") {
    showSwitcher.value = false;
  }
}
watch(switcherQuery, () => (switcherIndex.value = 0));
// 键盘上下移动时把选中项滚进可视区
watch(switcherIndex, (i) => {
  document.getElementById(`sw-item-${i}`)?.scrollIntoView({ block: "nearest" });
});

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
  // 最近使用排序（Ctrl+P 切换器用）
  mruPaths.value = [path, ...mruPaths.value.filter((p) => p !== path)];
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

function closeTab(path: string) {
  const i = repos.value.findIndex((r) => r.path === path);
  if (i === -1) return;
  const wasActive = repos.value[i].path === repo.value;
  repoCache.delete(path); // 关闭的选项卡不占 LRU 名额
  mruPaths.value = mruPaths.value.filter((p) => p !== path);
  repos.value.splice(i, 1); // syncBar 自动修剪 barOrder 条目
  if (wasActive) {
    // 关闭的是当前仓库：优先切到标签栏第一个可见仓库；都收进分组了就落到任一剩余仓库
    const firstBar = barOrder.value.find((e) => e.kind === "repo");
    const next =
      firstBar && repoByPath.value.has(firstBar.path) ? firstBar.path : (repos.value[0]?.path ?? "");
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

// 选项卡重命名（右键菜单 → 弹窗输入）、右键菜单；拖动排序交给 vue-draggable-plus。
// 分组的增删改查集中在标签栏右侧按钮的弹窗里，选项卡右键只保留仓库自身操作
const renameTarget = ref(""); // 目标仓库 path
const renameDraft = ref("");
const tabCtx = ref<{ x: number; y: number; path: string } | null>(null);

function openRenameModal() {
  const r = repoByPath.value.get(tabCtx.value!.path);
  if (!r) return;
  renameTarget.value = r.path;
  renameDraft.value = r.name;
  tabCtx.value = null;
}
function confirmRename() {
  const name = renameDraft.value.trim();
  const r = repoByPath.value.get(renameTarget.value);
  if (r && name) r.name = name;
  renameTarget.value = "";
}
// 关闭其他可见选项卡；分组内仓库是「归档」状态，不受影响
function closeOthers(path: string) {
  const keep = repoByPath.value.get(path);
  if (!keep) return;
  repos.value = repos.value.filter((r) => r.group || r.path === path);
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
    // 在标签栏可见仓库间循环（文件夹不参与）
    const vis = barOrder.value.filter((x): x is BarRepo => x.kind === "repo");
    const n = vis.length;
    if (!n) return;
    const i = vis.findIndex((x) => x.path === repo.value);
    const d = e.shiftKey ? -1 : 1;
    activate(vis[(i + d + n) % n].path);
  } else if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    // 第 N 个可见仓库选项卡，分组内的仓库不占号
    const t = barOrder.value.filter((x): x is BarRepo => x.kind === "repo")[Number(e.key) - 1];
    if (t) activate(t.path);
  } else if (e.ctrlKey && (e.key === "p" || e.key === "P")) {
    // 仓库快速切换器
    e.preventDefault();
    if (showSwitcher.value) showSwitcher.value = false;
    else openSwitcher();
  } else if (e.key === "Escape") {
    folderDd.value = null;
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
  // MRU 种子：当前仓库优先，其余按选项卡顺序
  mruPaths.value = repo.value
    ? [repo.value, ...repos.value.map((r) => r.path).filter((p) => p !== repo.value)]
    : [];
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
      <Tooltip text="打开仓库">
        <Button variant="ghost" size="sm" @click="openRepo">
          <FolderOpen class="size-4" />
          打开
        </Button>
      </Tooltip>
      <span class="max-w-[340px] truncate text-muted-foreground"><Tooltip :text="repo">{{ repo }}</Tooltip></span>
      <span class="flex-1" />
      <Badge v-if="status?.behind" variant="warning">↓{{ status.behind }}</Badge>
      <Badge v-if="status?.ahead" variant="info">↑{{ status.ahead }}</Badge>
      <Tooltip text="拉取远程更新并合并到当前分支">
        <Button size="sm" :disabled="!repo || busy" @click="run(() => api.pull(repo), 'pull')">
          <Spinner v-if="runningAction === 'pull'" :size="14" />
          <ArrowDownToLine v-else class="size-3.5" />
          Pull
        </Button>
      </Tooltip>
      <Tooltip text="推送本地提交到远程（无上游时自动建立跟踪）">
        <Button size="sm" :disabled="!repo || busy" @click="run(() => api.push(repo, status?.branch ?? ''), 'push')">
          <Spinner v-if="runningAction === 'push'" :size="14" />
          <ArrowUpFromLine v-else class="size-3.5" />
          Push
        </Button>
      </Tooltip>
      <Tooltip v-if="status?.ahead && settings.aiEnabled === 'on'" text="AI Review 未推送的提交">
        <Button
          size="sm"
          :disabled="busy || reviewBusy"
          @click="startReview"
        >
          <Spinner v-if="reviewBusy" :size="14" />
          <Bot v-else class="size-3.5 text-primary" />
          Review {{ status.ahead }}
        </Button>
      </Tooltip>
      <Tooltip text="刷新仓库状态">
        <Button
          variant="ghost"
          size="icon"
          :disabled="!repo || busy || refreshing"
          @click="doRefresh"
        >
          <RefreshCw class="size-4" :class="refreshing && 'animate-spin'" />
        </Button>
      </Tooltip>
      <Tooltip text="新建分支">
        <Button variant="ghost" size="icon" :disabled="!repo || busy" @click="openCreateBranch">
          <GitBranchPlus class="size-4" />
        </Button>
      </Tooltip>
      <Tooltip text="设置">
        <Button variant="ghost" size="icon" @click="showSettings = true">
          <SettingsIcon class="size-4" />
        </Button>
      </Tooltip>
    </header>

    <!-- 仓库选项卡栏：文件夹（分组）+ 未分组仓库，可拖动排序；最右侧按钮打开分组管理 -->
    <div class="flex items-end border-b border-border">
      <VueDraggable
        v-model="barOrder"
        :animation="150"
        :force-fallback="true"
        fallback-class="opacity-70"
        tag="div"
        class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2"
      >
        <template
          v-for="item in barOrder"
          :key="item.kind === 'group' ? `group:${item.name}` : `repo:${item.path}`"
        >
          <!-- 分组文件夹：点击弹出成员下拉，激活仓库在组内时高亮 -->
          <div
            v-if="item.kind === 'group'"
            class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs whitespace-nowrap select-none"
            :class="[
              isGroupActive(item.name)
                ? 'border-border bg-card font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-muted/60',
            ]"
            :title="`分组「${item.name}」· ${groupCount(item.name)} 个仓库 · 点击展开`"
            @click.stop="toggleFolder(item.name, $event)"
          >
            <Folder
              class="size-3.5 shrink-0"
              :class="isGroupActive(item.name) ? 'text-primary' : 'opacity-70'"
            />
            {{ item.name }}
            <ChevronDown class="size-3 opacity-50" />
          </div>
          <!-- 仓库选项卡 -->
          <div
            v-else
            class="group/tab flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs whitespace-nowrap transition-colors select-none"
            :class="[
              item.path === repo
                ? 'border-border bg-card font-medium text-foreground shadow-sm hover:bg-card'
                : 'border-transparent text-muted-foreground',
            ]"
            @click="switchRepo(item.path)"
            @contextmenu.prevent="tabCtx = { x: $event.clientX, y: $event.clientY, path: item.path }"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="item.path === repo ? 'bg-primary' : 'bg-border group-hover/tab:bg-muted-foreground'"
            />
            <Tooltip :text="item.path + '（右键更多操作，可拖动排序）'">
              <span class="max-w-[120px] truncate">{{ repoByPath.get(item.path)?.name }}</span>
            </Tooltip>
            <X
              class="size-3 opacity-0 transition-opacity group-hover/tab:opacity-60 hover:!opacity-100 hover:text-destructive"
              @mousedown.stop
              @click.stop="closeTab(item.path)"
            />
          </div>
        </template>
      </VueDraggable>
      <Tooltip text="管理分组（新建 / 重命名 / 删除 / 分配仓库）">
        <Button variant="ghost" size="icon" class="mr-1 mb-0.5 h-6 w-6 shrink-0" @click="openGroupMgr">
          <FolderPlus class="size-4" />
        </Button>
      </Tooltip>
    </div>

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
      <Tooltip v-if="remoteWebUrl" :text="`打开远程仓库网页：${remoteWebUrl}`">
        <Button
          variant="ghost"
          size="sm"
          class="h-5 gap-1 px-1.5 text-[11px]"
          @click="openRemote"
        >
        <ExternalLink class="size-3" />
          远程
        </Button>
      </Tooltip>
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

    <!-- 选项卡右键菜单（重命名 / 关闭；分组操作在右侧管理按钮里） -->
    <div v-if="tabCtx" class="fixed inset-0 z-40" @click="tabCtx = null" @contextmenu.prevent="tabCtx = null">
      <div
        class="fixed min-w-[140px] rounded-md border border-border bg-card py-1 shadow-xl"
        :style="{ left: tabCtx.x + 'px', top: tabCtx.y + 'px' }"
      >
        <button
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs hover:bg-muted"
          @click.stop="
            () => {
              openRenameModal();
              tabCtx = null;
            }
          "
        >
          重命名…
        </button>
        <button
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-destructive hover:bg-muted"
          @click.stop="
            () => {
              closeTab(tabCtx!.path);
              tabCtx = null;
            }
          "
        >
          关闭
        </button>
        <button
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs hover:bg-muted"
          @click.stop="
            () => {
              closeOthers(tabCtx!.path);
              tabCtx = null;
            }
          "
        >
          关闭其他
        </button>
      </div>
    </div>

    <!-- 分组文件夹下拉：成员仓库列表，点击激活 -->
    <div v-if="folderDd" class="fixed inset-0 z-40" @click="folderDd = null" @contextmenu.prevent="folderDd = null">
      <div
        class="fixed max-h-[60vh] w-[260px] overflow-y-auto rounded-md border border-border bg-card py-1 shadow-xl"
        :style="{ left: folderDd.x + 'px', top: folderDd.y + 'px' }"
      >
        <div class="px-3 py-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">
          {{ folderDd.group }} · {{ folderMembers.length }} 个仓库
        </div>
        <button
          v-for="r in folderMembers"
          :key="r.path"
          class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
          :class="r.path === repo && 'text-primary'"
          :title="r.path"
          @click.stop="openFromFolder(r.path)"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="r.path === repo ? 'bg-primary' : 'bg-border'"
          />
          <span class="truncate">{{ r.name }}</span>
        </button>
        <div v-if="!folderMembers.length" class="px-3 py-2 text-xs text-muted-foreground">
          空分组 · 点右下角「管理分组」添加仓库
        </div>
        <div class="mt-1 border-t border-border/60 pt-1">
          <button
            class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            @click.stop="openGroupMgr"
          >
            管理分组…
          </button>
        </div>
      </div>
    </div>

    <!-- 分组管理弹窗：新建 / 重命名 / 删除 / 分配仓库 -->
    <div
      v-if="showGroupMgr"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="showGroupMgr = false"
    >
      <div class="flex max-h-[75vh] w-[520px] flex-col rounded-lg border border-border bg-card shadow-xl">
        <header class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <FolderPlus class="size-4 text-primary" />
          <span class="font-medium">分组管理</span>
          <span class="flex-1" />
          <Button variant="ghost" size="icon" @click="showGroupMgr = false"><X class="size-4" /></Button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <Button variant="secondary" size="sm" class="mb-2" @click="openGroupCreate">
            <Plus class="size-3.5" /> 新建分组
          </Button>
          <div v-if="!groupList.length" class="py-8 text-center text-xs text-muted-foreground">
            还没有分组。新建一个，然后把仓库收进去——标签栏会出现一个文件夹，点击可展开仓库列表。
          </div>
          <div v-for="g in groupList" :key="g" class="mb-2 rounded-md border border-border">
            <div class="flex items-center gap-2 px-3 py-2">
              <button
                class="flex flex-1 cursor-pointer items-center gap-1.5 text-left text-[13px]"
                @click="mgrExpanded = mgrExpanded === g ? '' : g"
              >
                <ChevronDown
                  class="size-3 text-muted-foreground transition-transform"
                  :class="mgrExpanded !== g && '-rotate-90'"
                />
                <Folder class="size-3.5 text-primary" />
                <span class="font-medium">{{ g }}</span>
                <span class="text-[11px] text-muted-foreground">{{ groupCount(g) }} 个仓库</span>
                <span v-if="isGroupActive(g)" class="size-1.5 rounded-full bg-primary" title="当前打开的仓库在此分组" />
              </button>
              <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px]" @click="openGroupRename(g)">重命名</Button>
              <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px] text-destructive" @click="askDeleteGroup(g)">
                删除
              </Button>
            </div>
            <!-- 成员编辑：移出 / 添加 -->
            <div v-if="mgrExpanded === g" class="border-t border-border/60 px-3 py-2">
              <div
                v-for="r in repos.filter((x) => x.group === g)"
                :key="r.path"
                class="flex items-center gap-2 py-1 text-xs"
              >
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="r.path === repo ? 'bg-primary' : 'bg-border'"
                />
                <span class="shrink-0 font-medium">{{ r.name }}</span>
                <span class="flex-1 truncate text-[10.5px] text-muted-foreground">{{ r.path }}</span>
                <button
                  class="cursor-pointer text-muted-foreground hover:text-destructive"
                  title="移出分组（回到标签栏）"
                  @click="removeMember(r.path)"
                >
                  <X class="size-3" />
                </button>
              </div>
              <div v-if="!groupCount(g)" class="py-1 text-xs text-muted-foreground">空分组</div>
              <div class="mt-1 border-t border-border/60 pt-1.5">
                <div class="mb-1 text-[10.5px] text-muted-foreground">添加仓库（一个仓库只属一个分组）：</div>
                <div class="max-h-32 space-y-0.5 overflow-y-auto">
                  <button
                    v-for="r in repos.filter((x) => x.group !== g)"
                    :key="r.path"
                    class="flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                    @click="addMember(g, r.path)"
                  >
                    <Plus class="size-3 shrink-0 text-primary" />
                    <span class="truncate">{{ r.name }}</span>
                    <span class="ml-auto truncate text-[10.5px] text-muted-foreground">
                      {{ r.group ? `来自「${r.group}」` : "未分组" }}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <footer class="shrink-0 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          分组像书签文件夹：组内仓库不占选项卡，点文件夹下拉打开。移出/删除分组不会关闭任何仓库。
        </footer>
      </div>
    </div>

    <!-- 分组命名弹窗（新建 / 重命名共用） -->
    <div
      v-if="groupModal"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="groupModal = null"
    >
      <div class="w-[360px] rounded-lg border border-border bg-card p-4 shadow-xl">
        <div class="mb-2 font-medium">{{ groupModal.mode === "create" ? "新建分组" : "重命名分组" }}</div>
        <Input
          v-model="groupNameDraft"
          v-focus
          placeholder="分组名，如：前端 / 后端"
          @keyup.enter="confirmGroupModal"
          @keyup.esc="groupModal = null"
        />
        <div v-if="groupModalErr" class="mt-1.5 text-[11px] text-destructive">{{ groupModalErr }}</div>
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="groupModal = null">取消</Button>
          <Button variant="default" size="sm" :disabled="!groupNameDraft.trim()" @click="confirmGroupModal">
            确定
          </Button>
        </div>
      </div>
    </div>

    <!-- 仓库快速切换器（Ctrl+P）：模糊搜索 + 最近使用排序 -->
    <div
      v-if="showSwitcher"
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
      @click.self="showSwitcher = false"
    >
      <div class="w-[520px] overflow-hidden rounded-lg border border-border bg-card shadow-xl">
        <div class="relative p-2">
          <Search
            class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            v-model="switcherQuery"
            v-focus
            class="h-9 pl-8"
            placeholder="搜索仓库… ↑↓ 选择 · 回车打开 · Esc 关闭"
            @keydown="onSwitcherKeydown"
          />
        </div>
        <ul class="max-h-[50vh] overflow-y-auto p-1 pb-2">
          <li
            v-for="(r, idx) in switcherResults"
            :id="`sw-item-${idx}`"
            :key="r.path"
            :class="[
              'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px]',
              idx === switcherIndex && 'bg-primary/10',
            ]"
            @click="pickSwitcher(r.path)"
            @mousemove="switcherIndex = idx"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="r.path === repo ? 'bg-primary' : 'bg-border'"
            />
            <span class="shrink-0 font-medium">{{ r.name }}</span>
            <Badge v-if="r.group" variant="muted">{{ r.group }}</Badge>
            <span class="flex-1 truncate text-right text-[11px] text-muted-foreground">{{ r.path }}</span>
          </li>
          <li v-if="!switcherResults.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配的仓库
          </li>
        </ul>
      </div>
    </div>

    <!-- 选项卡重命名弹窗 -->
    <div
      v-if="renameTarget"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="renameTarget = ''"
    >
      <div class="w-[360px] rounded-lg border border-border bg-card p-4 shadow-xl">
        <div class="mb-2 font-medium">重命名仓库选项卡</div>
        <Input
          v-model="renameDraft"
          v-focus
          @keyup.enter="confirmRename"
          @keyup.esc="renameTarget = ''"
        />
        <p class="mt-1.5 truncate text-[11px] text-muted-foreground">{{ renameTarget }}</p>
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="renameTarget = ''">取消</Button>
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
