<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { X, ChevronDown, ChevronsDownUp, ChevronsUpDown, Bot } from "@lucide/vue";
import * as api from "../gitApi";
import { AI_PROMPTS, aiComplete, clipForAI } from "../ai";
import { Button, Spinner } from "@/components/ui";

export interface DiffTarget {
  path: string;
  cached: boolean;
  untracked: boolean;
}

export interface CommitTarget {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

// 二选一：单文件 diff 或整个 commit 的 patch
const props = defineProps<{
  repo: string;
  file?: DiffTarget;
  commit?: CommitTarget;
}>();
const emit = defineEmits<{ close: [] }>();

const text = ref("");
const loading = ref(true);
const err = ref("");

onMounted(async () => {
  try {
    if (props.commit) {
      text.value = await api.show(props.repo, props.commit.hash);
    } else if (props.file) {
      // 未跟踪文件没有 git diff，后端读文件内容合成“全新增”预览
      text.value = props.file.untracked
        ? await api.diffUntracked(props.repo, props.file.path)
        : await api.diff(props.repo, [props.file.path], props.file.cached);
    }
  } catch (e) {
    err.value = String(e);
  } finally {
    loading.value = false;
  }
});

// AI 解释变更：直接消费已加载的 patch 文本
const explainBusy = ref(false);
const explainErr = ref("");
const explainText = ref("");
async function explain() {
  if (explainBusy.value || !text.value.trim()) return;
  explainBusy.value = true;
  explainErr.value = "";
  explainText.value = "";
  try {
    explainText.value = await aiComplete(
      AI_PROMPTS.explainDiff.system,
      clipForAI(text.value)
    );
  } catch (e) {
    explainErr.value = String(e).replace(/^Error: /, "");
  } finally {
    explainBusy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));

interface Line {
  cls: string;
  text: string;
}

const lines = computed<Line[]>(() =>
  text.value.split("\n").map((l) => {
    if (l.startsWith("@@")) return { cls: "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]", text: l };
    if (l.startsWith("+") && !l.startsWith("+++"))
      return { cls: "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]", text: l };
    if (l.startsWith("-") && !l.startsWith("---"))
      return { cls: "bg-[var(--diff-del-bg)] text-[var(--diff-del-text)]", text: l };
    if (
      l.startsWith("diff ") ||
      l.startsWith("index ") ||
      l.startsWith("---") ||
      l.startsWith("+++") ||
      l.startsWith("new file") ||
      l.startsWith("deleted file") ||
      l.startsWith("rename ") ||
      l.startsWith("similarity ")
    )
      return { cls: "text-muted-foreground", text: l };
    return { cls: "", text: l };
  })
);

// 按文件切段，支持展开/收起
interface Section {
  file: string;
  lines: Line[];
}

function fileNameOf(l: Line): string {
  const m = l.text.match(/^diff --git a\/(\S+)/);
  return m ? m[1] : "";
}

const sections = computed<Section[]>(() => {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const l of lines.value) {
    if (l.text.startsWith("diff --git ")) {
      cur = { file: fileNameOf(l), lines: [l] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(l);
    }
  }
  return out;
});

const collapsed = ref(new Set<string>());
function toggle(file: string) {
  const next = new Set(collapsed.value);
  if (next.has(file)) next.delete(file);
  else next.add(file);
  collapsed.value = next;
}
// 全部收起 ⇄ 全部展开，单按钮切换
const allCollapsed = computed(() => sections.value.length > 0 && collapsed.value.size === sections.value.length);
function toggleAll() {
  collapsed.value = allCollapsed.value ? new Set() : new Set(sections.value.map((s) => s.file));
}
</script>

<template>
  <!-- 固定高度，避免加载前后高度跳动 -->
  <div class="fixed inset-0 z-20 flex items-center justify-center bg-black/50" @click.self="emit('close')">
    <div class="flex h-[80vh] w-[80vw] flex-col rounded-lg border border-border bg-card shadow-xl">
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span class="truncate font-medium">
          {{ commit ? commit.subject : file?.path }}
        </span>
        <span class="shrink-0 text-xs text-muted-foreground">
          {{ commit ? `${commit.author} · ${commit.date}` : file?.cached ? "已暂存的变更" : "工作区变更" }}
        </span>
        <span class="flex-1" />
        <Button variant="ghost" size="sm" title="AI 解释这段变更" :disabled="explainBusy" @click="explain">
          <Spinner v-if="explainBusy" :size="14" />
          <Bot v-else class="size-3.5 text-primary" />
        </Button>
        <template v-if="sections.length > 1">
          <Button variant="ghost" size="sm" :title="allCollapsed ? '全部展开' : '全部收起'" @click="toggleAll">
            <ChevronsUpDown v-if="allCollapsed" class="size-3.5" />
            <ChevronsDownUp v-else class="size-3.5" />
          </Button>
        </template>
        <Button variant="ghost" size="icon" @click="emit('close')"><X class="size-4" /></Button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5">
        <Spinner v-if="loading" label="加载中…" />
        <div v-else-if="err" class="text-destructive">{{ err }}</div>
        <div v-else-if="!sections.length" class="text-muted-foreground">没有文件变更。</div>
        <template v-else>
          <div
            v-for="s in sections"
            :key="s.file"
            class="mb-2 overflow-hidden rounded-md border border-border"
          >
            <!-- 多文件时可点击文件头展开/收起 -->
            <div
              v-if="sections.length > 1"
              class="flex cursor-pointer items-center gap-1.5 bg-muted/60 px-2 py-1 font-sans font-medium select-none hover:bg-muted"
              @click="toggle(s.file)"
            >
              <ChevronDown
                class="size-3 transition-transform"
                :class="collapsed.has(s.file) && '-rotate-90'"
              />
              {{ s.file }}
            </div>
            <pre v-show="sections.length === 1 || !collapsed.has(s.file)" class="px-2 py-1 whitespace-pre"><span
              v-for="(l, i) in s.lines"
              :key="i"
              :class="l.cls"
              class="block"
            >{{ l.text || " " }}</span></pre>
          </div>
        </template>
      </div>

      <!-- AI 解释面板 -->
      <div
        v-if="explainBusy || explainErr || explainText"
        class="max-h-[35%] shrink-0 overflow-y-auto border-t border-border px-3 py-2"
      >
        <Spinner v-if="explainBusy" label="AI 分析中…" />
        <div v-else-if="explainErr" class="text-[11px] text-destructive">{{ explainErr }}</div>
        <div v-else class="whitespace-pre-wrap font-sans text-xs leading-relaxed">{{ explainText }}</div>
      </div>
    </div>
  </div>
</template>
