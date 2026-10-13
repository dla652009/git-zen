<script setup lang="ts">
// 文件变更历史双栏弹窗：左侧该文件的提交列表，右侧选中提交中此文件的 diff
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { X, Search, ChevronUp, ChevronDown, Maximize2, Minimize2 } from "@lucide/vue";
import * as api from "../gitApi";
import type { LogEntry } from "../gitApi";
import { patchLines } from "../lib/patch";
import { searchSections, type Segment } from "../lib/diffSearch";
import { humanizeMsg } from "../lib/errors";
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
watch(cur, async () => {
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
