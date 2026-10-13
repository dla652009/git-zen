<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
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
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitBranchPlus,
  Cloud,
  Download,
  Tag,
  Sparkles,
  Workflow as WorkflowIcon,
  Check,
  Minus,
  X,
  Bot,
  ExternalLink,
  GripVertical,
} from "@lucide/vue";
import * as api from "./gitApi";
import { abortAi } from "./ai";
import type { Status, LogEntry, Branch, TagEntry } from "./gitApi";
import { parseBranchPrefixes, settings } from "./settings";
import { describeStep } from "./workflow";
import { workflows } from "./workflowStore";
import {
  Button,
  Input,
  Spinner,
  Md,
  Select,
  Tooltip,
  Badge,
  Toast,
  ContextMenu,
  toast,
  type MenuItem,
} from "@/components/ui";
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
import { closeTop, type OverlayLayer, type OverlayName } from "./lib/overlays";
import { readJsonArray, readJsonObject } from "./lib/safeJson";
import { imeGuard } from "./lib/imeGuard";

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
  retryFn.value = null; // 默认没有重试入口，只有 run() 失败时才挂上
}

// 失败后能就地重试：过去错误框只有一个「确认」，网络抖动导致 fetch 失败也得先关窗、
// 再自己找回原来的入口重来一遍。只有 run() 包的操作用它——那是「重放一次同样的调用」，
// 而 showError 直调的地方（校验失败等）重试没有意义。
const retryFn = ref<null | (() => Promise<unknown>)>(null);
const retryName = ref("");

function dismissError() {
  error.value = "";
  errDetail.value = "";
  retryFn.value = null;
}

function retryLast() {
  const fn = retryFn.value;
  const name = retryName.value;
  dismissError();
  if (fn) run(fn, name);
}

// git stderr -> 人话；实现放在 src/lib/errors.ts，组件内联错误提示也用同一份规则
import { humanize } from "./lib/errors";
import { isUnmerged } from "./lib/conflict";
import { useSidebarResize } from "./composables/useSidebarResize";
import { useRepoCache } from "./composables/useRepoCache";
import { useSwitcher } from "./composables/useSwitcher";
import { useWorkflowRun } from "./composables/useWorkflowRun";
import { useAiPanel } from "./composables/useAiPanel";
import { useRepoSession } from "./composables/useRepoSession";

// ---- 仓库数据 LRU 缓存：切回最近访问的仓库秒开，容量可在设置-个性化调节 ----
// 实现见 src/composables/useRepoCache.ts
const { cacheGet, cachePeek, cachePut, cacheDrop } = useRepoCache();

// 历史视图范围：当前分支 / 所有分支
const historyMode = ref<"current" | "all">("current");
// 文件变更历史弹窗（单文件 --follow）
const fileHistoryModal = ref<string | null>(null);
// 历史区按文件路径过滤（git log -- path）：文件右键进入，chip 退出
const historyFilePath = ref<string | null>(null);
const remoteRaw = ref(""); // origin 的 URL（git remote get-url）
const remoteLink = ref(""); // 用户在设置里自定义的网页链接（留空自动推断）
// 历史加载遮罩（切仓库、换历史范围时盖住历史区）
const historyLoading = ref(false);

// 窗口标题显示未推送数
// core:window:allow-set-title 已由 src-tauri/capabilities/default.json 授权；
// setTitle 是跨 IPC 的 promise，异常仍需吞掉——标题属非关键路径，不该刷未捕获 rejection
function updateTitle() {
  const a = status.value?.ahead ?? 0;
  getCurrentWindow()
    .setTitle(a > 0 ? `(↑${a}) git-zen` : "git-zen")
    .catch(() => {});
}
watch(status, updateTitle);

// 视图范围 / 文件路径过滤变化 → 重载当前历史（两段式：遮罩先盖）
// 仓库身份快照：fetchLog 期间用户可能已切走（Ctrl+Tab / Ctrl+数字绕过 busy），
// 过期结果会覆盖新仓库的历史、还会提前把遮罩关掉——切走就整个丢弃。
watch([historyMode, historyFilePath], () => {
  const path = repo.value;
  if (!path) return;
  historyLoading.value = true;
  nextTick().then(async () => {
    try {
      const l = await fetchLog(0, path);
      if (repo.value !== path) return;
      commits.value = l;
      canLoadMore.value = l.length >= 300;
    } catch (e) {
      if (repo.value === path) showError(String(e));
    } finally {
      // 已切走时不碰遮罩：新仓库的 activate() 正在自己管它
      if (repo.value === path) historyLoading.value = false;
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
    if (name === "push") dropReviewCache();
  } catch (e) {
    // 失败也要重拉：git 操作失败经常已经改了状态 —— merge 冲突会把冲突文件留在索引里、
    // pull 失败但 fetch 已经动了远程跟踪分支。只在成功时刷新，界面就会停在旧快照上
    // （症状：合并冲突后看不见冲突横幅，得手动点刷新才出现）。
    // refresh() 自带错误处理与仓库身份守卫，不会把下面这条真正的失败原因盖掉。
    await refresh();
    showError(String(e));
    // 挂上重试入口（放在 showError 之后，showError 会把它清掉）
    retryFn.value = fn;
    retryName.value = name;
  } finally {
    busy.value = false;
    runningAction.value = "";
  }
}

// 头部 Pull/Push：成功给轻量 toast（失败仍走确认框）
function doPull() {
  run(async () => {
    await api.pull(repo.value);
    toast("已拉取");
  }, "pull");
}
function doPush() {
  run(async () => {
    await api.push(repo.value, status.value?.branch ?? "");
    toast("已推送");
  }, "push");
}

async function openRepo() {
  try {
    const dir = await open({ directory: true });
    if (!dir) return;
    // 与拖拽入口 openDropped 行为对齐：先校验是不是 Git 仓库，避免选错目录后落库成永久坏选项卡
    if (!(await api.checkRepo(dir))) {
      showError(`「${dir.split(/[\\/]/).pop() || dir}」不是 Git 仓库`);
      return;
    }
    addRepo(dir);
    switchRepo(dir);
  } catch (e) {
    showError(String(e));
  }
}

// ---- 打开仓库：先选 本地目录 / 从远程克隆；克隆完成后自动加入选项卡并打开 ----
const openModal = ref<"choose" | "remote" | null>(null);
const remoteUrlInput = ref("");
const cloneParent = ref("");
const cloneName = ref("");
const cloneNameTouched = ref(false);
const cloneBusy = ref(false);
const cloneErr = ref("");
const cloneErrDetail = ref("");

// 从 URL 推断默认目录名：取最后一段并去掉 .git 后缀（scp 风格 git@host:path 也覆盖）
function deriveRepoName(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[\\/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}
watch(remoteUrlInput, () => {
  if (!cloneNameTouched.value) cloneName.value = deriveRepoName(remoteUrlInput.value);
});

function openRemoteClone() {
  remoteUrlInput.value = "";
  cloneParent.value = "";
  cloneName.value = "";
  cloneNameTouched.value = false;
  cloneErr.value = "";
  cloneErrDetail.value = "";
  openModal.value = "remote";
}

async function pickCloneParent() {
  const dir = await open({ directory: true });
  if (dir) cloneParent.value = dir;
}

// 初始化新仓库：把选中的空目录 git init 后直接打开（新项目不必先去终端）
async function initRepo() {
  try {
    const dir = await open({ directory: true });
    if (!dir) return;
    await api.initRepo(dir);
    addRepo(dir);
    switchRepo(dir);
    toast("已初始化仓库");
  } catch (e) {
    showError(String(e));
  }
}

async function doClone() {
  const url = remoteUrlInput.value.trim();
  const parent = cloneParent.value;
  const name = cloneName.value.trim();
  if (!url || !parent || !name || cloneBusy.value) return;
  if (/[\\/:]/.test(name) || name === "." || name === "..") {
    cloneErr.value = "目录名不能包含路径分隔符或特殊字符";
    return;
  }
  cloneBusy.value = true;
  cloneErr.value = "";
  cloneErrDetail.value = "";
  const dest = `${parent.replace(/[\\/]+$/, "")}/${name}`;
  try {
    await api.clone(url, dest);
    openModal.value = null;
    addRepo(dest);
    switchRepo(dest);
  } catch (e) {
    const h = humanize(String(e));
    cloneErr.value = h.msg;
    cloneErrDetail.value = h.detail ?? "";
  } finally {
    cloneBusy.value = false;
  }
}

// ---- 仓库选项卡：持久化所有导入过的仓库，支持重命名/删除/拖动排序 ----
// group：可选分组名（Chrome 标签组风格），扁平存进 gz.repos，无该字段 = 未分组
interface RepoTab {
  path: string;
  name: string;
  group?: string;
}
// 读 localStorage 一律经 lib/safeJson：坏数据（手改坏 / 旧版本形状）不该让 setup 抛错白屏
const repos = ref<RepoTab[]>(readJsonArray<RepoTab>("gz.repos"));
watch(repos, (v) => localStorage.setItem("gz.repos", JSON.stringify(v)), { deep: true });

// 启动时确保当前仓库在列表里
if (repo.value && !repos.value.some((r) => r.path === repo.value)) {
  repos.value.push({ path: repo.value, name: repo.value.split(/[\\/]/).pop() || repo.value });
}

// ---- 选项卡分组（书签文件夹模式）----
// 分组以文件夹形式常驻标签栏，组内仓库只在点击文件夹弹出的下拉里出现；
// 分组名录 gz.groups，标签栏顺序（文件夹+未分组仓库）存 gz.barOrder，管理集中在标签栏右侧按钮的弹窗
const groupList = ref<string[]>(readJsonArray<string>("gz.groups"));
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
const barOrder = ref<BarEntry[]>(readJsonArray<BarEntry>("gz.barOrder"));
watch(barOrder, (v) => localStorage.setItem("gz.barOrder", JSON.stringify(v)), { deep: true });

// 逐项比较，代替两次 JSON.stringify 全量序列化——syncBar 挂在 deep watcher 上，
// 拖拽/重命名时会被反复触发，序列化整表在仓库多时是白白烧掉的
function sameBar(a: BarEntry[], b: BarEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const y = b[i];
    return e.kind === "group"
      ? y.kind === "group" && y.name === e.name
      : y.kind === "repo" && y.path === e.path;
  });
}

// 自愈同步：修剪已关闭仓库/已删除分组的条目，补上漏掉的新分组/新仓库（放末尾）。
// barOrder 与渲染列表 1:1，拖拽映射始终成立
function syncBar() {
  const groups = new Set(groupList.value);
  const byPath = new Map(repos.value.map((r) => [r.path, r]));
  // !!e：拖拽库在极端时序下可能往数组里写入脏值，这里兜底过滤防模板读 kind 炸
  const next = barOrder.value.filter(
    (e): e is BarEntry =>
      !!e &&
      (e.kind === "group" ? groups.has(e.name) : byPath.has(e.path) && !byPath.get(e.path)!.group),
  );
  for (const g of groupList.value) {
    if (!next.some((e) => e.kind === "group" && e.name === g)) next.push({ kind: "group", name: g });
  }
  for (const r of repos.value) {
    if (!r.group && !next.some((e) => e.kind === "repo" && e.path === r.path)) {
      next.push({ kind: "repo", path: r.path });
    }
  }
  if (!sameBar(next, barOrder.value)) barOrder.value = next;
}
watch([repos, groupList], syncBar, { deep: true });
localStorage.removeItem("gz.tabGroupsCollapsed"); // 旧版折叠状态键，废弃
syncBar();

// 管理弹窗里拖完分组后，把 barOrder 里的文件夹条目按同一顺序原地回填。
// 只改 groupList 是不够的：syncBar 会保留 barOrder 里已有的顺序，标签栏看不出任何变化。
// 未分组仓库 tab 的位置不动，只有文件夹跟着新顺序排
function syncGroupBarOrder(list: string[]) {
  const order = new Map(list.map((n, i) => [n, i]));
  const groups = barOrder.value
    .filter((e): e is BarGroup => e.kind === "group")
    .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  let k = 0;
  const next = barOrder.value.map((e) => (e.kind === "group" ? groups[k++]! : e));
  if (!sameBar(next, barOrder.value)) barOrder.value = next;
}

const repoByPath = computed(() => new Map(repos.value.map((r) => [r.path, r])));
// 顶部只显示「父目录 › 仓库名」：整条路径太长会把右侧工具挤走，完整路径留给 tooltip
const repoCrumb = computed(() => {
  const p = repo.value;
  if (!p) return null;
  const parts = p.split(/[\\/]/).filter(Boolean);
  return {
    parent: parts.length > 1 ? parts[parts.length - 2] : "",
    name: repoByPath.value.get(p)?.name ?? parts[parts.length - 1] ?? p,
  };
});
const groupCount = (g: string) => repos.value.filter((r) => r.group === g).length;
const isGroupActive = (g: string) => repos.value.some((r) => r.group === g && r.path === repo.value);

// ---- 拖拽归组：仓库 tab 拖到文件夹上松手 = 收进该分组 ----
// 拖动期间用 elementFromPoint 命中检测文件夹并高亮；落在文件夹上时 Sortable 做的
// 中间排序会被 syncBar 修剪掉（仓库已带 group），无需回滚
const dragOverGroup = ref("");
const dragPointer = { x: 0, y: 0 };
function folderUnderPointer(x: number, y: number): string {
  const el = document.elementFromPoint(x, y);
  const folder = el?.closest("[data-group-folder]") as HTMLElement | null;
  return folder?.dataset.groupFolderName ?? "";
}
// ---- 手写「按住拖到某处松手」的指针拖拽（分组下拉成员 / 管理弹窗成员共用）----
// 不用 HTML5 DnD（WebView2 里不可靠），也不用 Sortable（这两处没有排序语义）。
// 标签栏那边的落点判定用元素矩形而不是 elementFromPoint：下拉浮层底下压着一层
// fixed inset-0 的背板（职责是接住「点外面关闭」），elementFromPoint 只会拿到背板。
const itemDrag = reactive({
  on: false,
  active: false,
  path: "",
  name: "",
  from: "",
  x: 0,
  y: 0,
  target: null as string | null,
});
// 松手后浏览器还会补一个 click：拖完不该顺手把仓库切走
let dragJustEnded = false;
function itemDragged() {
  return dragJustEnded;
}
function startItemDrag(
  e: MouseEvent,
  path: string,
  name: string,
  hit: (x: number, y: number) => string | null,
  commit: (path: string, target: string | null) => void,
) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const s = itemDrag;
  s.on = true;
  s.active = false;
  s.path = path;
  s.name = name;
  s.x = x0;
  s.y = y0;
  s.target = null;
  s.from = repoByPath.value.get(path)?.group ?? "";
  const onMove = (ev: MouseEvent) => {
    // 先要求真的移动了才算拖拽，否则手一抖「点击打开」就变成「拖拽」
    if (!s.active) {
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;
      s.active = true;
    }
    // 拖拽期间别顺手把行里的文字选中
    ev.preventDefault();
    s.x = ev.clientX;
    s.y = ev.clientY;
    s.target = hit(ev.clientX, ev.clientY);
  };
  const onUp = (ev: MouseEvent) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    s.on = false;
    if (!s.active) return;
    dragJustEnded = true;
    setTimeout(() => (dragJustEnded = false), 0);
    commit(path, hit(ev.clientX, ev.clientY));
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
// 标签栏上的落点：分组名 / ""（落在标签栏空白处 = 移出分组）/ null（没落在标签栏）
function folderAtPoint(x: number, y: number): string | null {
  const bar = document.querySelector("[data-tab-bar]");
  const r = bar?.getBoundingClientRect();
  if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  for (const el of document.querySelectorAll<HTMLElement>("[data-group-folder-name]")) {
    const b = el.getBoundingClientRect();
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
      return el.dataset.groupFolderName ?? "";
    }
  }
  return "";
}
// 管理弹窗里的落点：弹窗内部没有竞争的背板，直接命中检测即可
function mgrGroupAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest<HTMLElement>("[data-mgr-group]")?.dataset.mgrGroup ?? null;
}
// 统一的落点提交：null = 没落在任何能放的地方，什么都不做
function dropItem(path: string, target: string | null) {
  if (target === null) return;
  const r = repoByPath.value.get(path);
  if (!r) return;
  const to = target || null;
  if ((r.group ?? null) === to) return;
  if (to) addMember(to, path);
  else removeMember(path);
}
function onMemberClick(path: string) {
  if (itemDragged()) return;
  openFromFolder(path);
}
function onBarDragMove(e: MouseEvent) {
  dragPointer.x = e.clientX;
  dragPointer.y = e.clientY;
  dragOverGroup.value = folderUnderPointer(e.clientX, e.clientY);
}
// 仓库 tab 不允许排进文件夹的位置：悬停文件夹时 Sortable 不做任何腾位/换位，
// 松手归组完全交给 elementFromPoint 命中检测（否则 DOM 与 model 两次反向同步会打架）
function onBarMove(evt: { dragged?: HTMLElement; related?: HTMLElement }): boolean | void {
  const draggedIsRepo = !!evt.dragged?.dataset.repoPath;
  const relatedIsFolder = !!evt.related?.hasAttribute?.("data-group-folder");
  if (draggedIsRepo && relatedIsFolder) return false;
}
function onBarStart() {
  window.addEventListener("mousemove", onBarDragMove);
}
function onBarEnd(e: { item?: HTMLElement; originalEvent?: MouseEvent }) {
  window.removeEventListener("mousemove", onBarDragMove);
  dragOverGroup.value = "";
  const path = e.item?.dataset.repoPath;
  if (!path) return; // 拖的是文件夹（无 repo-path 标记）→ 纯排序
  const ev = e.originalEvent;
  const g = folderUnderPointer(ev?.clientX ?? dragPointer.x, ev?.clientY ?? dragPointer.y);
  if (g) {
    // 等 Sortable 的落子流程（含内部 model 同步与 DOM 复位）走完再归组，避免并发写坏 barOrder
    nextTick(() => addMember(g, path));
  }
}

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
  // 归组是「东西去哪儿了」的动作：标签栏上的仓库会立刻消失，得说一句它去了哪，
  // 否则看起来就像点坏了。toast 放在这里而不是各调用点，几条入口才不会漏
  if (r) toast(`已把「${r.name}」收进「${group}」`);
}
// 移出分组：仓库本身不会丢，只是回到标签栏——同一个面板下方的「添加仓库」列表
// 一次点击就能加回来，属于完全可逆操作，故意不加确认框（危险操作到处确认会让确认失去意义）
function removeMember(path: string) {
  const r = repoByPath.value.get(path);
  if (r) r.group = undefined;
  if (r) toast(`已把「${r.name}」移出分组`);
}

