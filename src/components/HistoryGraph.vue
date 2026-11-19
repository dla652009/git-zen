<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { layout, LANE_COLORS } from "../graph";
import type { LogEntry } from "../gitApi";
import { Badge, Button, Spinner, Tooltip } from "@/components/ui";
import { relDateText } from "@/lib/relDate";

// 泳道历史图：虚拟滚动——几千提交时只渲染可视区 ± BUFFER 行的内容与连线，
// 全量高度用空占位撑起（行高固定 26px，窗口换算无需测量）。
// 滚动容器内聚在本组件（App 只接 loadMore 事件），搜索过滤仍只决定哪些行可见
const props = defineProps<{
  commits: LogEntry[];
  head?: string;
  filter?: string;
  loadingMore: boolean; // 下一页正在拉取（App 的 loadMorePage 在飞）
  canLoadMore: boolean; // 还有下一页可拉；为假且不在加载 = 已到底
}>();
const emit = defineEmits<{
  openCommit: [c: LogEntry];
  commitMenu: [p: { x: number; y: number; c: LogEntry }];
  loadMore: [];
  /** 批量拣选：旧→新（按 cherry-pick 的依赖顺序，先拣祖先） */
  batchCherryPick: [hashes: string[]];
  /** 批量撤销：新→旧（先撤最近提交，避免相互覆盖） */
  batchRevert: [hashes: string[]];
  /** 压成一条：base 是这批提交的父提交（soft reset 的目标） */
  squashRange: [p: { base: string; hashes: string[]; subjects: string[] }];
  /** 导出 patch：范围 base..head（base = 最早选中项的父提交） */
  exportPatch: [p: { base: string; head: string; count: number }];
  /** 比较两个提交：a 旧、b 新 */
  compareRange: [p: { a: string; b: string; aSubject: string; bSubject: string }];
  selectionChange: [n: number];
}>();

const ROW_H = 26;
const COL_W = 14;
const R = 4;
const BUFFER = 30; // 视口外上下各多渲染的行数（快速滚动时不露白）

const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportH = ref(600);

function onScroll() {
  const el = viewport.value;
  if (!el) return;
  scrollTop.value = el.scrollTop;
  viewportH.value = el.clientHeight;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) emit("loadMore");
}

function tip(c: LogEntry): string {
  return [
    c.subject,
    `${c.hash.slice(0, 10)} · ${c.author} · ${shortDate(c.date)}`,
    c.refs.length ? c.refs.join(" ") : "",
    "再次单击查看变更 · 右键更多操作",
  ]
    .filter(Boolean)
    .join("\n");
}

// 单击选中（轻反馈零代价），双击同一行才打开 diff——防扫视误触弹大窗
const selected = ref("");
// 多选是叠加在单选之上的独立状态：Ctrl/Cmd 改它，Shift 按 shown 顺序铺一段，
// 无修饰键单击只清它、完全走原来的单选语义
const selection = ref<Set<string>>(new Set());
// Shift 范围起点。保持「上一次无修饰/ Ctrl 单击的行」，连续 Shift 始终从同一起点扩展
let rangeAnchor = "";

function onRowClick(c: LogEntry, e: MouseEvent) {
  viewport.value?.focus({ preventScroll: true });
  if (e.shiftKey) {
    if (!rangeAnchor) rangeAnchor = c.hash;
    extendTo(c.hash);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(selection.value);
    if (next.has(c.hash)) next.delete(c.hash);
    else next.add(c.hash);
    selection.value = next;
    rangeAnchor = c.hash;
    return;
  }
  // 无修饰键：先清多选，再走原来的单选/打开 diff
  if (selection.value.size) selection.value = new Set();
  rangeAnchor = c.hash;
  if (selected.value === c.hash) emit("openCommit", c);
  else selected.value = c.hash;
}

// Shift 范围按当前可见顺序（shown）铺；锚点被过滤掉时退化为只选当前行
function extendTo(hash: string) {
  const list = shown.value;
  const from = list.findIndex((c) => c.hash === rangeAnchor);
  const to = list.findIndex((c) => c.hash === hash);
  const next = new Set(selection.value);
  if (from === -1 || to === -1) {
    next.add(hash);
  } else {
    const [a, b] = from <= to ? [from, to] : [to, from];
    for (let i = a; i <= b; i++) next.add(list[i].hash);
  }
  selection.value = next;
}

function clearSelection() {
  rangeAnchor = "";
  if (selection.value.size) selection.value = new Set();
}

// 选中行按 shown 顺序（新→旧）取；批量操作各自决定正序还是逆序
const selectedEntries = computed(() => shown.value.filter((c) => selection.value.has(c.hash)));
const selectionCount = computed(() => selection.value.size);
watch(selection, (s) => emit("selectionChange", s.size));

