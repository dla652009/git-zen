<script setup lang="ts">
import { ref, computed } from "vue";
import { layout, LANE_COLORS } from "../graph";
import type { LogEntry } from "../gitApi";
import { Badge, Tooltip } from "@/components/ui";

// 泳道历史图：虚拟滚动——几千提交时只渲染可视区 ± BUFFER 行的内容与连线，
// 全量高度用空占位撑起（行高固定 26px，窗口换算无需测量）。
// 滚动容器内聚在本组件（App 只接 loadMore 事件），搜索过滤仍只决定哪些行可见
const props = defineProps<{ commits: LogEntry[]; head?: string; filter?: string }>();
const emit = defineEmits<{
  openCommit: [c: LogEntry];
  commitMenu: [p: { x: number; y: number; c: LogEntry }];
  loadMore: [];
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
    "点击查看变更，右键更多操作",
  ]
    .filter(Boolean)
    .join("\n");
}

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
  <!-- 滚动容器内聚：App 只接 loadMore -->
  <div ref="viewport" class="h-full overflow-y-auto" @scroll="onScroll">
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
          fill="none"
          stroke="#3a4450"
          stroke-width="1.5"
        />
        <circle
          v-for="(c, vi) in visible"
          :key="c.hash"
          :cx="lay.colOf.get(c.hash)! * COL_W + COL_W / 2"
          :cy="(winStart + vi) * ROW_H + ROW_H / 2"
          :r="R"
          :fill="color(lay.colOf.get(c.hash)!)"
        />
      </svg>

      <div
        v-for="(c, vi) in visible"
        :key="c.hash"
        class="absolute flex cursor-pointer items-center gap-1.5 overflow-hidden pr-3 whitespace-nowrap hover:bg-muted/60"
        :style="{
          top: (winStart + vi) * ROW_H + 'px',
          height: ROW_H + 'px',
          left: lay.cols * COL_W + 'px',
          right: 0,
        }"
        @click="emit('openCommit', c)"
        @contextmenu.prevent="emit('commitMenu', { x: $event.clientX, y: $event.clientY, c })"
      >
        <Tooltip :text="tip(c)">
          <span class="flex-1 truncate">
            <template v-if="hitSegments" v-for="(seg, si) in hitSegments(c.subject)" :key="si"
              ><mark v-if="seg.hit" class="rounded-sm bg-primary/30 px-0.5 text-foreground">{{ seg.text }}</mark
              ><template v-else>{{ seg.text }}</template></template
            >
            <template v-else>{{ c.subject }}</template>
          </span>
        </Tooltip>
        <Badge v-for="r in c.refs" :key="r" :variant="refVariant(r)">{{ r.replace(/^tag: /, "") }}</Badge>
        <span class="shrink-0 text-[11.5px] text-muted-foreground">{{ c.author }} · {{ c.date }}</span>
      </div>
    </div>
  </div>
</template>