// 分组命名弹窗（新建 / 重命名共用）
const groupModal = ref<{ mode: "create" } | { mode: "rename"; from: string } | null>(null);
const groupNameDraft = ref("");
const groupModalErr = ref("");
// 新建时顺带归组的仓库：默认一个不选，免得「建了个空组，东西怎么全进去了」
const groupPicks = ref<string[]>([]);
function toggleGroupPick(path: string) {
  groupPicks.value = groupPicks.value.includes(path)
    ? groupPicks.value.filter((p) => p !== path)
    : [...groupPicks.value, path];
}
function openGroupCreate() {
  groupNameDraft.value = "";
  groupModalErr.value = "";
  groupPicks.value = [];
  groupModal.value = { mode: "create" };
}
function openGroupRename(from: string) {
  groupNameDraft.value = from;
  groupModalErr.value = "";
  groupPicks.value = [];
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
  const picks = [...groupPicks.value];
  groupModal.value = null;
  groupPicks.value = [];
  // 建组后把勾选的仓库逐个搬进来：addMember 自己会 toast，也顺带处理「原先在别的组」
  if (m.mode === "create") for (const p of picks) addMember(name, p);
}

// 分组管理弹窗 + 文件夹下拉
const showGroupMgr = ref(false);
const mgrExpanded = ref("");
const folderDd = ref<{ x: number; y: number; group: string } | null>(null);
const folderDdEl = ref<HTMLElement | null>(null);
// 管理弹窗里的仓库搜索词：过滤「添加仓库」候选（仓库名或路径，大小写不敏感）
const groupSearch = ref("");
function matchRepoSearch(r: RepoTab): boolean {
  const q = groupSearch.value.trim().toLowerCase();
  if (!q) return true;
  return r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q);
}
// 某个分组「添加仓库」列表：排除已在组内 + 没过搜索词
function mgrCandidates(g: string): RepoTab[] {
  return repos.value.filter((r) => r.group !== g && matchRepoSearch(r));
}
// 关闭弹窗（背板 / X / Esc 都走 showGroupMgr = false）时清空搜索词，下次打开是干净的
watch(showGroupMgr, (open) => {
  if (!open) groupSearch.value = "";
});
// 文件夹右键菜单：分组的新建/删除原先只能进管理弹窗做，而右键是这类「对象上的操作」
// 最顺手的入口，也补齐了「文件夹能点开却什么都不带」的空缺
const folderCtx = ref<{ x: number; y: number; group: string } | null>(null);
function openFolderCtx(e: MouseEvent, g: string) {
  folderDd.value = null;
  folderCtx.value = { x: e.clientX, y: e.clientY, group: g };
}
// 文件夹高亮：Sortable 拖仓库进来，或从下拉里拖成员出去悬停到某个文件夹时。
// 已经在这个分组里的不高亮 —— 落点没有变化，高亮会骗人
function folderHighlighted(name: string) {
  if (itemDrag.on && itemDrag.active && itemDrag.target === name) return itemDrag.from !== name;
  return dragOverGroup.value === name;
}
function mgrHighlighted(g: string) {
  if (!itemDrag.on || !itemDrag.active || itemDrag.target !== g) return false;
  return itemDrag.from !== g;
}
// 拖完松手时浏览器会在共同祖先上补一个 click：落在背板上会顺手把下拉/弹窗关掉。
// 这里挡一下，让用户能连着拖走好几个成员
function closeFolderDd() {
  if (itemDragged()) return;
  folderDd.value = null;
}
function closeGroupMgr() {
  if (itemDragged()) return;
  showGroupMgr.value = false;
}
function openGroupMgr() {
  folderDd.value = null;
  mgrExpanded.value = "";
  showGroupMgr.value = true;
}
function toggleFolder(g: string, ev: MouseEvent | KeyboardEvent) {
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
  // 分组一多，下拉里哪一行是当前仓库就不好找了：打开后把它滚进视野
  nextTick(() => {
    folderDdEl.value?.querySelector('[data-folder-active="1"]')?.scrollIntoView({ block: "nearest" });
  });
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
    okText: "删除分组",
    body: `确认删除分组「${g}」？组内 ${groupCount(g)} 个仓库将回到选项卡栏（不会关闭任何仓库）。`,
    ok: async () => {
      deleteGroup(g);
      if (mgrExpanded.value === g) mgrExpanded.value = "";
      toast(`已删除分组「${g}」，组内仓库回到选项卡栏`);
    },
  });
}

function addRepo(path: string) {
  if (!repos.value.some((r) => r.path === path)) {
    repos.value.push({ path, name: path.split(/[\\/]/).pop() || path });
  }
}

// ---- 快速切换器（Ctrl+P 切仓库 / Ctrl+B 切分支）----
// 实现见 src/composables/useSwitcher.ts；mruPaths 的写入点仍在下面（切仓库、关选项卡、启动播种）
const {
  mruPaths,
  showSwitcher,
  switcherQuery,
  switcherIndex,
  switcherResults,
  openSwitcher,
  pickSwitcher,
  onSwitcherKeydown,
  showBranchSwitcher,
  bsQuery,
  bsIndex,
  bsResults,
  openBranchSwitcher,
  pickBranch,
  onBranchSwitcherKeydown,
} = useSwitcher({
  repos,
  branchList,
  hasRepo: () => !!repo.value,
  onPickRepo: (path) => switchRepo(path),
  onPickBranch: (b) => switchBranch(b),
});

// 切仓库是「导航」，不是「改动」，不该被正在跑的操作挡住。
// 之前这里是 `if (path === repo.value || busy.value) return;` —— 而 Ctrl+Tab / Ctrl+数字
// 一直走 activate() 直接切、根本不看 busy，于是鼠标点选项卡在操作期间毫无反应
// （而且没有任何提示，看起来就像「点了没生效」）。
// 两者现在对齐：都允许切。安全性由各处已有的仓库身份守卫保证 ——
// refresh / fetchLog / loadMorePage / activate 都做了 path 快照比对，
// executeFlow 也会在发现仓库变了时中止工作流。
function switchRepo(path: string) {
  if (path === repo.value) return;
  activate(path);
}

// 关闭选项卡会把仓库从 gz.repos（持久化列表）里摘掉，重开必须再走一次系统目录选择框——
// 恢复成本远高于一次确认。按项目既有约定（「丢失一条已保存记录」类操作都要确认，
// 例如删除分支、删除工作流），这里也走确认框；磁盘上的仓库本身不受影响。
function askCloseTab(path: string) {
  const r = repoByPath.value.get(path);
  if (!r) return;
  openConfirm({
    title: "关闭仓库选项卡",
    okText: "关闭选项卡",
    body: `将从选项卡列表里移除「${r.name}」，重新打开需要再选一次目录。磁盘上的仓库不受影响。`,
    ok: async () => doCloseTab(path),
  });
}

function doCloseTab(path: string) {
  const i = repos.value.findIndex((r) => r.path === path);
  if (i === -1) return;
  const name = repos.value[i].name;
  const wasActive = repos.value[i].path === repo.value;
  cacheDrop(path); // 关闭的选项卡不占 LRU 名额
  mruPaths.value = mruPaths.value.filter((p) => p !== path);
  repos.value.splice(i, 1); // syncBar 自动修剪 barOrder 条目
  toast(`已关闭「${name}」（可用「打开」重新加入）`);
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
      // 关掉最后一个仓库：把 per-repo 状态全部清干净（对齐 activate() 的重置清单）。
      // 只清 status/commits/branchList 会留下上一仓库的标签、远程链接、文件历史弹窗和
      // 「还能翻页」的标志位，空态下这些脏数据仍会渲染出来。
      status.value = null;
      commits.value = [];
      branchList.value = [];
      tags.value = [];
      canLoadMore.value = false;
      fileHistoryModal.value = null;
      historyFilePath.value = null;
      remoteRaw.value = "";
      remoteLink.value = "";
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
// 关闭其他可见选项卡；分组内仓库是「归档」状态，不受影响。
// 一次可能关掉多个，且它们都会从 gz.repos 里消失，所以先确认（文案里给数量）
function askCloseOthers(path: string) {
  const keep = repoByPath.value.get(path);
  if (!keep) return;
  tabCtx.value = null;
  const n = repos.value.filter((r) => !r.group && r.path !== path).length;
  if (!n) {
    toast("没有其他选项卡可关闭");
    return;
  }
  openConfirm({
    title: "关闭其他选项卡",
    okText: "关闭其他选项卡",
    body: `将关闭 ${n} 个仓库选项卡（收在分组里的仓库不受影响）。重新打开需要再选一次目录。`,
    ok: async () => doCloseOthers(path),
  });
}
function doCloseOthers(path: string) {
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
function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => showError("复制失败"));
}
function copyHash(hash: string) {
  copyText(hash);
}
function onCommitMenu(p: { x: number; y: number; c: LogEntry }) {
  commitCtx.value = p;
}

