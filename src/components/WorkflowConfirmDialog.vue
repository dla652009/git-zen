<script setup lang="ts">
// 工作流执行确认：步骤预览 + 运行时输入槽（「新建分支」的槽带前缀下拉）。
// 从 App.vue 抽出来的第六批之一：状态与回调都留在 App（wfConfirm / wfInputs / wfPrefixes /
// flowInputsReady / confirmFlow 来自 composables/useWorkflowRun.ts），这里只渲染。
// inputs / prefixes 是模板直接写入的真双向数据（v-model 落在它们的属性上），用 defineModel；
// close / confirm 是动作，emit 回 App 走原来的代码路径。
//
// 布局分四层：范围（多仓库名单）→ 参数（运行时输入槽）→ 步骤（可滚动）→ 注意（风险单独一块），
// 读的人从上到下依次确认「动哪些仓库 / 要填什么 / 具体做什么 / 有什么不可逆的」。
import { computed } from "vue";
import { TriangleAlert, Workflow as WorkflowIcon } from "@lucide/vue";
import { imeGuard } from "../lib/imeGuard";
import { describeStep } from "../workflow";
import type { InputSlot, Workflow } from "../workflow";
import { Button, Input, Select } from "@/components/ui";

const props = defineProps<{
  confirm: { wf: Workflow; slots: InputSlot[] } | null;
  ready: boolean;
  statusBranch?: string;
  prefixOptions: string[];
  slotPlaceholder: (s: InputSlot) => string;
  /** 多仓库入口：要执行的仓库名（空 = 单仓库，行为与以前一致） */
  batchNames?: string[];
}>();

const inputs = defineModel<Record<number, string>>("inputs", { required: true });
const prefixes = defineModel<Record<number, string>>("prefixes", { required: true });
const stopOnFail = defineModel<boolean>("stopOnFail", { default: false });
const emit = defineEmits<{ close: []; confirm: [] }>();

// 删除类步骤不可逆：确认框里提前说一句，别等执行完才发现提交没了
const deletesBranch = computed(() =>
  !!props.confirm?.wf.steps.some(
    (s) => s.kind === "deleteBranch" || s.kind === "deleteRemoteBranch",
  ),
);

// Enter 提交走 keydown + isComposing：Chromium 里确认候选词那次 keyup 的 isComposing 已回 false
const imeConfirm = imeGuard(() => emit("confirm"));
</script>

