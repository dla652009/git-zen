<script setup lang="ts">
// 文件变更历史双栏弹窗：左侧该文件的提交列表，右侧选中提交中此文件的 diff
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { X, Bot, Search, ChevronUp, ChevronDown, Maximize2, Minimize2 } from "@lucide/vue";
import * as api from "../gitApi";
import type { LogEntry } from "../gitApi";
import { patchLines } from "../lib/patch";
import { searchSections, type Segment } from "../lib/diffSearch";
import { humanizeMsg } from "../lib/errors";
import {
  AI_PROMPTS,
  aiComplete,
  aiCacheRead,
  aiCacheWrite,
  clipForAI,
  isAbortError,
} from "../ai";
import { settings } from "../settings";
import { Button, Input, Spinner, Tooltip } from "@/components/ui";

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

// diff 内搜索
const rootEl = ref<HTMLElement | null>(null);
const searchOpen = ref(false);
const q = ref("");
const cur = ref(0);

// 模板与搜索共用同一份解析结果，避免一次渲染里解析两遍 patch
const lines = computed(() => patchLines(diffText.value));
const found = computed(() => searchSections([{ file: props.path, lines: lines.value }], q.value));
const count = computed(() => found.value.count);
const segs = computed<Segment[][] | null>(() => (q.value.trim() ? found.value.sections[0]?.rows ?? null : null));
const segsFor = (li: number): Segment[] | null => segs.value?.[li] ?? null;
const hitRow = computed(() => found.value.hits[cur.value]?.row ?? -1);

watch(q, () => (cur.value = count.value ? 0 : -1));
// 必须同时盯 found，不能只盯 cur：cur 初值就是 0，敲第一个字符时 watch(q) 把它设回 0，
// 值没变 → Vue 用 Object.is 比较后不触发 → 高亮已经跳到第 1 个命中，视图却还停在顶部，
// 回车会「先到第 2 个」。found 是 computed，查询一变引用就变，靠它兜住这一步。
watch([found, cur], async () => {
  await nextTick();
  rootEl.value?.querySelector('[data-hit="1"]')?.scrollIntoView({ block: "center" });
});

function go(d: number) {
  if (!count.value) return;
  cur.value = (cur.value + d + count.value) % count.value;
}

// 关闭搜索后焦点要还给它：输入框随 v-if 消失时浏览器会把焦点丢回 body，
// 而 v-trap 的 Tab 循环监听在弹层容器上，焦点一旦离开容器，下一次 Tab 就直接穿透到弹层背后。
const searchBtn = ref<{ $el: HTMLButtonElement } | null>(null);

function toggleSearch() {
  searchOpen.value = true;
  nextTick(() => rootEl.value?.querySelector<HTMLInputElement>("[data-search-input]")?.focus());
}

function closeSearch() {
  searchOpen.value = false;
  q.value = "";
  cur.value = 0;
  nextTick(() => searchBtn.value?.$el.focus());
}

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
    class="fixed inset-0 z-30 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-file-history-title"
    @click.self="emit('close')"
  >
    <div
      class="pop-in surface flex flex-col overflow-hidden"
      :class="fullscreen ? 'h-full w-full' : 'h-[80vh] w-[85vw] rounded-lg'"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span id="dlg-file-history-title" class="truncate font-medium">{{ path }}</span>
        <span class="shrink-0 text-xs text-muted-foreground">文件变更历史 · {{ commits.length }} 个提交</span>
        <span class="flex-1" />
        <Tooltip text="AI 解读这个文件的演进">
          <Button
            variant="ghost"
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
            ref="searchBtn"
            variant="ghost"
            size="icon"
            class="h-6 w-6"
            aria-label="在 diff 里搜索"
            :aria-pressed="searchOpen"
            @click="toggleSearch"
          >
            <Search class="size-3.5" />
          </Button>
        </Tooltip>
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
        <Button variant="ghost" size="icon" aria-label="关闭" @click="emit('close')"><X class="size-4" /></Button>
      </header>

      <!-- diff 内搜索：回车下一个、Shift+回车上一个、Esc 只关搜索栏（stop 掉，别连带关掉弹窗） -->
      <div v-if="searchOpen" class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          v-model="q"
          data-search-input
          class="h-7 flex-1 text-xs"
          placeholder="在 diff 里查找…"
          @keydown.enter.exact.prevent="go(1)"
          @keydown.shift.enter.prevent="go(-1)"
          @keydown.esc.stop.prevent="closeSearch"
        />
        <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {{ q.trim() ? (count ? `${cur + 1}/${count}` : "无匹配") : "" }}
        </span>
        <Button variant="quiet" size="icon" class="h-6 w-6" :disabled="!count" aria-label="上一个匹配" @click="go(-1)">
          <ChevronUp class="size-3.5" />
        </Button>
        <Button variant="quiet" size="icon" class="h-6 w-6" :disabled="!count" aria-label="下一个匹配" @click="go(1)">
          <ChevronDown class="size-3.5" />
        </Button>
        <Button variant="quiet" size="icon" class="h-6 w-6" aria-label="关闭搜索" @click="closeSearch">
          <X class="size-3.5" />
        </Button>
      </div>

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
                'cursor-pointer border-b border-border/60 px-3 py-2 transition-colors duration-fast hover:bg-hover',
                selected === c.hash && 'bg-primary-soft',
              ]"
              @click="select(c.hash)"
            >
              <div class="truncate text-xs font-medium">{{ c.subject }}</div>
              <div class="mt-0.5 text-xs text-muted-foreground">
                <span class="font-mono">{{ c.hash.slice(0, 8) }}</span> · {{ c.author }} · {{ c.date }}
              </div>
            </li>
          </ul>
        </aside>

        <!-- 右：该提交中此文件的 diff -->
        <div class="min-w-0 flex-1 select-text overflow-auto p-3 font-mono text-xs leading-5">
          <Spinner v-if="diffLoading" label="加载中…" />
          <div v-else-if="diffErr" class="text-destructive">{{ diffErr }}</div>
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
          <div v-else class="text-muted-foreground">左侧选择一个提交查看变更。</div>
        </div>
      </div>
    </div>
  </div>
</template>
