<script setup lang="ts">
// 提交热力图：GitHub 风格 12 个月每日提交格子（列=周，行=周一..周日）。
// 只统计 authorEmail（设置页填写的提交邮箱）名下的提交；格子几百个，tooltip 用原生 title
import { ref, watch } from "vue";
import * as api from "../gitApi";
import { Spinner } from "@/components/ui";

const props = defineProps<{ repo: string; authorEmail: string }>();

const DAY_MS = 86_400_000;

interface Cell {
  date: string;
  count: number;
  level: number; // 0-4 档位
  future: boolean; // 本周还没到的日子，占位不显示
}
const weeks = ref<Cell[][]>([]);
const monthLabels = ref<{ col: number; label: string }[]>([]);
const total = ref(0);
const loading = ref(true);
const failed = ref(false);

// 档位配色必须写字面量（Tailwind 扫描源码生成，动态拼接的类名不会出现）
const LEVEL_CLASS = ["bg-muted", "bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"];
const LEVEL_DESC = ["无提交", "1-2 次提交", "3-5 次提交", "6-9 次提交", "10 次以上"];
const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", "日"];

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function levelOf(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

let loadSeq = 0; // 邮箱连续变化时丢弃过期请求的结果
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  const seq = ++loadSeq;
  const email = props.authorEmail.trim();
  const today = new Date();
  try {
    const days = await api.commitStats(
      props.repo,
      isoDate(new Date(today.getTime() - 365 * DAY_MS)),
      email || undefined,
    );
    if (seq !== loadSeq) return;
    const byDate = new Map(days.map((d) => [d.date, d.count]));
    // 网格起点：371 天前对齐到周一（首列必是完整一周，最后一列到今天为止）
    const start = new Date(today.getTime() - 370 * DAY_MS);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const ws: Cell[][] = [];
    const months: { col: number; label: string }[] = [];
    let lastMonth = -1;
    let sum = 0;
    for (let col = 0; ; col++) {
      const monday = new Date(start.getTime() + col * 7 * DAY_MS);
      if (monday > today) break;
      if (monday.getMonth() !== lastMonth) {
        months.push({ col, label: `${monday.getMonth() + 1}月` });
        lastMonth = monday.getMonth();
      }
      const week: Cell[] = [];
      for (let row = 0; row < 7; row++) {
        const d = new Date(start.getTime() + (col * 7 + row) * DAY_MS);
        if (d > today) {
          week.push({ date: "", count: 0, level: 0, future: true });
          continue;
        }
        const date = isoDate(d);
        const count = byDate.get(date) ?? 0;
        sum += count;
        week.push({ date, count, level: levelOf(count), future: false });
      }
      ws.push(week);
    }
    weeks.value = ws;
    monthLabels.value = months;
    total.value = sum;
    failed.value = false;
  } catch {
    if (seq === loadSeq) failed.value = true;
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

// 邮箱是设置页的输入框草稿，边输入边重载（防抖 300ms）
watch(
  () => [props.repo, props.authorEmail] as const,
  () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 300);
  },
  { immediate: true },
);
</script>

<template>
  <!-- 未配置邮箱：没有"当前提交者"可过滤，显示引导而不是误导性的全量数据 -->
  <div v-if="!authorEmail.trim()" class="text-[11px] text-muted-foreground">
    先在上方填写提交邮箱，热力图将只统计该邮箱名下的提交。
  </div>
  <div v-else-if="failed" class="text-[11px] text-muted-foreground">
    无法加载提交统计（该仓库可能不是 Git 仓库或没有提交历史）。
  </div>
  <template v-else>
    <div class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        过去 12 个月
        <span :title="authorEmail" class="font-medium text-foreground">{{ authorEmail }}</span>
        共 <span class="font-medium text-foreground">{{ total }}</span> 次提交
      </span>
      <Spinner v-if="loading" :size="12" />
    </div>
    <!-- 宽度超出设置面板时横向滚动（GitHub 同款行为） -->
    <div class="overflow-x-auto pb-1">
      <div class="inline-flex min-w-max flex-col gap-1">
        <!-- 月份标尺：只在月份变化的列放标签 -->
        <div class="flex gap-[2px] pl-8">
          <div
            v-for="(w, col) in weeks"
            :key="'m' + col"
            class="relative h-3 w-[10px] shrink-0"
          >
            <span
              v-if="monthLabels.some((m) => m.col === col)"
              class="absolute left-0 whitespace-nowrap text-[9px] leading-3 text-muted-foreground"
            >
              {{ monthLabels.find((m) => m.col === col)!.label }}
            </span>
          </div>
        </div>
        <div class="flex gap-[2px]">
          <!-- 星期标尺 -->
          <div class="flex w-8 shrink-0 flex-col gap-[2px] text-right text-[9px] leading-none text-muted-foreground">
            <span
              v-for="(d, i) in WEEKDAY_LABELS"
              :key="i"
              class="flex h-[10px] items-center justify-end"
            >{{ d }}</span>
          </div>
          <!-- 热力格子 -->
          <div class="flex gap-[2px]">
            <div v-for="(w, col) in weeks" :key="col" class="flex flex-col gap-[2px]">
              <div
                v-for="(c, row) in w"
                :key="row"
                :class="[c.future ? 'opacity-0' : LEVEL_CLASS[c.level], 'size-[10px] rounded-[2px]']"
                :title="c.future ? undefined : `${c.date}：${LEVEL_DESC[c.level]}`"
              />
            </div>
          </div>
        </div>
        <!-- 图例 -->
        <div class="mt-1 flex items-center gap-1 pl-8 text-[9px] text-muted-foreground">
          <span>少</span>
          <span
            v-for="i in 5"
            :key="i"
            :class="[LEVEL_CLASS[i - 1], 'size-[10px] rounded-[2px]']"
          />
          <span>多</span>
        </div>
      </div>
    </div>
  </template>
</template>