// Review / Release Notes 的生成、缓存与保存都抽到 composables/useAiPanel.ts
const {
  reviewBusy,
  reviewOpen,
  reviewText,
  reviewErr,
  reviewSaved,
  startReview,
  saveReviewToFile,
  notesOpen,
  notesBusy,
  notesText,
  notesErr,
  notesSaved,
  notesFrom,
  notesLatest,
  notesOptions,
  openReleaseNotes,
  genReleaseNotes,
  saveNotesToFile,
  dropReviewCache,
} = useAiPanel({
  repo,
  status,
  // tags 声明在下方「标签」一节，用取值函数传，避免初始化顺序依赖
  tags: () => tags.value,
  showSettingsTab,
  showSettings,
  showError,
});


// ---- 分支树：本地 / 按远程前缀分组，可折叠 ----
// "gz:tags"（侧栏标签组）默认收起，键带前缀避免与分支树节点撞名
const collapsedGroups = ref(new Set<string>(["gz:tags"]));
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
// 远程组内去掉远程前缀再建树，避免顶层重复出现 origin。
// 拷贝附 originName 保留完整引用名（origin/release/dev）——剥了前缀的 name 只是展示名，
// 合并/删除要作用于完整跟踪分支；曾因在已剥名的 name 上再剥一次前缀，
// 双击 release/dev 被 checkout 成 pathspec 'dev'（BUGS.md 远程分支切换）
function fullName(b: Branch): string {
  return (b as Branch & { originName?: string }).originName ?? b.name;
}
function remoteNodes(prefix: string): BNode[] {
  const list = (remoteGroups.value.find(([p]) => p === prefix)?.[1] ?? []).map((b) => ({
    ...b,
    name: b.name.slice(prefix.length + 1),
    originName: b.name,
  }));
  return buildNodes(list, `remote:${prefix}:`);
}
// 展开的远程组 → 树节点表：一次算好。原来模板在 v-for 里直接调 remoteNodes(prefix)，
// 每次重渲染都把每个展开的远程组全量重建一遍树。
const remoteNodeMap = computed(() => {
  const map = new Map<string, BNode[]>();
  for (const [prefix] of remoteGroups.value) map.set(prefix, remoteNodes(prefix));
  return map;
});

// ---- 标签：侧栏标签组（推送/删除）+ 新建弹窗；历史行右键可对任意提交建 tag ----
const tags = ref<TagEntry[]>([]);
const tagsFiltered = computed(() => {
  const q = branchFilter.value.trim().toLowerCase();
  if (!q) return tags.value;
  return tags.value.filter((t) => t.name.toLowerCase().includes(q));
});
const showCreateTag = ref(false);
const newTagName = ref("");
const newTagMsg = ref("");
const tagTarget = ref<string | null>(null); // null = 打在当前 HEAD

function openCreateTag(target?: string) {
  if (!repo.value) return;
  newTagName.value = "";
  newTagMsg.value = "";
  tagTarget.value = target ?? null;
  showCreateTag.value = true;
}
function confirmCreateTag() {
  const name = newTagName.value.trim();
  if (!name || busy.value) return;
  const t = tagTarget.value;
  showCreateTag.value = false;
  run(() => api.tagCreate(repo.value, name, newTagMsg.value || undefined, t || undefined));
}
function askDeleteTag(name: string) {
  openConfirm({
    title: "删除标签",
    okText: "删除标签",
    body: `确认删除标签 ${name}？若它已推送过远程，远程上的同名标签不会被删除。`,
    ok: () => api.tagDelete(repo.value, name),
  });
}
function pushTag(name: string) {
  if (busy.value || !repo.value) return;
  run(() => api.tagPush(repo.value, name), "tagPush");
}

// ---- M11 交互手感：右键菜单 / 侧栏折叠 / 分支切换器 / 拖拽打开 ----
// 行主操作（单击切换）不进菜单；危险操作换入口不换确认

const branchMenu = ref<{ x: number; y: number; b: Branch } | null>(null);
function branchMenuItems(b: Branch): MenuItem[] {
  if (b.remote) {
    const full = fullName(b);
    return [
      { label: "复制分支名", fn: () => copyText(full) },
      { separator: true, label: "" },
      { label: "删除远程分支", danger: true, fn: () => askDelete(b) },
    ];
  }
  const cur = b.current;
  return [
    { label: "复制分支名", fn: () => copyText(b.name) },
    { label: "重命名…", disabled: cur, fn: () => (branchRename.value = { b, draft: b.name }) },
    { separator: true, label: "" },
    { label: "合并到当前分支", disabled: cur, fn: () => askMerge(b) },
    { label: "把当前分支合并到该分支", disabled: cur, fn: () => askMergeInto(b) },
    { separator: true, label: "" },
    { label: "删除（未合并会拒绝）", danger: true, fn: () => askDelete(b) },
    {
      label: "强制删除（-D，未合并提交将丢失）",
      danger: true,
      fn: () =>
        openConfirm({
          title: "强制删除分支",
          okText: "强制删除",
          body: `确认强制删除本地分支 ${b.name}？未合并的提交将丢失，界面不可撤销。`,
          ok: () => api.branchDelete(repo.value, b.name, true),
        }),
    },
  ];
}
// 重命名：菜单触发 → 弹窗输入（替代原行内编辑）
const branchRename = ref<{ b: Branch; draft: string } | null>(null);
function confirmBranchRename() {
  const r = branchRename.value;
  const name = r?.draft.trim();
  branchRename.value = null;
  if (!r || !name || name === r.b.name) return;
  run(() => api.branchRename(repo.value, r.b.name, name));
}

const tagMenu = ref<{ x: number; y: number; name: string } | null>(null);
function tagMenuItems(name: string): MenuItem[] {
  return [
    { label: "复制标签名", fn: () => copyText(name) },
    { label: "推送到 origin", fn: () => pushTag(name) },
    { separator: true, label: "" },
    { label: "删除标签", danger: true, fn: () => askDeleteTag(name) },
  ];
}
// 标签组头右键：原 hover 图标（AI Release Notes / 新建）迁入菜单
const tagHeaderMenu = ref<{ x: number; y: number } | null>(null);

// ↑N 徽标下拉：徽标回归「指示 + 汇总入口」，破坏动作藏进菜单（仍有确认框兜底）
const aheadMenu = ref<{ x: number; y: number } | null>(null);
function aheadMenuItems(): MenuItem[] {
  return [
    { label: `AI Review ${status.value?.ahead ?? 0} 个未推送提交`, fn: () => startReview() },
    // amend / 撤销提交后本地与远程分叉，普通 push 必被拒（non-fast-forward）——安全强推出口
    { label: "强制推送（--force-with-lease）", fn: askForcePush },
    { label: "放弃这些提交（重置回远程）", danger: true, fn: askDiscardUnpushed },
  ];
}

// 侧栏折叠：双击把手 / Ctrl+Shift+L|R，状态持久化
const leftFold = ref(localStorage.getItem("gz.fold.left") === "1");
const rightFold = ref(localStorage.getItem("gz.fold.right") === "1");
function toggleFold(side: "l" | "r") {
  if (side === "l") {
    leftFold.value = !leftFold.value;
    localStorage.setItem("gz.fold.left", leftFold.value ? "1" : "0");
  } else {
    rightFold.value = !rightFold.value;
    localStorage.setItem("gz.fold.right", rightFold.value ? "1" : "0");
  }
}

// 拖拽仓库文件夹进窗口 = 打开（非仓库目录给出明确提示）
const dragOver = ref(false);
async function openDropped(path: string) {
  try {
    if (!(await api.checkRepo(path))) {
      showError(`「${path.split(/[\\/]/).pop() || path}」不是 Git 仓库`);
      return;
    }
    addRepo(path);
    switchRepo(path);
  } catch (e) {
    showError(String(e));
  }
}
let unDrag: (() => void) | null = null;
onMounted(async () => {
  try {
    unDrag = await getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        dragOver.value = false;
        const p = e.payload.paths[0];
        if (p) openDropped(p);
      } else {
        dragOver.value = e.payload.type !== "leave";
      }
    });
  } catch {
    /* 拖拽事件不可用时静默降级，不影响其它功能 */
  }
});
onUnmounted(() => unDrag?.());

// ---- M12 工作流：多步 git 操作一键执行（配置存 workflowStore，管理在设置页）----

// 工具栏入口：下拉列出全部工作流一键执行
const flowMenu = ref<{ x: number; y: number } | null>(null);
function flowMenuItems(): MenuItem[] {
  return [
    ...workflows.map((w) => ({ label: w.name, fn: () => runFlow(w) })),
    { separator: true, label: "" },
    { label: "管理工作流…", fn: () => { showSettingsTab.value = "workflow"; showSettings.value = true; } },
  ];
}

// 钉在工具栏上的工作流（最多 3 个，在设置页勾）：常用流程不必每次展开下拉
const pinnedFlows = computed(() => workflows.filter((w) => w.pinned).slice(0, 3));

// ---- 仓库会话：刷新 / 历史分页 / 后台 fetch / 切仓库 ----
// 实现见 src/composables/useRepoSession.ts
// 接线位置有讲究：注入项（repo / status / tags / filter / historyLoading…）都在上方，
// 而紧接着的 useWorkflowRun 需要 refresh —— 会话得建在这两者之间。
// setup 期间只是接线，真正的调用都在各个 handler 与 onMounted 之后。
const {
  refreshing,
  doRefresh,
  fetchLog,
  refresh,
  canLoadMore,
  loadingMore,
  loadMorePage,
  fetchOnce,
  activate,
} = useRepoSession({
  repo,
  status,
  commits,
  branchList,
  tags,
  busy,
  historyMode,
  historyFilePath,
  fileHistoryModal,
  filter,
  historyLoading,
  mruPaths,
  remoteRaw,
  remoteLink,
  cacheGet,
  cachePeek,
  cachePut,
  showError,
});

// 确认弹窗、进度弹窗、逐步 execStep 与失败重试都抽到 composables/useWorkflowRun.ts
const {
  wfConfirm,
  wfInputs,
  wfPrefixes,
  wfRun,
  wfRunOpen,
  runFlow,
  flowInputsReady,
  slotPlaceholder,
  confirmFlow,
  closeWfRun,
  retryFlow,
} = useWorkflowRun({ repo, status, busy, runningAction, refresh });

// ---- 创建分支：工具栏按钮 → 弹窗（可选前缀，基于当前分支，创建即切换）----
const prefixes = computed(() => parseBranchPrefixes(settings.branchPrefix));
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

// ---- 切换分支：单击触发（对齐主流客户端），但工作区有未提交改动时先确认——
// 兼容时 git 会把改动带到目标分支，用户常意识不到自己带着脏改动在写代码
async function switchBranch(b: Branch) {
  if (b.current || busy.value) return;
  // doSwitch 只做乐观更新 + checkout，刷新交给外层 run（确认路径 run(ok) 已包裹，避免嵌套 run）
  const doSwitch = async () => {
    // 乐观更新：先让界面切过去，不用等 git 返回。但 checkout 失败（工作区脏且冲突、
    // 分支被锁、目标分支已不存在…）必须回滚——否则界面停在一个从没切过去的分支名上，
    // run() 只弹错误框，用户却以为自己已经在目标分支了。
    const prevBranch = status.value?.branch ?? "";
    const prevCurrent = branchList.value.map((x) => x.current);
    if (status.value && !b.remote) status.value.branch = b.name;
    branchList.value.forEach((x) => (x.current = x.name === b.name));
    historyLoading.value = true;
    try {
      // 远程叶子 name 已是剥掉远程前缀的 DWIM 名（release/dev），checkout 自动建同名本地跟踪分支；
      // 本地叶子 name 即分支名。不能用完整引用名（origin/xxx）checkout，那会进 detached HEAD
      await api.checkout(repo.value, b.name);
    } catch (e) {
      if (status.value) status.value.branch = prevBranch;
      branchList.value.forEach((x, i) => (x.current = prevCurrent[i] ?? false));
      throw e; // 交给 run() 弹错误框
    } finally {
      historyLoading.value = false;
    }
  };
  const dirty = status.value?.files.length ?? 0;
  if (dirty) {
    openConfirm({
      title: "切换分支",
      body: `工作区有 ${dirty} 个未提交的文件改动，切换到 ${b.name} 会尝试把它们带过去（与目标分支冲突时 checkout 会被 git 拒绝）。继续切换？`,
      ok: doSwitch,
    });
    return;
  }
  await run(doSwitch);
}

// ---- 危险操作确认框（删分支/合并），支持强制删除勾选项 ----
interface ConfirmState {
  title: string;
  body: string;
  checkbox?: string;
  // 按钮上直接写后果（「删除分支」而不是「确认」）：用户无法从「确认」预判会发生什么，
  // 而错误框里同一个「确认」意思是「我知道了」——同一个词两种相反语义最容易点错
  okText?: string;
  ok: (checked: boolean) => Promise<unknown>;
}
const confirmState = ref<ConfirmState | null>(null);
const confirmChecked = ref(false);

function openConfirm(s: ConfirmState) {
  confirmChecked.value = false;
  confirmState.value = s;
  // 危险操作的安全默认：焦点落「取消」，Enter 天然触发取消而非确认
  nextTick(() => confirmCancelBtn.value?.$el.focus());
}
const confirmCancelBtn = ref<{ $el: HTMLButtonElement } | null>(null);

