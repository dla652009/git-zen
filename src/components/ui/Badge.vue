<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // 形状：不再用 rounded-full。实心药丸读起来像「按钮」，而徽标只是标注 —— 它该更像一枚标签。
  // 圆角走 rounded-xs（尺度表里 chip 那一档），保留一点圆润但明确是矩形。
  "inline-flex items-center gap-1 rounded-xs px-1.5 py-0 text-xs font-medium whitespace-nowrap",
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
