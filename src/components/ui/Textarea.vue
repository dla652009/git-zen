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
        'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none transition-colors resize-y placeholder:text-muted-foreground focus-visible:border-primary/60',
        props.class
      )
    "
  />
</template>
