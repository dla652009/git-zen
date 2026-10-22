<script setup lang="ts">
// 自动消失的结果提示（状态在 ./toast.ts，App 根部挂一次本组件即可）。
//
// 位置：顶部居中，紧贴选项卡栏下方。原先在底部居中 —— 中间列底部的说明文字与状态栏
// 让它在视觉上「沉」进背景，很容易错过。顶部是操作发生的方向（Pull/Push/刷新都在顶栏），
// 视线本来就在那里；且只在出现后的 2.6 秒里占位，不挡常驻控件。
//
// 图标是这次可辨识性的关键：纯文字的胶囊在满屏等宽字体里和正文长得太像，
// 一个 Check / Info / Warn 让它在任何主题下都能被一眼识别。
//
// 多条并存时叠成一摞而不是竖排平铺：竖排会把顶部的历史区挡掉一大片，
// 而用户此刻只关心「刚刚那一下」。最新的一条在最前面，旧的压到后面并缩小淡出。
// 鼠标停上去整摞展开成竖排（并暂停倒计时）—— 折叠只剩「有几条」，展开才读得到内容。
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { pauseToasts, resumeToasts, toasts, type ToastKind } from "./toast";
import { CheckCircle2, Info, TriangleAlert } from "@lucide/vue";

const ICON: Record<ToastKind, typeof CheckCircle2> = {
  success: CheckCircle2,
  info: Info,
  warn: TriangleAlert,
};

// 图标色：三种都是「图形色」令牌，对比度门槛 3:1（已在 check-contrast 里覆盖），
// 不要换成 --diff-*-text 那类文字色令牌 —— 它们只在各自的 diff 底色上达 4.5。
const ICON_CLASS: Record<ToastKind, string> = {
  success: "text-[var(--c-add)]",
  info: "text-[var(--c-mod)]",
  warn: "text-[var(--c-conf)]",
};

// 最多露 3 层：再往后每层只错开 6px，第 4 层已经看不出是独立的卡片了。
// 超出的折进前卡的 +N 角标（toast.ts 里上限 4 条，所以最多 +1）。
const MAX_STACK = 3;

// 反过来：最新的在最前（它是「刚发生」的那条），比它早的依次压到后面
const all = computed(() => [...toasts].reverse());
const stack = computed(() => all.value.slice(0, MAX_STACK));
const overflow = computed(() => Math.max(0, toasts.length - MAX_STACK));

// 展开时全部显示，折叠时只留 3 层
const expanded = ref(false);
const visible = computed(() => (expanded.value ? all.value : stack.value));
// 只有多条时才需要交互；单条保持 pointer-events-none，不挡下面任何点击
const interactive = computed(() => toasts.length > 1);

// 展开后的纵向位置：只能量出来。卡片高度取决于文案几行，写死间距会让第二张咬进第一张。
// 折叠态里后面几张也一直在渲染（只是被压住），所以尺寸随时可读，展开那一刻不必等布局。
//
// 宽度交给模板里那组「尺子」（.toast-ghost）：它是文档流里唯一参与定宽的东西，
// 卡片都是绝对定位、不参与计算。踩过的两次坑：
// ① 直接 w-fit —— 宽度由最前面那张决定，那张一走，第二张就从「被容器拉宽」变成
//    「按自己文案排版」，宽度骤减、长句一行一个字，看着像竖排；
// ② 改成 JS 量容器 offsetWidth 取 max —— 循环依赖：量的时候容器宽度本身就受上一轮
//    结果约束，只能量出「已经被挤窄的宽度」，越量越窄。
//
// 所以两个动作分开做：**定宽**取尺子的 scrollWidth（nowrap 内容的固有宽度，不受容器
// 当前宽度影响，没有循环依赖）；**冻结**在整批提示存活期间只增不减 —— 一条消失时
// 容器宽度一点都不变，剩下的卡片不会被重新排版，只是渐渐淡出。
const heights = reactive<Record<number, number>>({});
const els = new Map<number, HTMLElement>();
const GAP = 6;

const width = ref<number | null>(null);

function setCard(id: number, el: unknown) {
  if (el instanceof HTMLElement) els.set(id, el);
  else els.delete(id);
}

