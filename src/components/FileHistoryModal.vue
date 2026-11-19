<script setup lang="ts">
// 文件变更历史双栏弹窗：左侧该文件的提交列表，右侧选中提交中此文件的 diff
import { ref, computed, onMounted, onUnmounted } from "vue";
import { X, Bot, Search, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen } from "@lucide/vue";
import * as api from "../gitApi";
import type { LogEntry } from "../gitApi";
import { patchLines } from "../lib/patch";
import { useDiffSearch } from "../composables/useDiffSearch";
import { humanizeMsg } from "../lib/errors";
import { relDateText } from "../lib/relDate";
import {
  AI_PROMPTS,
  aiComplete,
  aiCacheRead,
  aiCacheWrite,
  clipForAI,
  isAbortError,
} from "../ai";
import { settings } from "../settings";
import { Button, Spinner, Tooltip } from "@/components/ui";
import DiffSearchBar from "./DiffSearchBar.vue";

const props = defineProps<{ repo: string; path: string }>();
const emit = defineEmits<{ close: [] }>();

const loading = ref(true);
const err = ref("");
const commits = ref<LogEntry[]>([]);
const selected = ref("");

const diffLoading = ref(false);
const diffErr = ref("");
const diffText = ref("");

// 全屏：h/w/rounded 必须整组切换 —— 静态 class 与动态 :class 同时给这两组值的话，
// 两套都会留在 class 上，谁生效由产物 CSS 顺序决定（不是先写的赢）。
const fullscreen = ref(false);

// ---- 辅助列表（左栏提交名单）可收起 ----
// 左栏固定 256px 会占掉窗口宽度，而这份名单只是「换提交」的入口，
// 收起来不影响当前提交的阅读。纯本地展示状态，不落盘、不影响任何请求。
// 不按窗口宽度自动开合：窗口最小宽 860，任何小于它的阈值都不会成立（等同死代码），
// 收起与否完全交给自己点。
const listOpen = ref(true);

// diff 内搜索（单段：整份 diff 就是一个 section）
const rootEl = ref<HTMLElement | null>(null);
// 模板与搜索共用同一份解析结果，避免一次渲染里解析两遍 patch
const lines = computed(() => patchLines(diffText.value));
const { searchOpen, q, cur, count, hitRow, segsFor, goTo, toggleSearch, closeSearch } = useDiffSearch({
  sections: computed(() => [{ file: props.path, lines: lines.value }]),
  activeSection: computed(() => 0),
  root: rootEl,
  focusBackSelector: "[data-search-toggle]",
});

function onWinKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
  // 可能同时开着别的 diff 弹窗：焦点不在本弹窗里就别抢。
  // 但焦点在 body 不算「别处在用」—— 点过 diff 文本之后焦点会落回 body，
  // 把它当成占用会让 Ctrl+F 静默失效（本组件挂载期间，它自己就是打开着的那个弹窗）。
  const act = document.activeElement as HTMLElement | null;
  if (act && act !== document.body && rootEl.value && !rootEl.value.contains(act)) return;
  e.preventDefault();
  toggleSearch();
}
onMounted(() => window.addEventListener("keydown", onWinKeydown));
onUnmounted(() => window.removeEventListener("keydown", onWinKeydown));

onMounted(async () => {
  try {
    // --follow：追踪重命名前的历史
    commits.value = await api.log(props.repo, 0, false, props.path);
    if (commits.value.length) await select(commits.value[0].hash);
  } catch (e) {
    err.value = humanizeMsg(e);
  } finally {
    loading.value = false;
  }
});

// 行 hover 提示：选中提交的改动人信息
const selectedMeta = computed(() => {
  const c = commits.value.find((x) => x.hash === selected.value);
  return c ? `修改：${c.author} · ${relDateText(c.date)}（${c.hash.slice(0, 8)}）` : "";
});

// 当前是第几个提交 / 一共几个：收起左栏之后，「现在看的是哪一条、还有没有下一条」
// 仍然从头部读得到，不必为了确认位置把名单再展开
const selectedNo = computed(() => {
  const i = commits.value.findIndex((x) => x.hash === selected.value);
  return i < 0 ? 0 : i + 1;
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
    diffErr.value = humanizeMsg(e);
  } finally {
    diffLoading.value = false;
  }
}

// ---- AI 解读演进：这个文件为什么长成现在这样 ----
const evoId = computed(() => `${props.repo}::${props.path}`);
const evoOpen = ref(false);
const evoBusy = ref(false);
const evoErr = ref("");
const evoText = ref("");
onMounted(() => {
  const saved = aiCacheRead("evolve", evoId.value);
  if (saved !== undefined) {
    evoText.value = saved;
    evoOpen.value = true;
  }
});