// 全量布局保证泳道稳定；过滤只决定哪些行可见，连线跨过隐藏提交连到最近可见祖先
const shown = computed(() => {
  const q = (props.filter ?? "").trim().toLowerCase();
  if (!q) return props.commits;
  return props.commits.filter(
    (c) => c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q)
  );
});

const lay = computed(() => layout(props.commits));

function color(col: number) {
  return LANE_COLORS[col % LANE_COLORS.length];
}

const displayRow = computed(() => {
  const m = new Map<string, number>();
  shown.value.forEach((c, i) => m.set(c.hash, i));
  return m;
});

const parentMap = computed(() => {
  const m = new Map<string, string[]>();
  props.commits.forEach((c) => m.set(c.hash, c.parents));
  return m;
});

// 过滤/刷新后把已经不可见的 hash 从多选里摘掉，避免「已选 N」含看不见的提交
watch(shown, (list) => {
  const visible = new Set(list.map((c) => c.hash));
  if (rangeAnchor && !visible.has(rangeAnchor)) rangeAnchor = "";
  if (!selection.value.size) return;
  const kept = [...selection.value].filter((h) => visible.has(h));
  if (kept.length !== selection.value.size) selection.value = new Set(kept);
});

// 压成一条的前置条件：至少 2 个、在真实历史里连续、最早那个有父提交。
// 连续性按 props.commits（而不是 shown）判定——过滤隐藏的中间提交也算断开，
// 否则 soft reset 到 base 会把没选中的提交一起压掉
const squashInfo = computed(() => {
  const picked = selectedEntries.value;
  if (picked.length < 2) return null;
  const index = new Map(props.commits.map((c, i) => [c.hash, i]));
  const positions = picked.map((c) => index.get(c.hash)!).sort((a, b) => a - b);
  const sequential = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
  // props.commits 是新→旧：下标越大越早；最早选中项的 parents[0] 就是要保留的父提交
  const oldest = props.commits[positions[positions.length - 1]];
  const base = oldest?.parents[0] ?? "";
  // picked 是新→旧，反过来给 App 一份旧→新（提交信息的自然叙述顺序）
  const chronological = [...picked].reverse();
  return {
    base,
    sequential,
    contiguous: sequential && !!base,
    hashes: chronological.map((c) => c.hash),
    subjects: chronological.map((c) => c.subject),
  };
});
const canSquash = computed(() => !!squashInfo.value?.contiguous);
const squashHint = computed(() => {
  if (canSquash.value) return "把所选提交压成一条，改动回到暂存区后重新提交";
  if (!squashInfo.value?.sequential) return "所选提交不连续";
  return "所选提交包含根提交，没有父提交可回退";
});

// 导出 patch：base..head 会包含区间内所有提交，所以和压条同判定——
// 区间内必须全部选中，否则导出的 patch 里会混进用户没选的提交。单选也允许。
const exportInfo = computed(() => {
  const picked = selectedEntries.value;
  if (!picked.length) return null;
  const index = new Map(props.commits.map((c, i) => [c.hash, i]));
  const positions = picked.map((c) => index.get(c.hash)!).sort((a, b) => a - b);
  const sequential = positions.every((p, i) => i === 0 || p === positions[i - 1] + 1);
  const oldest = props.commits[positions[positions.length - 1]];
  const base = oldest?.parents[0] ?? "";
  return {
    base,
    sequential,
    head: picked[0].hash, // picked 是 shown 顺序（新→旧），第一条就是最新选中项
    count: picked.length,
    contiguous: sequential && !!base,
  };
});
const canExport = computed(() => !!exportInfo.value?.contiguous);
const exportHint = computed(() => {
  if (canExport.value) return "导出所选区间的 patch（区间内提交需全部选中）";
  if (!exportInfo.value?.sequential) return "所选提交不连续";
  return "所选提交包含根提交，没有父提交可作为起点";
});

// 比较 A..B：恰好两个时出现；props.commits 新→旧，下标大的更早，作为 a
const comparePair = computed(() => {
  if (selectionCount.value !== 2) return null;
  const [x, y] = selectedEntries.value;
  if (!x || !y) return null;
  const index = new Map(props.commits.map((c, i) => [c.hash, i]));
  const ix = index.get(x.hash);
  const iy = index.get(y.hash);
  if (ix === undefined || iy === undefined) return null;
  const [older, newer] = ix > iy ? [x, y] : [y, x];
  return { a: older, b: newer };
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && selection.value.size) {
    e.stopPropagation();
    clearSelection();
  }
}