function askDelete(b: Branch) {
  if (b.remote) {
    // 远程叶子用完整引用名拆 远程名/分支名（origin/release/dev → origin + release/dev）
    const full = fullName(b);
    const remote = full.split("/")[0];
    const short = full.replace(/^[^/]+\//, "");
    openConfirm({
      title: "删除远程分支",
      okText: "删除远程分支",
      body: `确认删除远程分支 ${full}？该操作直接作用于远程仓库。`,
      ok: () => api.pushDelete(repo.value, remote, short),
    });
    return;
  }
  openConfirm({
    title: "删除分支",
    okText: "删除分支",
    body: `确认删除本地分支 ${b.name}？`,
    checkbox: "强制删除（-D，未合并的提交将丢失）",
    ok: (force) => api.branchDelete(repo.value, b.name, force),
  });
}
function askMerge(b: Branch) {
  // 合并远程分支 = 合并其完整跟踪引用（origin/release/dev）；本地分支直接用名字
  const target = b.remote ? fullName(b) : b.name;
  openConfirm({
    title: "合并分支",
    body: `将 ${target} 合并到当前分支 ${status.value?.branch ?? ""}？`,
    ok: async () => {
      try {
        await api.merge(repo.value, target);
        toast(`已合并 ${target}`);
      } catch (e) {
        // 冲突不是「操作失败」：git 有意停在中途等用户解决，这是合并的正常一步，
        // 不该弹红色错误框。必须先把状态拉回来再判断 —— 冲突文件只在重拉之后才看得见，
        // 这也是「合并冲突后界面没反应」的根因。
        await refresh();
        const n = (status.value?.files ?? []).filter(isUnmerged).length;
        if (!n) throw e; // 没有冲突文件 = 真失败（分支名不存在、本地改动会被覆盖…），照旧报错
        toast(`合并有 ${n} 个文件冲突，解决后暂存并提交即完成合并`);
      }
    },
  });
}
// 放弃未推送的提交：硬重置回上游。工作区未提交改动会被一并丢弃——确认框必须明示（含数量），
// reflog 提示给后悔药；成功后清掉该分支的 AI Review 缓存（未推送的提交已变）
function askDiscardUnpushed() {
  const ahead = status.value?.ahead ?? 0;
  if (!ahead) return;
  const upstream =
    branchList.value.find((x) => x.current && !x.remote)?.upstream || "上游分支";
  const dirty = status.value?.files.length ?? 0;
  openConfirm({
    title: "放弃未推送的提交",
    okText: "丢弃这些提交",
    body:
      `将丢弃这 ${ahead} 个未推送的提交，把 ${status.value?.branch} 重置回 ${upstream}。` +
      (dirty ? `工作区 ${dirty} 个未提交的文件改动也会一并丢弃。` : "") +
      "此操作无法在界面撤销（必要时可在终端用 git reflog 找回）。",
    ok: async () => {
      await api.resetUnpushed(repo.value);
      dropReviewCache();
    },
  });
}

// 把当前分支合并进目标分支：切过去合并后就留在目标分支（用户要求不切回）
function askMergeInto(b: Branch) {
  const target = b.name;
  const cur = status.value?.branch ?? "";
  if (!cur || cur === target) return;
  // 绑定仓库：确认框里的 checkout 与 merge 之间用户仍可能切走选项卡（Ctrl+Tab 一直能切），
  // 现读 repo.value 会变成「在 A 里 checkout、在 B 里 merge」
  const path = repo.value;
  openConfirm({
    title: "合并当前分支到目标分支",
    body: `将把当前分支 ${cur} 合并到 ${target}，完成后停留在 ${target}。若冲突请在解决后重新提交。`,
    ok: async () => {
      await api.checkout(path, target);
      await api.merge(path, cur);
    },
  });
}

// 强制推送：--force-with-lease 只在远程分支仍停在本地已知位置时才覆盖，
// 比 --force 安全——他人推过新提交时本次会失败，而不是静默覆盖别人的工作
function askForcePush() {
  const upstream = branchList.value.find((x) => x.current && !x.remote)?.upstream;
  if (!upstream) {
    showError("当前分支没有上游分支，无法强制推送");
    return;
  }
  openConfirm({
    title: "强制推送 (--force-with-lease)",
    okText: "强制推送",
    body:
      `将用本地 ${status.value?.branch ?? "当前分支"} 覆盖远程 ${upstream}，改写远程提交历史。` +
      "若期间他人推送过新提交，本次推送会失败而不会覆盖他们的工作。",
    ok: async () => {
      await api.pushForce(repo.value, status.value?.branch ?? "");
    },
  });
}

// 放弃合并：冲突态下唯一的退出通道（git 会在没有合并进行中时拒绝）
function askAbortMerge() {
  openConfirm({
    title: "放弃合并 (merge --abort)",
    okText: "放弃合并",
    body: "将中止本次合并，工作区与 HEAD 回到合并开始前的状态。合并过程中已手动解决的冲突内容会一并丢弃。",
    ok: () => api.mergeAbort(repo.value),
  });
}

// 丢弃暂存区的全部改动：暂存内容与工作区一起还原到 HEAD。
// 新增文件（HEAD 里没有）默认只取消暂存、文件留在磁盘上 —— 它们往往是从未提交过的工作成果，
// 删掉不可恢复，所以"连文件一起删"做成显式勾选，而不是默认行为。
function askDiscardStaged(p: {
  paths: string[];
  count: number;
  newCount: number;
  conflictCount: number;
}) {
  if (!p.paths.length) return;
  const parts = [`将丢弃暂存区 ${p.count} 个文件的改动，暂存内容与工作区一起还原到上次提交。`];
  if (p.newCount) {
    parts.push(
      `其中 ${p.newCount} 个是本次新加的文件（上次提交里没有）：默认只取消暂存、文件保留在磁盘上变成未跟踪。`
    );
  }
  if (p.conflictCount) {
    parts.push(`另有 ${p.conflictCount} 个合并冲突文件会按当前分支（HEAD）的版本解决。`);
  }
  openConfirm({
    title: "丢弃暂存区的全部改动",
    okText: "丢弃改动",
    body: parts.join(""),
    // 没有新增文件时不给这个勾选：一个没有作用的开关只会让人犹豫
    checkbox: p.newCount ? `同时删除这 ${p.newCount} 个新文件（不可恢复）` : undefined,
    ok: async (deleteNew) => {
      await api.discardStaged(repo.value, p.paths, deleteNew);
      const kept = p.newCount && !deleteNew ? `，${p.newCount} 个新增文件保留在磁盘上` : "";
      toast(`已丢弃 ${p.count} 个文件的暂存改动${kept}`);
    },
  });
}

// ---- amend / 撤销上次提交（都在改写历史，确认框负责安全提示）----
// "已推送"判定：分支有上游且 ahead==0，即本地与远程一致，最近一次提交就在远程
function pushedHead(): boolean {
  const upstream = branchList.value.find((x) => x.current && !x.remote)?.upstream;
  return !!upstream && (status.value?.ahead ?? 0) === 0;
}
function askAmend(p: { message: string; stagedCount: number; onDone: () => void }) {
  openConfirm({
    title: "追加到上次提交 (amend)",
    body:
      (p.stagedCount
        ? `把暂存区的 ${p.stagedCount} 个文件改动并入上次提交`
        : "不并入新的文件改动，仅重写上次提交") +
      (p.message ? "，提交信息更新为输入框内容" : "，保留原提交信息") +
      "。" +
      (pushedHead()
        ? "注意：上次提交已推送到远程，amend 会改写历史，之后需强制推送（点顶部 ↑N 徽标里的「强制推送」）才能更新远程分支。"
        : ""),
    ok: async () => {
      await api.amend(repo.value, p.message || undefined);
      p.onDone();
    },
  });
}
function askUndoCommit() {
  openConfirm({
    title: "撤销上次提交",
    body:
      "将撤销最近一次提交，其全部改动回到暂存区，工作区文件保持不变。" +
      (pushedHead()
        ? "注意：该提交已推送到远程，撤销后本地会落后于远程，重新推送需强制推送（点顶部 ↑N 徽标里的「强制推送」）。"
        : ""),
    ok: () => api.undoCommit(repo.value),
  });
}
// 删除 stash 记录（不恢复内容，不可找回）
function askStashDrop(index: number, subject: string) {
  openConfirm({
    title: "删除 Stash 记录",
    okText: "删除记录",
    body: `确认删除「${subject}」？这条记录收纳的改动将无法恢复。`,
    ok: () => api.stashDrop(repo.value, index),
  });
}

// ---- 全局快捷键 ----
// Ctrl+Tab / Ctrl+Shift+Tab：下一个/上一个仓库选项卡
// Ctrl+1..9：跳到第 N 个选项卡
// Ctrl+P：仓库切换器；Ctrl+B：分支切换器
// Ctrl+Shift+L / R：折叠/展开左右侧栏；F5：刷新；Esc：按层级关闭最上层浮层
// 浮层优先级表（顺序在 src/lib/overlays.ts 的 overlayOrder 里，只有那一个地方定义）。
// 这里的类型是 Record<OverlayName, OverlayLayer>：往 overlayOrder 里加一个新浮层后，
// 如果忘了在这里补对应的层，vue-tsc 会直接报缺键 —— 不再靠「记得改 if 链」。
const overlayLayers: Record<OverlayName, OverlayLayer> = {
  folderDd: { open: () => !!folderDd.value, close: () => (folderDd.value = null) },
  error: { open: () => !!error.value, close: () => dismissError() },
  confirm: { open: () => !!confirmState.value, close: () => (confirmState.value = null) },
  repoSwitcher: { open: () => showSwitcher.value, close: () => (showSwitcher.value = false) },
  branchSwitcher: {
    open: () => showBranchSwitcher.value,
    close: () => (showBranchSwitcher.value = false),
  },
  createBranch: { open: () => showCreateBranch.value, close: () => (showCreateBranch.value = false) },
  createTag: { open: () => showCreateTag.value, close: () => (showCreateTag.value = false) },
  openRepo: {
    open: () => !!openModal.value,
    close: () => (openModal.value = null),
    // 克隆进行中不关表单：后台克隆完成后会自动切换仓库，弹窗还承担进度与取消入口
    locked: () => cloneBusy.value,
  },
  releaseNotes: { open: () => notesOpen.value, close: () => (notesOpen.value = false) },
  aiReview: { open: () => reviewOpen.value, close: () => (reviewOpen.value = false) },
  groupManager: { open: () => showGroupMgr.value, close: () => (showGroupMgr.value = false) },
  groupModal: { open: () => !!groupModal.value, close: () => (groupModal.value = null) },
  tabRename: { open: () => !!renameTarget.value, close: () => (renameTarget.value = "") },
  branchRename: { open: () => !!branchRename.value, close: () => (branchRename.value = null) },
  flowConfirm: { open: () => !!wfConfirm.value, close: () => (wfConfirm.value = null) },
  flowRun: { open: () => !!wfRun.value, close: () => (wfRun.value = null) },
  settings: { open: () => showSettings.value, close: () => (showSettings.value = false) },
  fileHistory: {
    open: () => !!fileHistoryModal.value,
    close: () => (fileHistoryModal.value = null),
  },
  diff: { open: () => !!diffState.value, close: () => (diffState.value = null) },
};

function closeTopOverlay() {
  // 菜单类（右键/下拉）由 ContextMenu 自身捕获 Esc，这里兜底的是上面这些
  closeTop(overlayLayers);
}

// AI 请求没有「后台完成还有用」的场景：弹窗一关结果就没人看，但请求会继续跑满 30s 超时。
// 这里统一收口——任何一条关闭路径（Esc / 点遮罩 / 叉 / 关闭按钮）都会走到 flag 变化，
// 比在 6 个关闭点上各调一次 abortAi() 更不容易漏。取消属于正常操作，不弹错误。
watch(
  [reviewOpen, notesOpen, showSettings, () => !!diffState.value],
  ([r, n, s, d], [pr, pn, ps, pd]) => {
    if ((pr && !r) || (pn && !n) || (ps && !s) || (pd && !d)) abortAi();
  },
);

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.isComposing) return; // 中文输入法组合中：Esc/Enter 是候选词操作，不碰任何快捷键/浮层

  // 输入框里不抢键。Ctrl+1..9 / Ctrl+B / Ctrl+Shift+L/R / F5 在输入法与编辑器里都有别的含义；
  // 更糟的是 Ctrl+B 会把分支切换器（z-50）盖到设置弹窗（z-30）之上，层级瞬间混乱。
  // 只放行三件事：Esc（仍要能关弹层）、Ctrl+Tab（切标签是全局导航）、
  // 以及「关掉自己正待着的那个切换器」——在切换器搜索框里按 Ctrl+P / Ctrl+B 得能关掉它。
  const el = document.activeElement as HTMLElement | null;
  const typing =
    !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  if (typing) {
    const toggleSelf =
      (e.ctrlKey && (e.key === "p" || e.key === "P") && showSwitcher.value) ||
      (e.ctrlKey && (e.key === "b" || e.key === "B") && showBranchSwitcher.value);
    if (e.key !== "Escape" && !(e.ctrlKey && e.key === "Tab") && !toggleSelf) return;
  }

  // 下面每条都先确认「确实有可做的事」再 preventDefault——否则就是纯按键吞噬
  // （过去在最前面 preventDefault，没有仓库时 Ctrl+P / Ctrl+1 也被吃掉，用户毫无反馈）。
  if (e.ctrlKey && e.key === "Tab") {
    // 在标签栏可见仓库间循环（文件夹不参与）
    const vis = barOrder.value.filter((x): x is BarRepo => x.kind === "repo");
    const n = vis.length;
    if (!n) return;
    e.preventDefault();
    const i = vis.findIndex((x) => x.path === repo.value);
    const d = e.shiftKey ? -1 : 1;
    activate(vis[(i + d + n) % n].path);
  } else if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
    // 第 N 个可见仓库选项卡，分组内的仓库不占号
    const t = barOrder.value.filter((x): x is BarRepo => x.kind === "repo")[Number(e.key) - 1];
    if (!t) return;
    e.preventDefault();
    activate(t.path);
  } else if (e.ctrlKey && (e.key === "p" || e.key === "P")) {
    if (!showSwitcher.value && !repos.value.length) return; // 一个仓库都没有：切换器没内容，别吞按键
    e.preventDefault();
    if (showSwitcher.value) showSwitcher.value = false;
    else openSwitcher();
  } else if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
    if (!showBranchSwitcher.value && !repo.value) return;
    e.preventDefault();
    if (showBranchSwitcher.value) showBranchSwitcher.value = false;
    else openBranchSwitcher();
  } else if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
    e.preventDefault();
    toggleFold("l");
  } else if (e.ctrlKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
    e.preventDefault();
    toggleFold("r");
  } else if (e.key === "Escape") {
    closeTopOverlay();
  } else if (e.key === "F5") {
    e.preventDefault();
    doRefresh();
  }
}

