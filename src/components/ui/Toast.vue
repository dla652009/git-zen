<script setup lang="ts">
// 自动消失的成功提示（状态在 ./toast.ts，App 根部挂一次本组件即可）。
// 位置：底部居中。原来在右下角，正好压住右栏的「提交」按钮和「提交后推送」开关 ——
// 提示虽然不吃点击（容器 pointer-events-none），但看不见按钮同样没法操作。
// 中间列的底部是唯一没有常驻控件的区域。
import { toasts } from "./toast";
</script>

<template>
  <div class="pointer-events-none fixed bottom-10 left-1/2 z-[60] flex max-w-[420px] -translate-x-1/2 flex-col items-center gap-1.5">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="surface-menu rounded-sm px-3 py-1.5 text-xs"
      >
        {{ t.text }}
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
  transform: translateY(6px);
}
</style>