async function syncLayout() {
  await nextTick();
  for (const [id, el] of els) heights[id] = el.offsetHeight;

  // 整批清空后复位，下一条重新按自己的文案收紧
  if (!toasts.length) {
    width.value = null;
    return;
  }
  // 量「这条文案单行需要多宽」：把卡片临时设成 width:max-content 再读盒子宽度。
  // 这一步不能量容器的 scrollWidth / 自己的 scrollWidth —— 前者量的是「当前」宽度，
  // 后者在 height:0 + overflow:hidden 的隐藏尺子上读过一次被裁后的宽度，
  // 越量越窄，最后把文案挤成一列竖排。改成量「把宽度交给内容时盒子有多宽」，
  // 结果与容器当前被钉成多少无关，量的是它自己，没有循环依赖。
  let need = 0;
  for (const el of els.values()) {
    const prev = el.style.width;
    el.style.width = "max-content";
    need = Math.max(need, Math.round(el.getBoundingClientRect().width));
    el.style.width = prev;
  }
  // 兜底：中文的 min-content 就是单个字，宽度一旦塌到几十像素就变成一列竖排。
  // 量到多小都不让它跌破这个下限，宁可宽一点也不能不可读。
  const MIN_W = 160;
  const cap = Math.min(560, Math.round(window.innerWidth * 0.8));
  const next = Math.min(Math.max(width.value ?? 0, need, MIN_W), cap);
  if (next !== width.value) width.value = next;
}

// 文案变化、增删条目都会改变高度；窗口变窄会让文案折行，也得重量
watch([() => toasts.length, expanded], syncLayout, { immediate: true });
onMounted(() => {
  window.addEventListener("resize", syncLayout);
  void syncLayout();
});
onUnmounted(() => {
  window.removeEventListener("resize", syncLayout);
  resumeToasts();
});

function onEnter() {
  if (!interactive.value) return;
  expanded.value = true;
  pauseToasts();
}

function onLeave() {
  if (!expanded.value) return;
  expanded.value = false;
  resumeToasts();
}

/**
 * 用 CSS 变量而不是内联 transform/opacity：进入/离开动画也要写这两个属性，
 * 内联样式会把动画的起点值直接覆盖掉（层一多就能看出来只有最前面那条在动）。
 * 展开与折叠都只是改变这几个变量 —— 位置永远由 transform 表达，才谈得上「有动画」；
 * 若靠 absolute ↔ relative 切换来排布，布局是瞬变的，没有任何属性可过渡，只能硬切。
 */
function offsetOf(i: number) {
  let ty = 0;
  for (let k = 0; k < i; k++) ty += (heights[visible.value[k].id] ?? 0) + GAP;
  return ty;
}

function layerStyle(i: number) {
  if (expanded.value) {
    return { "--ty": `${offsetOf(i)}px`, "--sc": "1", "--op": "1", zIndex: 30 - i };
  }
  return {
    "--ty": `${i * 6}px`,
    "--sc": `${1 - i * 0.05}`,
    "--op": i === 0 ? "1" : `${0.6 - (i - 1) * 0.18}`,
    zIndex: 30 - i,
  };
}
</script>

<template>
  <div
    class="pointer-events-none fixed top-[84px] left-1/2 z-[60] max-w-[min(560px,80vw)] -translate-x-1/2"
    :style="width === null ? { width: 'max-content' } : { width: `${width}px` }"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <TransitionGroup name="toast">
      <div
        v-for="(t, i) in visible"
        :key="t.id"
        :ref="(el) => setCard(t.id, el)"
        role="status"
        aria-live="polite"
        :aria-hidden="!expanded && i > 0 ? 'true' : undefined"
        class="toast-item surface-menu flex items-start gap-2 rounded-md px-4 py-2.5 text-sm"
        :class="[
          i === 0 ? 'relative' : 'absolute inset-x-0 top-0 origin-top',
          interactive ? 'pointer-events-auto' : '',
        ]"
        :style="layerStyle(i)"
      >
        <component
          :is="ICON[t.kind]"
          class="mt-0.5 size-4 shrink-0"
          :class="ICON_CLASS[t.kind]"
          aria-hidden="true"
        />
        <span class="select-text break-words">{{ t.text }}</span>
        <span
          v-if="!expanded && i === 0 && overflow"
          class="mt-0.5 shrink-0 rounded-full bg-muted px-1.5 text-2xs text-muted-foreground tabular-nums"
          :title="`另有 ${overflow} 条更早的提示`"
        >
          +{{ overflow }}
        </span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* 位移与缩放都由 --ty / --sc 驱动，进入与离开动画才有统一的起点。
   基础态就带 transition：展开/折叠改的是这三个变量，靠 transform 过渡才有「收放」的感觉 */
.toast-item {
  transform: translateY(var(--ty, 0)) scale(var(--sc, 1));
  opacity: var(--op, 1);
  transition:
    transform 0.18s ease,
    opacity 0.18s ease;
  will-change: transform, opacity;
}
.toast-enter-active,
.toast-leave-active {
  transition:
    transform 0.18s ease,
    opacity 0.18s ease;
}
/* 离开的那条脱离文档流，否则它和新来的那条会在 0.18 秒里叠成两行、容器高度跳一下 */
.toast-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(calc(var(--ty, 0px) - 8px)) scale(var(--sc, 1));
}
</style>
