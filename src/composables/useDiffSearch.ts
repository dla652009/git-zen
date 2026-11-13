// diff 内搜索状态机：命中计算、游标、跳转与滚动定位。
// DiffViewer（多文件分段）与 FileHistoryModal（单段）共用；差异全部经 opts 注入，
// 纯查找逻辑仍在 lib/diffSearch.ts。
import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from "vue";
// 显式 .ts：本文件的自检脚本（src/lib/useDiffSearch.test.ts）用 Node strip-types 直跑，
// ESM 不做无扩展名解析；tsconfig 已开 allowImportingTsExtensions
import { searchSections, type Segment } from "../lib/diffSearch.ts";

export interface DiffSearchSection {
  file: string;
  lines: { text: string }[];
}

export function useDiffSearch(opts: {
  /** 供搜索的分段数据：每段 = 一个文件 / 一份 diff */
  sections: ComputedRef<DiffSearchSection[]>;
  /** 当前展示的 section 下标（FH 恒 0；DV 由 selectedFile 派生） */
  activeSection: ComputedRef<number>;
  /** 命中落在非当前 section 时回调：DV 用它切 selectedFile；FH 不传 */
  onHitInOtherSection?: (section: number) => void;
  /** 焦点/DOM 查找范围（默认 document）；两个 diff 弹层同时存在时靠它区分 */
  root?: Ref<HTMLElement | null>;
  /** 关闭搜索后焦点交还目标的选择器 */
  focusBackSelector?: string;
}) {
  const searchOpen = ref(false);
  const q = ref("");
  const cur = ref(-1); // 当前停在第几个命中；-1 表示没有

  const found = computed(() => searchSections(opts.sections.value, q.value));
  const count = computed(() => found.value.count);

  // 当前命中落在「正在渲染的那一段」的哪一行；不在这一段就是 -1（不画高亮）
  const hitRow = computed(() => {
    const h = cur.value >= 0 ? found.value.hits[cur.value] : undefined;
    return h && h.section === opts.activeSection.value ? h.row : -1;
  });
  // 查询为空时给 null，让模板走回纯文本渲染：否则每一行都要白白建一个片段数组
  const segments = computed<Segment[][] | null>(() =>
    q.value.trim() ? (found.value.sections[opts.activeSection.value]?.rows ?? null) : null,
  );
  const segsFor = (li: number): Segment[] | null => segments.value?.[li] ?? null;

  function scope(): ParentNode | null {
    return opts.root ? opts.root.value : typeof document !== "undefined" ? document : null;
  }

  function focusSearch() {
    void nextTick(() => scope()?.querySelector<HTMLInputElement>("[data-search-input]")?.focus());
  }

  function goTo(d: number) {
    if (!count.value) return;
    cur.value = (cur.value + d + count.value) % count.value;
  }

  function toggleSearch() {
    if (searchOpen.value) {
      focusSearch();
      return;
    }
    searchOpen.value = true;
    cur.value = count.value ? 0 : -1;
    focusSearch();
  }

  // 关搜索要把焦点交还给搜索开关：输入框随 v-if 一起被卸掉，浏览器会把焦点丢回 body，
  // 而 v-trap 的 Tab 循环是绑在弹层容器上的（focusTrap.ts 的 el.addEventListener）——
  // 焦点一旦离开容器它就收不到事件，下一次 Tab 会直接穿透到弹层背后。
  function closeSearch() {
    searchOpen.value = false;
    q.value = "";
    cur.value = -1;
    const sel = opts.focusBackSelector;
    if (sel) void nextTick(() => scope()?.querySelector<HTMLElement>(sel)?.focus());
  }

  watch(q, () => (cur.value = count.value ? 0 : -1));
  // 查询变了、或游标动了，都要把当前命中滚进视野（跟浏览器查找一样，边打字边定位）。
  // 必须同时盯 found，不能只盯 cur：cur 已经是 0 时，敲下一个字符 watch(q) 又把它设回 0，
  // 值没变 → Vue 用 Object.is 比较后不触发 → 高亮已经跳到第 1 个命中，视图却还停在顶部，
  // 回车会「先到第 2 个」。found 是 computed，查询一变引用就变，靠它兜住这一步。
  watch([found, cur], async () => {
    const h = cur.value >= 0 ? found.value.hits[cur.value] : undefined;
    if (!h) return;
    if (h.section !== opts.activeSection.value) opts.onHitInOtherSection?.(h.section);
    await nextTick();
    scope()?.querySelector('[data-hit="1"]')?.scrollIntoView({ block: "center" });
  });

  return {
    searchOpen,
    q,
    cur,
    found,
    count,
    hitRow,
    segsFor,
    goTo,
    toggleSearch,
    closeSearch,
    focusSearch,
  };
}
