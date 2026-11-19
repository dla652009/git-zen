<script setup lang="ts">
import { Search } from "@lucide/vue";
import { Badge, Input } from "@/components/ui";

// 搜索、选中项与快捷键仍由 App/useSwitcher 管理。
const open = defineModel<boolean>("open", { required: true });
const query = defineModel<string>("query", { required: true });
const index = defineModel<number>("index", { required: true });
interface SwitcherRepoItem {
  path: string;
  name: string;
  group?: string;
}
defineProps<{ results: SwitcherRepoItem[]; current: string }>();
const emit = defineEmits<{ pick: [path: string]; keydown: [e: KeyboardEvent] }>();
</script>

<template>
  <Transition name="dlg">
    <div v-if="open" v-trap class="quick-dialog-overlay fixed inset-0 z-50 flex items-start justify-center bg-scrim" role="dialog" aria-modal="true" aria-label="仓库快速切换器" @click.self="open = false">
      <div class="dialog-shell quick-dialog-panel w-dlg-lg surface rounded-lg pop-in">
        <div class="quick-dialog-search relative">
          <Search class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" v-focus class="h-9 pl-8" placeholder="搜索仓库名称或路径…" role="combobox" aria-label="搜索仓库" aria-autocomplete="list" aria-controls="repo-switcher-results" :aria-expanded="true" :aria-activedescendant="results[index] ? `sw-item-${index}` : undefined" @keydown="emit('keydown', $event)" />
        </div>
        <ul id="repo-switcher-results" class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" role="listbox" aria-label="仓库搜索结果">
          <li v-for="(r, idx) in results" :id="`sw-item-${idx}`" :key="r.path" role="option" :aria-selected="idx === index" class="flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2.5 text-sm transition-colors duration-fast" :class="idx === index ? 'bg-row-selected' : 'hover:bg-hover'" :title="r.path" @click="emit('pick', r.path)" @mousemove="index = idx">
            <span class="size-1.5 shrink-0 rounded-full" :class="r.path === current ? 'bg-primary' : 'bg-border'" :title="r.path === current ? '当前仓库' : undefined" />
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate font-medium">{{ r.name }}</span>
                <Badge v-if="r.group" variant="muted" class="min-w-0 max-w-[40%] shrink overflow-hidden"><span class="truncate">{{ r.group }}</span></Badge>
              </div>
              <div class="mt-0.5 truncate text-xs" :class="idx === index ? 'text-foreground' : 'text-muted-foreground'">{{ r.path }}</div>
            </div>
          </li>
          <li v-if="!results.length" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ query.trim() ? '没有匹配的仓库，试试其他名称或路径' : '暂无可切换的仓库' }}</li>
        </ul>
        <footer class="quick-dialog-footer"><span>↑↓ 选择 · Enter 打开</span><span>Esc 关闭</span></footer>
      </div>
    </div>
  </Transition>
</template>
