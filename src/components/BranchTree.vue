<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import type { Branch } from "../gitApi";
import type { BNode } from "../branchTree";

// 树形分支列表：单击切换（对齐 VS Code / GitHub Desktop 惯例），右键出管理菜单
// （菜单项由 App 侧 ui/ContextMenu 统一渲染，本组件只上报事件）
const props = withDefaults(
  defineProps<{ nodes: BNode[]; depth?: number }>(),
  { depth: 0 },
);
const emit = defineEmits<{
  switch: [b: Branch];
  menu: [b: Branch, x: number, y: number];
}>();
// 折叠集合由根共享（v-model），跨层级一致
const collapsed = defineModel<Set<string>>({ required: true });

function toggle(path: string) {
  const next = new Set(collapsed.value);
  next.has(path) ? next.delete(path) : next.add(path);
  collapsed.value = next;
}
</script>

<template>
  <template v-for="n in nodes" :key="n.path">
    <!-- 中间节点：可折叠 -->
    <template v-if="n.children.length">
      <div
        class="flex cursor-pointer items-center gap-1 py-1 pr-3 text-xs select-none hover:bg-muted"
        :style="{ paddingLeft: (props.depth ?? 0) * 12 + 12 + 'px' }"
        @click="toggle(n.path)"
      >
        <ChevronDown class="size-3 shrink-0 transition-transform" :class="collapsed.has(n.path) && '-rotate-90'" />
        <span class="truncate text-muted-foreground" :title="`${n.seg}（含 ${n.count} 个分支）`">{{ n.seg }}</span>
        <span class="shrink-0 text-[10px] opacity-60">{{ n.count }}</span>
      </div>
      <BranchTree
        v-if="!collapsed.has(n.path)"
        v-model="collapsed"
        :nodes="n.children"
        :depth="(props.depth ?? 0) + 1"
        @switch="emit('switch', $event)"
        @menu="(b, x, y) => emit('menu', b, x, y)"
      />
    </template>

    <!-- 叶子：真实分支 -->
    <li
      v-else
      :class="[
        'flex cursor-pointer items-center gap-1 py-1.5 pr-3 hover:bg-muted',
        n.branch?.current && 'font-semibold text-primary',
      ]"
      :style="{ paddingLeft: (props.depth ?? 0) * 12 + 24 + 'px' }"
      :title="`${n.branch!.name}${n.branch!.current ? '（当前分支）' : '（点击切换，右键更多操作）'}`"
      @click="!n.branch!.current && emit('switch', n.branch!)"
      @contextmenu.prevent="emit('menu', n.branch!, $event.clientX, $event.clientY)"
    >
      <span class="truncate">{{ n.seg }}</span>
      <span class="ml-auto shrink-0 pl-1 text-[10px] leading-none">
        <span v-if="n.branch!.ahead" class="mr-0.5 text-[var(--c-mod)]">↑{{ n.branch!.ahead }}</span>
        <span v-if="n.branch!.behind" class="text-[var(--c-conf)]">↓{{ n.branch!.behind }}</span>
      </span>
    </li>
  </template>
</template>
