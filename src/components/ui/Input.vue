<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
const model = defineModel<string | number>({ default: "" });
</script>

<template>
  <input
    v-model="model"
    :class="
      cn(
        'h-8 w-full rounded-sm border border-border bg-input-bg px-2.5 text-base outline-none transition-colors duration-fast placeholder:text-muted-foreground focus-visible:border-primary/60',
        props.class
      )
    "
  />
</template>
