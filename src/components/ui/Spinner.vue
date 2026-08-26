<script setup lang="ts">
// 全局统一 loading 图标：以后所有加载态都用它
import { LoaderCircle } from "@lucide/vue";

defineProps<{ size?: number; label?: string }>();
</script>

<template>
  <span class="inline-flex items-center gap-2 text-muted-foreground">
    <LoaderCircle class="animate-spin" :style="{ width: (size ?? 16) + 'px', height: (size ?? 16) + 'px' }" />
    <span v-if="label">{{ label }}</span>
  </span>
</template>
