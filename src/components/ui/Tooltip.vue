<script setup lang="ts">
import { ref, nextTick } from "vue";

// 自定义 tooltip：跟随鼠标、支持多行（\n）、Teleport 到 body 不被 overflow 裁剪。
// 外层 display:contents，不影响宿主的 flex/truncate 布局。
// 位置在渲染后按实际尺寸收敛到视口内，贴边不再被截断；贴近下边缘时翻到鼠标上方。
const props = defineProps<{ text: string }>();

const show = ref(false);
const pos = ref({ x: 0, y: 0 });
const tipEl = ref<HTMLElement | null>(null);
let lastEvent: MouseEvent | null = null;

async function place(e: MouseEvent) {
  lastEvent = e;
  pos.value = { x: e.clientX + 16, y: e.clientY + 18 };
  await nextTick();
  const el = tipEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = e.clientX + 16;
  let y = e.clientY + 18;
  if (x + r.width > vw - 8) {
    // 右侧放不下 → 试左侧
    const lx = e.clientX - r.width - 16;
    if (lx >= 8) {
      x = lx;
    } else {
      // 两侧都放不下 → 水平贴边收敛 + 换到鼠标正上方
      x = Math.max(8, Math.min(vw - r.width - 8, e.clientX - r.width / 2));
      y = Math.max(8, e.clientY - r.height - 12);
    }
  }
  if (y + r.height > vh - 8) y = Math.max(8, e.clientY - r.height - 12);
  if (pos.value.x !== x || pos.value.y !== y) pos.value = { x, y };
}

function enter(e: MouseEvent) {
  show.value = true;
  place(e);
}
function move(e: MouseEvent) {
  if (!show.value) return;
  place(e);
}
function leave() {
  show.value = false;
}
</script>

<template>
  <span class="contents" @mouseenter="enter" @mousemove="move" @mouseleave="leave">
    <slot />
    <Teleport to="body">
      <Transition name="tt">
        <div
          v-if="show"
          ref="tipEl"
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
