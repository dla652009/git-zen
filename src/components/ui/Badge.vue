<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0 text-[10.5px] font-medium leading-[16px] whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-[var(--badge-default-bg)] text-[var(--badge-default-fg)]",
        muted: "bg-muted text-muted-foreground",
        info: "bg-[var(--badge-info-bg)] text-[var(--badge-info-fg)]",
        warning: "bg-[var(--badge-warning-bg)] text-[var(--badge-warning-fg)]",
        danger: "bg-[var(--badge-danger-bg)] text-[var(--badge-danger-fg)]",
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
