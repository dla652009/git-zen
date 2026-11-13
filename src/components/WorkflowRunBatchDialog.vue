<script setup lang="ts">
// 多仓库批次进度：一行一个仓库，展开看步骤。
// 执行期允许关掉弹窗（批次可能跑很久），状态留在 useWorkflowRun 的 wfBatch 里继续更新 ——
// 关窗必须走 closeWfBatch()，它在 busy 期间只收起、不置空。
import { computed, ref, watch } from "vue";
import { Check, ChevronDown, Minus, FolderGit2, Workflow as WorkflowIcon, X } from "@lucide/vue";
import { describeStep } from "../workflow";
import type { Workflow } from "../workflow";
import { Button, Spinner } from "@/components/ui";

interface StepView {
  state: "pending" | "running" | "done" | "skip" | "fail";
  note: string;
}

interface RowView {
  path: string;
  name: string;
  startBranch: string;
  state: "pending" | "running" | "done" | "fail" | "skipped";
  states: StepView[];
  error: string;
  failIndex: number;
}

// 与 composables/useWorkflowRun.ts 的 wfBatch 结构一一对应
interface BatchView {
  wf: Workflow;
  rows: RowView[];
  stopOnFail: boolean;
  cur: number;
  done: boolean;
}

const props = defineProps<{ batch: BatchView | null; open: boolean; busy: boolean; repo: string }>();
const emit = defineEmits<{ close: []; retry: [index: number]; switchTo: [path: string] }>();

const expanded = ref<string[]>([]);
function toggle(path: string) {
  expanded.value = expanded.value.includes(path)
    ? expanded.value.filter((p) => p !== path)
    : [...expanded.value, path];
}
function show(path: string): boolean {
  return expanded.value.includes(path);
}

// 正在跑的仓库自动展开 —— 否则用户只看到一行「进行中」，不知道卡在哪一步
watch(
  () => [props.batch?.cur, props.batch?.rows.length] as const,
  () => {
    const b = props.batch;
    const row = b && b.cur >= 0 ? b.rows[b.cur] : null;
    if (row && !expanded.value.includes(row.path)) expanded.value = [...expanded.value, row.path];
  },
);
// 换了一个批次就重置展开状态
watch(
  () => props.batch?.wf.name,
  () => (expanded.value = []),
);

const counts = computed(() => {
  const rows = props.batch?.rows ?? [];
  return {
    total: rows.length,
    done: rows.filter((r) => r.state === "done").length,
    fail: rows.filter((r) => r.state === "fail").length,
    skipped: rows.filter((r) => r.state === "skipped").length,
  };
});

const STATE_TEXT: Record<RowView["state"], string> = {
  pending: "等待",
  running: "进行中",
  done: "完成",
  fail: "失败",
  skipped: "跳过",
};

function stepDone(r: RowView): string {
  const total = r.states.length;
  const done = r.states.filter((s) => s.state === "done" || s.state === "skip").length;
  return `${done}/${total}`;
}
</script>

<template>
  <div
    v-if="batch && open"
    v-trap
    class="fixed inset-0 z-30 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-wf-batch-title"
    @click.self="emit('close')"
  >
    <div class="w-dlg-lg surface rounded-lg p-5 pop-in">
      <div id="dlg-wf-batch-title" class="mb-1 flex items-center gap-2 text-base font-semibold">
        <WorkflowIcon class="size-4 text-primary" />
        {{ batch.wf.name }}
        <span class="text-xs font-normal text-muted-foreground">
          {{ counts.total }} 个仓库
        </span>
      </div>
      <div class="mb-3 text-xs text-muted-foreground">
        <template v-if="!batch.done">
          已完成 {{ counts.done }}/{{ counts.total }}<span v-if="counts.fail">，失败 {{ counts.fail }}</span>
        </template>
        <template v-else>
          全部结束：成功 {{ counts.done }}<span v-if="counts.fail">，失败 {{ counts.fail }}</span><span
            v-if="counts.skipped"
          >，跳过 {{ counts.skipped }}</span>
        </template>
        <span v-if="batch.stopOnFail" class="ml-1">（勾了「失败即停」）</span>
      </div>

      <ul class="max-h-[55vh] space-y-1.5 overflow-auto pr-1 text-base">
        <li v-for="(r, i) in batch.rows" :key="r.path" class="rounded-md border border-border-soft">
          <div class="flex items-start gap-2 px-2 py-1.5">
            <span class="flex w-4 shrink-0 justify-center pt-0.5">
              <Spinner v-if="r.state === 'running'" :size="13" />
              <Check v-else-if="r.state === 'done'" class="size-3.5 text-[var(--c-add)]" />
              <Minus v-else-if="r.state === 'skipped'" class="size-3.5 text-muted-foreground" />
              <X v-else-if="r.state === 'fail'" class="size-3.5 text-destructive" />
              <span v-else class="size-2 rounded-full border border-border" />
            </span>
            <button
              type="button"
              class="min-w-0 flex-1 text-left"
              :aria-expanded="show(r.path)"
              @click="toggle(r.path)"
            >
              <div class="flex items-center gap-1.5">
                <ChevronDown
                  class="size-3 shrink-0 text-muted-foreground transition-transform duration-110"
                  :class="show(r.path) ? '' : '-rotate-90'"
                />
                <span class="truncate font-medium" :class="r.path === repo ? 'text-primary' : ''">{{ r.name }}</span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ STATE_TEXT[r.state] }}</span>
                <span v-if="r.states.length" class="shrink-0 text-xs text-muted-foreground">
                  {{ stepDone(r) }}
                </span>
              </div>
              <div v-if="r.error" class="mt-0.5 whitespace-pre-wrap text-xs text-destructive">
                {{ r.error }}
              </div>
            </button>
            <div class="flex shrink-0 items-center gap-1">
              <Button
                v-if="r.state === 'fail' && !busy"
                variant="quiet"
                size="sm"
                @click="emit('retry', i)"
              >
                重试
              </Button>
              <Button
                v-if="r.path !== repo && !busy"
                variant="quiet"
                size="sm"
                :title="`切换到 ${r.name}`"
                @click="emit('switchTo', r.path)"
              >
                <FolderGit2 class="size-3.5" />
              </Button>
            </div>
          </div>
          <ul v-if="show(r.path)" class="space-y-1 pb-2 pl-8 pr-2 text-sm">
            <li v-for="(s, si) in r.states" :key="si" class="flex items-start gap-2">
              <span class="flex w-3.5 shrink-0 justify-center pt-0.5">
                <Spinner v-if="s.state === 'running'" :size="11" />
                <Check v-else-if="s.state === 'done'" class="size-3 text-[var(--c-add)]" />
                <Minus v-else-if="s.state === 'skip'" class="size-3 text-muted-foreground" />
                <X v-else-if="s.state === 'fail'" class="size-3 text-destructive" />
                <span v-else class="size-1.5 rounded-full border border-border" />
              </span>
              <span class="min-w-0 flex-1" :class="s.state === 'fail' && 'text-destructive'">
                {{ describeStep(batch.wf.steps[si]!, r.startBranch) }}
                <span v-if="s.note" class="text-xs text-muted-foreground">· {{ s.note }}</span>
              </span>
            </li>
          </ul>
        </li>
      </ul>

      <div class="mt-3 flex items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">执行期间可以关掉这个窗口，流程会继续跑</span>
        <Button variant="secondary" size="sm" @click="emit('close')">关闭</Button>
      </div>
    </div>
  </div>
</template>
