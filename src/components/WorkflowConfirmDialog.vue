<script setup lang="ts">
// 工作流执行确认：步骤预览 + 运行时输入槽（「新建分支」的槽带前缀下拉）。
// 从 App.vue 抽出来的第六批之一：状态与回调都留在 App（wfConfirm / wfInputs / wfPrefixes /
// flowInputsReady / confirmFlow 来自 composables/useWorkflowRun.ts），这里只渲染。
// inputs / prefixes 是模板直接写入的真双向数据（v-model 落在它们的属性上），用 defineModel；
// close / confirm 是动作，emit 回 App 走原来的代码路径。
import { imeGuard } from "../lib/imeGuard";
import { describeStep } from "../workflow";
import type { InputSlot, Workflow } from "../workflow";
import { Button, Input, Select } from "@/components/ui";

defineProps<{
  confirm: { wf: Workflow; slots: InputSlot[] } | null;
  ready: boolean;
  statusBranch?: string;
  prefixOptions: string[];
  slotPlaceholder: (s: InputSlot) => string;
}>();

const inputs = defineModel<Record<number, string>>("inputs", { required: true });
const prefixes = defineModel<Record<number, string>>("prefixes", { required: true });
const emit = defineEmits<{ close: []; confirm: [] }>();

// Enter 提交走 keydown + isComposing：Chromium 里确认候选词那次 keyup 的 isComposing 已回 false
const imeConfirm = imeGuard(() => emit("confirm"));
</script>

<template>
  <div
    v-if="confirm"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-wf-confirm-title"
    @click.self="emit('close')"
  >
    <div class="w-dlg-md surface rounded-lg p-5 pop-in">
      <div id="dlg-wf-confirm-title" class="mb-3 text-base font-semibold">
        执行工作流：{{ confirm.wf.name }}
      </div>
      <div v-if="confirm.slots.length" class="mb-2 space-y-1.5">
        <!-- 整行不能再用 <label> 包：<button> 也是 labelable 元素，Select 的触发器会
             把 label 的关联目标从输入框顶掉，点标签文字就会误开下拉。改成 for/id 显式关联 -->
        <div v-for="(slot, k) in confirm.slots" :key="slot.index" class="flex items-center gap-2">
          <label
            :for="`wf-slot-${slot.index}`"
            class="w-28 shrink-0 truncate text-xs text-muted-foreground"
            >{{ slot.label }}</label
          >
          <!-- 新建分支的槽带一个前缀下拉：候选就是「个性化 → 分支前缀」里配的那些，
               不必在流程里手写。没有可选项（没配前缀、步骤也没配）时不显示，
               否则就是一个只有「无前缀」的下拉 -->
          <Select
            v-if="slot.branch && (prefixOptions.length || slot.branch.prefix)"
            v-model="prefixes[slot.index]"
            class="h-7 w-32 shrink-0 text-xs"
            :options="[
              { value: '', label: '无前缀' },
              ...prefixOptions.map((p: string) => ({ value: p, label: p })),
            ]"
          />
          <Input
            :id="`wf-slot-${slot.index}`"
            v-model="inputs[slot.index]"
            v-focus="k === 0"
            class="h-7 text-xs"
            :placeholder="slotPlaceholder(slot)"
            @keydown.enter.prevent="imeConfirm"
          />
        </div>
      </div>
      <ol class="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        <li v-for="(s, i) in confirm.wf.steps" :key="i">
          {{ i + 1 }}. {{ describeStep(s, statusBranch) }}
        </li>
        <li v-if="!confirm.wf.steps.length">（空工作流，先到管理里添加步骤）</li>
      </ol>
      <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
        顺序执行、任一步失败立即中止。「提交推送」在有改动时自动全部暂存，无改动时跳过；
        工作区有未提交改动时拉取/合并可能失败或被带入提交。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="emit('close')">取消</Button>
        <Button variant="default" size="sm" :disabled="!ready" @click="emit('confirm')">执行</Button>
      </div>
    </div>
  </div>
</template>
