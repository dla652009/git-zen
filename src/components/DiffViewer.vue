<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { X, Bot } from "@lucide/vue";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../gitApi";
import { AI_PROMPTS, aiComplete, clipForAI, aiCacheRead, aiCacheWrite } from "../ai";
import { settings } from "../settings";
import { FileDown } from "@lucide/vue";

const savedTip = ref(false);
async function saveExplainToFile() {
  if (!explainText.value) return;
  const base = props.commit ? `AI-explain-${props.commit.hash.slice(0, 8)}` : `AI-explain-${props.file!.path.split(/[\/]/).pop()}`;
  const target = await saveDialog({
    title: "保存 AI 解释",
    defaultPath: `${base}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (!target) return;
  try {
    await api.writeTextFile(target, explainText.value);
    savedTip.value = true;
    setTimeout(() => (savedTip.value = false), 2000);
  } catch (e) {
    err.value = String(e).replace(/^Error: /, "");
  }
}
import { Button, Spinner, Md, Tooltip } from "@/components/ui";

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

// 解释结果本地缓存：commit 用 hash 键（不可变，永久有效）；文件用 路径+模式 键（可能过期，可重生成）
function explainId(): string {
  return props.commit
    ? `${props.repo}::commit::${props.commit.hash}`
    : `${props.repo}::${props.file!.cached ? "s" : "w"}::${props.file!.path}`;
}
onMounted(() => {
  // 缓存命中：直接预填解释面板，diff 主区照常加载；可点 Bot 按钮重新生成覆盖
  const saved = aiCacheRead("explain", explainId());
  if (saved !== undefined) explainText.value = saved;
});

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

// AI 解释变更：直接消费已加载的 patch 文本；结果写入 localStorage 二次打开秒显
const explainBusy = ref(false);
const explainErr = ref("");
const explainText = ref("");
async function loadExplain() {
  if (settings.aiEnabled !== "on") {
    explainErr.value = "AI 功能已关闭：设置 → AI 页可开启";
    return;
  }
  explainBusy.value = true;
  explainErr.value = "";
  explainText.value = "";
  try {
    explainText.value = await aiComplete(
      AI_PROMPTS.explainDiff.system,
      clipForAI(text.value),
    );
    aiCacheWrite("explain", explainId(), explainText.value);
  } catch (e) {
    explainErr.value = String(e).replace(/^Error: /, "");
  } finally {
    explainBusy.value = false;
  }
}
async function explain() {
  if (explainBusy.value || !text.value.trim()) return;
  explainErr.value = "";
  explainText.value = "";
  await loadExplain();
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

// 双栏：左文件列表选中项（默认第一个文件）
const selectedFile = ref("");
watch(sections, (list) => {
  if (!list.find((s) => s.file === selectedFile.value)) {
    selectedFile.value = list[0]?.file ?? "";
  }
}, { immediate: true });

// 行 hover 提示改动人信息（工作区文件无改动人 → 显示路径与模式）
const lineTip = computed(() =>
  props.commit
    ? `修改：${props.commit.author} · ${props.commit.date}`
    : props.file
      ? `文件：${props.file.path}${props.file.cached ? "（已暂存）" : "（工作区）"}`
      : ""
);
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
        <Tooltip v-if="settings.aiEnabled === 'on'" text="AI 解释这段变更">
          <Button variant="ghost" size="sm" :disabled="explainBusy" @click="explain">
            <Spinner v-if="explainBusy" :size="14" />
            <Bot v-else class="size-3.5 text-primary" />
          </Button>
        </Tooltip>
        <Button variant="ghost" size="icon" @click="emit('close')"><X class="size-4" /></Button>
      </header>

        <!-- 双栏：左文件列表 / 右选中文件的 diff（参考 FileHistoryModal 布局） -->
        <div class="flex min-h-0 flex-1">
        <aside class="w-56 shrink-0 overflow-y-auto border-r border-border">
          <ul>
            <li
              v-for="s in sections"
              :key="s.file"
              :class="[
                'cursor-pointer border-b border-border/60 px-3 py-2 font-sans hover:bg-muted',
                selectedFile === s.file && 'bg-primary/10',
              ]"
              :title="s.file"
              @click="selectedFile = s.file"
            >
              <div class="truncate text-xs font-medium">{{ s.file.split("/").pop() }}</div>
              <div class="mt-0.5 text-[10.5px] text-muted-foreground">{{ s.lines.length }} 行</div>
            </li>
          </ul>
        </aside>
        <div class="min-w-0 flex-1 select-text overflow-auto p-3 font-mono text-xs leading-5">
          <Spinner v-if="loading" label="加载中…" />
          <div v-else-if="err" class="text-destructive">{{ err }}</div>
          <div v-else-if="!sections.length" class="text-muted-foreground">没有文件变更。</div>
          <template v-else>
            <div
              class="mb-2 truncate rounded bg-muted/60 px-2 py-1 font-sans text-[11px] text-muted-foreground"
              :title="selectedFile"
            >
              {{ selectedFile }}
            </div>
            <pre class="whitespace-pre"><span
              v-for="(l, i) in sections.find((s) => s.file === selectedFile)?.lines ?? []"
              :key="i"
              :class="l.cls"
              class="block"
              :title="lineTip"
            >{{ l.text || " " }}</span></pre>
          </template>
        </div>
      </div>

      <!-- AI 解释面板 -->
      <div
        v-if="explainBusy || explainErr || explainText"
        class="max-h-[35%] shrink-0 overflow-y-auto border-t border-border px-3 py-2"
      >
        <div class="mb-1 flex items-center gap-2">
          <span class="text-[11px] uppercase tracking-wider text-muted-foreground">AI 解释</span>
          <Button variant="ghost" size="sm" class="h-5 px-1.5 text-[11px]" :disabled="!explainText" @click="saveExplainToFile">
            <FileDown class="size-3" />{{ savedTip ? "已保存 ✓" : "保存到本地" }}
          </Button>
          <span class="flex-1" />
        </div>
        <Spinner v-if="explainBusy" label="AI 分析中…" />
        <div v-else-if="explainErr" class="text-[11px] text-destructive">{{ explainErr }}</div>
        <Md v-else :source="explainText" class="text-xs" />
      </div>
    </div>
  </div>
</template>
