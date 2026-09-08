<script setup lang="ts">
// 共享右键/下拉菜单：统一 定位收敛到视口 / Esc 关闭 / ↑↓ 选择 + 回车执行 / 外点关闭 / 入场动效。
// 替代此前各处手搓的 fixed 定位菜单（选项卡/提交/文件/分组/stash）
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";

export interface MenuItem {
  label: string;
  fn?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean; // 只画分隔线，label 留空
}

const props = defineProps<{ x: number; y: number; items: MenuItem[] }>();
const emit = defineEmits<{ close: [] }>();

const active = ref(0);
const root = ref<HTMLElement | null>(null);
const pos = ref({ x: props.x, y: props.y });

// 可键盘选择的项（跳过分隔线与禁用项）
const actionable = computed(() =>
  props.items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.separator && !it.disabled),
);

onMounted(async () => {
  await nextTick();
  const el = root.value;
  if (el) {
    const r = el.getBoundingClientRect();
    pos.value = {
      x: Math.max(6, Math.min(props.x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(props.y, window.innerHeight - r.height - 6)),
    };
  }
  // capture：菜单浮在最上层，Esc 不应再穿透给下层弹窗
  window.addEventListener("keydown", onKey, true);
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));

function run(it: MenuItem) {
  if (it.separator || it.disabled) return;
  // 先执行再关闭：菜单项闭包可能还在读父级的菜单状态（如 tabCtx.path）
  try {
    it.fn?.();
  } finally {
    emit("close");
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = actionable.value.length;
    if (!n) return;
    const cur = actionable.value.findIndex(({ i }) => i === active.value);
    const d = e.key === "ArrowDown" ? 1 : -1;
    active.value = actionable.value[(cur + d + n) % n]!.i;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const hit = actionable.value.find(({ i }) => i === active.value);
    if (hit) run(hit.it);
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50" @click="emit('close')" @contextmenu.prevent="emit('close')">
    <div
      ref="root"
      class="pop-in fixed min-w-[150px] overflow-hidden rounded-md border border-border bg-card py-1 shadow-xl"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      @click.stop
    >
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it.separator" class="my-1 border-t border-border/60" />
        <button
          v-else
          class="flex w-full cursor-pointer px-3 py-1.5 text-left text-xs"
          :class="[
            it.danger ? 'text-destructive' : '',
            active === i ? 'bg-muted' : '',
            it.disabled && 'pointer-events-none opacity-40',
          ]"
          @mousemove="active = i"
          @click.stop="run(it)"
        >
          {{ it.label }}
        </button>
      </template>
    </div>
  </div>
</template>
