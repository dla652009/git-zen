<script setup lang="ts">
import { Sparkles, X } from "@lucide/vue";
import { Button, Md, Select, Spinner } from "@/components/ui";

// open 由 App.vue 的 notesOpen 传入（overlayLayers.releaseNotes 指向它）；生成与保存在 App
const open = defineModel<boolean>("open", { required: true });
const from = defineModel<string>("from", { required: true });

defineProps<{
  options: { value: string; label: string }[];
  busy: boolean;
  err: string;
  text: string;
  saved: boolean;
}>();

const emit = defineEmits<{ save: []; generate: [] }>();
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-30 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-notes-title"
    @click.self="open = false"
  >
    <div class="flex max-h-[80vh] w-dlg-xl flex-col surface rounded-lg pop-in">
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
        <Sparkles class="size-4 text-primary" />
        <span id="dlg-notes-title" class="text-base font-semibold">AI Release Notes</span>
        <Select v-model="from" class="w-56" :options="options" />
        <span class="flex-1" />
        <Button variant="ghost" size="icon" @click="open = false"><X class="size-4" /></Button>
      </header>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-base leading-relaxed">
        <Spinner v-if="busy" label="AI 正在汇总提交生成 Release Notes…" />
        <div v-else-if="err" class="text-destructive">{{ err }}</div>
        <Md v-else-if="text" :source="text" />
        <div v-else class="text-muted-foreground">选择范围后点「生成」。</div>
      </div>
      <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
        <span v-if="saved" class="mr-auto text-xs text-primary">已保存 ✓</span>
        <Button variant="secondary" size="sm" :disabled="busy || !text" @click="emit('save')">
          保存到本地
        </Button>
        <Button variant="secondary" size="sm" :disabled="busy" @click="emit('generate')">生成</Button>
        <Button variant="secondary" size="sm" @click="open = false">关闭</Button>
      </footer>
    </div>
  </div>
</template>
