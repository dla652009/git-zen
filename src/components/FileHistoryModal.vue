<script setup lang="ts">
// 文件变更历史双栏弹窗：左侧该文件的提交列表，右侧选中提交中此文件的 diff
import { ref, computed, onMounted } from "vue";
import { X } from "@lucide/vue";
import * as api from "../gitApi";
import type { LogEntry } from "../gitApi";
import { patchLines } from "../lib/patch";
import { Button, Spinner } from "@/components/ui";

const props = defineProps<{ repo: string; path: string }>();
const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const err = ref("");
const commits = ref<LogEntry[]>([]);
const selected = ref("");

const diffLoading = ref(false);
const diffErr = ref("");
const diffText = ref("");

onMounted(async () => {
  try {
    // --follow：追踪重命名前的历史
    commits.value = await api.log(props.repo, 0, false, props.path);
    if (commits.value.length) await select(commits.value[0].hash);
  } catch (e) {
    err.value = String(e).replace(/^Error: /, "");
  } finally {
    loading.value = false;
  }
});

// 行 hover 提示：选中提交的改动人信息
const selectedMeta = computed(() => {
  const c = commits.value.find((x) => x.hash === selected.value);
  return c ? `修改：${c.author} · ${c.date}（${c.hash.slice(0, 8)}）` : "";
});

async function select(hash: string) {
  if (selected.value === hash) return;
  selected.value = hash;
  diffLoading.value = true;
  diffErr.value = "";
  diffText.value = "";
  try {
    diffText.value = await api.showFile(props.repo, hash, props.path);
  } catch (e) {
    diffErr.value = String(e).replace(/^Error: /, "");
  } finally {
    diffLoading.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-30 flex items-center justify-center bg-black/50" @click.self="emit('close')">
    <div class="flex h-[80vh] w-[85vw] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span class="truncate font-medium">{{ path }}</span>
        <span class="shrink-0 text-xs text-muted-foreground">文件变更历史 · {{ commits.length }} 个提交</span>
        <span class="flex-1" />
        <Button variant="ghost" size="icon" @click="emit('close')"><X class="size-4" /></Button>
      </header>

      <div class="flex min-h-0 flex-1">
        <!-- 左：提交列表 -->
        <aside class="w-64 shrink-0 overflow-y-auto border-r border-border">
          <Spinner v-if="loading" class="m-3" label="加载中…" />
          <div v-else-if="err" class="m-3 text-xs text-destructive">{{ err }}</div>
          <div v-else-if="!commits.length" class="m-3 text-xs text-muted-foreground">
            该文件没有提交历史（可能是新文件）。
          </div>
          <ul v-else>
            <li
              v-for="c in commits"
              :key="c.hash"
              :class="[
                'cursor-pointer border-b border-border/60 px-3 py-2 hover:bg-muted',
                selected === c.hash && 'bg-primary/10',
              ]"
              @click="select(c.hash)"
            >
              <div class="truncate text-xs font-medium">{{ c.subject }}</div>
              <div class="mt-0.5 text-[10.5px] text-muted-foreground">
                {{ c.hash.slice(0, 8) }} · {{ c.author }} · {{ c.date }}
              </div>
            </li>
          </ul>
        </aside>

        <!-- 右：该提交中此文件的 diff -->
        <div class="min-w-0 flex-1 select-text overflow-auto p-3 font-mono text-xs leading-5">
          <Spinner v-if="diffLoading" label="加载中…" />
          <div v-else-if="diffErr" class="text-destructive">{{ diffErr }}</div>
          <pre v-else-if="diffText" class="whitespace-pre-wrap"><span
            v-for="(l, i) in patchLines(diffText)"
            :key="i"
            :class="l.cls"
            class="block"
            :title="selectedMeta"
          >{{ l.text || " " }}</span></pre>
          <div v-else class="text-muted-foreground">左侧选择一个提交查看变更。</div>
        </div>
      </div>
    </div>
  </div>
</template>
