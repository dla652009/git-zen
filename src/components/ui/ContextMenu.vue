<script setup lang="ts">
// 共享右键/下拉菜单：统一 定位收敛到视口 / Esc 关闭 / ↑↓ 选择 + 回车执行 / 外点关闭 / 入场动效。
// 替代此前各处手搓的 fixed 定位菜单（选项卡/提交/文件/分组/stash）
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";

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

async function place() {
  await nextTick();
  const el = root.value;
  if (!el) return;
  pos.value = {
    x: Math.max(6, Math.min(props.x, window.innerWidth - el.offsetWidth - 6)),
    y: Math.max(6, Math.min(props.y, window.innerHeight - el.offsetHeight - 6)),
  };
}
onMounted(async () => {
  await place();
  // capture：菜单浮在最上层，Esc 不应再穿透给下层弹窗
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", place);
});
watch(active, async () => {
  await nextTick();
  root.value?.querySelector<HTMLElement>(`[data-menu-index="${active.value}"]`)?.scrollIntoView({ block: "nearest" });
});

function run(it: MenuItem) {
  if (it.separator || it.disabled) return;
  // 先执行再关闭：菜单项闭包可能还在读父级的菜单状态（如 tabCtx.path）
  try {
    it.fn?.();
  } finally {
    emit("close");
  }
}

// 遮罩上的右键：关掉本菜单后把事件按原坐标透传给底层元素——
// 连续右键浏览（A 行换 B 行）一步到位，不用先点一下空白关菜单
function onOverlayContextmenu(e: MouseEvent) {
  emit("close");
  nextTick(() => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    el?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        button: 2,
      }),
    );
  });
}
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return; // 输入法组合中：Enter/Esc 属于候选词操作，绝不能当成菜单确认/关闭
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
  <!-- Teleport 到 body：菜单的根是 fixed inset-0，调用处常常是 overflow-y-auto 的
       侧栏（如变更面板的右栏）或 flex 列。fixed 本身脱离文档流，但把它留在滚动容器
       内部仍会让该容器的滚动区/滚动条状态发生变化（实测：在变更面板点「⋯」展开菜单
       时右栏内容整体跳一下）。挪到 body 下与调用处的布局彻底脱钩，同时也保证菜单不被
       任何祖先的 transform/contain 意外做成包含块。 -->
  <Teleport to="body">
    <div class="fixed inset-0 z-50" @click="emit('close')" @contextmenu.prevent="onOverlayContextmenu">
      <div
        ref="root"
        class="bounded-menu pop-in surface-menu fixed rounded-sm p-1"
        :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
        @click.stop
      >
        <template v-for="(it, i) in items" :key="i">
          <div v-if="it.separator" class="mx-1 my-1 border-t border-border/60" />
          <button
            v-else
            :data-menu-index="i"
            class="flex w-full cursor-pointer items-center gap-2 rounded-xs px-2.5 py-1.5 text-left text-xs transition-colors duration-fast active:bg-active"
            :class="[
              it.danger ? 'text-destructive' : '',
              active === i ? 'bg-hover' : '',
              it.disabled && 'pointer-events-none opacity-40',
            ]"
            @mousemove="active = i"
            @click.stop="run(it)"
          >
            <span class="min-w-0 flex-1 whitespace-normal break-words">{{ it.label }}</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>
