<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[12.5px] font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        secondary: "bg-secondary text-secondary-foreground border border-border hover:border-primary/50",
        ghost: "hover:bg-muted",
        destructive: "bg-destructive/15 text-destructive border border-destructive/40 hover:bg-destructive/25",
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
