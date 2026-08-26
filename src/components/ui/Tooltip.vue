<script setup lang="ts">
import { ref } from "vue";

// 自定义 tooltip：跟随鼠标、支持多行（\n）、Teleport 到 body 不被 overflow 裁剪。
// 外层 display:contents，不影响宿主的 flex/truncate 布局。
const props = defineProps<{ text: string }>();

const show = ref(false);
const pos = ref({ x: 0, y: 0 });

function enter(e: MouseEvent) {
  move(e);
  show.value = true;
}
function move(e: MouseEvent) {
  // 靠右半屏时翻到鼠标左侧，避免溢出窗口
  const flip = e.clientX > window.innerWidth * 0.62;
  pos.value = { x: flip ? e.clientX - 14 : e.clientX + 16, y: e.clientY + 18 };
}
</script>

<template>
  <span class="contents" @mouseenter="enter" @mousemove="move" @mouseleave="show = false">
    <slot />
    <Teleport to="body">
      <Transition name="tt">
        <div
          v-if="show"
          class="pointer-events-none fixed z-50 max-w-[380px] whitespace-pre-line rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs leading-relaxed text-foreground shadow-lg"
          :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
        >
          {{ text }}
        </div>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.tt-enter-active,
.tt-leave-active {
  transition: opacity 0.12s;
}
.tt-enter-from,
.tt-leave-to {
  opacity: 0;
}
</style>
