<script setup lang="ts">
// 工作流执行进度：步骤状态列表 + 从失败处重试。
// 从 App.vue 抽出来的第六批之二：wfRun / wfRunOpen 与 closeWfRun / retryFlow 都留在 App ——
// 关弹窗必须走 closeWfRun()（执行中只收起、不置空 wfRun），否则循环里会读到 null 崩掉。
// describeStep 是无状态纯函数，直接 import。
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

defineProps<{ run: WfRunView | null; open: boolean; busy: boolean }>();
const emit = defineEmits<{ close: []; retry: [] }>();
</script>

<template>
  <div
    v-if="run && open"
    v-trap
    class="fixed inset-0 z-30 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-wf-run-title"
    @click.self="emit('close')"
  >
    <div class="w-dlg-md surface rounded-lg p-5 pop-in">
      <div id="dlg-wf-run-title" class="mb-3 flex items-center gap-2 text-base font-semibold">
        <WorkflowIcon class="size-4 text-primary" />
        {{ run.wf.name }}
        <span v-if="run.start" class="text-xs font-normal text-muted-foreground">
          起始分支 {{ run.start }}
        </span>
      </div>
      <ul class="space-y-2 text-base">
        <li v-for="(s, i) in run.states" :key="i" class="flex items-start gap-2">
          <span class="flex w-4 shrink-0 justify-center pt-0.5">
            <Spinner v-if="s.state === 'running'" :size="13" />
            <Check v-else-if="s.state === 'done'" class="size-3.5 text-[var(--c-add)]" />
            <Minus v-else-if="s.state === 'skip'" class="size-3.5 text-muted-foreground" />
            <X v-else-if="s.state === 'fail'" class="size-3.5 text-destructive" />
            <span v-else class="size-2 rounded-full border border-border" />
          </span>
          <span class="min-w-0 flex-1" :class="s.state === 'fail' && 'text-destructive'">
            {{ describeStep(run.wf.steps[i]!, run.start) }}
            <span v-if="s.note" class="text-xs text-muted-foreground">· {{ s.note }}</span>
          </span>
        </li>
      </ul>
      <div
        v-if="run.error"
        class="mt-3 whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      >{{ run.error }}</div>
      <div class="mt-3 flex justify-end gap-2">
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
      </div>
    </div>
  </div>
</template>
