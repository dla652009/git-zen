<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"] }>();
const model = defineModel<string>({ default: "" });
</script>

<template>
  <textarea
    v-model="model"
    :class="
      cn(
        'w-full rounded-sm border border-border bg-input-bg px-2.5 py-1.5 text-base outline-none transition-colors duration-fast resize-y placeholder:text-muted-foreground focus-visible:border-primary/60',
        props.class
      )
    "
  />
</template>
