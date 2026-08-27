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
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:opacity-45',
        model ? 'bg-primary' : 'bg-muted-foreground/40',
        props.class,
      )
    "
    @click="toggle"
  >
    <span
      :class="
        cn(
          'block h-4 w-4 rounded-full bg-white shadow transition-transform',
          model ? 'translate-x-4' : 'translate-x-0.5',
        )
      "
    />
  </button>
</template>
