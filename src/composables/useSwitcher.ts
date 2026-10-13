// 两个快速切换器（Ctrl+P 切仓库 / Ctrl+B 切分支）：模糊搜索 + 键盘上下选。
// 从 App.vue 抽出来的第二批：除了「取数据」和「选中后做什么」，这里没有业务耦合。

import { computed, ref, watch, type Ref } from "vue";
import type { Branch } from "../gitApi";

// 只用到 path 与 name；RepoTab 定义在 App.vue，按结构取避免反向依赖
interface SwitcherRepo {
  path: string;
  name: string;
}

export function useSwitcher<T extends SwitcherRepo>(opts: {
  repos: Ref<T[]>;
  branchList: Ref<Branch[]>;
  hasRepo: () => boolean;
  onPickRepo: (path: string) => void;
  onPickBranch: (b: Branch) => void;
}) {
  // MRU 顺序是仓库切换器的排序依据；写入点在 App.vue（切仓库、关选项卡、启动播种）
  const mruPaths = ref<string[]>([]);

  // ---- 仓库切换器（Ctrl+P）----
  const showSwitcher = ref(false);
  const switcherQuery = ref("");
  const switcherIndex = ref(0);

  const switcherResults = computed(() => {
    const q = switcherQuery.value.trim().toLowerCase();
    const mru = (p: string) => {
      const i = mruPaths.value.indexOf(p);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const list = [...opts.repos.value];
    if (!q) return list.sort((a, b) => mru(a.path) - mru(b.path));
    return list
      .filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(q)) -
            Number(a.name.toLowerCase().startsWith(q)) || mru(a.path) - mru(b.path),
      );
  });

  function openSwitcher() {
    switcherQuery.value = "";
    switcherIndex.value = 0;
    showSwitcher.value = true;
  }
  function pickSwitcher(path: string) {
    showSwitcher.value = false;
    opts.onPickRepo(path);
  }
  function onSwitcherKeydown(e: KeyboardEvent) {
    // 输入法组词中：Enter 是确认候选词，不是「选中这一项」
    if (e.isComposing) return;
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

  // ---- 分支切换器（Ctrl+B）：复用仓库切换器的交互骨架 ----
  const showBranchSwitcher = ref(false);
  const bsQuery = ref("");
  const bsIndex = ref(0);
  const bsResults = computed(() => {
    const q = bsQuery.value.trim().toLowerCase();
    // 远程分支拷贝成剥前缀的 DWIM 名（switchBranch 直接 checkout 该名建跟踪分支）
    const list = opts.branchList.value
      .filter((b) => !b.name.endsWith("/HEAD"))
      .map((b): Branch & { originName?: string } =>
        b.remote ? { ...b, name: b.name.replace(/^[^/]+\//, ""), originName: b.name } : b,
      );
    if (!q) return list;
    return list
      .filter((b) => b.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)),
      );
  });
  function openBranchSwitcher() {
    if (!opts.hasRepo()) return;
    bsQuery.value = "";
    bsIndex.value = 0;
    showBranchSwitcher.value = true;
  }
  function pickBranch(b: Branch) {
    showBranchSwitcher.value = false;
    opts.onPickBranch(b);
  }
  function onBranchSwitcherKeydown(e: KeyboardEvent) {
    // 输入法组词中：Enter 是确认候选词，不是「选中这一项」
    if (e.isComposing) return;
    const n = bsResults.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      bsIndex.value = n ? (bsIndex.value + 1) % n : 0;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      bsIndex.value = n ? (bsIndex.value - 1 + n) % n : 0;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const b = bsResults.value[bsIndex.value];
      if (b) pickBranch(b);
    } else if (e.key === "Escape") {
      showBranchSwitcher.value = false;
    }
  }
  watch(bsQuery, () => (bsIndex.value = 0));
  watch(bsIndex, (i) => {
    document.getElementById(`bs-item-${i}`)?.scrollIntoView({ block: "nearest" });
  });

  return {
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
  };
}
