<script setup lang="ts">
// shadcn 风格下拉选择（原生 select 不吃 token 样式）
import { ref, onMounted, onUnmounted } from "vue";
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

function pick(v: string) {
  model.value = v;
  open.value = false;
}

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

const current = () => props.options.find((o) => o.value === model.value);
</script>

<template>
  <div ref="rootEl" class="relative">
    <button
      type="button"
      :disabled="disabled"
      :class="
        cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none transition-colors focus-visible:border-primary/60 disabled:opacity-45',
          props.class
        )
      "
      @click="open = !open"
    >
      <span :class="current() ? '' : 'text-muted-foreground'">
        {{ current()?.label ?? placeholder }}
      </span>
      <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
    </button>
    <div
      v-if="open"
      class="absolute top-full left-0 z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-card py-1 shadow-lg"
    >
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        :class="[
          'block w-full cursor-pointer px-2.5 py-1.5 text-left text-xs hover:bg-muted',
          o.value === model && 'bg-primary/10 text-primary',
        ]"
        @click="pick(o.value)"
      >
        {{ o.label }}
      </button>
    </div>
  </div>
</template>