<template>
  <Transition name="dlg">
  <div
    v-if="confirm"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-wf-confirm-title"
    @click.self="emit('close')"
  >
    <div class="dialog-shell w-dlg-md surface rounded-lg pop-in">
      <header class="dialog-header flex items-start gap-2">
        <WorkflowIcon class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <div id="dlg-wf-confirm-title" class="dialog-title">运行工作流：{{ confirm.wf.name }}</div>
          <p class="mt-0.5 text-xs text-muted-foreground">
            <span class="tabular-nums">{{ confirm.wf.steps.length }}</span> 个步骤 · 顺序执行，任一步失败立即中止
          </p>
        </div>
      </header>

      <div class="dialog-body space-y-3">
        <!-- 范围：多仓库入口才出现。名单可能很长，单独滚动，不把下面的步骤顶出视野 -->
        <section v-if="batchNames?.length" aria-label="执行范围">
          <div class="mb-1 flex flex-wrap items-baseline gap-x-1.5 text-xs">
            <span class="font-semibold text-foreground">范围</span>
            <span class="text-muted-foreground">
              对 <span class="font-medium text-foreground tabular-nums">{{ batchNames.length }}</span>
              个仓库依次执行（串行，一个跑完再跑下一个）
            </span>
          </div>
          <div class="rounded-md border border-border-soft bg-muted/30 px-3 py-2 text-xs">
            <div class="max-h-24 overflow-y-auto leading-relaxed text-foreground">{{ batchNames.join("、") }}</div>
            <label class="mt-2 flex items-center gap-1.5 text-muted-foreground">
              <input
                id="wf-stop-on-fail"
                v-model="stopOnFail"
                type="checkbox"
                class="size-3.5 shrink-0 accent-[var(--primary)]"
              >
              <span>某个仓库失败就停止后面的仓库</span>
            </label>
            <p class="mt-1.5 text-muted-foreground">流程里若用到 AI（如生成提交信息），每个仓库各调一次。</p>
          </div>
        </section>

        <!-- 参数：运行时输入槽。窄窗下靠容器查询改纵排（见文件末尾的 scoped 样式） -->
        <section v-if="confirm.slots.length" aria-label="运行参数">
          <div class="mb-1 text-xs font-semibold text-foreground">参数</div>
          <div class="wf-confirm-params space-y-2">
            <!-- 整行不能再用 <label> 包：<button> 也是 labelable 元素，Select 的触发器会
                 把 label 的关联目标从输入框顶掉，点标签文字就会误开下拉。改成 for/id 显式关联 -->
            <div v-for="(slot, k) in confirm.slots" :key="slot.index" class="wf-slot flex flex-wrap items-center gap-2">
              <!-- 标签允许换行：长参数名被 truncate 掉就分不清是哪个槽位（窄窗更明显） -->
              <label
                :for="`wf-slot-${slot.index}`"
                class="wf-slot-label w-28 shrink-0 text-xs leading-snug break-words text-muted-foreground"
                >{{ slot.label }}</label
              >
              <!-- 新建分支的槽带一个前缀下拉：候选就是「个性化 → 分支前缀」里配的那些，
                   不必在流程里手写。没有可选项（没配前缀、步骤也没配）时不显示，
                   否则就是一个只有「无前缀」的下拉。
                   下拉触发器是 button，外层 <label for> 关联不到它，可访问名称走 label → aria-label；
                   旁边那行文字已经写清了是哪个参数，所以不再额外出可见的「前缀」字样 -->
              <Select
                v-if="slot.branch && (prefixOptions.length || slot.branch.prefix)"
                :id="`wf-slot-prefix-${slot.index}`"
                v-model="prefixes[slot.index]"
                class="wf-slot-prefix h-7 w-32 shrink-0 text-xs"
                :label="`分支前缀：${slot.label}`"
                :options="[
                  { value: '', label: '无前缀' },
                  ...prefixOptions.map((p: string) => ({ value: p, label: p })),
                ]"
              />
              <Input
                :id="`wf-slot-${slot.index}`"
                v-model="inputs[slot.index]"
                v-focus="k === 0"
                class="h-7 min-w-32 flex-1 text-xs"
                :placeholder="slotPlaceholder(slot)"
                @keydown.enter.prevent="imeConfirm"
              />
            </div>
          </div>
        </section>

        <!-- 步骤：唯一一次通读整套动作的机会。长流程在框内滚动，标题与动作保持可见 -->
        <section aria-label="执行步骤">
          <div class="mb-1 text-xs font-semibold text-foreground">步骤</div>
          <ol class="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <li v-for="(s, i) in confirm.wf.steps" :key="i" class="break-words">
              {{ i + 1 }}. {{ describeStep(s, statusBranch) }}
            </li>
            <li v-if="!confirm.wf.steps.length">（空工作流，先到管理里添加步骤）</li>
          </ol>
        </section>

        <!-- 注意：常规说明与不可逆风险分开摆 —— 混成一段时，真正要命的那句会被读成顺带一提 -->
        <section aria-label="注意事项" class="space-y-1.5">
          <div class="text-xs font-semibold text-foreground">注意</div>
          <p class="text-xs leading-relaxed text-muted-foreground">
            「提交推送」在有改动时自动全部暂存，无改动时跳过；工作区有未提交改动时拉取/合并可能失败或被带入提交。
          </p>
          <div
            v-if="deletesBranch"
            class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          >
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 break-words">
              「删除分支」用强制 -D，未合并的提交会丢；「删除远程分支」直接作用于远程仓库。
            </span>
          </div>
        </section>
      </div>

      <footer class="dialog-footer">
        <span v-if="!ready" class="mr-auto text-xs text-muted-foreground">填完上面的参数才能执行</span>
        <Button variant="ghost" size="sm" @click="emit('close')">取消</Button>
        <Button variant="default" size="sm" :disabled="!ready" @click="emit('confirm')">执行</Button>
      </footer>
    </div>
  </div>
  </Transition>
</template>

<style scoped>
/* 窄窗（浮层被 max-width: calc(100vw - 32px) 压窄）下槽位改纵排：
   标签独占一行，前缀下拉与输入框各占整宽，长占位符不会被挤成几个字。
   容器查询不支持时，上一行的 flex-wrap 仍会把输入框换到下一行，只是标签和下拉还同行。 */
.wf-confirm-params {
  container-type: inline-size;
}

@container (max-width: 22rem) {
  .wf-slot {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .wf-slot-label {
    width: auto;
  }
  .wf-slot-prefix {
    width: 100%;
  }
}
</style>
