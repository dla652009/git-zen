<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0 text-[10.5px] font-medium leading-[16px] whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-primary/20 text-primary",
        muted: "bg-muted text-muted-foreground",
        info: "bg-[var(--c-mod)]/15 text-[var(--c-mod)]",
        warning: "bg-[var(--c-conf)]/15 text-[var(--c-conf)]",
        danger: "bg-destructive/15 text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

type Variants = VariantProps<typeof badgeVariants>;

const props = withDefaults(
  defineProps<{ variant?: Variants["variant"]; class?: HTMLAttributes["class"] }>(),
  {}
);
</script>

<template>
  <span :class="cn(badgeVariants({ variant }), props.class)">
    <slot />
  </span>
</template>
