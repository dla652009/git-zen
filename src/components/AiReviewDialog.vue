<script setup lang="ts">
import { Bot, X } from "@lucide/vue";
import { Button, Md, Spinner } from "@/components/ui";

// open 由 App.vue 的 reviewOpen 传入（overlayLayers.aiReview 指向它）；生成与保存仍在 App
const open = defineModel<boolean>("open", { required: true });

defineProps<{
  // 未推送提交数：标题与「重新生成」的门槛都用它（无上游时为 undefined）
  ahead: number | undefined;
  busy: boolean;
  err: string;
  text: string;
  saved: boolean;
}>();

const emit = defineEmits<{ save: []; regen: [] }>();
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-30 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-review-title"
    @click.self="open = false"
  >
    <div class="flex max-h-[80vh] w-dlg-xl flex-col surface rounded-lg pop-in">
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
        <Bot class="size-4 text-primary" />
        <span id="dlg-review-title" class="text-base font-semibold">AI Review · 未推送的 {{ ahead }} 个提交</span>
        <span class="flex-1" />
        <Button variant="ghost" size="icon" @click="open = false"><X class="size-4" /></Button>
      </header>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-base leading-relaxed">
        <Spinner v-if="busy" label="AI 正在审查未推送的变更…" />
        <div v-else-if="err" class="text-destructive">{{ err }}</div>
        <Md v-else :source="text" />
      </div>
      <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
        <span v-if="saved" class="mr-auto text-xs text-primary">已保存 ✓</span>
        <Button variant="secondary" size="sm" :disabled="busy || !text" @click="emit('save')">保存到本地</Button>
        <Button variant="secondary" size="sm" :disabled="busy || !ahead" @click="emit('regen')">
          重新生成
        </Button>
        <Button variant="secondary" size="sm" @click="open = false">关闭</Button>
      </footer>
    </div>
  </div>
</template>
