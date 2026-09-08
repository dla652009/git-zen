<script setup lang="ts">
// 右下角自动消失的成功提示（状态在 ./toast.ts，App 根部挂一次本组件即可）
import { toasts } from "./toast";
</script>

<template>
  <div class="pointer-events-none fixed right-4 bottom-10 z-[60] flex flex-col items-end gap-1.5">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="rounded-md border border-border bg-card px-3 py-1.5 text-xs shadow-lg"
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
