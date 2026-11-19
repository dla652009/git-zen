<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ChevronDown, Maximize2, Minimize2, X } from "@lucide/vue";
import * as api from "../gitApi";
import type { CommitBrief } from "../gitApi";
import { patchSections } from "../lib/patch";
import { humanizeMsg } from "../lib/errors";
import { Button, Spinner, Tooltip } from "@/components/ui";

// 比较 A..B：上段提交清单 + 下段合并 diff 汇总。
// 刻意不嵌 DiffViewer（双栏 + 搜索 + AI 对「看区间差异」太重），只做简化渲染
const props = defineProps<{
  repo: string;
  a: string; // 旧
  b: string; // 新
  aSubject: string;
  bSubject: string;
}>();
const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const err = ref("");
const text = ref("");
const commits = ref<CommitBrief[]>([]);
const fullscreen = ref(false);
// 提交清单的展开状态：纯展示、不落盘。默认展开（多数比较就是为了看这几个提交），
// 但清单本身有高度上限，收起后正文能拿到全部剩余空间
const commitsOpen = ref(true);

onMounted(async () => {
  try {
    // 两个接口互不依赖，并行拉；任一失败整体报错
    const [diffText, list] = await Promise.all([
      api.diffRange(props.repo, props.a, props.b),
      api.commitsRange(props.repo, props.a, props.b),
    ]);
    text.value = diffText;
    commits.value = list;
  } catch (e) {
    err.value = humanizeMsg(e);
  } finally {
    loading.value = false;
  }
});

const sections = computed(() => patchSections(text.value));

// 空态分三种，各自的成因不同，混成一句「没有差异」会误导：
//  A..B 只收「B 有而 A 没有」的提交，两个快照的差异却是直接比树 ——
//  分叉时前者可能为空而后者不为空，反之（改动被抵消）也会出现有提交、无 diff。
const emptyKind = computed<"none" | "diff-only" | "commits-only" | null>(() => {
  const noCommits = commits.value.length === 0;
  const noDiff = sections.value.length === 0;
  if (noCommits && noDiff) return "none";
  if (noCommits) return "diff-only";
  if (noDiff) return "commits-only";
  return null;
});
</script>