/**
 * 挑有代表性的几次改动：首尾 + 均匀取样，最多 5 次。
 * 全量 diff 塞不进上下文，而只看最近几条又讲不清「为什么长成这样」——
 * 这份文件最早那次改动（创建）往往才是理解现状的钥匙。
 */
function pickEvoCommits(list: LogEntry[], n = 5): LogEntry[] {
  if (list.length <= n) return [...list];
  const idx = new Set<number>([0, list.length - 1]);
  if (n > 2) idx.add(1);
  const rest = n - idx.size;
  for (let k = 1; k <= rest; k++) {
    idx.add(Math.round(((list.length - 1) * k) / (rest + 1)));
  }
  return [...idx].sort((a, b) => a - b).map((i) => list[i]);
}

async function aiEvolution() {
  if (evoBusy.value || !commits.value.length) return;
  evoOpen.value = true;
  if (settings.aiEnabled !== "on") {
    evoErr.value = "AI 功能已关闭：设置 → AI 页可开启";
    return;
  }
  evoBusy.value = true;
  evoErr.value = "";
  evoText.value = "";
  const repo = props.repo;
  const path = props.path;
  try {
    const timeline = commits.value
      .slice(0, 40)
      .map((c) => `${c.hash.slice(0, 7)} ${c.date} ${c.author} ${c.subject}`)
      .join("\n");
    // 取 diff 时按时间正序（旧→新），模型的「演进」叙述才不会倒着讲
    const picks = [...pickEvoCommits(commits.value)].reverse();
    const parts: string[] = [];
    for (const c of picks) {
      try {
        const d = await api.showFile(repo, c.hash, path);
        if (d.trim()) {
          parts.push(`--- ${c.hash.slice(0, 7)}（${c.date} ${c.subject}）---\n${clipForAI(d, 1800)}`);
        }
      } catch {
        // 单个提交取不到 diff 不影响整体（例如改名前的路径差异）
      }
    }
    const user = `【文件】${path}

【提交时间线（新→旧，最多 40 条；该文件共 ${commits.value.length} 个提交）】
${timeline || "（无提交历史）"}

【若干次关键改动的 diff（旧→新）】
${parts.join("\n\n") || "（取不到 diff）"}`;
    const text = await aiComplete(AI_PROMPTS.fileEvolution.system, clipForAI(user));
    if (props.repo !== repo || props.path !== path) return;
    evoText.value = text;
    aiCacheWrite("evolve", evoId.value, text);
  } catch (e) {
    if (isAbortError(e)) return;
    evoErr.value = humanizeMsg(e);
  } finally {
    evoBusy.value = false;
  }
}

function closeEvo() {
  evoOpen.value = false;
  evoText.value = "";
  evoErr.value = "";
}
</script>

