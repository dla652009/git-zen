<script setup lang="ts">
// 轻量 Markdown 渲染（AI 输出用）：markdown-it 默认安全转义 + 禁外链跳转风险可控
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";

const props = defineProps<{ source: string; class?: string }>();

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const html = computed(() => md.render(props.source ?? ""));

// AI 输出里的链接必须走系统浏览器。不拦的话 WebView 会直接导航过去，
// 而这是个桌面应用——没有地址栏也没有后退键，用户点一下就被困在网页里，只能重启。
// markdown-it 默认的 validateLink 已经挡掉 javascript:/vbscript:/file:/data:，
// 这里再只放行 http(s)，双保险。
async function onClick(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest?.("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return;
  try {
    await openUrl(href);
  } catch {
    /* 打不开就算了，不值得为一条链接弹错误框 */
  }
}
</script>

<template>
  <div
    :class="cn('text-base leading-relaxed', props.class)"
    v-html="html"
    @click="onClick"
  />
</template>

<style scoped>
:deep(h1),
:deep(h2),
:deep(h3) {
  font-size: var(--text-base);
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
  border-radius: var(--radius-xs);
  padding: 0.1em 0.4em;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
:deep(pre) {
  background: var(--muted);
  border-radius: var(--radius-md);
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
