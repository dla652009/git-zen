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
        'h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/60',
        props.class
      )
    "
  />
</template>
