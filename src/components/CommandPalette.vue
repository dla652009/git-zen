<script setup lang="ts">
import { Search } from "@lucide/vue";
import { Input } from "@/components/ui";
import type { PaletteResult } from "../composables/usePalette";

// 搜索、选中项与快捷键仍由 App/usePalette 管理。
const open = defineModel<boolean>("open", { required: true });
const query = defineModel<string>("query", { required: true });
const index = defineModel<number>("index", { required: true });
defineProps<{ results: PaletteResult[] }>();
const emit = defineEmits<{ pick: [r: PaletteResult]; keydown: [e: KeyboardEvent] }>();
const KIND_LABEL: Record<PaletteResult["kind"], string> = { repo: "仓库", branch: "分支", action: "动作" };
</script>

<template>
  <Transition name="dlg">
    <div v-if="open" v-trap class="quick-dialog-overlay fixed inset-0 z-50 flex items-start justify-center bg-scrim" role="dialog" aria-modal="true" aria-label="命令面板" @click.self="open = false">
      <div class="dialog-shell quick-dialog-panel w-dlg-lg surface rounded-lg pop-in">
        <div class="quick-dialog-search relative">
          <Search class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" v-focus class="h-9 pl-8" placeholder="搜索仓库、分支或操作…" role="combobox" aria-label="搜索命令" aria-autocomplete="list" aria-controls="command-palette-results" :aria-expanded="true" :aria-activedescendant="results[index] ? `palette-item-${index}` : undefined" @keydown="emit('keydown', $event)" />
        </div>
        <ul id="command-palette-results" class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" role="listbox" aria-label="命令搜索结果">
          <li v-for="(r, idx) in results" :id="`palette-item-${idx}`" :key="r.id" role="option" :aria-selected="idx === index && !r.disabled" :aria-disabled="r.disabled || undefined" :class="['flex items-start gap-2.5 rounded-sm px-3 py-2.5 text-sm transition-colors duration-fast', r.disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer', idx === index && !r.disabled ? 'bg-row-selected' : !r.disabled && 'hover:bg-hover']" :title="r.detail ? `${r.label} · ${r.detail}` : r.label" @click="!r.disabled && emit('pick', r)" @mousemove="!r.disabled && (index = idx)">
            <component :is="r.icon" v-if="r.icon" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ r.label }}</div>
              <div v-if="r.detail" class="mt-0.5 line-clamp-2 break-words text-xs" :class="idx === index && !r.disabled ? 'text-foreground' : 'text-muted-foreground'">{{ r.detail }}</div>
            </div>
            <span class="shrink-0 text-xs" :class="idx === index && !r.disabled ? 'text-foreground' : 'text-muted-foreground'">{{ KIND_LABEL[r.kind] }}</span>
          </li>
          <li v-if="!results.length" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ query.trim() ? '无匹配结果，试试仓库名、分支名或操作名称' : '暂无可用命令' }}</li>
        </ul>
        <footer class="quick-dialog-footer"><span>↑↓ 选择 · Enter 执行</span><span>Esc 关闭</span></footer>
      </div>
    </div>
  </Transition>
</template>
