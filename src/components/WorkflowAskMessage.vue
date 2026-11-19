<script setup lang="ts">
// 工作流执行中「AI 生成不了提交信息，请手填一句」的输入框。
//
// 为什么做成独立的小弹窗而不是塞进进度列表里：执行流此刻是真的停住等这一句，
// 用户必须看见并回应；嵌在滚动的步骤列表里很容易被忽略（尤其执行了很久之后）。
//
// 布局重点：先把「流程停住了」说清楚，再给输入，最后把「取消 = 本步骤失败」的后果
// 摆在取消按钮旁边 —— 这是用户唯一会误判的地方（以为取消只是关掉这个框）。
import { computed, nextTick, ref, watch } from "vue";
import { Pause } from "@lucide/vue";
import { Button, Input } from "@/components/ui";

const ask = defineModel<{ reason: string; draft: string } | null>("ask", { required: true });

const emit = defineEmits<{ answer: [value: string | null] }>();

const text = ref("");
const inputEl = ref<{ $el: HTMLInputElement } | null>(null);

watch(
  () => ask.value,
  async (v) => {
    if (!v) return;
    text.value = v.draft;
    // 打开即聚焦：这一步卡着整条流程，让用户少点一次
    await nextTick();
    inputEl.value?.$el.focus();
  },
);

const ready = computed(() => text.value.trim().length > 0);

function confirm() {
  if (!ready.value) return;
  emit("answer", text.value.trim());
}
// 输入法组词中的 Enter 是确认候选词，不该顺手提交半成品
function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    confirm();
  }
}
</script>

<template>
  <Transition name="dlg">
    <div
      v-if="ask"
      v-trap
      class="fixed inset-0 z-50 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wf-ask-title"
    >
      <div class="dialog-shell w-dlg-md surface rounded-lg pop-in">
        <header class="dialog-header">
          <div id="wf-ask-title" class="dialog-title">手动填写提交信息</div>
          <p class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Pause class="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            工作流已停在这一步，等你回应
          </p>
        </header>

        <div class="dialog-body space-y-3">
          <!-- 把 AI 失败的真实原因摆出来：用户才知道是开关没开、Key 过期还是网络断了 -->
          <section aria-label="为什么需要手动填写" class="space-y-1">
            <div class="text-xs font-semibold text-foreground">原因</div>
            <p class="break-words text-xs leading-relaxed text-muted-foreground">{{ ask.reason }}</p>
          </section>

          <div class="dialog-field">
            <label for="wf-ask-input" class="text-xs font-semibold text-foreground">提交信息</label>
            <Input
              id="wf-ask-input"
              ref="inputEl"
              v-model="text"
              placeholder="例如：fix: 修复登录页在 Safari 下的白屏"
              aria-describedby="wf-ask-effect"
              @keydown="onKeydown"
            />
            <p id="wf-ask-effect" class="text-xs leading-relaxed text-muted-foreground">
              填一条提交信息即可继续执行后面的步骤。
            </p>
          </div>

          <!-- 取消的真实后果：前面已执行的步骤不会回退，本步骤按失败处理 -->
          <div class="rounded-md border border-border-soft bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <span class="font-medium text-foreground">取消执行</span>
            会让本步骤失败、流程停在这里；已跑完的步骤不会回退，之后可以从失败处重试。
          </div>
        </div>

        <footer class="dialog-footer">
          <Button variant="ghost" size="sm" @click="emit('answer', null)">取消执行</Button>
          <Button variant="default" size="sm" :disabled="!ready" @click="confirm">用这条信息继续</Button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
