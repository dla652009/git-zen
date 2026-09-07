<script setup lang="ts">
import { computed } from "vue";
import { layout, LANE_COLORS } from "../graph";
import type { LogEntry } from "../gitApi";
import { Badge, Tooltip } from "@/components/ui";

const props = defineProps<{ commits: LogEntry[]; head?: string; filter?: string }>();
const emit = defineEmits<{
  openCommit: [c: LogEntry];
  commitMenu: [p: { x: number; y: number; c: LogEntry }];
}>();

// hover 提示：完整信息多行展示
function tip(c: LogEntry): string {
  return [
    c.subject,
    `${c.hash.slice(0, 10)} · ${c.author} · ${c.date}`,
    c.refs.length ? c.refs.join(" ") : "",
    "双击查看变更",
  ]
    .filter(Boolean)
    .join("\n");
}

const ROW_H = 26;
const COL_W = 14;
const R = 4;

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

// SVG 连线：child -> 最近可见祖先，竖向贝塞尔；跨行距离大时曲线自然变长
const edgesSvg = computed(() => {
  const dRow = displayRow.value;
  const out: string[] = [];
  const drawn = new Set<string>();
  shown.value.forEach((c, di) => {
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
      if (y2 <= y1) continue; // 只向下连
      const x1 = lay.value.colOf.get(c.hash)! * COL_W + COL_W / 2;
      const x2 = lay.value.colOf.get(t)! * COL_W + COL_W / 2;
      const mid = (y1 + y2) / 2;
      out.push(`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`);
    }
  });
  return out;
});

function refVariant(ref: string): "default" | "muted" | "info" | "warning" {
  if (ref === "HEAD") return "warning";
  if (ref.startsWith("tag: ")) return "muted"; // 标签与分支用色区分
  if (ref.startsWith("origin/")) return "info";
  return "default";
}
</script>

<template>
  <div class="relative" :style="{ '--row-h': ROW_H + 'px' }">
    <svg
      class="absolute top-0 left-0"
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
        v-for="(c, i) in shown"
        :key="c.hash"
        :cx="lay.colOf.get(c.hash)! * COL_W + COL_W / 2"
        :cy="i * ROW_H + ROW_H / 2"
        :r="R"
        :fill="color(lay.colOf.get(c.hash)!)"
      />
    </svg>

    <ul>
      <li
        v-for="c in shown"
        :key="c.hash"
        class="flex h-[var(--row-h)] cursor-pointer items-center gap-1.5 overflow-hidden pr-3 whitespace-nowrap hover:bg-muted/60"
        :style="{ paddingLeft: lay.cols * COL_W + 'px' }"
        @dblclick="emit('openCommit', c)"
        @contextmenu.prevent="emit('commitMenu', { x: $event.clientX, y: $event.clientY, c })"
      >
        <Tooltip :text="tip(c)">
          <span class="flex-1 truncate">{{ c.subject }}</span>
        </Tooltip>
        <Badge v-for="r in c.refs" :key="r" :variant="refVariant(r)">{{ r.replace(/^tag: /, "") }}</Badge>
        <span class="shrink-0 text-[11.5px] text-muted-foreground">{{ c.author }} · {{ c.date }}</span>
      </li>
    </ul>
  </div>
</template>
