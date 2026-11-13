<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { layout, LANE_COLORS } from "../graph";
import type { LogEntry } from "../gitApi";
import { Badge, Button, Spinner, Tooltip } from "@/components/ui";

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
    `${c.hash.slice(0, 10)} · ${c.author} · ${c.date}`,
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
    class="h-full overflow-y-auto"
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
          :style="{ fill: color(lay.colOf.get(c.hash)!) }"
        />
      </svg>

      <div
        v-for="(c, vi) in visible"
        :key="c.hash"
        class="absolute flex cursor-pointer items-center gap-1.5 overflow-hidden border-l-2 pr-3 whitespace-nowrap transition-colors duration-fast hover:bg-hover"
        :class="[
          selected === c.hash ? 'bg-primary-soft' : selection.has(c.hash) && 'bg-primary/15',
        ]"
        :style="{
          top: (winStart + vi) * ROW_H + 'px',
          height: ROW_H + 'px',
          left: lay.cols * COL_W + 'px',
          right: 0,
          // 左侧 2px 蓝条标记多选；单选仍是 bg-primary-soft，两者可叠加区分
          borderLeftColor: selection.has(c.hash) ? 'var(--primary)' : 'transparent',
        }"
        @click="onRowClick(c, $event)"
        @contextmenu.prevent="emit('commitMenu', { x: $event.clientX, y: $event.clientY, c })"
      >
        <span class="flex-1 truncate" :title="tip(c)">
          <template v-if="hitSegments" v-for="(seg, si) in hitSegments(c.subject)" :key="si"
            ><mark v-if="seg.hit" class="rounded-sm bg-primary/30 px-0.5 text-foreground">{{ seg.text }}</mark
            ><template v-else>{{ seg.text }}</template></template
          >
          <template v-else>{{ c.subject }}</template>
        </span>
        <Badge v-for="r in c.refs" :key="r" :variant="refVariant(r)">{{ r.replace(/^tag: /, "") }}</Badge>
        <span
          class="max-w-[38%] shrink-0 truncate text-sm text-muted-foreground tabular-nums"
          :title="`${c.author} · ${c.date}`"
          >{{ c.author }} · {{ c.date }}</span
        >
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
    <!-- 批量操作条：sticky 在列表底部，不随滚动离开视口 -->
    <div
      v-if="selectionCount >= 2"
      class="pointer-events-none sticky bottom-0 z-20 flex justify-center px-2 pb-2"
    >
      <div
        class="pointer-events-auto surface-menu shadow-elev-3 flex items-center gap-1 rounded-md px-2 py-1"
      >
        <span class="px-1 text-xs text-muted-foreground">已选 {{ selectionCount }}</span>
        <Button variant="ghost" size="sm" @click="emitCherryPick">Cherry-pick</Button>
        <Button variant="ghost" size="sm" @click="emitBatchRevert">Revert</Button>
        <Tooltip :text="squashHint">
          <span class="inline-flex">
            <Button variant="ghost" size="sm" :disabled="!canSquash" @click="emitSquash">
              压成一条
            </Button>
          </span>
        </Tooltip>
        <Button variant="ghost" size="sm" @click="clearSelection">清除</Button>
      </div>
    </div>
  </div>
</template>
