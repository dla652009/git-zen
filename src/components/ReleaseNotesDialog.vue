<script setup lang="ts">
import { computed } from "vue";
import { Sparkles, X } from "@lucide/vue";
import { Button, Md, Select, Spinner } from "@/components/ui";

// open 由 App.vue 的 notesOpen 传入（overlayLayers.releaseNotes 指向它）；生成与保存在 App
const open = defineModel<boolean>("open", { required: true });
const from = defineModel<string>("from", { required: true });

const props = defineProps<{
  options: { value: string; label: string }[];
  busy: boolean;
  err: string;
  text: string;
  saved: boolean;
}>();

const emit = defineEmits<{ save: []; generate: [] }>();

// 范围选择器在头部，生成状态单列一行：换范围时标题栏不重排，状态也不会被下拉挤掉
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
    aria-labelledby="dlg-notes-title"
    @click.self="open = false"
  >
    <!-- dialog-shell：固定头尾 + 正文主滚动，四周留出屏幕余量 -->
    <div class="dialog-shell w-dlg-xl surface rounded-lg pop-in">
      <header class="dialog-header">
        <div class="flex items-center gap-2">
          <Sparkles class="size-4 shrink-0 text-primary" />
          <span id="dlg-notes-title" class="dialog-title">AI Release Notes</span>
          <span class="flex-1" />
          <Button variant="quiet" size="icon" class="h-6 w-6" aria-label="关闭" @click="open = false">
            <X class="size-4" />
          </Button>
        </div>
        <!-- 范围选择与状态：窄窗时下拉换行到下一排，不挤压标题 -->
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span class="shrink-0">起点</span>
          <Select v-model="from" label="起点" class="w-56 max-w-full" :options="options" />
          <span class="tabular-nums" :class="status.tone" aria-live="polite">{{ status.text }}</span>
        </div>
      </header>

      <div class="dialog-body space-y-3 text-base leading-relaxed">
        <Spinner v-if="busy" label="AI 正在汇总提交生成 Release Notes…" />
        <div v-else-if="err" class="text-destructive">{{ err }}</div>
        <Md v-else-if="text" :source="text" />
        <div v-else class="text-muted-foreground">选择起点后再点下方「生成」。</div>
      </div>

      <footer class="dialog-footer">
        <span v-if="saved" class="mr-auto text-xs text-primary">已保存 ✓</span>
        <Button variant="secondary" size="sm" :disabled="busy || !text" @click="emit('save')">保存到本地</Button>
        <Button variant="secondary" size="sm" :disabled="busy" @click="emit('generate')">生成</Button>
        <Button variant="secondary" size="sm" @click="open = false">关闭</Button>
      </footer>
    </div>
  </div>
  </Transition>
</template>