function emitCherryPick() {
  // 旧→新：先拣祖先，后代才落得下来
  emit("batchCherryPick", [...selectedEntries.value].reverse().map((c) => c.hash));
}
function emitBatchRevert() {
  // 新→旧：先撤最近的，避免前一条的撤销被后面的改动挡住
  emit("batchRevert", selectedEntries.value.map((c) => c.hash));
}
function emitSquash() {
  const info = squashInfo.value;
  if (!info?.contiguous) return;
  emit("squashRange", { base: info.base, hashes: info.hashes, subjects: info.subjects });
}
function emitExportPatch() {
  const info = exportInfo.value;
  if (!info?.contiguous) return;
  emit("exportPatch", { base: info.base, head: info.head, count: info.count });
}
function emitCompare() {
  const pair = comparePair.value;
  if (!pair) return;
  emit("compareRange", {
    a: pair.a.hash,
    b: pair.b.hash,
    aSubject: pair.a.subject,
    bSubject: pair.b.subject,
  });
}

// 沿 parent 链向上找最近的可见祖先（过滤掉的中间节点被跳过）
function nearestShownAncestor(hash: string): string | null {
  const dRow = displayRow.value;
  const parents = parentMap.value;
  const queue = [...(parents.get(hash) ?? [])];
  const seen = new Set([hash]);
  while (queue.length) {
    const h = queue.shift()!;
    if (seen.has(h)) continue;
    seen.add(h);
    if (dRow.has(h)) return h;
    queue.push(...(parents.get(h) ?? []));
  }
  return null;
}

// 可视窗口（行号区间）：内容行与连线只在此范围内生成
const winStart = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - BUFFER));
const winEnd = computed(() =>
  Math.min(shown.value.length, Math.ceil((scrollTop.value + viewportH.value) / ROW_H) + BUFFER),
);
const visible = computed(() => shown.value.slice(winStart.value, winEnd.value));

// 列表末尾的分页指示：只对非空列表渲染（空列表由「无匹配提交」承担）。
// 它是普通块级元素，只给 scrollHeight 增加固定的 24px；行与连线全部绝对定位在定高占位块里，
// scrollTop / viewportH 又都取自容器，因此可视区间与连线窗口的换算不受影响
const showTailHint = computed(
  () => shown.value.length > 0 && (props.loadingMore || !props.canLoadMore)
);

// SVG 连线：child -> 最近可见祖先，竖向贝塞尔；窗口外的连线不画
// （跨窗口的长边在滚动中短暂消失，换来的常数级 DOM 是值得的）
const edgesSvg = computed(() => {
  const dRow = displayRow.value;
  const out: string[] = [];
  const drawn = new Set<string>();
  const maxY = (winEnd.value + BUFFER) * ROW_H;
  for (let di = winStart.value; di < winEnd.value; di++) {
    const c = shown.value[di];
    if (!c) continue;
    const targets = new Set<string>();
    for (const p of c.parents) {
      if (dRow.has(p)) targets.add(p);
      else {
        const a = nearestShownAncestor(p);
        if (a && a !== c.hash) targets.add(a);
      }
    }
    for (const t of targets) {
      const key = c.hash + ">" + t;
      if (drawn.has(key)) continue;
      drawn.add(key);
      const y1 = di * ROW_H + ROW_H / 2;
      const y2 = dRow.get(t)! * ROW_H + ROW_H / 2;
      if (y2 <= y1 || y2 > maxY) continue; // 只向下连；目标在窗口外不画
      const x1 = lay.value.colOf.get(c.hash)! * COL_W + COL_W / 2;
      const x2 = lay.value.colOf.get(t)! * COL_W + COL_W / 2;
      const mid = (y1 + y2) / 2;
      out.push(`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`);
    }
  }
  return out;
});

function refVariant(ref: string): "default" | "muted" | "info" | "warning" {
  if (ref === "HEAD") return "warning";
  if (ref.startsWith("tag: ")) return "muted"; // 标签与分支用色区分
  if (ref.startsWith("origin/")) return "info";
  return "default";
}

// ── refs 徽标：一行宽度有限，得把「远程分支的完整名字」压短 ──
// 同屏最多摆 2 枚，其余折成「+N」，否则一条挂了很多 ref 的提交会把主题挤没。
const REFS_SHOWN = 2;

/** 显示的短名：远程分支去掉 origin/（蓝色徽标已经表示远程），标签去掉 tag: */
function refLabel(ref: string): string {
  if (ref === "HEAD") return "HEAD";
  if (ref.startsWith("tag: ")) return ref.slice(5);
  return ref.startsWith("origin/") ? ref.slice(7) : ref;
}

