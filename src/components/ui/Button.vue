<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-sm font-medium transition-[color,background-color,border-color,transform] duration-fast active:scale-[.98] cursor-pointer disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-primary/60 focus-visible:-outline-offset-1",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        secondary: "bg-secondary text-secondary-foreground border border-border hover:border-primary/50",
        ghost: "hover:bg-hover active:bg-active",
        // 危险按钮走专用实心色对：半透明底（bg-destructive/15）合成后 6 套主题都不达标
        destructive: "bg-[var(--btn-danger-bg)] text-[var(--btn-danger-fg)] hover:bg-[var(--btn-danger-bg-hover)]",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 px-2.5",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  }
);

type Variants = VariantProps<typeof buttonVariants>;

const props = withDefaults(
  defineProps<{ variant?: Variants["variant"]; size?: Variants["size"]; class?: HTMLAttributes["class"] }>(),
  {}
);
</script>

<template>
  <button :class="cn(buttonVariants({ variant, size }), props.class)">
    <slot />
  </button>
</template>
