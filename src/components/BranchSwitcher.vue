<script setup lang="ts">
import { Cloud, GitBranch } from "@lucide/vue";
import { Badge, Input } from "@/components/ui";
import type { Branch } from "../gitApi";

// 开关、搜索词、选中项与键盘处理全部留在 App.vue（由 useSwitcher 提供）：
// onBranchSwitcherKeydown 要在 onGlobalKeydown 里被调用，调用方必须是 App，这里只渲染。
const open = defineModel<boolean>("open", { required: true });
const query = defineModel<string>("query", { required: true });
const index = defineModel<number>("index", { required: true });

defineProps<{
  // bsResults：远程分支已剥前缀成 DWIM 名，originName 留着完整引用名供建跟踪分支用
  results: (Branch & { originName?: string })[];
}>();

// keydown 往上报给 App 的 onBranchSwitcherKeydown（声明进 emits 才不会又当原生监听落到根节点）
const emit = defineEmits<{ pick: [b: Branch]; keydown: [e: KeyboardEvent] }>();
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[15vh]"
    role="dialog"
    aria-modal="true"
    aria-label="分支快速切换器"
    @click.self="open = false"
  >
    <div class="w-dlg-lg surface overflow-hidden rounded-lg pop-in">
      <div class="relative p-2">
        <GitBranch
          class="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          v-model="query"
          v-focus
          class="h-9 pl-8"
          placeholder="搜索分支… ↑↓ 选择 · 回车切换 · Esc 关闭"
          @keydown="emit('keydown', $event)"
        />
      </div>
      <ul class="max-h-[50vh] overflow-y-auto p-1 pb-2">
        <li
          v-for="(b, idx) in results"
          :id="`bs-item-${idx}`"
          :key="b.name + (b.remote ? '@' : '')"
          :class="[
            'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-base',
            idx === index && 'bg-primary/10',
            b.current && 'font-medium text-primary',
          ]"
          @click="emit('pick', b)"
          @mousemove="index = idx"
        >
          <Cloud v-if="b.remote" class="size-3.5 shrink-0 text-muted-foreground" />
          <GitBranch v-else class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ b.name }}</span>
          <span v-if="b.ahead" class="shrink-0 text-2xs text-[var(--c-mod)]">↑{{ b.ahead }}</span>
          <span v-if="b.behind" class="shrink-0 text-2xs text-[var(--c-conf)]">↓{{ b.behind }}</span>
          <span class="flex-1" />
          <Badge v-if="b.current" variant="default">当前</Badge>
          <Badge v-if="b.remote" variant="muted">远程</Badge>
        </li>
        <li v-if="!results.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
          没有匹配的分支
        </li>
      </ul>
    </div>
  </div>
</template>
