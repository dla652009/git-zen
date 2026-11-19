<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Badge, Button, Spinner } from "@/components/ui";
import type { ReflogEntry } from "@/gitApi";
import { relDateText } from "@/lib/relDate";

// 时间线（reflog）：HEAD 的每一次移动都留一条，包含被 reset / 覆盖掉的提交。
// 数据与「回到这里」的实际调用留在 App，这里只管选。
const open = defineModel<boolean>("open", { required: true });

const props = defineProps<{
  entries: ReflogEntry[];
  loading: boolean;
  /** 当前 HEAD 的 hash；不传时取列表第一条（git reflog 新到旧，第一条就是 HEAD） */
  head?: string;
}>();

const emit = defineEmits<{ pick: [hash: string] }>();

// selector 是位置编号（HEAD@{3} 会随列表变化指向别处），所以选中态按 hash 记
const picked = ref("");

watch(open, (v) => {
  if (v) picked.value = "";
});

const current = computed(() => props.head || props.entries[0]?.hash || "");
const canGo = computed(() => !!picked.value && picked.value !== current.value);

// 短 hash：前 7 位就够认，列表里全串太吵
const short = (h: string) => h.slice(0, 7);
</script>

<template>
<Transition name="dlg"><div v-if="open" v-trap class="fixed inset-0 z-40 grid place-items-center bg-scrim" role="dialog" aria-modal="true" aria-labelledby="dlg-reflog-title" @click.self="open = false">
<div class="dialog-shell w-dlg-xl surface rounded-lg pop-in"><header class="dialog-header"><div id="dlg-reflog-title" class="dialog-title">时间线</div><p class="mt-1 text-xs leading-relaxed text-muted-foreground">查看 HEAD 的移动记录，包括被 reset 或覆盖的提交。未提交的文件改动不会出现在这里，也无法通过时间线恢复。</p></header>
<div class="dialog-body">
<div v-if="loading" class="grid min-h-24 place-items-center"><Spinner label="读取中…" /></div><div v-else-if="!entries.length" class="grid min-h-24 place-items-center text-xs text-muted-foreground">还没有操作记录</div>
<template v-else><button v-for="e in entries" :key="e.hash + e.selector" type="button" class="mb-1 flex w-full cursor-pointer items-start gap-2 rounded-sm border-l-2 p-2.5 text-left text-xs transition-colors duration-fast disabled:cursor-default" :class="e.hash === current || picked === e.hash ? 'border-l-primary bg-row-selected' : 'border-l-transparent hover:bg-hover'" :disabled="e.hash === current" :title="e.action" @click="picked = e.hash">
<div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2" :class="e.hash === current || picked === e.hash ? 'text-foreground' : 'text-muted-foreground'"><code class="font-mono">{{ e.selector }}</code><code class="font-mono">{{ short(e.hash) }}</code><Badge v-if="e.hash === current" variant="info">当前</Badge></div><div class="mt-1 line-clamp-2 break-words text-sm">{{ e.action }}</div></div><span class="shrink-0 text-xs" :class="e.hash === current || picked === e.hash ? 'text-foreground' : 'text-muted-foreground'">{{ relDateText(e.date) }}</span>
</button></template></div>
<footer class="dialog-footer"><p v-if="picked" class="dialog-footnote w-full text-xs leading-relaxed text-muted-foreground">已选择 <code class="font-mono text-foreground">{{ short(picked) }}</code>。回到这里后，其后的提交会从当前分支移走，仍可在时间线中找回。</p><Button variant="ghost" size="sm" @click="open = false">取消</Button><Button variant="default" size="sm" :disabled="!canGo" @click="emit('pick', picked)">回到这里</Button></footer>
</div></div></Transition>
</template>
