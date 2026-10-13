<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { X, Bot, Maximize2, Minimize2, Search, ChevronUp, ChevronDown } from "@lucide/vue";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../gitApi";
import { AI_PROMPTS, aiComplete, clipForAI, aiCacheRead, aiCacheWrite, isAbortError } from "../ai";
import { settings } from "../settings";
import { patchSections, type PatchLine } from "../lib/patch";
import { searchSections, type Segment } from "../lib/diffSearch";
import { humanizeMsg } from "../lib/errors";
import { FileDown } from "@lucide/vue";

const savedTip = ref(false);
async function saveExplainToFile() {
  if (!explainText.value) return;
  const base = props.commit ? `AI-explain-${props.commit.hash.slice(0, 8)}` : `AI-explain-${props.file!.path.split(/[\/]/).pop()}`;
  // saveDialog 放进 try：插件调用失败会 reject，放外面就是一次静默的未处理 rejection
  try {
    const target = await saveDialog({
      title: "保存 AI 解释",
      defaultPath: `${base}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!target) return;
    await api.writeTextFile(target, explainText.value);
    savedTip.value = true;
    setTimeout(() => (savedTip.value = false), 2000);
  } catch (e) {
    err.value = humanizeMsg(e);
  }
}
import { Badge, Button, Input, Spinner, Md, Tooltip } from "@/components/ui";

export interface DiffTarget {
  path: string;
  cached: boolean;
  untracked: boolean;
  conflict?: boolean; // 合并冲突（unmerged）：只看工作区合并 diff（--cached 对未合并路径无输出）
}

export interface CommitTarget {
  hash: string;
  subject: string;
  author: string;
  date: string;
  parents?: string[]; // HistoryGraph 传整个 LogEntry 时携带；根提交为空
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
// 全屏查看：diff 经常又长又宽，80vw/80vh 在看单个文件时偏窄。
// 与「折行」一样是纯展示状态，关掉弹层即恢复默认尺寸，不持久化
const fullscreen = ref(false);

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
    err.value = humanizeMsg(e);
  } finally {
    loading.value = false;
  }
});

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
    // 冲突文件用专用提示词解读双方意图；普通变更用通用解释
    explainText.value = await aiComplete(
      props.file?.conflict
        ? AI_PROMPTS.conflictExplain.system
        : AI_PROMPTS.explainDiff.system,
      clipForAI(text.value),
    );
    aiCacheWrite("explain", explainId(), explainText.value);
  } catch (e) {
    // 弹层关闭会调 abortAi()：主动取消不算失败，静默收尾（busy 由 finally 复位）
    if (isAbortError(e)) return;
    explainErr.value = humanizeMsg(e);
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

// Esc 关闭统一走 App 的 closeTopOverlay 分层链，本组件不再自挂 window 监听

// ---- 阅读细节：导出 patch ----
// 折行固定开着。原来这里有个折行开关（持久化在 gz.diffWrap），用户反馈用不上，已移除。
const savedPatchTip = ref(false);
async function exportPatch() {
  if (!text.value.trim()) return;
  const base = props.commit
    ? `patch-${props.commit.hash.slice(0, 8)}`
    : `patch-${props.file!.path.split(/[\\/]/).pop()}`;
  // 同上
  try {
    const target = await saveDialog({
      title: "导出 patch",
      defaultPath: `${base}.patch`,
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    });
    if (!target) return;
    await api.writeTextFile(target, text.value);
    savedPatchTip.value = true;
    setTimeout(() => (savedPatchTip.value = false), 2000);
  } catch (e) {
    err.value = humanizeMsg(e);
  }
}

// 按文件切段 + 行着色收敛到 lib/patch.ts（unified 与合并冲突的 combined 格式都支持）
const sections = computed(() => patchSections(text.value));

// 双栏：左文件列表选中项（默认第一个文件）
const selectedFile = ref("");
watch(sections, (list) => {
  if (!list.find((s) => s.file === selectedFile.value)) {
    selectedFile.value = list[0]?.file ?? "";
  }
}, { immediate: true });

// ---- diff 内搜索 ----
// 命中跨文件连续编号，跳转时自动切到命中所在的文件 —— 多文件 diff 里只搜当前文件
// 会让人以为没找到；左侧列表会显示每个文件各命中几处。
const rootEl = ref<HTMLElement | null>(null);
const searchOpen = ref(false);
const q = ref("");
const cur = ref(-1); // 当前停在第几个命中；-1 表示没有
const found = computed(() => searchSections(sections.value, q.value));
const count = computed(() => found.value.count);
// 正在渲染的是第几段（左列表选中的文件）
const curSectionIdx = computed(() => sections.value.findIndex((s) => s.file === selectedFile.value));
const curLines = computed(() => sections.value[curSectionIdx.value]?.lines ?? []);
// 当前命中落在「正在渲染的那一段」的哪一行；不在这一段就是 -1（不画高亮）
const hitRow = computed(() => {
  const h = cur.value >= 0 ? found.value.hits[cur.value] : undefined;
  return h && h.section === curSectionIdx.value ? h.row : -1;
});
// 查询为空时给 null，让模板走回纯文本渲染：否则每一行都要白白建一个片段数组
const segments = computed<Segment[][] | null>(() =>
  q.value.trim() ? (found.value.sections[curSectionIdx.value]?.rows ?? null) : null,
);
const segsFor = (li: number): Segment[] | null => segments.value?.[li] ?? null;
const hitsOf = (si: number): number => found.value.sections[si]?.hits.length ?? 0;

function go(d: number) {
  if (!count.value) return;
  cur.value = (cur.value + d + count.value) % count.value;
}
function focusSearch() {
  void nextTick(() => rootEl.value?.querySelector<HTMLInputElement>("[data-search-input]")?.focus());
}
function toggleSearch() {
  if (searchOpen.value) {
    focusSearch();
    return;
  }
  searchOpen.value = true;
  cur.value = count.value ? 0 : -1;
  focusSearch();
}
// 关搜索要把焦点交还给搜索开关：输入框随 v-if 一起被卸掉，浏览器会把焦点丢回 body，
// 而 v-trap 的 Tab 循环是绑在弹层容器上的（focusTrap.ts 的 el.addEventListener）——
// 焦点一旦离开容器它就收不到事件，下一次 Tab 会直接穿透到弹层背后。
function focusSearchToggle() {
  void nextTick(() => rootEl.value?.querySelector<HTMLElement>("[data-search-toggle]")?.focus());
}
function closeSearch() {
  searchOpen.value = false;
  q.value = "";
  cur.value = -1;
  focusSearchToggle();
}
// 左列表手动切文件时把游标挪到该文件的第一个命中，否则计数还停在别的文件上、当前文件里却一个高亮都没有
function pickFile(file: string) {
  selectedFile.value = file;
  if (!count.value) return;
  const i = found.value.hits.findIndex((h) => sections.value[h.section]?.file === file);
  if (i >= 0 && i !== cur.value) cur.value = i;
}
watch(q, () => (cur.value = count.value ? 0 : -1));
// 查询变了、或游标动了，都要把当前命中滚进视野（跟浏览器查找一样，边打字边定位）
watch([found, cur], async () => {
  const h = cur.value >= 0 ? found.value.hits[cur.value] : undefined;
  if (!h) return;
  const f = sections.value[h.section]?.file;
  if (f && f !== selectedFile.value) selectedFile.value = f; // 命中在别的文件：先切过去
  await nextTick();
  rootEl.value?.querySelector('[data-hit="1"]')?.scrollIntoView({ block: "center" });
});
// Ctrl+F 打开搜索。焦点在别的浮层里就不抢（两个 diff 弹层理论上不会同时开，
// 真同时开着时让焦点所在的那个响应）
function onFindKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
  const act = document.activeElement as HTMLElement | null;
  // 焦点在 body 也算「没在别的浮层里」：点过右侧 diff 文本（select-text）之后焦点会落回 body，
  // 若把它当成「别处在用」，Ctrl+F 就会静默失效 —— 而这个组件挂载期间，它自己就是打开着的浮层
  if (act && act !== document.body && rootEl.value && !rootEl.value.contains(act)) return;
  e.preventDefault();
  toggleSearch();
}

// 行 hover 提示改动人信息（工作区文件无改动人 → 显示路径与模式）
// ---- 逐行归属（blame）：+ 行归属本次变更；context/- 行查该行真正的最后修改提交 ----
// commit 模式 blame 父版本（`<hash>^`，按旧文件行号查）；文件模式 blame 工作区（按新文件行号查）。
// 按选中的文件段懒加载，失败静默降级为通用提示
interface BlameEntry {
  author: string;
  hash: string;
  time: number;
}
const blameStore = ref<Map<string, Map<number, BlameEntry>>>(new Map());

function relTime(epoch: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

watch(
  () => [sections.value, selectedFile.value] as const,
  async ([secs, sel]) => {
    const sec = secs.find((s) => s.file === sel);
    if (!sec || blameStore.value.has(sel)) return;
    if (!sec.lines.some((l) => l.oldLine !== undefined)) return; // 纯新增，无历史可归属
    let rev: string | null = null;
    if (props.commit) {
      if (!props.commit.parents?.length) return; // 根提交全部为新增
      rev = `${props.commit.hash}^`;
    } else if (props.file?.untracked) return;
    try {
      const rows = await api.blame(props.repo, rev, sec.file);
      const m = new Map<number, BlameEntry>();
      for (const r of rows) m.set(r.line, { author: r.author, hash: r.hash, time: r.time });
      blameStore.value = new Map(blameStore.value).set(sel, m);
    } catch {
      blameStore.value = new Map(blameStore.value).set(sel, new Map()); // 失败不再重试
    }
  },
  { immediate: true },
);

function tipFor(l: PatchLine): string {
  const generic = props.commit
    ? `修改：${props.commit.author} · ${props.commit.date}`
    : props.file
      ? `文件：${props.file.path}${props.file.cached ? "（已暂存）" : "（工作区）"}`
      : "";
  const blameOf = (line?: number) =>
    line !== undefined ? blameStore.value.get(selectedFile.value)?.get(line) : undefined;
  const attribution = (b: BlameEntry) =>
    `最后修改：${b.author} · ${relTime(b.time)}（${b.hash.slice(0, 8)}）`;
  if (props.commit) {
    if (l.text.startsWith("+")) return generic; // 本次提交新增 → 归属当前提交作者
    const b = blameOf(l.oldLine);
    return b ? attribution(b) : generic;
  }
  if (l.text.startsWith("+")) return "工作区修改（未提交）";
  const b = blameOf(l.newLine);
  return b ? attribution(b) : generic;
}

// ---- 左侧文件列表拖宽 + 持久化（与主界面侧栏同款把手）----
const listW = ref(Number(localStorage.getItem("gz.diffListW")) || 256);
// 窄窗口下 560px 会把右侧 diff 挤没：上限随窗口收敛（同时用于拖拽钳制与渲染宽度）
const winW = ref(window.innerWidth);
const maxListW = computed(() => Math.min(560, Math.round(winW.value * 0.45)));
const listWShown = computed(() => Math.min(maxListW.value, Math.max(160, listW.value)));
const onWinResize = () => (winW.value = window.innerWidth);
let resizeStartX = 0;
let resizeStartW = 0;
function startListResize(e: MouseEvent) {
  resizeStartX = e.clientX;
  resizeStartW = listW.value;
  document.body.style.cursor = "col-resize";
  window.addEventListener("mousemove", onListResize);
  window.addEventListener("mouseup", endListResize);
}
function onListResize(e: MouseEvent) {
  listW.value = Math.min(maxListW.value, Math.max(160, resizeStartW + e.clientX - resizeStartX));
}
function endListResize() {
  window.removeEventListener("mousemove", onListResize);
  window.removeEventListener("mouseup", endListResize);
  document.body.style.cursor = "";
  localStorage.setItem("gz.diffListW", String(listW.value));
}
onMounted(() => {
  window.addEventListener("resize", onWinResize);
  window.addEventListener("keydown", onFindKey);
});
onUnmounted(() => {
  window.removeEventListener("mousemove", onListResize);
  window.removeEventListener("mouseup", endListResize);
  window.removeEventListener("resize", onWinResize);
  window.removeEventListener("keydown", onFindKey);
});
</script>

<template>
  <!-- 固定高度，避免加载前后高度跳动 -->
  <div
    v-trap
    ref="rootEl"
    class="fixed inset-0 z-20 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-diff-title"
    @click.self="emit('close')"
  >
    <!-- 尺寸走 :class 而不是叠一个 class：rounded-lg 与 h/w 必须整组切换，
         否则两个 rounded 会同时留在 class 上、由产物 CSS 顺序决定谁赢 -->
    <div
      class="pop-in surface flex flex-col"
      :class="fullscreen ? 'h-full w-full' : 'h-[80vh] w-[80vw] rounded-lg'"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span id="dlg-diff-title" class="truncate font-medium">
          {{ commit ? commit.subject : file?.path }}
        </span>
        <span class="shrink-0 text-xs text-muted-foreground">
          {{ commit ? `${commit.author} · ${commit.date}` : file?.cached ? "已暂存的变更" : "工作区变更" }}
        </span>
        <Badge v-if="file?.conflict" variant="warning">合并冲突</Badge>
        <span class="flex-1" />
        <Tooltip text="搜索（Ctrl+F）">
          <Button
            variant="ghost"
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
        <Tooltip :text="savedPatchTip ? '已导出 ✓' : '导出 .patch'">
          <Button variant="ghost" size="icon" class="h-6 w-6" aria-label="导出 patch" @click="exportPatch">
            <FileDown class="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip v-if="settings.aiEnabled === 'on'" text="AI 解释这段变更">
          <Button variant="ghost" size="sm" aria-label="AI 解释变更" :disabled="explainBusy" @click="explain">
            <Spinner v-if="explainBusy" :size="14" />
            <Bot v-else class="size-3.5 text-primary" />
          </Button>
        </Tooltip>
        <Button variant="ghost" size="icon" aria-label="关闭" @click="emit('close')"><X class="size-4" /></Button>
      </header>

      <!-- 搜索栏：常驻会白占 36px 高，所以由 header 的按钮或 Ctrl+F 开关 -->
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
        <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">{{
          q.trim() ? (count ? `${cur + 1}/${count}` : "无匹配") : ""
        }}</span>
        <Tooltip text="上一个（Shift+Enter）">
          <Button variant="quiet" size="icon" class="h-6 w-6" :disabled="!count" aria-label="上一个匹配" @click="go(-1)">
            <ChevronUp class="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip text="下一个（Enter）">
          <Button variant="quiet" size="icon" class="h-6 w-6" :disabled="!count" aria-label="下一个匹配" @click="go(1)">
            <ChevronDown class="size-3.5" />
          </Button>
        </Tooltip>
        <Button variant="quiet" size="icon" class="h-6 w-6" aria-label="关闭搜索" @click="closeSearch">
          <X class="size-3.5" />
        </Button>
      </div>

        <!-- 双栏：左文件列表 / 右选中文件的 diff（参考 FileHistoryModal 布局） -->
        <div class="flex min-h-0 flex-1">
        <aside
          class="shrink-0 overflow-y-auto border-r border-border"
          :style="{ width: listWShown + 'px' }"
        >
          <ul>
            <li
              v-for="(s, si) in sections"
              :key="s.file"
              :class="[
                'cursor-pointer border-b border-border/60 px-3 py-2 transition-colors duration-fast hover:bg-hover',
                selectedFile === s.file && 'bg-primary-soft',
              ]"
              :title="s.file"
              @click="pickFile(s.file)"
            >
              <div class="truncate text-xs font-medium">{{ s.file }}</div>
              <div class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{{ s.lines.length }} 行</span>
                <span
                  v-if="q.trim() && hitsOf(si)"
                  class="shrink-0 rounded-xs bg-primary/15 px-1 text-2xs text-primary"
                  >{{ hitsOf(si) }} 处</span
                >
              </div>
            </li>
          </ul>
        </aside>
        <!-- 文件列表拖宽把手 -->
        <div class="w-1 shrink-0 cursor-col-resize transition-colors duration-fast hover:bg-primary/40" @mousedown="startListResize" />
        <div class="min-w-0 flex-1 select-text overflow-auto p-3 font-mono text-xs leading-5">
          <Spinner v-if="loading" label="加载中…" />
          <div v-else-if="err" class="text-destructive">{{ err }}</div>
          <div v-else-if="!sections.length" class="text-muted-foreground">没有文件变更。</div>
          <template v-else>
            <div
              class="mb-2 truncate rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground"
              :title="selectedFile"
            >
              {{ selectedFile }}
            </div>
            <pre
              class="whitespace-pre-wrap font-mono text-xs leading-5 [overflow-wrap:anywhere]"
            ><span
              v-for="(l, li) in curLines"
              :key="li"
              :class="l.cls"
              class="flex"
              :title="tipFor(l)"
            ><span class="w-10 shrink-0 select-none pr-1.5 text-right opacity-45">{{ l.oldLine ?? "" }}</span><span class="w-10 shrink-0 select-none pr-2 text-right opacity-45">{{ l.newLine ?? "" }}</span><span class="min-w-0 flex-1" :data-hit="hitRow === li ? '1' : undefined"><template v-if="segsFor(li)"><span
              v-for="(g, k) in segsFor(li)!"
              :key="k"
              :class="g.hit && g.at === cur ? 'rounded-xs bg-primary/40' : g.hit ? 'bg-primary/15' : ''"
            >{{ g.t }}</span></template><template v-else>{{ l.text || " " }}</template></span></span></pre>
          </template>
        </div>
      </div>

      <!-- AI 解释面板 -->
      <div
        v-if="explainBusy || explainErr || explainText"
        class="max-h-[35%] shrink-0 overflow-y-auto border-t border-border px-3 py-2"
      >
        <div class="mb-1 flex items-center gap-2">
          <span class="text-xs tracking-wide text-muted-foreground">AI 解释</span>
          <Button variant="ghost" size="sm" class="h-5 px-1.5 text-xs" :disabled="!explainText" @click="saveExplainToFile">
            <FileDown class="size-3" />{{ savedTip ? "已保存 ✓" : "保存到本地" }}
          </Button>
          <span class="flex-1" />
        </div>
        <Spinner v-if="explainBusy" label="AI 分析中…" />
        <div v-else-if="explainErr" class="text-xs text-destructive">{{ explainErr }}</div>
        <Md v-else :source="explainText" class="text-xs" />
      </div>
    </div>
  </div>
</template>
