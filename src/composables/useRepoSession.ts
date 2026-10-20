// 仓库会话：刷新（静默 fetch + 竞态序号）、历史分页、打开仓库时的后台 fetch、切仓库。
// 从 App.vue 抽出来的第五批：注入当前仓库与历史/视图相关的 ref、缓存函数与报错回调，
// git 调用、localStorage 读取都是无状态模块，直接 import。

import { nextTick, ref } from "vue";
import type { Ref } from "vue";
import * as api from "../gitApi";
import type { Branch, LogEntry, Status, TagEntry } from "../gitApi";
import { readJsonObject } from "../lib/safeJson";
import type { RepoCache } from "./useRepoCache";

export function useRepoSession(opts: {
  repo: Ref<string>;
  status: Ref<Status | null>;
  commits: Ref<LogEntry[]>;
  branchList: Ref<Branch[]>;
  tags: Ref<TagEntry[]>;
  busy: Ref<boolean>;
  historyMode: Ref<"current" | "all">;
  historyFilePath: Ref<string | null>;
  fileHistoryModal: Ref<string | null>;
  filter: Ref<string>;
  historyLoading: Ref<boolean>;
  mruPaths: Ref<string[]>;
  remoteRaw: Ref<string>;
  remoteLink: Ref<string>;
  cacheGet: (path: string) => RepoCache | null;
  cachePeek: (path: string) => RepoCache | undefined;
  cachePut: (path: string, data: RepoCache) => void;
  showError: (msg: string) => void;
}) {
  const {
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
  } = opts;

  // 刷新按钮动画 + 整页刷新遮罩
  const refreshing = ref(false);
  async function doRefresh() {
    if (busy.value) return; // 操作进行中不并发刷新
    refreshing.value = true;
    try {
      await refresh({ fetch: true });
    } finally {
      refreshing.value = false;
    }
  }

  // 统一的历史拉取入口：带上 视图范围（--all）、文件历史（--follow -- path）与文件路径过滤。
  // path 显式传入（默认当前仓库）——await 期间仓库可能已切走，隐式读 repo.value 会让调用方
  // 很难把「这次请求属于哪个仓库」和结果对应起来（历史范围 watcher 的串台就出在这里）。
  function fetchLog(skip = 0, path = repo.value) {
    return api.log(
      path,
      skip,
      historyMode.value === "all" ? true : undefined,
      historyFilePath.value ?? undefined,
    );
  }

  // fetch=true 时先静默 fetch 远程再拉数据——ahead/behind 基于本地 remote-tracking refs，
  // 不 fetch 就永远看不到「远程有新提交可拉」；离线时 fetch 失败不打扰，仍刷新本地状态。
  // 操作后的刷新（run()）不带 fetch：pull/push 已更新过 refs，无需重复网络请求
  // 刷新序号：窗口聚焦、F5、操作后刷新可能并发（focus 那条不看 busy），
  // 让「后发起的那次」胜出——否则先发起的旧请求晚回来会把提交后的新状态覆盖回旧值
  // 进行中的多步操作（合并/拣选/撤销/变基）与剩余冲突数。冲突文件是「暂存即减少」的，
  // 所以它必须跟 status 一起刷新，否则右侧那条进度永远停在第一次的数字上。
  const op = ref<api.OpState | null>(null);

  let refreshSeq = 0;
  async function refresh(opts: { fetch?: boolean } = {}) {
    // 仓库身份快照：await 期间用户可能已切走（Ctrl+Tab / Ctrl+数字绕过 busy 检查）
    const path = repo.value;
    if (!path) return;
    const seq = ++refreshSeq;
    if (opts.fetch) {
      await api.fetchAll(path).catch(() => {});
      if (repo.value !== path || seq !== refreshSeq) return;
    }
    remoteLink.value = readJsonObject<Record<string, string>>("gz.remoteLinks", {})[path] ?? "";
    try {
      const [s, l, b, tg, o] = await Promise.all([
        api.status(path),
        fetchLog(0, path),
        api.branches(path),
        api.tagList(path),
        api.opState(path),
      ]);
      // 结果属于已切走的仓库：丢弃，别写进新仓库的视图与 LRU 槽（否则切回来还是错数据）
      // seq 过期同理丢弃：已有更新的一次刷新在跑，它的结果才是真相
      if (repo.value !== path || seq !== refreshSeq) return;
      status.value = s;
      commits.value = l;
      branchList.value = b;
      tags.value = tg;
      op.value = o;
      canLoadMore.value = l.length >= 300;
      cachePut(path, { status: s, commits: l, branchList: b, tags: tg });
    } catch (e) {
      if (repo.value === path && seq === refreshSeq) showError(String(e));
    }
  }

  const canLoadMore = ref(false);
  const loadingMore = ref(false);

  async function loadMorePage() {
    if (!repo.value || !canLoadMore.value || filter.value || loadingMore.value) return;
    const path = repo.value; // 仓库身份快照：翻页期间可能已切走
    loadingMore.value = true;
    try {
      const next = await fetchLog(commits.value.length, path);
      // 仓库已切走：丢弃过期分页，别把上一仓库的提交 push 进新仓库的历史数组
      if (repo.value !== path) return;
      commits.value.push(...next);
      canLoadMore.value = next.length >= 300;
    } catch (e) {
      showError(String(e));
    } finally {
      loadingMore.value = false;
    }
  }

  // 打开/切回仓库时后台 fetch 一次，成功后把 status 一并重拉——
  // 否则 refs 已更新而头部 ahead/behind 徽标还停在 fetch 前的旧值（分支树与徽标不一致）。
  // 静默失败（离线时保留本地视图）；切换期间的过期结果按 path 守卫丢弃
  function fetchOnce() {
    const path = repo.value;
    if (!path) return;
    api.fetchAll(path)
      .then(async () => {
        if (repo.value !== path || busy.value) return;
        const [s, b] = await Promise.all([api.status(path), api.branches(path)]);
        if (repo.value !== path) return;
        status.value = s;
        branchList.value = b;
        // 缓存快照同步更新，避免切回时又恢复 fetch 前的旧 status
        const c = cachePeek(path);
        if (c) cachePut(path, { ...c, status: s, branchList: b });
      })
      .catch(() => {});
    api.remoteUrl(path)
      .then((u) => {
        if (repo.value === path) remoteRaw.value = u;
      })
      .catch(() => {});
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
    tags.value = [];
    canLoadMore.value = false;
    fileHistoryModal.value = null;
    historyFilePath.value = null;
    remoteRaw.value = "";
    remoteLink.value = "";

    // LRU 命中：秒开缓存快照，后台静默刷新轻量数据
    const cached = cacheGet(path);
    if (cached) {
      status.value = cached.status;
      commits.value = cached.commits;
      branchList.value = cached.branchList;
      tags.value = cached.tags;
      canLoadMore.value = cached.commits.length >= 300;
      fetchOnce();
      api.branches(path)
        .then((b) => seq === activateSeq && (branchList.value = b))
        .catch(() => {});
      api.opState(path)
        .then((o) => seq === activateSeq && (op.value = o))
        .catch(() => {});
      return;
    }

    historyLoading.value = true;
    await nextTick();
    if (seq !== activateSeq) return;
    try {
      const [s, b, tg, o] = await Promise.all([
        api.status(path),
        api.branches(path),
        api.tagList(path),
        api.opState(path),
      ]);
      if (seq !== activateSeq) return;
      status.value = s;
      branchList.value = b;
      tags.value = tg;
      op.value = o;
      commits.value = [];
      canLoadMore.value = false;
      await nextTick();
      const l = await fetchLog(0, path);
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

  return {
    refreshing,
    doRefresh,
    fetchLog,
    refresh,
    op,
    canLoadMore,
    loadingMore,
    loadMorePage,
    fetchOnce,
    activate,
  };
}
