<script setup lang="ts">
import { computed } from "vue";
import { Bot, X } from "@lucide/vue";
import { Button, Md, Spinner } from "@/components/ui";

// open 由 App.vue 的 reviewOpen 传入（overlayLayers.aiReview 指向它）；生成与保存仍在 App
const open = defineModel<boolean>("open", { required: true });

const props = defineProps<{
  // 未推送提交数：标题与「重新生成」的门槛都用它（无上游时为 undefined）
  ahead: number | undefined;
  busy: boolean;
  err: string;
  text: string;
  saved: boolean;
}>();

const emit = defineEmits<{ save: []; regen: [] }>();

// 头部只留「这是什么 + 范围 + 生成状态」三层，正文专心读报告。
// 生成状态与保存结果分开放：前者说「有没有内容」，后者是动作回执，留在按钮旁边
const rangeLabel = computed(() =>
  props.ahead === undefined ? "未推送的提交（当前分支无上游）" : `未推送的 ${props.ahead} 个提交`
);
const status = computed(() => {
  if (props.busy) return { text: "正在生成…", tone: "text-primary" };
  if (props.err) return { text: "生成失败", tone: "text-destructive" };
  if (props.text) return { text: "已生成", tone: "" };
  return { text: "待生成", tone: "" };
});
</script>

<template>
  <Transition name="dlg">
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-30 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-review-title"
    @click.self="open = false"
  >
    <!-- dialog-shell：固定头尾 + 正文主滚动，四周留出屏幕余量 -->
    <div class="dialog-shell w-dlg-xl surface rounded-lg pop-in">
      <header class="dialog-header">
        <div class="flex items-center gap-2">
          <Bot class="size-4 shrink-0 text-primary" />
          <span id="dlg-review-title" class="dialog-title">AI Review</span>
          <span class="flex-1" />
          <Button variant="quiet" size="icon" class="h-6 w-6" aria-label="关闭" @click="open = false">
            <X class="size-4" />
          </Button>
        </div>
        <!-- 生成范围与状态各占一层：范围不会随滚动消失，状态变化不挤动标题 -->
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span class="tabular-nums">{{ rangeLabel }}</span>
          <span aria-hidden="true">·</span>
          <span class="tabular-nums" :class="status.tone" aria-live="polite">{{ status.text }}</span>
        </div>
      </header>

      <div class="dialog-body space-y-3 text-base leading-relaxed">
        <Spinner v-if="busy" label="AI 正在审查未推送的变更…" />
        <div v-else-if="err" class="text-destructive">{{ err }}</div>
        <Md v-else-if="text" :source="text" />
        <div v-else class="text-muted-foreground">还没有内容：点下方「重新生成」开始审查。</div>
      </div>

      <footer class="dialog-footer">
        <span v-if="saved" class="mr-auto text-xs text-primary">已保存 ✓</span>
        <Button variant="secondary" size="sm" :disabled="busy || !text" @click="emit('save')">保存到本地</Button>
        <Button variant="secondary" size="sm" :disabled="busy || !ahead" @click="emit('regen')">
          重新生成
        </Button>
        <Button variant="secondary" size="sm" @click="open = false">关闭</Button>
      </footer>
    </div>
  </div>
  </Transition>
</template>
