<script setup lang="ts">
import { Search } from "@lucide/vue";
import { Badge, Input } from "@/components/ui";

// 开关、搜索词、选中项与键盘处理全部留在 App.vue（由 useSwitcher 提供）：
// onSwitcherKeydown 要在 onGlobalKeydown 里被调用，调用方必须是 App，这里只渲染。
const open = defineModel<boolean>("open", { required: true });
const query = defineModel<string>("query", { required: true });
const index = defineModel<number>("index", { required: true });

// 只用到 path / name / group；RepoTab 定义在 App.vue，按结构取避免反向依赖
interface SwitcherRepoItem {
  path: string;
  name: string;
  group?: string;
}

defineProps<{
  results: SwitcherRepoItem[];
  // 当前仓库路径：点亮每行左侧的圆点
  current: string;
}>();

// keydown 往上报给 App 的 onSwitcherKeydown（声明进 emits 才不会又当原生监听落到根节点）
const emit = defineEmits<{ pick: [path: string]; keydown: [e: KeyboardEvent] }>();
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[15vh]"
    role="dialog"
    aria-modal="true"
    aria-label="仓库快速切换器"
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
          placeholder="搜索仓库… ↑↓ 选择 · 回车打开 · Esc 关闭"
          @keydown="emit('keydown', $event)"
        />
      </div>
      <ul class="max-h-[50vh] overflow-y-auto p-1 pb-2">
        <li
          v-for="(r, idx) in results"
          :id="`sw-item-${idx}`"
          :key="r.path"
          :class="[
            'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-base',
            idx === index && 'bg-primary/10',
          ]"
          @click="emit('pick', r.path)"
          @mousemove="index = idx"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="r.path === current ? 'bg-primary' : 'bg-border'"
          />
          <span class="shrink-0 font-medium">{{ r.name }}</span>
          <Badge v-if="r.group" variant="muted">{{ r.group }}</Badge>
          <span class="flex-1 truncate text-right text-xs text-muted-foreground">{{ r.path }}</span>
        </li>
        <li v-if="!results.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
          没有匹配的仓库
        </li>
      </ul>
    </div>
  </div>
</template>
