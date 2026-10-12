<script setup lang="ts">
// shadcn 风格开关
import { cn } from "@/lib/utils";

const model = defineModel<boolean>({ required: true });
const props = defineProps<{ disabled?: boolean; class?: string }>();

function toggle() {
  if (!props.disabled) model.value = !model.value;
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    :disabled="disabled"
    :class="
      cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors duration-fast disabled:opacity-45',
        // 关闭态轨道用不透明 token：原来的 muted-foreground/40 合成后浅色主题只有 ~1.8:1，白滑块看不见
        model ? 'bg-primary' : 'bg-[var(--switch-off-bg)]',
        props.class,
      )
    "
    @click="toggle"
  >
    <span
      :class="
        cn(
          'block h-4 w-4 rounded-full bg-white shadow-elev-1 transition-transform duration-fast',
          model ? 'translate-x-4' : 'translate-x-0.5',
        )
      "
    />
  </button>
</template>
