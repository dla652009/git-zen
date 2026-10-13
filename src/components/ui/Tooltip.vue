<script setup lang="ts">
import { ref, nextTick, onUnmounted } from "vue";

// 自定义 tooltip：锚定触发元素（不跟随鼠标，避免滚动/嵌套场景错位），
// 默认显示在触发元素下方左对齐；贴边/贴底自动翻转到上方或收敛进视口。
// 外层 display:contents，不影响宿主的 flex/truncate 布局；Teleport 到 body 防 overflow 裁剪。
const props = defineProps<{ text: string }>();

const show = ref(false);
const pos = ref({ x: 0, y: 0 });
const hostEl = ref<HTMLElement | null>(null);
const tipEl = ref<HTMLElement | null>(null);

// 宿主槽位里的第一个真实元素作为锚点
function anchor(): DOMRect | null {
  const first = hostEl.value?.firstElementChild as HTMLElement | null;
  return first?.getBoundingClientRect() ?? null;
}

async function place() {
  const a = anchor();
  if (!a) return;
  await nextTick();
  const el = tipEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = a.left;
  let y = a.bottom + 6;
  if (x + r.width > vw - 8) x = Math.max(8, vw - r.width - 8); // 右溢出收敛
  if (y + r.height > vh - 8) y = Math.max(8, a.top - r.height - 6); // 底部放不下 → 翻上方
  if (y < 8) y = 8;
  pos.value = { x, y };
}

// 触发元素变成 disabled 时必须主动收起：Chrome 不会因为「指针底下那个元素被禁用」而补发
// mouseleave（指针不动就永远不重算 hover），于是在「点一下按钮、按钮随即变禁用」的场景里
// tooltip 会一直挂着 —— 例如「AI 生成提交信息」按下后 aiBusy 为真。
// 每次展开时重新绑定：槽位内容可能被 v-if 换掉，只绑一次会指向旧节点。
let mo: MutationObserver | null = null;
function watchDisabled() {
  mo?.disconnect();
  const first = hostEl.value?.firstElementChild as (HTMLElement & { disabled?: boolean }) | null;
  if (!first) return;
  mo = new MutationObserver(() => {
    if (first.disabled) show.value = false;
  });
  mo.observe(first, { attributes: true, attributeFilter: ["disabled"] });
}

function enter() {
  show.value = true;
  watchDisabled();
  place();
}
function leave() {
  show.value = false;
}
// 面板滚动时锚点会移动，直接隐藏最省心
function onScroll() {
  show.value = false;
}

onUnmounted(() => mo?.disconnect());
</script>

<template>
  <span
    ref="hostEl"
    class="contents"
    @mouseenter="enter"
    @mouseleave="leave"
    @click="leave"
    @scroll.capture="onScroll"
  >
    <slot />
    <Teleport to="body">
      <Transition name="tt">
        <div
          v-if="show"
          ref="tipEl"
          class="surface-menu pointer-events-none fixed z-50 max-w-[380px] whitespace-pre-line rounded-sm px-2.5 py-1.5 text-left text-xs leading-relaxed text-foreground"
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