// ---- 侧边栏拖宽 + 持久化 ----
// 实现见 src/composables/useSidebarResize.ts（上限跟窗口宽度联动，避免挤没中间区）
const { leftW, rightW, startResize, endResize, clampSidebars } = useSidebarResize();

// v-focus 已提到 src/lib/focus.ts 并在 main.ts 全局注册
// （浮层正在逐个拆成子组件，局部指令在子组件模板里会静默失效）

// ---- IME 守卫：输入法组词期间 Enter/Esc 属于输入法，不触发弹窗动作 ----
// 守卫实现见 src/lib/imeGuard.ts。下面这些是给模板直接引用的处理器常量（不是函数调用），
// 模板里写 @keydown.enter.prevent="imeConfirmRename" 这样的裸标识符，
// 避免内联表达式 imeGuard(fn) 把返回的函数当语句丢掉。
const imeConfirmCreateBranch = imeGuard(confirmCreateBranch);
const imeConfirmCreateTag = imeGuard(confirmCreateTag);
const imeConfirmGroupModal = imeGuard(confirmGroupModal);
const imeConfirmRename = imeGuard(confirmRename);
const imeConfirmBranchRename = imeGuard(confirmBranchRename);
const imeConfirmFlow = imeGuard(confirmFlow);
const imeDoClone = imeGuard(doClone);
const imeCloseOpenModal = imeGuard(() => {
  openModal.value = null;
});
const imeCloseCreateTag = imeGuard(() => {
  showCreateTag.value = false;
});
const imeCloseGroupModal = imeGuard(() => {
  groupModal.value = null;
});
const imeCloseRename = imeGuard(() => {
  renameTarget.value = "";
});
const imeCloseBranchRename = imeGuard(() => {
  branchRename.value = null;
});

// 窗口重新获得焦点时静默刷新（切回来看到的就是最新状态）
const onWindowFocus = () => refresh();

onMounted(async () => {
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("resize", clampSidebars);
  clampSidebars(); // 存下来的侧栏宽度可能来自更宽的窗口
  // MRU 种子：当前仓库优先，其余按选项卡顺序
  mruPaths.value = repo.value
    ? [repo.value, ...repos.value.map((r) => r.path).filter((p) => p !== repo.value)]
    : [];
  if (repo.value) {
    await refresh();
    fetchOnce();
  }
});

onUnmounted(() => {
  window.removeEventListener("focus", onWindowFocus);
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("resize", clampSidebars);
  endResize(); // 拖动中途卸载（热更新/退出）别把监听和 col-resize 光标留下
});
</script>

