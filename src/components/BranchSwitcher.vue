<script setup lang="ts">
import { Cloud, GitBranch } from "@lucide/vue";
import { Badge, Input } from "@/components/ui";
import type { Branch } from "../gitApi";

// 搜索、选中项与快捷键仍由 App/useSwitcher 管理。
const open = defineModel<boolean>("open", { required: true });
const query = defineModel<string>("query", { required: true });
const index = defineModel<number>("index", { required: true });
defineProps<{ results: (Branch & { originName?: string })[] }>();
const emit = defineEmits<{ pick: [b: Branch]; keydown: [e: KeyboardEvent] }>();
</script>

<template>
  <Transition name="dlg">
    <div v-if="open" v-trap class="quick-dialog-overlay fixed inset-0 z-50 flex items-start justify-center bg-scrim" role="dialog" aria-modal="true" aria-label="分支快速切换器" @click.self="open = false">
      <div class="dialog-shell quick-dialog-panel w-dlg-lg surface rounded-lg pop-in">
        <div class="quick-dialog-search relative">
          <GitBranch class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" v-focus class="h-9 pl-8" placeholder="搜索分支…" role="combobox" aria-label="搜索分支" aria-autocomplete="list" aria-controls="branch-switcher-results" :aria-expanded="true" :aria-activedescendant="results[index] ? `bs-item-${index}` : undefined" @keydown="emit('keydown', $event)" />
        </div>
        <ul id="branch-switcher-results" class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" role="listbox" aria-label="分支搜索结果">
          <li v-for="(b, idx) in results" :id="`bs-item-${idx}`" :key="b.name + (b.remote ? '@' : '')" role="option" :aria-selected="idx === index" class="flex cursor-pointer items-start gap-2.5 rounded-sm px-3 py-2.5 text-sm transition-colors duration-fast" :class="idx === index ? 'bg-row-selected' : 'hover:bg-hover'" :title="b.originName || b.name" @click="emit('pick', b)" @mousemove="index = idx">
            <Cloud v-if="b.remote" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <GitBranch v-else class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="line-clamp-2 break-all font-medium">{{ b.name }}</div>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs" :class="idx === index ? 'text-foreground' : 'text-muted-foreground'">
                <Badge v-if="b.current" variant="muted">当前</Badge>
                <span v-if="b.remote">远程分支</span>
                <span v-if="b.ahead" class="tabular-nums">↑{{ b.ahead }} 领先</span>
                <span v-if="b.behind" class="tabular-nums">↓{{ b.behind }} 落后</span>
                <span v-if="!b.current && !b.remote && !b.ahead && !b.behind">本地分支</span>
              </div>
            </div>
          </li>
          <li v-if="!results.length" class="px-4 py-8 text-center text-sm text-muted-foreground">{{ query.trim() ? '没有匹配的分支，试试其他关键词' : '暂无可切换的分支' }}</li>
        </ul>
        <footer class="quick-dialog-footer"><span>↑↓ 选择 · Enter 切换</span><span>Esc 关闭</span></footer>
      </div>
    </div>
  </Transition>
</template>