/** tooltip 给全名：短名把 origin/ 去掉后，光看徽标分不出本地还是远程的同名分支 */
function refTitle(ref: string): string {
  if (ref === "HEAD") return "HEAD（当前检出）";
  if (ref.startsWith("tag: ")) return `标签 ${ref.slice(5)}`;
  return ref.startsWith("origin/") ? `远程分支 ${ref}` : `本地分支 ${ref}`;
}

/** 折起来的那些 refs，tooltip 里一次列全 */
function restRefs(c: LogEntry): string {
  return c.refs
    .slice(REFS_SHOWN)
    .map((r) => refTitle(r))
    .join("\n");
}

// 日期本地化统一走 lib/relDate：git 给的是英文 "3 days ago"，这里转中文
const shortDate = relDateText;

// 搜索命中高亮：把主题按命中位置切段渲染（不区分大小写）
const hitSegments = computed(() => {
  const q = (props.filter ?? "").trim().toLowerCase();
  if (!q) return null;
  return (subject: string): { text: string; hit: boolean }[] => {
    const segs: { text: string; hit: boolean }[] = [];
    const lower = subject.toLowerCase();
    let i = 0;
    while (i < subject.length) {
      const at = lower.indexOf(q, i);
      if (at === -1) {
        segs.push({ text: subject.slice(i), hit: false });
        break;
      }
      if (at > i) segs.push({ text: subject.slice(i, at), hit: false });
      segs.push({ text: subject.slice(at, at + q.length), hit: true });
      i = at + q.length;
    }
    return segs;
  };
});
</script>

