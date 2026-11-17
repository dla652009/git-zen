<script setup lang="ts">
// 工作流执行中「AI 生成不了提交信息，请手填一句」的输入框。
//
// 为什么做成独立的小弹窗而不是塞进进度列表里：执行流此刻是真的停住等这一句，
// 用户必须看见并回应；嵌在滚动的步骤列表里很容易被忽略（尤其执行了很久之后）。
import { computed, nextTick, ref, watch } from "vue";
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
      <div class="surface w-dlg-md rounded-lg p-5 pop-in">
        <div id="wf-ask-title" class="mb-1 text-base font-semibold">手动填写提交信息</div>
        <!-- 把 AI 失败的真实原因摆出来：用户才知道是开关没开、Key 过期还是网络断了 -->
        <p class="mb-3 text-xs leading-relaxed text-muted-foreground">{{ ask.reason }}</p>
        <p class="mb-3 text-xs leading-relaxed text-muted-foreground">
          流程已停在这一步等待。填一条提交信息即可继续执行后面的步骤；取消则本步骤失败、流程停住。
        </p>
        <Input
          ref="inputEl"
          v-model="text"
          placeholder="例如：fix: 修复登录页在 Safari 下的白屏"
          aria-label="提交信息"
          @keydown="onKeydown"
        />
        <div class="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" @click="emit('answer', null)">取消执行</Button>
          <Button variant="default" size="sm" :disabled="!ready" @click="confirm">
            用这条信息继续
          </Button>
        </div>
      </div>
    </div>
  </Transition>
</template>