<template>
  <div
    ref="rootEl"
    v-trap
    class="fixed inset-x-0 top-8 bottom-0 z-30 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-file-history-title"
    @click.self="emit('close')"
  >
    <!-- dialog-shell 只在非全屏套用：它的 max-height 按屏幕算，套进 h-full 会把全屏顶掉 -->
    <div
      class="pop-in surface flex flex-col overflow-hidden"
      :class="fullscreen ? 'h-full w-full' : 'dialog-shell h-[80vh] w-[85vw] rounded-lg'"
    >
      <header class="flex shrink-0 items-start gap-2 border-b border-border px-4 py-2.5">
        <!-- 标题两行：第一行路径（超长截断，完整值走 title），第二行是文件身份与总数。
             这样收起左栏、标题被截断时，「这是哪个文件、一共几个提交」依然读得到 -->
        <div class="min-w-0 flex-1">
          <div id="dlg-file-history-title" class="truncate font-medium" :title="path">{{ path }}</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
            <span class="shrink-0">文件变更历史</span>
            <span aria-hidden="true">·</span>
            <span class="shrink-0">共 {{ commits.length }} 个提交</span>
            <template v-if="selected">
              <span aria-hidden="true">·</span>
              <span class="shrink-0">第 {{ selectedNo }} / {{ commits.length }} 个</span>
            </template>
          </div>
        </div>
        <span class="flex shrink-0 items-center gap-0.5">
          <Tooltip :text="listOpen ? '收起提交列表' : '展开提交列表'">
            <Button
              variant="quiet"
              size="icon"
              class="h-6 w-6"
              :aria-label="listOpen ? '收起提交列表' : '展开提交列表'"
              :aria-pressed="listOpen"
              :disabled="!commits.length"
              @click="listOpen = !listOpen"
            >
              <PanelLeftClose v-if="listOpen" class="size-3.5" />
              <PanelLeftOpen v-else class="size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip text="AI 解读这个文件的演进">
            <Button
              variant="quiet"
              size="icon"
              class="h-6 w-6"
              aria-label="AI 解读演进历史"
              :disabled="!commits.length"
              @click="aiEvolution"
            >
              <Bot v-if="!evoBusy" class="size-3.5" :class="evoText ? 'text-primary' : ''" />
              <Spinner v-else :size="14" aria-label="解读中" />
            </Button>
          </Tooltip>
          <Tooltip text="搜索（Ctrl+F）">
            <Button
              variant="quiet"
              size="icon"
              class="h-6 w-6"
              data-search-toggle
              aria-label="在 diff 里搜索"
              :aria-pressed="searchOpen"
              @click="toggleSearch"
            >
              <Search class="size-3.5" />
            </Button>
          </Tooltip>
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

      <!-- diff 内搜索：回车下一个、Shift+回车上一个、Esc 只关搜索栏（stop 掉，别连带关掉弹窗） -->
      <DiffSearchBar
        v-if="searchOpen"
        v-model:q="q"
        :count="count"
        :cur="cur"
        @go="goTo"
        @close="closeSearch"
      />

      <!-- AI 演进解读：与 diff 主区并列的一条可收起面板 -->
      <div
        v-if="evoOpen"
        class="max-h-[45%] shrink-0 overflow-auto border-b border-border bg-muted/25 px-4 py-2.5"
      >
        <div class="mb-1 flex items-center gap-2">
          <Bot class="size-3.5 shrink-0 text-primary" />
          <span class="text-xs font-medium">AI 演进解读</span>
          <span class="flex-1" />
          <Button variant="quiet" size="icon" class="h-6 w-6" aria-label="收起解读" @click="closeEvo">
            <X class="size-3.5" />
          </Button>
        </div>
        <Spinner v-if="evoBusy" label="解读中…" />
        <div v-else-if="evoErr" class="text-xs text-destructive">{{ evoErr }}</div>
        <div v-else-if="evoText" class="select-text whitespace-pre-wrap text-xs leading-relaxed">{{ evoText }}</div>
      </div>

      <div class="flex min-h-0 flex-1">
        <!-- 左：提交列表（默认展开，可手动收起；仅影响展示） -->
        <aside v-if="listOpen" class="w-64 shrink-0 overflow-y-auto border-r border-border">
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
                'cursor-pointer border-b border-border-soft px-3 py-2 transition-colors duration-fast hover:bg-hover',
                selected === c.hash && 'bg-row-selected',
              ]"
              @click="select(c.hash)"
            >
              <div class="truncate text-xs font-medium" :title="c.subject">{{ c.subject }}</div>
              <div
                class="mt-0.5 text-xs tabular-nums"
                :class="selected === c.hash ? 'text-foreground' : 'text-muted-foreground'"
              >
                <span class="font-mono">{{ c.hash.slice(0, 8) }}</span> · {{ c.author }} · {{ relDateText(c.date) }}
              </div>
            </li>
          </ul>
        </aside>

        <!-- 右：该提交中此文件的 diff（正文优先，占满剩余空间并自己滚动） -->
        <div class="min-w-0 flex-1 select-text overflow-auto p-3 font-mono text-xs leading-5">
          <Spinner v-if="loading || diffLoading" label="加载中…" />
          <div v-else-if="err || diffErr" class="font-sans text-destructive">{{ err || diffErr }}</div>
          <pre v-else-if="diffText" class="whitespace-pre-wrap [overflow-wrap:anywhere]"><span
            v-for="(l, li) in lines"
            :key="li"
            :class="l.cls"
            class="block"
            :title="selectedMeta"
            :data-hit="hitRow === li ? '1' : undefined"
          ><template v-if="segsFor(li)"><span
              v-for="(g, k) in segsFor(li)!"
              :key="k"
              :class="g.hit && g.at === cur ? 'rounded-xs bg-primary/40' : g.hit ? 'bg-primary/15' : ''"
            >{{ g.t }}</span></template><template v-else>{{ l.text || " " }}</template></span></pre>
          <div v-else class="font-sans text-muted-foreground">
            <template v-if="!commits.length">该文件没有提交历史（可能是新文件）。</template>
            <template v-else-if="!selected">左侧选择一个提交查看变更。</template>
            <template v-else>这个提交没有改动该文件的内容。</template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
