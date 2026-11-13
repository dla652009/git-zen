// 命令面板（Ctrl+K）：仓库 / 分支 / 动作混排搜索 + 键盘上下选。
// 交互骨架与 useSwitcher 一致；条目由 App 组装，这里只管过滤、选中与关闭。

import { computed, ref, watch, type Component, type Ref } from "vue";

export interface PaletteResult {
  kind: "repo" | "branch" | "action";
  id: string;
  label: string;
  detail?: string;
  icon?: Component;
  disabled?: boolean;
  run: () => void;
}

export function usePalette(opts: { items: Ref<PaletteResult[]> }) {
  const showPalette = ref(false);
  const paletteQuery = ref("");
  const paletteIndex = ref(0);

  const paletteResults = computed(() => {
    const items = opts.items.value;
    const q = paletteQuery.value.trim().toLowerCase();
    // 空查询：最近仓库前 5 + 全部动作；分支不参与（数量多，靠输入过滤）
    if (!q) {
      return [
        ...items.filter((i) => i.kind === "repo").slice(0, 5),
        ...items.filter((i) => i.kind === "action"),
      ];
    }
    // 仓库额外匹配路径，分支与动作只匹配名称
    return items.filter((i) => {
      if (i.label.toLowerCase().includes(q)) return true;
      return i.kind === "repo" && !!i.detail?.toLowerCase().includes(q);
    });
  });

  // 跳过禁用项，避免一打开就停在「刷新」这类不可执行的条目上
  function firstEnabled(): number {
    const i = paletteResults.value.findIndex((r) => !r.disabled);
    return i === -1 ? 0 : i;
  }
  function step(dir: number) {
    const list = paletteResults.value;
    const n = list.length;
    if (!n) return;
    let i = paletteIndex.value;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (!list[i].disabled) {
        paletteIndex.value = i;
        return;
      }
    }
  }

  function openPalette() {
    paletteQuery.value = "";
    paletteIndex.value = firstEnabled();
    showPalette.value = true;
  }
  function pickPalette(r?: PaletteResult) {
    if (!r || r.disabled) return;
    showPalette.value = false;
    r.run();
  }
  function onPaletteKeydown(e: KeyboardEvent) {
    // 输入法组词中：Enter 是确认候选词，不是「执行这一项」
    if (e.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickPalette(paletteResults.value[paletteIndex.value]);
    } else if (e.key === "Escape") {
      // 面板自己消费掉 Esc，别再冒泡到全局分层关闭链去关掉下面那一层
      e.stopPropagation();
      showPalette.value = false;
    }
  }
  watch(paletteQuery, () => (paletteIndex.value = firstEnabled()));
  // 键盘上下移动时把选中项滚进可视区
  watch(paletteIndex, (i) => {
    document.getElementById(`palette-item-${i}`)?.scrollIntoView({ block: "nearest" });
  });

  return {
    showPalette,
    paletteQuery,
    paletteIndex,
    paletteResults,
    openPalette,
    pickPalette,
    onPaletteKeydown,
  };
}
