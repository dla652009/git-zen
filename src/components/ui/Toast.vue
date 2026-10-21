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
import { computed, ref } from "vue";
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
 * 展开时全部归位 —— 位置差交给文档流的 gap，不再是视觉上的错位。
 */
function layerStyle(i: number) {
  if (expanded.value) {
    return { "--ty": "0px", "--sc": "1", "--op": "1", zIndex: 30 - i };
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
    class="pointer-events-none fixed top-[84px] left-1/2 z-[60] flex w-fit max-w-[min(560px,80vw)] -translate-x-1/2 flex-col gap-1.5"
    :class="expanded ? '' : 'toast-deck'"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <TransitionGroup name="toast">
      <div
        v-for="(t, i) in visible"
        :key="t.id"
        role="status"
        aria-live="polite"
        :aria-hidden="!expanded && i > 0 ? 'true' : undefined"
        class="toast-item surface-menu flex items-start gap-2 rounded-md px-4 py-2.5 text-sm"
        :class="[
          expanded || i === 0 ? 'relative' : 'absolute inset-x-0 top-0 origin-top',
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
/* 位移与缩放都由 --ty / --sc 驱动，进入与离开动画才有统一的起点 */
.toast-item {
  transform: translateY(var(--ty, 0)) scale(var(--sc, 1));
  opacity: var(--op, 1);
}
.toast-enter-active,
.toast-leave-active {
  transition:
    transform 0.18s ease,
    opacity 0.18s ease;
}
/* 折叠时离开的那条脱离文档流，否则它和新来的那条会在 0.18 秒里叠成两行、容器高度跳一下。
   展开成竖排后要留在原位，否则它会盖到最上面那条身上 */
.toast-deck .toast-leave-active {
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
