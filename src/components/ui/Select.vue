<script setup lang="ts">
// shadcn 风格下拉选择（原生 select 不吃 token 样式）
//
// 面板用 Teleport 到 body + position:fixed：下拉可能出现在任何滚动容器里
// （设置页的 overflow-y-auto、弹窗的 overflow-hidden），absolute 定位会被祖先
// 裁掉 —— 表现就是列表在容器底部被切断、尾部选项点不到。fixed 相对视口，
// 不受任何祖先裁剪影响；代价是锚点要自己算，且滚动/缩放时要跟着重算。
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import { ChevronDown } from "@lucide/vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    options: { value: string; label: string }[];
    placeholder?: string;
    class?: string;
    disabled?: boolean;
  }>(),
  { placeholder: "请选择" }
);

const model = defineModel<string>({ required: true });
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0, width: 0 });

function pick(v: string) {
  model.value = v;
  open.value = false;
}

// 面板定位：贴按钮下方左对齐；右溢出收敛、底部放不下就翻到上方。
// 宽度跟随按钮（min-w-full 的原意），但至少能容下最长选项，上限压在视口内。
async function place() {
  const anchor = rootEl.value;
  if (!anchor) return;
  const a = anchor.getBoundingClientRect();
  await nextTick();
  const panel = panelEl.value;
  const pw = panel?.offsetWidth ?? a.width;
  const ph = panel?.offsetHeight ?? 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = a.left;
  if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
  let top = a.bottom + 4;
  if (ph && top + ph > vh - 8) top = Math.max(8, a.top - ph - 4); // 底部放不下 → 翻上方
  pos.value = { left, top, width: a.width };
}

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) place();
}

function onDocClick(e: MouseEvent) {
  const t = e.target as Node;
  if (rootEl.value?.contains(t) || panelEl.value?.contains(t)) return;
  open.value = false;
}
// 页面滚动或缩放时锚点会移动：收起面板最省心（与 Tooltip 一致）。
// 但**面板自身内部的滚动不算** —— 它 max-h-56 + overflow-y-auto，选项多时要能滚着看。
// capture 监听会先于冒泡拿到面板里的 scroll 事件，所以这里按事件源排除。
function onScrollOrResize(e?: Event) {
  if (!open.value) return;
  const t = e?.target as Node | null;
  if (t && panelEl.value?.contains(t)) return; // 面板内部滚动：不关
  open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) {
    // 面板在 body 下，Esc 要自己拦一下，别让下层浮层跟着关
    e.stopPropagation();
    open.value = false;
  }
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  window.addEventListener("scroll", onScrollOrResize, true); // capture：滚动可能发生在任意容器里
  window.addEventListener("resize", onScrollOrResize);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  window.removeEventListener("scroll", onScrollOrResize, true);
  window.removeEventListener("resize", onScrollOrResize);
});

watch(open, (v) => {
  if (v) place();
});

const current = () => props.options.find((o) => o.value === model.value);
</script>

<template>
  <div ref="rootEl" class="relative">
    <button
      type="button"
      :disabled="disabled"
      :title="current()?.label ?? placeholder"
      :class="
        cn(
          'gz-field flex h-8 w-full items-center justify-between gap-2 rounded-sm border border-border bg-input-bg px-2.5 text-base whitespace-nowrap outline-none transition-colors duration-fast focus-visible:border-primary/60 disabled:opacity-45',
          props.class
        )
      "
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onKey"
    >
      <span class="truncate" :class="current() ? '' : 'text-muted-foreground'">
        {{ current()?.label ?? placeholder }}
      </span>
      <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelEl"
        class="pop-in surface-menu fixed z-[60] max-h-56 overflow-y-auto overscroll-contain rounded-sm py-1"
        :style="{ left: pos.left + 'px', top: pos.top + 'px', minWidth: pos.width + 'px' }"
        role="listbox"
        @keydown="onKey"
      >
        <button
          v-for="o in options"
          :key="o.value"
          type="button"
          role="option"
          :aria-selected="o.value === model"
          :class="[
            'block w-full cursor-pointer px-2.5 py-1.5 text-left text-xs whitespace-nowrap transition-colors duration-fast hover:bg-hover active:bg-active',
            o.value === model && 'bg-primary-soft text-primary',
          ]"
          @click="pick(o.value)"
        >
          {{ o.label }}
        </button>
      </div>
    </Teleport>
  </div>
</template>
