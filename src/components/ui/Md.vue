<script setup lang="ts">
// 轻量 Markdown 渲染（AI 输出用）：markdown-it 默认安全转义 +禁外链跳转风险可控
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import { cn } from "@/lib/utils";

const props = defineProps<{ source: string; class?: string }>();

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const html = computed(() => md.render(props.source ?? ""));
</script>

<template>
  <div
    :class="cn('text-[13px] leading-relaxed', props.class)"
    v-html="html"
  />
</template>

<style scoped>
:deep(h1),
:deep(h2),
:deep(h3) {
  font-size: 13px;
  font-weight: 600;
  margin: 0.6em 0 0.3em;
}
:deep(p) {
  margin: 0.35em 0;
}
:deep(ul),
:deep(ol) {
  padding-left: 1.3em;
  margin: 0.35em 0;
}
:deep(li) {
  margin: 0.15em 0;
}
:deep(code) {
  background: var(--muted);
  border-radius: 4px;
  padding: 0.1em 0.4em;
  font-family: Consolas, monospace;
  font-size: 11.5px;
}
:deep(pre) {
  background: var(--muted);
  border-radius: 6px;
  padding: 8px 10px;
  overflow-x: auto;
  margin: 0.5em 0;
}
:deep(pre code) {
  background: transparent;
  padding: 0;
}
:deep(strong) {
  font-weight: 600;
}
</style>
