<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Maximize2, Minimize2, X } from "@lucide/vue";
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
    <div
      class="pop-in surface flex flex-col"
      :class="fullscreen ? 'h-full w-full' : 'h-[80vh] w-[80vw] rounded-lg'"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span id="dlg-range-title" class="min-w-0 truncate font-medium">
          比较 {{ aSubject }} → {{ bSubject }}
        </span>
        <span v-if="!loading && !err" class="shrink-0 text-xs text-muted-foreground tabular-nums">
          {{ commits.length }} 个提交 · {{ sections.length }} 个文件
        </span>
        <span class="flex-1" />
        <Tooltip :text="fullscreen ? '退出全屏' : '全屏查看'">
          <Button
            variant="ghost"
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
        <Button variant="ghost" size="icon" aria-label="关闭" @click="emit('close')">
          <X class="size-4" />
        </Button>
      </header>

      <div v-if="loading" class="grid flex-1 place-items-center">
        <Spinner label="加载中…" />
      </div>
      <div v-else-if="err" class="flex-1 p-3 text-sm text-destructive">{{ err }}</div>
      <template v-else>
        <!-- 上段：区间内的提交（git log 顺序，新→旧） -->
        <div class="max-h-[35%] shrink-0 overflow-auto border-b border-border">
          <div v-if="!commits.length" class="px-3 py-3 text-xs text-muted-foreground">
            两个提交之间没有提交
          </div>
          <div
            v-for="c in commits"
            :key="c.hash"
            class="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs last:border-b-0"
          >
            <code class="shrink-0 font-mono text-muted-foreground">{{ c.hash }}</code>
            <span class="min-w-0 flex-1 truncate" :title="c.subject">{{ c.subject }}</span>
            <span class="shrink-0 text-2xs text-muted-foreground">{{ c.author }} · {{ c.date }}</span>
          </div>
        </div>

        <!-- 下段：合并 diff 按文件汇总；着色复用 lib/patch.ts 的 PatchLine.cls -->
        <div class="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5 select-text">
          <div v-if="!sections.length" class="text-muted-foreground">两个提交之间没有文件变更。</div>
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
        </div>
      </template>
    </div>
  </div>
</template>
