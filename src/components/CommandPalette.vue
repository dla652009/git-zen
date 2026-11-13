<script setup lang="ts">
import { Search } from "@lucide/vue";
import { Input } from "@/components/ui";
import type { PaletteResult } from "../composables/usePalette";

// 开关、搜索词、选中项与键盘处理全部留在 App.vue（由 usePalette 提供）：
// onPaletteKeydown 要在 onGlobalKeydown 之外单独接住输入框的按键，调用方必须是 App，这里只渲染。
const open = defineModel<boolean>("open", { required: true });
const query = defineModel<string>("query", { required: true });
const index = defineModel<number>("index", { required: true });

defineProps<{ results: PaletteResult[] }>();

// keydown 往上报给 App 的 onPaletteKeydown（声明进 emits 才不会又当原生监听落到根节点）
const emit = defineEmits<{ pick: [r: PaletteResult]; keydown: [e: KeyboardEvent] }>();

const KIND_LABEL: Record<PaletteResult["kind"], string> = {
  repo: "仓库",
  branch: "分支",
  action: "动作",
};
</script>

<template>
  <Transition name="dlg">
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[15vh]"
    role="dialog"
    aria-modal="true"
    aria-label="命令面板"
    @click.self="open = false"
  >
    <div class="w-dlg-lg surface overflow-hidden rounded-lg pop-in">
      <div class="relative p-2">
        <Search
          class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          v-model="query"
          v-focus
          class="h-9 pl-8"
          placeholder="搜索仓库、分支或操作…"
          @keydown="emit('keydown', $event)"
        />
      </div>
      <ul class="max-h-[50vh] overflow-y-auto p-1 pb-2">
        <li
          v-for="(r, idx) in results"
          :id="`palette-item-${idx}`"
          :key="r.id"
          :aria-disabled="r.disabled || undefined"
          :class="[
            'flex items-center gap-2 rounded-md px-2.5 py-2 text-base',
            r.disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
            idx === index && !r.disabled && 'bg-primary/10',
          ]"
          @click="!r.disabled && emit('pick', r)"
          @mousemove="!r.disabled && (index = idx)"
        >
          <component :is="r.icon" v-if="r.icon" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ r.label }}</span>
          <span v-if="r.detail" class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
            {{ r.detail }}
          </span>
          <span v-else class="flex-1" />
          <span class="w-8 shrink-0 text-right text-2xs text-muted-foreground">
            {{ KIND_LABEL[r.kind] }}
          </span>
        </li>
        <li v-if="!results.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
          无匹配结果
        </li>
      </ul>
    </div>
  </div>
  </Transition>
</template>
