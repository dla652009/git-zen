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
        info: "bg-primary/15 text-sky-300",
        warning: "bg-amber-400/15 text-amber-300",
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
