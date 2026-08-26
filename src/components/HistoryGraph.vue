<script setup lang="ts">
import { computed } from "vue";
import { layout, LANE_COLORS } from "../graph";
import type { LogEntry } from "../gitApi";
import { Badge, Tooltip } from "@/components/ui";

const props = defineProps<{ commits: LogEntry[]; head?: string; filter?: string }>();
const emit = defineEmits<{ openCommit: [c: LogEntry] }>();

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

// 过滤后再布局：被过滤掉的 commit 不占行，其连线自动断开（layout 已容错）
const shown = computed(() => {
  const q = (props.filter ?? "").trim().toLowerCase();
  if (!q) return props.commits;
  return props.commits.filter(
    (c) => c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q)
  );
});

const lay = computed(() => layout(shown.value));

function color(col: number) {
  return LANE_COLORS[col % LANE_COLORS.length];
}

// SVG 连线：child -> parent 竖向贝塞尔
const edgesSvg = computed(() =>
  lay.value.edges.map((e) => {
    const y1 = e.from.row * ROW_H + ROW_H / 2;
    const y2 = e.to.row * ROW_H + ROW_H / 2;
    const x1 = e.from.col * COL_W + COL_W / 2;
    const x2 = e.to.col * COL_W + COL_W / 2;
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  })
);

function refVariant(ref: string): "default" | "muted" | "info" | "warning" {
  if (ref === "HEAD") return "warning";
  if (ref.startsWith("origin/")) return "info";
  return "default";
}
</script>

<template>
  <div class="relative" :style="{ '--row-h': ROW_H + 'px' }">
    <!-- 过滤模式下父子连线必然断裂，隐藏泳道改纯列表展示 -->
    <svg
      v-if="!filter"
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
        :style="{ paddingLeft: (filter ? 12 : lay.cols * COL_W) + 'px' }"
        @dblclick="emit('openCommit', c)"
      >
        <Tooltip :text="tip(c)">
          <span class="flex-1 truncate">{{ c.subject }}</span>
        </Tooltip>
        <Badge v-for="r in c.refs" :key="r" :variant="refVariant(r)">{{ r }}</Badge>
        <span class="shrink-0 text-[11.5px] text-muted-foreground">{{ c.author }} · {{ c.date }}</span>
      </li>
    </ul>
  </div>
</template>
