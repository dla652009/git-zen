<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown } from "@lucide/vue";
import type { Branch } from "../gitApi";
import type { BNode } from "../branchTree";

// 树形分支列表：单击切换（对齐 VS Code / GitHub Desktop 惯例），右键出管理菜单
// （菜单项由 App 侧 ui/ContextMenu 统一渲染，本组件只上报事件）
//
// 层级靠两样东西同时表达：缩进步长 STEP，以及每层一条垂直引导线。
// 只给缩进时，一行属于哪个文件夹要靠视线回溯，层数一多就断——引导线是那条回程路。
// 一级栏（本地 / origin / 标签）由 App.vue 渲染，左侧内边距是 px-3；本组件负责它下面的所有行
const GROUP_INSET = 12;
const STEP = 16;
// 树的第一级落在 12 + 一个步长：一级栏的 chevron 在 12，它的孩子就该在 12 的右边一列。
// 关键是 **chevron 列之间永远相差一个 STEP** ——「谁在谁里面」靠同一个规律读出来，不靠逐行猜。
const TREE_BASE = GROUP_INSET + STEP;
// 叶子没有 chevron，右移一个 STEP 去对齐同级文件夹的「文字」
// （文件夹 chevron 宽 12 + gap-1 = 4 → 文字正好在 chevron 起点 + 16 = 一个 STEP 处）
const LEAF_OFFSET = STEP;
// 一级栏 chevron 的中心：12 + size-3(12) / 2
const GROUP_GUIDE = GROUP_INSET + 6;
// 文件夹名沿用 text-xs（比分支名小一档）——那是层级信号，不删。
// 但行高必须取同一个绝对值：两种行高交替出现，扫读时节奏就是断的。
// 为什么不用 leading-* 工具类：它与 text-xs 自带的 line-height 谁生效，取决于产物 CSS 里的先后顺序；
// 而无单位的 1.25 又会各自乘自己的字号（13px×1.25 ≠ 16px×1.25），根本统一不了。
const ROW_LEADING = "1.25rem";
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

// 每个祖先各一条引导线：一级栏一条，加上树内的 depth 条。
// 最上面那条落在 12 + 6 = 18，正好穿过一级栏 chevron 的中心 —— 线因此是「从组标题上长下来」的，
// 而不是从半空中开始的一截。
const guideXs = computed(() =>
  Array.from({ length: (props.depth ?? 0) + 1 }, (_, i) => GROUP_GUIDE + i * STEP),
);

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
        class="relative flex cursor-pointer items-center gap-1 py-1.5 pr-3 text-xs transition-colors duration-fast select-none hover:bg-hover"
        :style="{ paddingLeft: TREE_BASE + (props.depth ?? 0) * STEP + 'px', lineHeight: ROW_LEADING }"
        @click="toggle(n.path)"
      >
        <span
          v-for="x in guideXs"
          :key="x"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 w-px bg-border"
          :style="{ left: x + 'px' }"
        />
        <ChevronDown class="size-3 shrink-0 transition-transform duration-fast" :class="collapsed.has(n.path) && '-rotate-90'" />
        <span class="truncate text-muted-foreground" :title="`${n.seg}（含 ${n.count} 个分支）`">{{ n.seg }}</span>
        <span class="shrink-0 text-2xs opacity-60">{{ n.count }}</span>
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
        'relative flex cursor-pointer items-center gap-1 py-1.5 pr-3 transition-colors duration-fast hover:bg-hover',
        n.branch?.current && 'font-semibold text-primary',
      ]"
      :style="{ paddingLeft: TREE_BASE + (props.depth ?? 0) * STEP + LEAF_OFFSET + 'px', lineHeight: ROW_LEADING }"
      :title="`${n.branch!.name}${n.branch!.current ? '（当前分支）' : '（点击切换，右键更多操作）'}`"
      @click="!n.branch!.current && emit('switch', n.branch!)"
      @contextmenu.prevent="emit('menu', n.branch!, $event.clientX, $event.clientY)"
    >
      <span
        v-for="x in guideXs"
        :key="x"
        aria-hidden="true"
        class="pointer-events-none absolute inset-y-0 w-px bg-border"
        :style="{ left: x + 'px' }"
      />
      <span class="truncate">{{ n.seg }}</span>
      <span class="ml-auto shrink-0 pl-1 text-2xs leading-none">
        <span v-if="n.branch!.ahead" class="mr-0.5 text-[var(--c-mod)]">↑{{ n.branch!.ahead }}</span>
        <span v-if="n.branch!.behind" class="text-[var(--c-conf)]">↓{{ n.branch!.behind }}</span>
      </span>
    </li>
  </template>
</template>
