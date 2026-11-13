<script setup lang="ts">
// diff 内搜索栏：DiffViewer 与 FileHistoryModal 共用，开关与状态由 useDiffSearch 持有。
// Esc 只关搜索栏（stop 掉，别连带关掉弹窗）。
import { X, Search, ChevronUp, ChevronDown } from "@lucide/vue";
import { Button, Input, Tooltip } from "@/components/ui";

defineProps<{ count: number; cur: number }>();
const q = defineModel<string>("q", { required: true });
const emit = defineEmits<{ go: [d: number]; close: [] }>();
</script>

<template>
  <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
    <Search class="size-3.5 shrink-0 text-muted-foreground" />
    <Input
      v-model="q"
      data-search-input
      class="h-7 flex-1 text-xs"
      placeholder="在 diff 里查找…"
      @keydown.enter.exact.prevent="emit('go', 1)"
      @keydown.shift.enter.prevent="emit('go', -1)"
      @keydown.esc.stop.prevent="emit('close')"
    />
    <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">{{
      q.trim() ? (count ? `${cur + 1}/${count}` : "无匹配") : ""
    }}</span>
    <Tooltip text="上一个（Shift+Enter）">
      <Button variant="quiet" size="icon" class="h-6 w-6" :disabled="!count" aria-label="上一个匹配" @click="emit('go', -1)">
        <ChevronUp class="size-3.5" />
      </Button>
    </Tooltip>
    <Tooltip text="下一个（Enter）">
      <Button variant="quiet" size="icon" class="h-6 w-6" :disabled="!count" aria-label="下一个匹配" @click="emit('go', 1)">
        <ChevronDown class="size-3.5" />
      </Button>
    </Tooltip>
    <Button variant="quiet" size="icon" class="h-6 w-6" aria-label="关闭搜索" @click="emit('close')">
      <X class="size-3.5" />
    </Button>
  </div>
</template>
