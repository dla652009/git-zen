<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Badge, Button, Spinner } from "@/components/ui";
import type { ReflogEntry } from "@/gitApi";

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
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-reflog-title"
    @click.self="open = false"
  >
    <div class="w-dlg-lg surface rounded-lg p-5 pop-in">
      <div id="dlg-reflog-title" class="text-base font-semibold">时间线</div>
      <p class="mt-1 text-xs text-muted-foreground">
        reflog 记录的是 HEAD 的每一次移动（含被 reset / 覆盖掉的提交），可以回到其中任意一步。
      </p>

      <div class="mt-3 max-h-80 min-h-24 overflow-auto rounded-md border border-border-soft bg-background/40 p-1">
        <div v-if="loading" class="grid h-24 place-items-center">
          <Spinner label="读取中…" />
        </div>
        <div
          v-else-if="!entries.length"
          class="grid h-24 place-items-center text-xs text-muted-foreground"
        >
          还没有操作记录
        </div>
        <template v-else>
          <button
            v-for="e in entries"
            :key="e.hash + e.selector"
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 rounded-sm border-l-2 px-2 py-1.5 text-left text-xs transition-colors duration-fast disabled:cursor-default"
            :class="[
              e.hash === current
                ? 'border-l-[var(--primary)] bg-hover'
                : picked === e.hash
                  ? 'border-l-[var(--primary)] bg-hover'
                  : 'border-l-transparent hover:bg-hover',
            ]"
            :disabled="e.hash === current"
            @click="picked = e.hash"
          >
            <code class="shrink-0 font-mono text-muted-foreground">{{ e.selector }}</code>
            <code class="shrink-0 font-mono">{{ short(e.hash) }}</code>
            <span class="min-w-0 flex-1 truncate">{{ e.action }}</span>
            <Badge v-if="e.hash === current" variant="info" class="shrink-0">当前</Badge>
            <span class="shrink-0 text-2xs text-muted-foreground">{{ e.date }}</span>
          </button>
        </template>
      </div>

      <p v-if="picked" class="mt-2 text-xs text-muted-foreground">
        回到 {{ short(picked) }} 后，它之后的提交只是从这个分支上移走，仍可在时间线里找回。
      </p>

      <div class="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="open = false">取消</Button>
        <Button size="sm" :disabled="!canGo" @click="emit('pick', picked)">回到这里</Button>
      </div>
    </div>
  </div>
</template>