<template>
  <!-- 滚动容器内聚：App 只接 loadMore。tabindex 让 Esc 清多选落在历史区内部，
       不去抢全局键盘（Ctrl+F、浮层 Esc 关闭等保持原样） -->
  <div
    ref="viewport"
    tabindex="0"
    class="history-viewport h-full overflow-y-auto"
    @scroll="onScroll"
    @keydown="onKeydown"
  >
    <div v-if="!shown.length" class="grid h-full place-items-center text-sm text-muted-foreground">
      无匹配提交
    </div>
    <div v-else class="relative" :style="{ height: shown.length * ROW_H + 'px' }">
      <svg
        class="pointer-events-none absolute top-0 left-0"
        :width="lay.cols * COL_W"
        :height="shown.length * ROW_H"
      >
        <path
          v-for="(d, i) in edgesSvg"
          :key="i"
          :d="d"
          :style="{ fill: 'none', stroke: 'var(--graph-line)', strokeWidth: '1.5px' }"
        />
        <circle
          v-for="(c, vi) in visible"
          :key="c.hash"
          :cx="lay.colOf.get(c.hash)! * COL_W + COL_W / 2"
          :cy="(winStart + vi) * ROW_H + ROW_H / 2"
          :r="R"
          :style="{
            fill: color(lay.colOf.get(c.hash)!),
            // 用画布色描一圈 1.5px：相邻泳道靠得近时，圆点不会糊成一条
            stroke: 'var(--background)',
            strokeWidth: '1.5px',
          }"
        />
      </svg>

      <div
        v-for="(c, vi) in visible"
        :key="c.hash"
        class="group/history absolute isolate flex cursor-pointer items-center gap-1.5 overflow-hidden border-l-2 border-l-transparent pr-3 whitespace-nowrap"
        :style="{
          top: (winStart + vi) * ROW_H + 'px',
          height: ROW_H + 'px',
          left: 0,
          right: 0,
          // 点击区域保留整行，底色单独从泳道右侧开始，避免遮挡 SVG。
          paddingLeft: lay.cols * COL_W + 'px',
        }"
        @click="onRowClick(c, $event)"
        @contextmenu.prevent="emit('commitMenu', { x: $event.clientX, y: $event.clientY, c })"
      >
        <span
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 -z-10 transition-colors duration-fast"
          :class="selected === c.hash ? 'bg-row-selected' : selection.has(c.hash) ? 'bg-row-selected-strong' : 'group-hover/history:bg-hover'"
          :style="{ left: lay.cols * COL_W + 'px' }"
        />
        <!-- 多选的左标记落在泳道与文字之间，而不是面板最左缘；
             单选只靠底色，保持和参考图一致的安静选中态。 -->
        <span
          v-if="selection.has(c.hash)"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 w-[2px] bg-primary"
          :style="{ left: lay.cols * COL_W + 'px' }"
        />
        <!-- 一行三段争宽度：主题 / refs / 作者·hash·时间。优先级从高到低，
             主题保底 min-w-0 flex-1，refs 可收缩（min-w-0 才破得开 auto 最小尺寸，
             否则 nowrap 的徽标永远撑满自己的内容宽），元信息固定窄列不参与争夺。 -->
        <span class="min-w-0 flex-1 truncate text-foreground" :title="tip(c)">
          <template v-if="hitSegments" v-for="(seg, si) in hitSegments(c.subject)" :key="si"
            ><mark v-if="seg.hit" class="rounded-sm bg-primary/30 px-0.5 text-foreground">{{ seg.text }}</mark
            ><template v-else>{{ seg.text }}</template></template
          >
          <template v-else>{{ c.subject }}</template>
        </span>
        <!-- refs 区：最多 2 枚，其余折成「+N」；整体可收缩，单枚再兜一层 truncate -->
        <span v-if="c.refs.length" class="flex min-w-0 max-w-[45%] shrink items-center gap-1">
          <Badge
            v-for="r in c.refs.slice(0, REFS_SHOWN)"
            :key="r"
            :variant="refVariant(r)"
            class="min-w-0 shrink overflow-hidden"
            :title="refTitle(r)"
            ><span class="truncate">{{ refLabel(r) }}</span></Badge
          >
          <Badge v-if="c.refs.length > REFS_SHOWN" variant="muted" class="shrink-0" :title="restRefs(c)"
            >+{{ c.refs.length - REFS_SHOWN }}</Badge
          >
        </span>
        <!-- 元信息比主题低一档：作者 / 相对时间统一 text-xs。
             hash 不再占行内位置（一眼认不出、也背不下来，真要复制走 tooltip）。
             宽度按内容收紧，不写死列宽：写死时作者那格 flex-1 会把剩余空间全吃掉，
             作者和日期之间就空出一大块。现在元信息整体贴右，日期仍跨行右对齐。
             选中行不能沿用 muted-foreground：它在浅色主题的淡紫底上只有 4.0–4.2:1；
             半透明的前景色也会被底色稀释（latte 只有 3.3–3.8），所以选中时直接回到前景色，
             层级交给字号与字重，不拿对比度换。 -->
        <span
          class="history-meta flex min-w-0 max-w-[35%] shrink items-center gap-1.5 text-xs tabular-nums"
          :class="
            selected === c.hash || selection.has(c.hash)
              ? 'text-foreground'
              : 'text-muted-foreground'
          "
          :title="`${c.author} · ${c.hash} · ${shortDate(c.date)}`"
        >
          <span class="min-w-0 truncate">{{ c.author }}</span>
          <span class="shrink-0 text-right whitespace-nowrap">{{ shortDate(c.date) }}</span>
        </span>
      </div>
    </div>
    <!-- 末尾指示条：滚到分页边界时给出「正在加载 / 已到底」的反馈，不然页面完全静止 -->
    <div
      v-if="showTailHint"
      aria-live="polite"
      class="flex h-6 items-center justify-center text-xs text-muted-foreground"
    >
      <Spinner v-if="loadingMore" :size="12" label="正在加载更多…" />
      <span v-else>已到底部</span>
    </div>
    <!-- 批量操作条：sticky 在列表底部，不随滚动离开视口。
         选中 1 个也显示（导出 patch 对单个提交同样有意义），批量按钮从 2 个起出现 -->
    <div
      v-if="selectionCount >= 1"
      class="pointer-events-none sticky bottom-0 z-20 flex justify-center px-2 pb-2"
    >
      <div
        class="pointer-events-auto surface-menu shadow-elev-3 flex items-center gap-1 rounded-md px-2 py-1"
      >
        <span class="px-1 text-xs text-muted-foreground">已选 {{ selectionCount }}</span>
        <template v-if="selectionCount >= 2">
          <Button variant="ghost" size="sm" @click="emitCherryPick">Cherry-pick</Button>
          <Button variant="ghost" size="sm" @click="emitBatchRevert">Revert</Button>
          <Tooltip :text="squashHint">
            <span class="inline-flex">
              <Button variant="ghost" size="sm" :disabled="!canSquash" @click="emitSquash">
                压成一条
              </Button>
            </span>
          </Tooltip>
        </template>
        <Tooltip :text="exportHint">
          <span class="inline-flex">
            <Button variant="ghost" size="sm" :disabled="!canExport" @click="emitExportPatch">
              导出 patch
            </Button>
          </span>
        </Tooltip>
        <Button v-if="comparePair" variant="ghost" size="sm" @click="emitCompare">比较 A..B</Button>
        <Button variant="ghost" size="sm" @click="clearSelection">清除</Button>
      </div>
    </div>
  </div>
</template>
