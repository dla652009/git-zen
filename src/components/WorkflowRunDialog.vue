<script setup lang="ts">
// 工作流执行进度：步骤状态列表 + 从失败处重试。
// 从 App.vue 抽出来的第六批之二：wfRun / wfRunOpen 与 closeWfRun / retryFlow 都留在 App ——
// 关弹窗必须走 closeWfRun()（执行中只收起、不置空 wfRun），否则循环里会读到 null 崩掉。
// describeStep 是无状态纯函数，直接 import。
//
// 布局分工：标题固定（含起始分支），步骤与错误正文各自在框内滚动，动作固定在底部。
// 「执行期间可以关掉窗口、任务继续跑」这句必须常驻在动作上方 —— 用户不敢关窗就是因为它没被说出来。
import { computed } from "vue";
import { Check, Minus, Workflow as WorkflowIcon, X } from "@lucide/vue";
import { describeStep } from "../workflow";
import type { Workflow } from "../workflow";
import { Button, Spinner } from "@/components/ui";

interface WfStepState {
  state: "pending" | "running" | "done" | "skip" | "fail";
  note: string;
}

// 与 composables/useWorkflowRun.ts 里的 wfRun 结构一一对应（那边是局部类型，未导出）
interface WfRunView {
  wf: Workflow;
  start: string;
  states: WfStepState[];
  error: string;
  failIndex: number;
  repoChanged: boolean;
}

const props = defineProps<{ run: WfRunView | null; open: boolean; busy: boolean }>();
const emit = defineEmits<{ close: []; retry: [] }>();

/** 进度摘要：已完成 / 总数，和失败的那一步放在同一处，扫一眼就知道跑到哪了 */
const doneCount = computed(
  () => (props.run?.states ?? []).filter((s) => s.state === "done" || s.state === "skip").length,
);
const totalCount = computed(() => props.run?.states.length ?? 0);
</script>

<template>
  <Transition name="dlg">
  <div
    v-if="run && open"
    v-trap
    class="fixed inset-0 z-30 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-wf-run-title"
    @click.self="emit('close')"
  >
    <div class="dialog-shell w-dlg-md surface rounded-lg pop-in">
      <header class="dialog-header">
        <div class="flex items-center gap-2">
          <WorkflowIcon class="size-4 shrink-0 text-primary" aria-hidden="true" />
          <div id="dlg-wf-run-title" class="dialog-title min-w-0 flex-1 truncate" :title="run.wf.name">
            {{ run.wf.name }}
          </div>
          <span class="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
            {{ doneCount }}/{{ totalCount }}
          </span>
        </div>
        <!-- 起始分支是「切回起始分支」这类步骤的唯一参照，长名折行也不藏起来 -->
        <p v-if="run.start" class="mt-1 break-all text-xs text-muted-foreground">
          起始分支 {{ run.start }}
        </p>
      </header>

      <div class="dialog-body space-y-2">
        <ul class="space-y-2 text-base">
          <li v-for="(s, i) in run.states" :key="i" class="flex items-start gap-2">
            <span class="flex w-4 shrink-0 justify-center pt-0.5">
              <Spinner v-if="s.state === 'running'" :size="13" />
              <Check v-else-if="s.state === 'done'" class="size-3.5 text-[var(--c-add)]" />
              <Minus v-else-if="s.state === 'skip'" class="size-3.5 text-muted-foreground" />
              <X v-else-if="s.state === 'fail'" class="size-3.5 text-destructive" />
              <span v-else class="size-2 rounded-full border border-border" />
            </span>
            <span class="min-w-0 flex-1 break-words" :class="s.state === 'fail' && 'text-destructive'">
              {{ describeStep(run.wf.steps[i]!, run.start) }}
              <span v-if="s.note" class="text-xs text-muted-foreground">· {{ s.note }}</span>
            </span>
          </li>
        </ul>

        <!-- 错误正文可能很长（humanize 会附上原始 stderr）：单独滚动并压住高度，
             别让它把步骤列表和底部动作挤到框外 -->
        <div
          v-if="run.error"
          class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs leading-relaxed text-destructive"
        >{{ run.error }}</div>
      </div>

      <footer class="dialog-footer">
        <span class="mr-auto text-xs text-muted-foreground">执行期间可以关掉这个窗口，流程会继续跑</span>
        <!-- 只在「某一步失败」时给重试：切走仓库导致的中止，重试没有意义 -->
        <Button
          v-if="run.failIndex >= 0 && !run.repoChanged"
          variant="default"
          size="sm"
          :disabled="busy"
          @click="emit('retry')"
        >
          从失败处重试
        </Button>
        <Button variant="secondary" size="sm" @click="emit('close')">关闭</Button>
      </footer>
    </div>
  </div>
  </Transition>
</template>