<template>
  <div class="relative flex h-full flex-col">
    <Toast />
    <!-- 整页刷新遮罩（点刷新按钮时盖全页，替代仅按钮动画） -->
    <Transition name="fade">
      <div
        v-if="refreshing"
        class="absolute inset-0 z-20 grid place-items-center bg-background/50 text-sm backdrop-blur-[2px]"
      >
        <Spinner label="刷新中…" />
      </div>
    </Transition>
    <!-- 窗口镶边（header / 选项卡栏 / footer）统一用卡片色，工作区回落画布色：
         选项卡的「连着下面」才好成立 —— 激活页签跟内容同色，才像真的嵌进去 -->
    <header class="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
      <Tooltip text="打开仓库">
        <Button variant="ghost" aria-label="打开仓库" @click="openModal = 'choose'">
          <FolderOpen class="size-4" />
          打开
        </Button>
      </Tooltip>
      <Tooltip v-if="repoCrumb" :text="repo">
        <span class="flex min-w-0 max-w-[420px] items-baseline gap-1.5 text-xs">
          <span v-if="repoCrumb.parent" class="shrink-0 truncate text-muted-foreground">{{ repoCrumb.parent }}</span>
          <span v-if="repoCrumb.parent" class="shrink-0 text-muted-foreground">›</span>
          <span class="truncate font-medium text-foreground">{{ repoCrumb.name }}</span>
        </span>
      </Tooltip>
      <span v-else class="text-xs text-muted-foreground">未打开仓库</span>
      <span class="flex-1" />
      <Badge v-if="status?.behind" variant="warning">↓{{ status.behind }}</Badge>
      <Tooltip v-if="status?.ahead" text="未推送的提交：Review 或放弃">
        <button
          class="cursor-pointer border-0 bg-transparent p-0"
          aria-label="未推送提交菜单"
          @click.stop="aheadMenu = { x: $event.clientX, y: $event.clientY }"
        >
          <Badge variant="info" class="transition-shadow duration-fast hover:ring-1 hover:ring-[var(--badge-info-fg)]/45">↑{{ status.ahead }}</Badge>
        </button>
      </Tooltip>
      <span class="mx-1 h-4 w-px bg-border" />
      <!-- 顶部这排统一用默认高度：图标按钮是 h-8，文字按钮若用 sm(h-7) 会在同一行里
           差 4px，对齐看得很明显；32px 也是更舒服的点击目标 -->
      <Tooltip text="拉取并合并远程更新">
        <Button :disabled="!repo || busy" @click="doPull">
          <Spinner v-if="runningAction === 'pull'" :size="14" />
          <ArrowDownToLine v-else class="size-3.5" />
          Pull
        </Button>
      </Tooltip>
      <Tooltip text="推送（无上游自动建立跟踪）">
        <Button :disabled="!repo || busy" @click="doPush">
          <Spinner v-if="runningAction === 'push'" :size="14" />
          <ArrowUpFromLine v-else class="size-3.5" />
          Push
        </Button>
      </Tooltip>
      <!-- 钉住的工作流（最多 3 个，在设置页勾）：常用流程不必每次展开下拉再点一次 -->
      <Tooltip v-for="w in pinnedFlows" :key="w.id" :text="`执行工作流：${w.name}`">
        <Button :disabled="!repo || busy" @click="runFlow(w)">
          <WorkflowIcon class="size-3.5 shrink-0" />
          <span class="max-w-[7rem] truncate">{{ w.name }}</span>
        </Button>
      </Tooltip>
      <Tooltip text="工作流">
        <Button
          variant="quiet"
          size="icon"
          :disabled="!repo || busy"
          aria-label="工作流"
          @click.stop="flowMenu = { x: $event.clientX, y: $event.clientY }"
        >
          <WorkflowIcon class="size-4" />
        </Button>
      </Tooltip>
      <Tooltip text="刷新">
        <Button
          variant="quiet"
          size="icon"
          :disabled="!repo || busy || refreshing"
          aria-label="刷新"
          @click="doRefresh"
        >
          <RefreshCw class="size-4" :class="refreshing && 'animate-spin'" />
        </Button>
      </Tooltip>
      <Tooltip text="新建分支">
        <Button variant="quiet" size="icon" :disabled="!repo || busy" aria-label="新建分支" @click="openCreateBranch">
          <GitBranchPlus class="size-4" />
        </Button>
      </Tooltip>
      <Tooltip text="设置">
        <Button variant="quiet" size="icon" aria-label="设置" @click="showSettings = true">
          <SettingsIcon class="size-4" />
        </Button>
      </Tooltip>
    </header>

    <!-- 仓库选项卡栏：文件夹（分组）+ 未分组仓库，可拖动排序；最右侧按钮打开分组管理 -->
    <div data-tab-bar class="flex items-end border-b border-border bg-card">
      <VueDraggable
        v-model="barOrder"
        :animation="150"
        :force-fallback="true"
        fallback-class="opacity-70"
        tag="div"
        class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2"
        @start="onBarStart"
        @move="onBarMove"
        @end="onBarEnd"
      >
        <template
          v-for="item in barOrder"
          :key="item.kind === 'group' ? `group:${item.name}` : `repo:${item.path}`"
        >
          <!-- 分组文件夹：点击弹出成员下拉，激活仓库在组内时高亮；拖仓库到此处松手可归组 -->
          <div
            v-if="item.kind === 'group'"
            data-group-folder
            :data-group-folder-name="item.name"
            tabindex="0"
            role="button"
            aria-haspopup="menu"
            :aria-expanded="folderDd?.group === item.name"
            class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs whitespace-nowrap transition-colors duration-fast select-none outline-none focus-visible:outline-2 focus-visible:outline-primary/60 focus-visible:-outline-offset-1"
            :class="[
              folderHighlighted(item.name)
                ? 'border-primary/60 bg-primary/10 text-primary ring-1 ring-primary/40'
                : isGroupActive(item.name)
                  ? 'border-border bg-background font-medium text-foreground'
                  : 'border-transparent text-muted-foreground transition-colors duration-fast hover:bg-hover',
            ]"
            :title="`分组「${item.name}」· ${groupCount(item.name)} 个仓库 · 点击展开；拖仓库到此处可收进分组，右键可重命名/删除`"
            @click.stop="toggleFolder(item.name, $event)"
            @keydown.enter.prevent="toggleFolder(item.name, $event)"
            @keydown.space.prevent="toggleFolder(item.name, $event)"
            @contextmenu.prevent.stop="openFolderCtx($event, item.name)"
          >
            <Folder
              class="size-3.5 shrink-0"
              :class="folderHighlighted(item.name) || isGroupActive(item.name) ? 'text-primary' : 'opacity-70'"
            />
            <!-- 分组名长起来会挤爆标签栏：截断 + 成员数，让每个文件夹的宽度可预期 -->
            <span class="max-w-[140px] truncate">{{ item.name }}</span>
            <span class="text-2xs text-muted-foreground">{{ groupCount(item.name) }}</span>
            <ChevronDown class="size-3 opacity-50" />
          </div>
          <!-- 仓库选项卡 -->
          <div
            v-else
            :data-repo-path="item.path"
            class="group/tab flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs whitespace-nowrap transition-colors duration-fast select-none"
            :class="[
              item.path === repo
                ? 'border-border bg-background font-medium text-foreground'
                : 'border-transparent text-muted-foreground transition-colors duration-fast hover:bg-hover',
            ]"
            @click="switchRepo(item.path)"
            @contextmenu.prevent="tabCtx = { x: $event.clientX, y: $event.clientY, path: item.path }"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="item.path === repo ? 'bg-primary' : 'bg-border group-hover/tab:bg-muted-foreground'"
            />
            <Tooltip :text="item.path">
              <span class="max-w-[120px] truncate">{{ repoByPath.get(item.path)?.name }}</span>
            </Tooltip>
            <X
              class="size-3 opacity-0 transition-opacity duration-fast group-hover/tab:opacity-60 hover:!opacity-100 hover:text-destructive"
              aria-label="关闭仓库选项卡"
              @mousedown.stop
              @click.stop="askCloseTab(item.path)"
            />
          </div>
        </template>
      </VueDraggable>
      <Tooltip text="管理分组">
        <Button variant="ghost" size="icon" class="mr-1 mb-0.5 h-6 w-6 shrink-0" @click="openGroupMgr">
          <FolderPlus class="size-4" />
        </Button>
      </Tooltip>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- 分支侧栏（可拖宽 / 双击把手折叠） -->
      <aside
        v-show="!leftFold"
        class="shrink-0 overflow-y-auto border-r border-border"
        :style="{ width: leftW + 'px' }"
      >
        <div class="px-3 pt-3.5 pb-2 text-2xs font-semibold tracking-wide text-muted-foreground">
          分支
        </div>
        <!-- 分支模糊搜索（创建分支在工具栏按钮） -->
        <div class="px-2.5 pb-2">
          <!-- relative 只包住 Input、不跟外层合并：外层带 pb-2，若让图标相对外层定位，
               top-1/2 算的是「输入框 + 下边距」的一半，图标会比输入框中心低 4px -->
          <div class="relative">
            <Search
              class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input v-model="branchFilter" placeholder="搜索分支…" class="h-7 pl-7 text-xs" />
          </div>
        </div>
        <!-- 本地分支组：一级栏，图标+强调 -->
        <div
          class="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-base font-medium select-none transition-colors duration-fast hover:bg-hover"
          @click="toggleGroup('local')"
        >
          <ChevronDown class="size-3 transition-transform duration-fast" :class="collapsedGroups.has('local') && '-rotate-90'" />
          <GitBranch class="size-3.5" />
          本地
          <span class="text-xs font-normal text-muted-foreground">{{ localBranches.length }}</span>
        </div>
        <BranchTree
          v-if="!collapsedGroups.has('local')"
          v-model="collapsedGroups"
          :nodes="localNodes"
          @switch="switchBranch"
          @menu="(b, x, y) => (branchMenu = { x, y, b })"
        />

        <!-- 远程分组：一级栏图标+强调，默认收起 -->
        <template v-for="[prefix, list] in remoteGroups" :key="prefix">
          <div
            class="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-base font-medium select-none transition-colors duration-fast hover:bg-hover"
            @click="toggleRemote(prefix)"
          >
            <ChevronDown class="size-3 transition-transform duration-fast" :class="!openRemotes.has(prefix) && '-rotate-90'" />
            <Cloud class="size-3.5" />
            {{ prefix }}
            <span class="text-xs font-normal text-muted-foreground">{{ list.length }}</span>
          </div>
          <BranchTree
            v-if="openRemotes.has(prefix)"
            v-model="collapsedGroups"
            :nodes="remoteNodeMap.get(prefix) ?? []"
            @switch="switchBranch"
            @menu="(b, x, y) => (branchMenu = { x, y, b })"
          />
        </template>

        <!-- 标签组：右键组头出 新建/AI Release Notes，右键行出 推送/删除/复制 -->
        <div
          class="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-base font-medium select-none transition-colors duration-fast hover:bg-hover"
          title="右键：新建标签 / AI Release Notes"
          @click="toggleGroup('gz:tags')"
          @contextmenu.prevent="tagHeaderMenu = { x: $event.clientX, y: $event.clientY }"
        >
          <ChevronDown class="size-3 transition-transform duration-fast" :class="collapsedGroups.has('gz:tags') && '-rotate-90'" />
          <Tag class="size-3.5" />
          标签
          <span class="ml-auto text-xs font-normal text-muted-foreground">{{ tags.length }}</span>
        </div>
        <ul v-if="!collapsedGroups.has('gz:tags')" class="pb-1">
          <li
            v-for="t in tagsFiltered"
            :key="t.name"
            class="flex cursor-pointer items-center gap-1 py-1.5 pr-3 pl-6 transition-colors duration-fast hover:bg-hover"
            :title="`${t.annotated ? '附注标签' : '轻量标签'} · ${t.date} · 指向 ${t.target.slice(0, 10)}${t.message ? '\n' + t.message : ''}（右键更多操作）`"
            @contextmenu.prevent="tagMenu = { x: $event.clientX, y: $event.clientY, name: t.name }"
          >
            <span class="truncate text-xs">{{ t.name }}</span>
          </li>
          <li v-if="!tagsFiltered.length" class="py-1.5 pl-6 pr-3 text-xs text-muted-foreground">
            {{ tags.length ? "无匹配标签" : "暂无标签 · 右键组头新建" }}
          </li>
        </ul>
      </aside>

      <!-- 左把手：拖宽 / 双击折叠（Ctrl+Shift+L）；折叠后点箭头展开 -->
      <div
        class="flex shrink-0 cursor-col-resize items-center justify-center transition-colors duration-fast hover:bg-primary/40"
        :class="leftFold ? 'w-3' : 'w-1'"
        :title="leftFold ? '展开侧栏（Ctrl+Shift+L）' : '拖宽 · 双击折叠'"
        @dblclick="toggleFold('l')"
        @mousedown="!leftFold && startResize('l')"
      >
        <ChevronRight
          v-if="leftFold"
          class="size-3 text-muted-foreground"
          aria-label="展开左侧栏"
          @click.stop="toggleFold('l')"
          @dblclick.stop
        />
      </div>

      <!-- 历史（滚动与虚拟化内聚在 HistoryGraph，App 只接加载更多） -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <!-- 视图范围：当前分支 / 所有分支 -->
          <Select
            v-model="historyMode"
            class="h-7 w-24 shrink-0 text-xs"
            :options="[
              { value: 'current', label: '当前分支' },
              { value: 'all', label: '所有分支' },
            ]"
          />
          <!-- 文件路径过滤 chip，× 退出 -->
          <div
            v-if="historyFilePath"
            class="flex shrink-0 cursor-default items-center gap-1 rounded-xs bg-muted px-2 py-1 text-xs"
            :title="`历史已按文件过滤：${historyFilePath}`"
          >
            {{ historyFilePath.split(/[\\/]/).pop() }}
            <X class="size-3 cursor-pointer transition-colors duration-fast hover:text-destructive" @click="historyFilePath = null" />
          </div>
          <div class="relative min-w-0 flex-1">
            <Search class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="filter" placeholder="搜索提交信息 / 作者…" class="h-7 pl-8 text-xs" />
          </div>
        </div>
        <div class="relative min-h-0 flex-1">
          <!-- 切换分支时的 loading 遮罩 -->
          <Transition name="fade">
            <div
              v-if="historyLoading"
              class="absolute inset-0 z-10 grid place-items-center bg-background/60 text-sm backdrop-blur-[2px]"
            >
              <Spinner label="加载中…" />
            </div>
          </Transition>
          <HistoryGraph
            v-if="commits.length"
            :commits="commits"
            :filter="filter"
            :loading-more="loadingMore"
            :can-load-more="canLoadMore"
            @open-commit="(c: LogEntry) => (diffState = { kind: 'commit', target: c })"
            @commit-menu="onCommitMenu"
            @load-more="loadMorePage"
          />
          <!-- 空态：这是用户看到的第一屏，值得比别的空态多花一点功夫 -->
          <div v-else-if="repo" class="grid h-full place-items-center">
            <div class="flex flex-col items-center gap-2.5 text-center">
              <div class="grid size-12 place-items-center rounded-lg bg-primary-soft">
                <GitBranch class="size-6 text-primary" />
              </div>
              <div class="text-sm text-muted-foreground">这个仓库还没有提交</div>
              <div class="text-xs text-muted-foreground">在右侧暂存改动、写好提交信息，就能创建第一个提交</div>
            </div>
          </div>
          <!-- 首屏：欢迎 + 最近仓库 + 拖拽提示 -->
          <div v-else class="grid h-full place-items-center">
            <div class="flex w-[420px] flex-col items-center gap-5 text-center">
              <div class="grid size-14 place-items-center rounded-lg bg-primary-soft">
                <GitBranch class="size-7 text-primary" />
              </div>
              <div>
                <div class="text-lg font-semibold">打开一个 Git 仓库开始</div>
                <div class="mt-1.5 text-xs text-muted-foreground">
                  把仓库文件夹拖进窗口，或从下面选择最近打开的
                </div>
              </div>
              <Button size="sm" @click="openModal = 'choose'">
                <FolderOpen class="size-3.5" />
                打开仓库…
              </Button>
              <ul v-if="repos.length" class="max-h-44 w-full space-y-0.5 overflow-y-auto text-left">
                <li v-for="r in repos.slice(0, 8)" :key="r.path">
                  <button
                    class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs transition-colors duration-fast hover:bg-hover"
                    :title="r.path"
                    @click="switchRepo(r.path)"
                  >
                    <span class="size-1.5 shrink-0 rounded-full bg-primary/40" />
                    <span class="shrink-0 font-medium">{{ r.name }}</span>
                    <span class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{{ r.path }}</span>
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <!-- 右把手：拖宽 / 双击折叠（Ctrl+Shift+R）；折叠后点箭头展开 -->
      <div
        class="flex shrink-0 cursor-col-resize items-center justify-center transition-colors duration-fast hover:bg-primary/40"
        :class="rightFold ? 'w-3' : 'w-1'"
        :title="rightFold ? '展开侧栏（Ctrl+Shift+R）' : '拖宽 · 双击折叠'"
        @dblclick="toggleFold('r')"
        @mousedown="!rightFold && startResize('r')"
      >
        <ChevronLeft
          v-if="rightFold"
          class="size-3 text-muted-foreground"
          aria-label="展开右侧栏"
          @click.stop="toggleFold('r')"
          @dblclick.stop
        />
      </div>

      <!-- 变更 -->
      <aside
        class="shrink-0 overflow-y-auto border-l border-border"
        :style="{ width: rightW + 'px' }"
      >
        <ChangesPanel
          :repo="repo"
          :status="status"
          :busy="busy"
          :commit-count="commits.length"
          @action="(fn: () => Promise<unknown>) => run(fn)"
          @open-diff="(t: DiffTarget) => (diffState = { kind: 'file', target: t })"
          @file-history="(p: string) => (fileHistoryModal = p)"
          @filter-history="(p: string) => (historyFilePath = p)"
          @amend="askAmend"
          @undo="askUndoCommit"
          @stash-drop="askStashDrop"
          @abort-merge="askAbortMerge"
          @discard-staged="askDiscardStaged"
          @discard="(t: DiffTarget) =>
            openConfirm({
              title: t.untracked ? '删除未跟踪文件' : '丢弃更改',
              okText: t.untracked ? '删除文件' : '丢弃更改',
              body: `确认${t.untracked ? '删除' : '丢弃'} ${t.path}？此操作不可恢复。`,
              ok: () => api.discard(repo, t.path, t.untracked),
            })"
        />
      </aside>
    </div>

    <!-- 创建分支弹窗 -->
    <div
      v-if="showCreateBranch"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-create-branch-title"
      @click.self="showCreateBranch = false"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-create-branch-title" class="mb-3 text-base font-semibold">新建分支</div>
        <div class="flex gap-2">
          <Select
            v-model="newBranchPrefix"
            class="w-32 shrink-0"
            :options="[
              { value: '', label: '无前缀' },
              ...prefixes.map((p: string) => ({ value: p, label: p })),
            ]"
          />
          <Input v-model="newBranchName" placeholder="分支名" @keydown.enter.prevent="imeConfirmCreateBranch" />
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          基于当前分支 {{ status?.branch || "—" }} 创建并自动切换。
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="showCreateBranch = false">取消</Button>
          <Button variant="default" size="sm" :disabled="!newBranchName.trim() || busy" @click="confirmCreateBranch">
            创建
          </Button>
        </div>
      </div>
    </div>

    <!-- 打开仓库：本地 / 从远程克隆 -->
    <div
      v-if="openModal"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="openModal === 'choose' ? 'dlg-open-repo-title' : 'dlg-clone-title'"
      @click.self="openModal = null"
    >
      <div class="w-dlg-lg surface rounded-lg p-5 pop-in">
        <!-- 选择入口 -->
        <template v-if="openModal === 'choose'">
          <div id="dlg-open-repo-title" class="mb-3 text-base font-semibold">打开仓库</div>
          <div class="grid grid-cols-2 gap-3">
            <button
              class="cursor-pointer rounded-md surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-primary/5 hover:shadow-elev-2"
              @click="
                openModal = null;
                openRepo();
              "
            >
              <FolderOpen class="mb-1.5 size-5 text-primary" />
              <span class="block text-sm font-medium">本地目录</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">选择本机已有的 Git 仓库</span>
            </button>
            <button
              class="cursor-pointer rounded-md surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-primary/5 hover:shadow-elev-2"
              @click="openRemoteClone"
            >
              <Download class="mb-1.5 size-5 text-primary" />
              <span class="block text-sm font-medium">从远程克隆</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">输入 URL 克隆到本地并打开</span>
            </button>
            <!-- 第三个动作横跨整行：三个等宽卡片在 520px 里太挤，而且它本来就比前两个少见 -->
            <button
              class="col-span-2 flex cursor-pointer items-center gap-3 rounded-md surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-primary/5 hover:shadow-elev-2"
              @click="
                openModal = null;
                initRepo();
              "
            >
              <FolderPlus class="size-5 shrink-0 text-primary" />
              <span class="min-w-0">
                <span class="block text-sm font-medium">初始化新仓库</span>
                <span class="mt-0.5 block text-xs text-muted-foreground">把选中的空目录 git init 后打开</span>
              </span>
            </button>
          </div>
        </template>
        <!-- 远程克隆表单 -->
        <template v-else>
          <div id="dlg-clone-title" class="mb-3 text-base font-semibold">从远程克隆</div>
          <Input
            v-model="remoteUrlInput"
            v-focus
            placeholder="远程地址：https://host/user/repo.git 或 git@host:user/repo.git"
            @keydown.esc="imeCloseOpenModal"
          />
          <div class="mt-2 flex items-center gap-2">
            <Button variant="secondary" size="sm" class="shrink-0" @click="pickCloneParent">
              选择位置…
            </Button>
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" :title="cloneParent">
              {{ cloneParent || "未选择克隆到哪个目录" }}
            </span>
          </div>
          <Input
            v-model="cloneName"
            class="mt-2"
            placeholder="目录名（输入地址后自动推断，可修改）"
            @input="cloneNameTouched = true"
            @keydown.enter.prevent="imeDoClone"
            @keydown.esc="imeCloseOpenModal"
          />
          <div v-if="cloneErr" class="mt-2 text-xs text-destructive">
            {{ cloneErr }}
            <details v-if="cloneErrDetail" class="mt-1">
              <summary class="cursor-pointer text-muted-foreground">详细信息</summary>
              <pre class="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{{ cloneErrDetail }}</pre>
            </details>
          </div>
          <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
            将克隆到「位置 / 目录名」，完成后自动打开。认证走系统凭据（credential helper / ssh key）。
          </p>
          <div class="mt-5 flex justify-end gap-2">
            <Button variant="ghost" size="sm" @click="openModal = null">取消</Button>
            <Button
              variant="default"
              size="sm"
              :disabled="!remoteUrlInput.trim() || !cloneParent || !cloneName.trim() || cloneBusy"
              @click="doClone"
            >
              <Spinner v-if="cloneBusy" :size="14" />
              {{ cloneBusy ? "克隆中…" : "克隆并打开" }}
            </Button>
          </div>
        </template>
      </div>
    </div>

    <!-- 新建标签弹窗（target 为空 = 打在当前 HEAD） -->
    <div
      v-if="showCreateTag"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-create-tag-title"
      @click.self="showCreateTag = false"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-create-tag-title" class="mb-3 text-base font-semibold">新建标签</div>
        <Input
          v-model="newTagName"
          v-focus
          placeholder="标签名，如 v1.0.0"
          @keydown.enter.prevent="imeConfirmCreateTag"
          @keydown.esc="imeCloseCreateTag"
        />
        <Input
          v-model="newTagMsg"
          class="mt-2"
          placeholder="附注信息（可选，填写即创建附注标签）"
          @keydown.esc="imeCloseCreateTag"
        />
        <p class="mt-2 text-xs text-muted-foreground">
          基于{{ tagTarget ? `提交 ${tagTarget.slice(0, 10)}` : `当前 HEAD（${status?.branch || "—"}）` }}创建。
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="showCreateTag = false">取消</Button>
          <Button variant="default" size="sm" :disabled="!newTagName.trim() || busy" @click="confirmCreateTag">
            创建
          </Button>
        </div>
      </div>
    </div>

    <!-- 历史行右键菜单（ui/ContextMenu 统一渲染：Esc/键盘/外点关闭） -->
    <ContextMenu
      v-if="commitCtx"
      :x="commitCtx.x"
      :y="commitCtx.y"
      :items="[
        { label: '复制短 hash', fn: () => copyHash(commitCtx!.c.hash.slice(0, 10)) },
        { label: '复制完整 hash', fn: () => copyHash(commitCtx!.c.hash) },
        { label: '复制提交信息', fn: () => copyText(commitCtx!.c.subject) },
        { label: '复制作者', fn: () => copyText(commitCtx!.c.author) },
        { separator: true, label: '' },
        { label: '新建标签…', fn: () => openCreateTag(commitCtx!.c.hash) },
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
        {
          label: 'Cherry-pick 到当前分支',
          fn: () =>
            openConfirm({
              title: 'Cherry-pick 提交',
              body: `把「${commitCtx!.c.subject}」拣选到当前分支 ${status?.branch ?? ''}？若该改动已在当前分支（空拣选）或产生冲突会失败停留。`,
              ok: () => api.cherryPick(repo, commitCtx!.c.hash),
            }),
        },
      ]"
      @close="commitCtx = null"
    />

    <!-- 分支右键菜单：管理操作（切换在行单击） -->
    <ContextMenu
      v-if="branchMenu"
      :x="branchMenu.x"
      :y="branchMenu.y"
      :items="branchMenuItems(branchMenu.b)"
      @close="branchMenu = null"
    />
    <!-- 标签行右键菜单 -->
    <ContextMenu
      v-if="tagMenu"
      :x="tagMenu.x"
      :y="tagMenu.y"
      :items="tagMenuItems(tagMenu.name)"
      @close="tagMenu = null"
    />
    <!-- 标签组头右键菜单 -->
    <ContextMenu
      v-if="tagHeaderMenu"
      :x="tagHeaderMenu.x"
      :y="tagHeaderMenu.y"
      :items="[
        { label: '新建标签（打在当前 HEAD）', fn: () => openCreateTag() },
        { label: 'AI 生成 Release Notes', fn: openReleaseNotes },
      ]"
      @close="tagHeaderMenu = null"
    />
    <!-- ↑N 徽标下拉：Review / 放弃未推送 -->
    <ContextMenu
      v-if="aheadMenu"
      :x="aheadMenu.x"
      :y="aheadMenu.y"
      :items="aheadMenuItems()"
      @close="aheadMenu = null"
    />
    <!-- 工作流入口下拉 -->
    <ContextMenu
      v-if="flowMenu"
      :x="flowMenu.x"
      :y="flowMenu.y"
      :items="flowMenuItems()"
      @close="flowMenu = null"
    />

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
      v-trap
      class="fixed inset-0 z-30 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-review-title"
      @click.self="reviewOpen = false"
    >
      <div class="flex max-h-[80vh] w-dlg-xl flex-col surface rounded-lg pop-in">
        <header class="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <Bot class="size-4 text-primary" />
          <span id="dlg-review-title" class="text-base font-semibold">AI Review · 未推送的 {{ status?.ahead }} 个提交</span>
          <span class="flex-1" />
          <Button variant="ghost" size="icon" @click="reviewOpen = false"><X class="size-4" /></Button>
        </header>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-base leading-relaxed">
          <Spinner v-if="reviewBusy" label="AI 正在审查未推送的变更…" />
          <div v-else-if="reviewErr" class="text-destructive">{{ reviewErr }}</div>
          <Md v-else :source="reviewText" />
        </div>
        <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <span v-if="reviewSaved" class="mr-auto text-xs text-primary">已保存 ✓</span>
          <Button variant="secondary" size="sm" :disabled="reviewBusy || !reviewText" @click="saveReviewToFile">保存到本地</Button>
          <Button variant="secondary" size="sm" :disabled="reviewBusy || !status?.ahead" @click="startReview(true)">
            重新生成
          </Button>
          <Button variant="secondary" size="sm" @click="reviewOpen = false">关闭</Button>
        </footer>
      </div>
    </div>

    <!-- AI Release Notes 弹窗（复用 Review 骨架） -->
    <div
      v-if="notesOpen"
      v-trap
      class="fixed inset-0 z-30 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-notes-title"
      @click.self="notesOpen = false"
    >
      <div class="flex max-h-[80vh] w-dlg-xl flex-col surface rounded-lg pop-in">
        <header class="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <Sparkles class="size-4 text-primary" />
          <span id="dlg-notes-title" class="text-base font-semibold">AI Release Notes</span>
          <Select v-model="notesFrom" class="w-56" :options="notesOptions" />
          <span class="flex-1" />
          <Button variant="ghost" size="icon" @click="notesOpen = false"><X class="size-4" /></Button>
        </header>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-base leading-relaxed">
          <Spinner v-if="notesBusy" label="AI 正在汇总提交生成 Release Notes…" />
          <div v-else-if="notesErr" class="text-destructive">{{ notesErr }}</div>
          <Md v-else-if="notesText" :source="notesText" />
          <div v-else class="text-muted-foreground">选择范围后点「生成」。</div>
        </div>
        <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <span v-if="notesSaved" class="mr-auto text-xs text-primary">已保存 ✓</span>
          <Button variant="secondary" size="sm" :disabled="notesBusy || !notesText" @click="saveNotesToFile">
            保存到本地
          </Button>
          <Button variant="secondary" size="sm" :disabled="notesBusy" @click="genReleaseNotes">生成</Button>
          <Button variant="secondary" size="sm" @click="notesOpen = false">关闭</Button>
        </footer>
      </div>
    </div>

    <SettingsModal
      v-if="showSettings"
      :repo="repo"
      :initial-tab="showSettingsTab"
      @close="showSettings = false"
    />

    <footer class="flex items-center gap-3 border-t border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
      <span class="font-medium text-foreground">{{ status?.branch ?? "—" }}</span>
      <span class="flex-1" />
      <span v-if="status">{{ status.files.length }} 个变更文件</span>
      <Tooltip v-if="remoteWebUrl" text="打开远程仓库网页">
        <Button
          variant="ghost"
          size="sm"
          class="h-5 gap-1 px-1.5 text-xs"
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
    <ContextMenu
      v-if="tabCtx"
      :x="tabCtx.x"
      :y="tabCtx.y"
      :items="[
        { label: '重命名…', fn: openRenameModal },
        { label: '关闭', danger: true, fn: () => askCloseTab(tabCtx!.path) },
        { label: '关闭其他', fn: () => askCloseOthers(tabCtx!.path) },
      ]"
      @close="tabCtx = null"
    />

    <!-- 分组文件夹右键菜单（重命名 / 管理 / 删除） -->
    <ContextMenu
      v-if="folderCtx"
      :x="folderCtx.x"
      :y="folderCtx.y"
      :items="[
        { label: '重命名…', fn: () => openGroupRename(folderCtx!.group) },
        { label: '管理分组…', fn: openGroupMgr },
        { label: '删除分组', danger: true, fn: () => askDeleteGroup(folderCtx!.group) },
      ]"
      @close="folderCtx = null"
    />

    <!-- 拖拽跟手标签（分组下拉 / 管理弹窗共用） -->
    <div
      v-if="itemDrag.on && itemDrag.active"
      class="pointer-events-none fixed z-[80] surface-menu rounded-sm px-2 py-1 text-xs"
      :style="{ left: itemDrag.x + 12 + 'px', top: itemDrag.y + 12 + 'px' }"
    >
      {{ itemDrag.name }}
    </div>

    <!-- 分组文件夹下拉：成员仓库列表，点击激活 -->
    <div v-if="folderDd" class="fixed inset-0 z-40" @click="closeFolderDd" @contextmenu.prevent="folderDd = null">
      <div
        ref="folderDdEl"
        class="fixed max-h-[60vh] w-[260px] overflow-y-auto surface-menu rounded-sm py-1 pop-in"
        :style="{ left: folderDd.x + 'px', top: folderDd.y + 'px' }"
      >
        <div class="px-3 pt-3 pb-1.5 text-2xs font-semibold tracking-wide text-muted-foreground">
          {{ folderDd.group }} · {{ folderMembers.length }} 个仓库
        </div>
        <div
          v-for="r in folderMembers"
          :key="r.path"
          :data-folder-active="r.path === repo ? '1' : undefined"
          class="group/member flex items-center gap-1 transition-colors duration-fast hover:bg-hover"
          :class="r.path === repo && 'bg-primary-soft text-primary'"
        >
          <button
            class="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-3 py-1.5 text-left text-xs select-none"
            :title="`${r.path} · 按住可拖到标签栏移出分组，或拖到别的文件夹换组`"
            @mousedown="startItemDrag($event, r.path, r.name, folderAtPoint, dropItem)"
            @click.stop="onMemberClick(r.path)"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="r.path === repo ? 'bg-primary' : 'bg-border'"
            />
            <span class="truncate">{{ r.name }}</span>
          </button>
          <Tooltip text="移出分组（回到选项卡栏）">
            <button
              class="mr-1 shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/member:opacity-100 hover:text-destructive"
              aria-label="移出分组"
              @mousedown.stop
              @click.stop="removeMember(r.path)"
            >
              <X class="size-3" />
            </button>
          </Tooltip>
        </div>
        <div v-if="!folderMembers.length" class="px-3 py-2 text-xs text-muted-foreground">
          空分组 · 用选项卡栏右侧的「管理分组」添加仓库
        </div>
        <div class="mt-1 border-t border-border/60 pt-1">
          <button
            class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-fast hover:bg-hover"
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
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-group-mgr-title"
      @click.self="closeGroupMgr"
    >
      <div class="flex max-h-[75vh] w-dlg-lg flex-col surface rounded-lg pop-in">
        <header class="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
          <FolderPlus class="size-4 text-primary" />
          <span id="dlg-group-mgr-title" class="text-base font-semibold">分组管理</span>
          <span class="flex-1" />
          <Button variant="ghost" size="icon" @click="showGroupMgr = false"><X class="size-4" /></Button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto p-3">
          <div class="mb-2 flex items-center gap-2">
            <Button variant="secondary" size="sm" @click="openGroupCreate">
              <Plus class="size-3.5" /> 新建分组
            </Button>
            <div class="relative ml-auto">
              <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                v-model="groupSearch"
                class="h-7 w-52 pl-7 text-xs"
                placeholder="搜索仓库：名称或路径"
                aria-label="搜索仓库"
              />
            </div>
          </div>
          <div v-if="!groupList.length" class="py-8 text-center text-xs text-muted-foreground">
            还没有分组。新建一个，然后把仓库收进去——标签栏会出现一个文件夹，点击可展开仓库列表。
          </div>
          <VueDraggable
            v-model="groupList"
            :animation="150"
            :force-fallback="true"
            fallback-class="opacity-70"
            handle=".mgr-group-handle"
            tag="div"
            @update:model-value="syncGroupBarOrder"
          >
            <div
              v-for="g in groupList"
              :key="g"
              :data-mgr-group="g"
              class="mb-2 rounded-md border transition-colors duration-fast"
              :class="mgrHighlighted(g) ? 'border-primary/60 bg-primary-soft' : 'border-border'"
            >
              <div class="flex items-center gap-2 px-3 py-2">
                <GripVertical class="mgr-group-handle size-3.5 shrink-0 cursor-grab text-muted-foreground" @click.stop />
                <button
                  class="flex flex-1 cursor-pointer items-center gap-1.5 text-left text-base"
                  @click="mgrExpanded = mgrExpanded === g ? '' : g"
                >
                  <ChevronDown
                    class="size-3 text-muted-foreground transition-transform duration-fast"
                    :class="mgrExpanded !== g && '-rotate-90'"
                  />
                  <Folder class="size-3.5 text-primary" />
                  <span class="font-medium">{{ g }}</span>
                  <span class="text-xs text-muted-foreground">{{ groupCount(g) }} 个仓库</span>
                  <span v-if="isGroupActive(g)" class="size-1.5 rounded-full bg-primary" title="当前打开的仓库在此分组" />
                </button>
                <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="openGroupRename(g)">重命名</Button>
                <Button variant="ghost" size="sm" class="h-6 px-2 text-xs text-destructive" @click="askDeleteGroup(g)">
                  删除
                </Button>
              </div>
              <!-- 成员编辑：移出 / 添加 -->
              <div v-if="mgrExpanded === g" class="border-t border-border/60 px-3 py-2">
                <div
                  v-for="r in repos.filter((x) => x.group === g)"
                  :key="r.path"
                  class="flex cursor-grab items-center gap-2 rounded-sm py-1 text-xs select-none transition-colors duration-fast hover:bg-hover"
                  title="按住可拖到上面任意分组"
                  @mousedown="startItemDrag($event, r.path, r.name, mgrGroupAtPoint, dropItem)"
                >
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    :class="r.path === repo ? 'bg-primary' : 'bg-border'"
                  />
                  <span class="shrink-0 font-medium">{{ r.name }}</span>
                  <span class="flex-1 truncate text-xs text-muted-foreground">{{ r.path }}</span>
                  <button
                    class="cursor-pointer text-muted-foreground transition-colors duration-fast hover:text-destructive"
                    title="移出分组（回到标签栏，可在下方列表点回来）"
                    @mousedown.stop
                    @click="removeMember(r.path)"
                  >
                    <X class="size-3" />
                  </button>
                </div>
                <div v-if="!groupCount(g)" class="py-1 text-xs text-muted-foreground">空分组</div>
                <div class="mt-1 border-t border-border/60 pt-1.5">
                  <div class="mb-1 text-xs text-muted-foreground">添加仓库（一个仓库只属一个分组）：</div>
                  <div class="max-h-32 space-y-0.5 overflow-y-auto">
                    <button
                      v-for="r in mgrCandidates(g)"
                      :key="r.path"
                      class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-hover"
                      @click="addMember(g, r.path)"
                    >
                      <Plus class="size-3 shrink-0 text-primary" />
                      <span class="truncate">{{ r.name }}</span>
                      <span class="ml-auto truncate text-xs text-muted-foreground">
                        {{ r.group ? `来自「${r.group}」` : "未分组" }}
                      </span>
                    </button>
                    <div v-if="!mgrCandidates(g).length" class="px-1.5 py-1 text-xs text-muted-foreground">
                      没有匹配的仓库
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </VueDraggable>
        </div>
        <footer class="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          分组像书签文件夹：组内仓库不占选项卡，点文件夹下拉打开。移出/删除分组不会关闭任何仓库。
        </footer>
      </div>
    </div>

    <!-- 分组命名弹窗（新建 / 重命名共用） -->
    <div
      v-if="groupModal"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-group-name-title"
      @click.self="groupModal = null"
    >
      <div class="w-dlg-sm surface rounded-lg p-5 pop-in">
        <div id="dlg-group-name-title" class="mb-3 text-base font-semibold">{{ groupModal.mode === "create" ? "新建分组" : "重命名分组" }}</div>
        <Input
          v-model="groupNameDraft"
          v-focus
          placeholder="分组名，如：前端 / 后端"
          @keydown.enter.prevent="imeConfirmGroupModal"
          @keydown.esc="imeCloseGroupModal"
        />
        <!-- 新建时顺带归组：从标签栏拖进文件夹对键盘/单窗口用户不友好，这里给一条鼠标直路 -->
        <template v-if="groupModal.mode === 'create'">
          <div class="mt-3 mb-1 text-xs text-muted-foreground">顺带加入仓库（可选，一个仓库只属一个分组）：</div>
          <div class="max-h-40 overflow-y-auto rounded-md border border-border/70 p-1">
            <button
              v-for="r in repos"
              :key="r.path"
              class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-hover"
              :class="groupPicks.includes(r.path) && 'bg-primary-soft'"
              @click="toggleGroupPick(r.path)"
            >
              <span
                class="flex size-3.5 shrink-0 items-center justify-center rounded-xs border"
                :class="groupPicks.includes(r.path) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"
              >
                <Check v-if="groupPicks.includes(r.path)" class="size-2.5" />
              </span>
              <span class="truncate">{{ r.name }}</span>
              <span class="ml-auto truncate text-xs text-muted-foreground">
                {{ r.group ? `来自「${r.group}」` : "未分组" }}
              </span>
            </button>
            <div v-if="!repos.length" class="px-1.5 py-1 text-xs text-muted-foreground">还没有仓库</div>
          </div>
        </template>
        <div v-if="groupModalErr" class="mt-1.5 text-xs text-destructive">{{ groupModalErr }}</div>
        <div class="mt-5 flex justify-end gap-2">
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
      v-trap
      class="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="仓库快速切换器"
      @click.self="showSwitcher = false"
    >
      <div class="w-dlg-lg surface overflow-hidden rounded-lg pop-in">
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
              'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-base',
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
            <span class="flex-1 truncate text-right text-xs text-muted-foreground">{{ r.path }}</span>
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
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-rename-tab-title"
      @click.self="renameTarget = ''"
    >
      <div class="w-dlg-sm surface rounded-lg p-5 pop-in">
        <div id="dlg-rename-tab-title" class="mb-3 text-base font-semibold">重命名仓库选项卡</div>
        <Input
          v-model="renameDraft"
          v-focus
          @keydown.enter.prevent="imeConfirmRename"
          @keydown.esc="imeCloseRename"
        />
        <p class="mt-1.5 truncate text-xs text-muted-foreground">{{ renameTarget }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="renameTarget = ''">取消</Button>
          <Button variant="default" size="sm" @click="confirmRename">确定</Button>
        </div>
      </div>
    </div>

    <!-- 分支重命名弹窗（右键菜单触发） -->
    <div
      v-if="branchRename"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-rename-branch-title"
      @click.self="branchRename = null"
    >
      <div class="w-dlg-sm surface rounded-lg p-5 pop-in">
        <div id="dlg-rename-branch-title" class="mb-3 text-base font-semibold">重命名分支</div>
        <Input
          v-model="branchRename.draft"
          v-focus
          @keydown.enter.prevent="imeConfirmBranchRename"
          @keydown.esc="imeCloseBranchRename"
        />
        <p class="mt-1.5 truncate text-xs text-muted-foreground">{{ branchRename.b.name }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="branchRename = null">取消</Button>
          <Button variant="default" size="sm" :disabled="!branchRename.draft.trim()" @click="confirmBranchRename">
            确定
          </Button>
        </div>
      </div>
    </div>

    <!-- 分支快速切换器（Ctrl+B） -->
    <div
      v-if="showBranchSwitcher"
      v-trap
      class="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="分支快速切换器"
      @click.self="showBranchSwitcher = false"
    >
      <div class="w-dlg-lg surface overflow-hidden rounded-lg pop-in">
        <div class="relative p-2">
          <GitBranch
            class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            v-model="bsQuery"
            v-focus
            class="h-9 pl-8"
            placeholder="搜索分支… ↑↓ 选择 · 回车切换 · Esc 关闭"
            @keydown="onBranchSwitcherKeydown"
          />
        </div>
        <ul class="max-h-[50vh] overflow-y-auto p-1 pb-2">
          <li
            v-for="(b, idx) in bsResults"
            :id="`bs-item-${idx}`"
            :key="b.name + (b.remote ? '@' : '')"
            :class="[
              'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-base',
              idx === bsIndex && 'bg-primary/10',
              b.current && 'font-medium text-primary',
            ]"
            @click="pickBranch(b)"
            @mousemove="bsIndex = idx"
          >
            <Cloud v-if="b.remote" class="size-3.5 shrink-0 text-muted-foreground" />
            <GitBranch v-else class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ b.name }}</span>
            <span v-if="b.ahead" class="shrink-0 text-2xs text-[var(--c-mod)]">↑{{ b.ahead }}</span>
            <span v-if="b.behind" class="shrink-0 text-2xs text-[var(--c-conf)]">↓{{ b.behind }}</span>
            <span class="flex-1" />
            <Badge v-if="b.current" variant="default">当前</Badge>
            <Badge v-if="b.remote" variant="muted">远程</Badge>
          </li>
          <li v-if="!bsResults.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
            没有匹配的分支
          </li>
        </ul>
      </div>
    </div>

    <!-- 工作流执行确认：步骤预览 + 运行时输入 -->
    <div
      v-if="wfConfirm"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-wf-confirm-title"
      @click.self="wfConfirm = null"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-wf-confirm-title" class="mb-3 text-base font-semibold">执行工作流：{{ wfConfirm.wf.name }}</div>
        <div v-if="wfConfirm.slots.length" class="mb-2 space-y-1.5">
          <!-- 整行不能再用 <label> 包：<button> 也是 labelable 元素，Select 的触发器会
               把 label 的关联目标从输入框顶掉，点标签文字就会误开下拉。改成 for/id 显式关联 -->
          <div
            v-for="(slot, k) in wfConfirm.slots"
            :key="slot.index"
            class="flex items-center gap-2"
          >
            <label
              :for="`wf-slot-${slot.index}`"
              class="w-28 shrink-0 truncate text-xs text-muted-foreground"
              >{{ slot.label }}</label
            >
            <!-- 新建分支的槽带一个前缀下拉：候选就是「个性化 → 分支前缀」里配的那些，
                 不必在流程里手写。没有可选项（没配前缀、步骤也没配）时不显示，
                 否则就是一个只有「无前缀」的下拉 -->
            <Select
              v-if="slot.branch && (prefixes.length || slot.branch.prefix)"
              v-model="wfPrefixes[slot.index]"
              class="w-24 shrink-0"
              :options="[
                { value: '', label: '无前缀' },
                ...prefixes.map((p: string) => ({ value: p, label: p })),
              ]"
            />
            <Input
              :id="`wf-slot-${slot.index}`"
              v-model="wfInputs[slot.index]"
              v-focus="k === 0"
              class="h-7 text-xs"
              :placeholder="slotPlaceholder(slot)"
              @keydown.enter.prevent="imeConfirmFlow"
            />
          </div>
        </div>
        <ol class="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <li v-for="(s, i) in wfConfirm.wf.steps" :key="i">
            {{ i + 1 }}. {{ describeStep(s, status?.branch) }}
          </li>
          <li v-if="!wfConfirm.wf.steps.length">（空工作流，先到管理里添加步骤）</li>
        </ol>
        <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
          顺序执行、任一步失败立即中止。「提交推送」在有改动时自动全部暂存，无改动时跳过；
          工作区有未提交改动时拉取/合并可能失败或被带入提交。
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="wfConfirm = null">取消</Button>
          <Button
            variant="default"
            size="sm"
            :disabled="!flowInputsReady()"
            @click="confirmFlow"
          >
            执行
          </Button>
        </div>
      </div>
    </div>

    <!-- 工作流执行进度：逐步打勾，失败标红停住 -->
    <div
      v-if="wfRun && wfRunOpen"
      v-trap
      class="fixed inset-0 z-30 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-wf-run-title"
      @click.self="closeWfRun()"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-wf-run-title" class="mb-3 flex items-center gap-2 text-base font-semibold">
          <WorkflowIcon class="size-4 text-primary" />
          {{ wfRun.wf.name }}
          <span v-if="wfRun.start" class="text-xs font-normal text-muted-foreground">
            起始分支 {{ wfRun.start }}
          </span>
        </div>
        <ul class="space-y-2 text-base">
          <li v-for="(s, i) in wfRun.states" :key="i" class="flex items-start gap-2">
            <span class="flex w-4 shrink-0 justify-center pt-0.5">
              <Spinner v-if="s.state === 'running'" :size="13" />
              <Check v-else-if="s.state === 'done'" class="size-3.5 text-[var(--c-add)]" />
              <Minus v-else-if="s.state === 'skip'" class="size-3.5 text-muted-foreground" />
              <X v-else-if="s.state === 'fail'" class="size-3.5 text-destructive" />
              <span v-else class="size-2 rounded-full border border-border" />
            </span>
            <span class="min-w-0 flex-1" :class="s.state === 'fail' && 'text-destructive'">
              {{ describeStep(wfRun.wf.steps[i]!, wfRun.start) }}
              <span v-if="s.note" class="text-xs text-muted-foreground">· {{ s.note }}</span>
            </span>
          </li>
        </ul>
        <div
          v-if="wfRun.error"
          class="mt-3 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >{{ wfRun.error }}</div>
        <div class="mt-3 flex justify-end gap-2">
          <!-- 只在「某一步失败」时给重试：切走仓库导致的中止，重试没有意义 -->
          <Button
            v-if="wfRun.failIndex >= 0 && !wfRun.repoChanged"
            variant="default"
            size="sm"
            :disabled="busy"
            @click="retryFlow"
          >
            从失败处重试
          </Button>
          <Button variant="secondary" size="sm" @click="closeWfRun()">关闭</Button>
        </div>
      </div>
    </div>

    <!-- 拖拽仓库进窗口的提示遮罩 -->
    <div
      v-if="dragOver"
      class="pointer-events-none fixed inset-0 z-[70] grid place-items-center border-2 border-dashed border-primary/60 bg-primary/5 text-sm text-primary"
    >
      松开打开这个仓库
    </div>

    <!-- 错误确认框：居中展示，点确认才关 -->
    <div
      v-if="error"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-error-title"
      @click.self="dismissError()"
    >
      <!-- 错误框不用 surface：它要保持红色描边，会和 surface 自带的 border 打架 -->
      <div class="w-dlg-md rounded-lg border border-destructive/40 bg-elevated p-5 shadow-elev-4 pop-in">
        <div id="dlg-error-title" class="mb-3 text-base font-semibold text-destructive">操作失败</div>
        <div>{{ error }}</div>
        <details v-if="errDetail" class="mt-2">
          <summary class="cursor-pointer text-xs text-muted-foreground">详细信息</summary>
          <pre class="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{{ errDetail }}</pre>
        </details>
        <div class="mt-5 flex justify-end gap-2">
          <!-- 只对 run() 包起来的操作给重试：那是「重放一次同样的调用」，校验类错误重试没意义 -->
          <Button v-if="retryFn" variant="secondary" size="sm" @click="retryLast()">重试</Button>
          <Button variant="secondary" size="sm" @click="dismissError()">知道了</Button>
        </div>
      </div>
    </div>

    <!-- 危险操作确认框（删除分支/合并） -->
    <div
      v-if="confirmState"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-confirm-title"
      @click.self="confirmState = null"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-confirm-title" class="mb-3 text-base font-semibold">{{ confirmState.title }}</div>
        <div>{{ confirmState.body }}</div>
        <label v-if="confirmState.checkbox" class="mt-2 flex cursor-pointer items-center gap-2 text-xs">
          <input v-model="confirmChecked" type="checkbox" class="accent-[var(--primary)]" />
          {{ confirmState.checkbox }}
        </label>
        <div class="mt-5 flex justify-end gap-2">
          <Button ref="confirmCancelBtn" variant="ghost" size="sm" @click="confirmState = null">取消</Button>
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
            {{ confirmState.okText ?? "确认执行" }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur-slow) var(--ease-out);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
