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
  defineProps<{
    nodes: BNode[];
    depth?: number;
    /** 平铺模式：不渲染文件夹层，把所有叶子拉平成一列（显示完整分支名）。
     *  只有组件根实例需要关注它 —— 递归子节点不会再出现在平铺模式里。 */
    flat?: boolean;
  }>(),
  { depth: 0, flat: false },
);

// 平铺：递归收集所有叶子，按完整分支名排序。
// 用完整名（feature/login 而不是叶子段 login）——平铺时没有层级上下文，
// 只显示末段会出现两个同名 login 分不清谁是谁。
function flatten(list: BNode[], out: BNode[] = []): BNode[] {
  for (const n of list) {
    if (n.children.length) flatten(n.children, out);
    else out.push(n);
  }
  return out;
}
const flatLeaves = computed(() =>
  flatten(props.nodes)
    .filter((n) => !!n.branch)
    .sort((a, b) =>
      a.branch!.name.localeCompare(b.branch!.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    ),
);
const emit = defineEmits<{
  switch: [b: Branch];
  menu: [b: Branch, x: number, y: number];
}>();

// 本地分支：单击切换（原有手感）。远程分支：单击不动作，双击才 checkout 到本地 ——
// 远程分支是「别人那边的」参照物，误点一下就切走代价太大；双击是有意的动作。
function branchTitle(b: Branch): string {
  if (b.current) return `${b.name}（当前分支）`;
  if (b.remote) return `${b.name}（双击检出到本地 · 右键更多操作）`;
  return `${b.name}（单击切换 · 右键更多操作）`;
}
function onBranchClick(b: Branch) {
  if (b.current || b.remote) return;
  emit("switch", b);
}
function onBranchDblClick(b: Branch) {
  // 双击只在远程分支上生效；本地的双击会触发两次 click，行为已由 click 处理
  if (b.current || !b.remote) return;
  emit("switch", b);
}
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
  <!-- 平铺模式：只有根实例会用（flat 由 App 传给一级树），一列到底、没有文件夹行。
       缩进取一级栏的内边距，与目录树分支行的起点对齐。 -->
  <template v-if="flat">
    <li
      v-for="n in flatLeaves"
      :key="n.path"
      :class="[
        'relative flex cursor-pointer items-center gap-1 py-1.5 pr-3 transition-colors duration-fast hover:bg-hover',
        n.branch!.current && 'font-semibold text-primary',
      ]"
      :style="{ paddingLeft: TREE_BASE + 'px', lineHeight: ROW_LEADING }"
      :title="branchTitle(n.branch!)"
      @click="onBranchClick(n.branch!)"
      @dblclick="onBranchDblClick(n.branch!)"
      @contextmenu.prevent="emit('menu', n.branch!, $event.clientX, $event.clientY)"
    >
      <span class="truncate">{{ n.branch!.name }}</span>
      <span class="ml-auto shrink-0 pl-1 text-2xs leading-none tabular-nums">
        <span v-if="n.branch!.ahead" class="mr-0.5 text-[var(--c-mod)]">↑{{ n.branch!.ahead }}</span>
        <span v-if="n.branch!.behind" class="text-[var(--c-conf)]">↓{{ n.branch!.behind }}</span>
      </span>
    </li>
  </template>
  <template v-else v-for="n in nodes" :key="n.path">
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
        <span class="shrink-0 text-2xs tabular-nums opacity-60">{{ n.count }}</span>
      </div>
      <!-- 文件夹的展开/收起与一级分组同一套高度动画（class 见 style.css 的 .collapse-*）。
           内层 div 是唯一 grid item：BranchTree 是多根 fragment，直接做 0fr 只压得动第一行。
           树里的行没有拖拽/键盘导航（只有 click / contextmenu），包一层不影响交互。 -->
      <Transition name="collapse">
        <div v-if="!collapsed.has(n.path)">
          <div>
            <BranchTree
              v-model="collapsed"
              :nodes="n.children"
              :depth="(props.depth ?? 0) + 1"
              @switch="emit('switch', $event)"
              @menu="(b, x, y) => emit('menu', b, x, y)"
            />
          </div>
        </div>
      </Transition>
    </template>

    <!-- 叶子：真实分支 -->
    <li
      v-else
      :class="[
        'relative flex cursor-pointer items-center gap-1 py-1.5 pr-3 transition-colors duration-fast hover:bg-hover',
        n.branch?.current && 'font-semibold text-primary',
      ]"
      :style="{ paddingLeft: TREE_BASE + (props.depth ?? 0) * STEP + LEAF_OFFSET + 'px', lineHeight: ROW_LEADING }"
      :title="branchTitle(n.branch!)"
      @click="onBranchClick(n.branch!)"
      @dblclick="onBranchDblClick(n.branch!)"
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
      <span class="ml-auto shrink-0 pl-1 text-2xs leading-none tabular-nums">
        <span v-if="n.branch!.ahead" class="mr-0.5 text-[var(--c-mod)]">↑{{ n.branch!.ahead }}</span>
        <span v-if="n.branch!.behind" class="text-[var(--c-conf)]">↓{{ n.branch!.behind }}</span>
      </span>
    </li>
  </template>
</template>
