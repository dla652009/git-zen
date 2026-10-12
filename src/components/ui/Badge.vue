<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  // 圆角刻意留 full：徽标是一颗「药丸」，形状本身就在表达「这是个标记」。
  // 圆角档位管的是矩形（按钮/卡片/弹窗），不辖制这种独立形状。
  "inline-flex items-center rounded-full px-2 py-0 text-xs font-medium whitespace-nowrap",
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
