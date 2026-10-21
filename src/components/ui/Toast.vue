<script setup lang="ts">
// 自动消失的结果提示（状态在 ./toast.ts，App 根部挂一次本组件即可）。
//
// 位置：顶部居中，紧贴选项卡栏下方。原先在底部居中 —— 中间列底部的说明文字与状态栏
// 让它在视觉上「沉」进背景，很容易错过。顶部是操作发生的方向（Pull/Push/刷新都在顶栏），
// 视线本来就在那里；容器 pointer-events-none，且只在出现后的 2.6 秒里占位，不挡常驻控件。
//
// 图标是这次可辨识性的关键：纯文字的胶囊在满屏等宽字体里和正文长得太像，
// 一个 Check / Info / Warn 让它在任何主题下都能被一眼识别。
import { toasts, type ToastKind } from "./toast";
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
</script>

<template>
  <div
    class="pointer-events-none fixed top-[84px] left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-1.5"
  >
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        role="status"
        aria-live="polite"
        class="surface-menu flex max-w-[min(560px,80vw)] items-start gap-2 rounded-md px-4 py-2.5 text-sm"
      >
        <component
          :is="ICON[t.kind]"
          class="mt-0.5 size-4 shrink-0"
          :class="ICON_CLASS[t.kind]"
          aria-hidden="true"
        />
        <span class="select-text break-words">{{ t.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