<template>
  <!-- 同 DiffViewer：从标题栏下方开始，避免全屏时被常驻 TitleBar 盖住顶部 -->
  <div
    v-trap
    class="fixed inset-x-0 top-8 bottom-0 z-20 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-range-title"
    @click.self="emit('close')"
  >
    <!-- dialog-shell 只在非全屏套用：它的 max-height 按屏幕算，套进 h-full 会把全屏顶掉 32px -->
    <div
      class="pop-in surface flex flex-col overflow-hidden"
      :class="fullscreen ? 'h-full w-full' : 'dialog-shell h-[80vh] w-[80vw] rounded-lg'"
    >
      <header class="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
        <div class="min-w-0 flex-1">
          <!-- 起止范围可折行：两个提交的标题本身就长，截断等于看不到比的是什么 -->
          <div id="dlg-range-title" class="flex flex-wrap items-baseline gap-x-1.5 font-medium">
            <span class="min-w-0 [overflow-wrap:anywhere]">{{ aSubject }}</span>
            <span class="shrink-0 text-muted-foreground" aria-hidden="true">→</span>
            <span class="min-w-0 [overflow-wrap:anywhere]">{{ bSubject }}</span>
          </div>
          <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
            <span v-if="!loading && !err">{{ commits.length }} 个提交 · {{ sections.length }} 个文件</span>
            <span v-else-if="loading">加载中…</span>
            <span v-else>区间比较</span>
            <span class="font-mono">{{ a.slice(0, 8) }}..{{ b.slice(0, 8) }}</span>
          </div>
        </div>
        <span class="flex shrink-0 items-center gap-0.5">
          <Tooltip :text="fullscreen ? '退出全屏' : '全屏查看'">
            <Button
              variant="quiet"
              size="icon"
              class="h-6 w-6"
              :aria-label="fullscreen ? '退出全屏' : '全屏查看'"
              :aria-pressed="fullscreen"
              @click="fullscreen = !fullscreen"
            >
              <Minimize2 v-if="fullscreen" class="size-3.5" />
              <Maximize2 v-else class="size-3.5" />
            </Button>
          </Tooltip>
          <Button variant="quiet" size="icon" class="h-6 w-6" aria-label="关闭" @click="emit('close')">
            <X class="size-4" />
          </Button>
        </span>
      </header>

      <div v-if="loading" class="grid min-h-0 flex-1 place-items-center">
        <Spinner label="加载中…" />
      </div>
      <div v-else-if="err" class="min-h-0 flex-1 overflow-auto p-3 text-sm text-destructive">{{ err }}</div>
      <template v-else>
        <div class="flex min-h-0 flex-1 flex-col">
          <!-- 上段：区间内的提交（git log 顺序，新→旧）。高度封顶 + 可收起，
               清单再长也不会把下面的正文挤没 -->
          <section v-if="commits.length" class="flex shrink-0 flex-col" :class="commitsOpen && 'max-h-[38%]'">
            <div class="flex shrink-0 items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
              <button
                type="button"
                class="flex min-w-0 items-center gap-1 rounded-xs px-1 py-0.5 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary/60 focus-visible:-outline-offset-1"
                :aria-expanded="commitsOpen"
                @click="commitsOpen = !commitsOpen"
              >
                <ChevronDown
                  class="size-3 shrink-0 transition-transform duration-fast"
                  :class="!commitsOpen && '-rotate-90'"
                />
                <span class="truncate tabular-nums">区间内的 {{ commits.length }} 个提交（新→旧）</span>
              </button>
            </div>
            <div v-if="commitsOpen" class="min-h-0 flex-1 overflow-auto border-t border-border-soft">
              <div
                v-for="c in commits"
                :key="c.hash"
                class="flex items-start gap-2 border-b border-border-soft px-3 py-1.5 text-xs last:border-b-0"
              >
                <code class="shrink-0 font-mono text-muted-foreground">{{ c.hash }}</code>
                <span class="min-w-0 flex-1 [overflow-wrap:anywhere]" :title="c.subject">{{ c.subject }}</span>
                <!-- 这里是 --date=short 的绝对日期（后端 commitsRange 就是这么取的）：
                     比较两个提交范围时，具体哪一天比「3 天前」有用，所以不做相对化。 -->
                <span class="shrink-0 text-2xs text-muted-foreground">{{ c.author }} · {{ c.date }}</span>
              </div>
            </div>
          </section>

          <!-- 下段：合并 diff 按文件汇总；着色复用 lib/patch.ts 的 PatchLine.cls -->
          <div class="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5 select-text">
            <div v-if="emptyKind === 'none'" class="space-y-1 font-sans text-muted-foreground">
              <div>这两个提交之间没有提交，也没有文件变更。</div>
              <div class="text-2xs">
                A..B 只比较「B 有而 A 没有」的提交；如果方向选反了，结果就会是空的。
              </div>
            </div>
            <div v-else-if="emptyKind === 'diff-only'" class="font-sans text-muted-foreground">
              没有新增提交，但两个快照之间有文件差异。
            </div>
            <div v-else-if="emptyKind === 'commits-only'" class="font-sans text-muted-foreground">
              有 {{ commits.length }} 个提交，但两个快照的文件内容相同（改动可能已被后续提交抵消）。
            </div>
            <!-- v-for 不能和 v-else 写在同一元素上（Vue 3 里 v-if 优先级更高，会拿不到 s） -->
            <template v-else>
              <section v-for="s in sections" :key="s.file" class="mb-2">
                <div
                  class="sticky top-0 z-10 mb-1 truncate rounded-md bg-muted/60 px-2 py-1 text-muted-foreground"
                  :title="s.file"
                >
                  {{ s.file }}
                </div>
                <pre class="whitespace-pre-wrap font-mono text-xs leading-5 [overflow-wrap:anywhere]"><span
                  v-for="(l, i) in s.lines"
                  :key="i"
                  :class="l.cls"
                  class="flex"
                ><span class="min-w-0 flex-1">{{ l.text || " " }}</span></span></pre>
              </section>
            </template>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
