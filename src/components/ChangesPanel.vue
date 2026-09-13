<script setup lang="ts">
import { ref, computed, reactive, watch, type Component } from "vue";
import {
  Plus,
  Undo2,
  FilePlus,
  FilePen,
  FileMinus,
  FileQuestion,
  FileSymlink,
  GitMerge,
  GitCommitHorizontal,
  RotateCcw,
  Sparkles,
  History,
  Archive,
  ArchiveRestore,
  Trash2,
} from "@lucide/vue";
import * as api from "../gitApi";
import type { Status, StatusFile, StashEntry } from "../gitApi";
import type { DiffTarget } from "./DiffViewer.vue";
import { AI_PROMPTS, aiComplete, clipForAI } from "../ai";
import { settings } from "../settings";
import {
  Button,
  Textarea,
  Tooltip,
  Spinner,
  Input,
  ContextMenu,
  toast,
  type MenuItem,
} from "@/components/ui";

const props = defineProps<{
  repo: string;
  status: Status | null;
  busy: boolean;
  commitCount: number; // 已加载提交数：>0 才可 amend，>1 才可撤销（根提交无 HEAD~1）
  recentMessages?: string[]; // 最近提交信息（提交框为空时可一键复用）
}>();

// 所有操作都抛回 App.run() 统一执行+刷新；diff 打开事件抛给 App
const emit = defineEmits<{
  action: [fn: () => Promise<unknown>];
  openDiff: [target: DiffTarget];
  discard: [target: DiffTarget]; // 右键丢弃更改（App 侧二次确认）
  fileHistory: [path: string]; // 右键查看该文件历史
  filterHistory: [path: string]; // 右键在历史区按此文件过滤
  amend: [p: { message: string; stagedCount: number; onDone: () => void }]; // 追加到上次提交（App 侧确认）
  undo: []; // 撤销上次提交（App 侧确认）
  stashDrop: [index: number, subject: string]; // 删除 stash 记录（App 侧确认）
}>();

// 切仓库时收起 stash 菜单/弹窗，避免上一仓库的列表串到新仓库
watch(
  () => props.repo,
  () => {
    stashMenuOpen.value = false;
    stashPushOpen.value = false;
  },
);

// ---- amend / 撤销上次提交：改写历史，确认框在 App 侧 ----
function askAmend() {
  emit("amend", {
    message: message.value,
    stagedCount: staged.value.length,
    onDone: () => {
      if (message.value) message.value = ""; // 新信息已被 amend 使用，清空草稿
    },
  });
}

// ---- stash（暂存架）：菜单打开时懒加载列表，收纳/恢复走 App.run() ----
const stashMenuOpen = ref(false);
const stashAnchor = ref({ x: 0, y: 0 });
const stashEntries = ref<StashEntry[] | null>(null); // null = 加载中
const stashErr = ref("");
const stashPushOpen = ref(false);
const stashMsg = ref("");
const stashUntracked = ref(false);

async function toggleStashMenu(ev: MouseEvent) {
  if (stashMenuOpen.value) {
    stashMenuOpen.value = false;
    return;
  }
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  stashAnchor.value = {
    x: Math.min(rect.left, window.innerWidth - 320),
    y: rect.bottom + 4,
  };
  stashMenuOpen.value = true;
  stashErr.value = "";
  stashEntries.value = null;
  try {
    stashEntries.value = await api.stashList(props.repo);
  } catch (e) {
    stashErr.value = String(e).replace(/^Error: /, "");
  }
}
// 恢复：pop=true 恢复并删除记录（冲突时 git 自动保留），pop=false 仅恢复
function stashRestore(index: number, pop: boolean) {
  stashMenuOpen.value = false;
  emit("action", async () => {
    await api.stashApply(props.repo, index, pop);
    toast(pop ? "已恢复并移除记录" : "已恢复（记录保留）");
  });
}
function openStashPush() {
  stashMenuOpen.value = false;
  stashMsg.value = "";
  stashUntracked.value = false;
  stashPushOpen.value = true;
}
function doStashPush() {
  stashPushOpen.value = false;
  const msg = stashMsg.value;
  const untracked = stashUntracked.value;
  emit("action", async () => {
    await api.stashPush(props.repo, msg || undefined, untracked);
    toast("已收纳到 Stash");
  });
}
// 文件右键复制路径（rename 行取新路径）
function copyPath(p: string) {
  navigator.clipboard.writeText(p.split(" -> ").pop() ?? p).catch(() => {});
  toast("已复制路径");
}

// 文件行单击选中、双击同一行才打开 diff——防扫视误触弹大窗（与 HistoryGraph 同策略）
const selKey = ref("");
function onRowClick(key: string, open: () => void) {
  if (selKey.value === key) open();
  else selKey.value = key;
}

// 未暂存文件右键菜单
const fileCtx = ref<{ x: number; y: number; f: StatusFile; cached: boolean } | null>(null);

// 提交信息草稿按仓库隔离（切选项卡互不串）。
// 注意必须是 reactive Map：computed setter 写入才能触发响应式失效，否则 AI 生成结果不会渲染
const drafts = reactive(new Map<string, string>());
const message = computed({
  get: () => drafts.get(props.repo) ?? "",
  set: (v: string) => drafts.set(props.repo, v),
});

const staged = computed(() =>
  (props.status?.files ?? []).filter((f) => f.x !== " " && f.x !== "?")
);
const unstaged = computed(() =>
  (props.status?.files ?? []).filter((f) => f.x === "?" || f.y !== " ")
);

function label(f: StatusFile): string {
  if (f.x === "?") return "?"; // 未跟踪
  return (f.y !== " " ? f.y : f.x).toUpperCase();
}

// 未合并（冲突中）的 porcelain 状态码：UU AA DD AU UA DU UD
function isUnmerged(f: StatusFile): boolean {
  return (
    f.x === "U" ||
    f.y === "U" ||
    (f.x === "A" && f.y === "A") ||
    (f.x === "D" && f.y === "D")
  );
}

// 状态 → 图标 + 颜色 + 中文说明（替代字母徽标）
const STATUS_META: Record<string, { icon: Component; cls: string; desc: string }> = {
  A: { icon: FilePlus, cls: "text-[var(--c-add)]", desc: "新增" },
  M: { icon: FilePen, cls: "text-[var(--c-mod)]", desc: "修改" },
  D: { icon: FileMinus, cls: "text-[var(--c-del)]", desc: "删除" },
  R: { icon: FileSymlink, cls: "text-[var(--c-ren)]", desc: "重命名" },
  "?": { icon: FileQuestion, cls: "text-[var(--c-conf)]", desc: "未跟踪" },
  U: { icon: GitMerge, cls: "text-[var(--c-conf)]", desc: "合并冲突" },
};
function statusMeta(f: StatusFile) {
  return (
    STATUS_META[label(f)] ?? { icon: FilePen, cls: "text-muted-foreground", desc: "变更" }
  );
}

// porcelain rename 行是 "old -> new" 整串，拆开显示
function renameParts(path: string): [string, string] | null {
  const i = path.indexOf(" -> ");
  return i === -1 ? null : [path.slice(0, i), path.slice(i + 4)];
}

const canCommit = computed(
  () => !props.busy && staged.value.length > 0 && message.value.trim().length > 0
);

// 勾选「提交后推送到远程」时，提交完自动 push（无上游自动 -u）
const pushAfterCommit = ref(false);

function doCommit() {
  emit("action", async () => {
    await api.commit(props.repo, message.value);
    message.value = "";
    if (pushAfterCommit.value) await api.push(props.repo, props.status?.branch ?? "");
    toast(pushAfterCommit.value ? "已提交并推送" : "已提交");
  });
}

// ---- 最近提交信息复用：提交框为空时从 History 按钮选一条填入 ----
const recentMsgMenu = ref<{ x: number; y: number } | null>(null);
function recentMsgItems(): MenuItem[] {
  return (props.recentMessages ?? []).map((m) => ({
    label: m,
    fn: () => applyGenerated(m),
  }));
}

// ---- B6：生成/复用的信息不静默覆盖已输入草稿——挂起待确认（覆盖 / 保留原内容）----
const pendingMsg = ref("");
function applyGenerated(text: string) {
  if (message.value.trim()) pendingMsg.value = text;
  else message.value = text;
}
function applyPending() {
  message.value = pendingMsg.value;
  pendingMsg.value = "";
}

// ---- AI 生成提交信息：暂存区 diff → 提交框，人工可改后再提交（不自动提交）----
const aiBusy = ref(false);
const aiErr = ref("");
async function genCommitMsg() {
  if (aiBusy.value) return;
  if (settings.aiEnabled !== "on") {
    aiErr.value = "AI 功能已关闭：设置 → AI 页可开启";
    return;
  }
  if (!staged.value.length) {
    aiErr.value = "先暂存文件，AI 才有 diff 可读";
    return;
  }
  aiBusy.value = true;
  aiErr.value = "";
  try {
    const d = await api.diff(
      props.repo,
      staged.value.map((f) => f.path.split(" -> ").pop()!),
      true
    );
    // 取最近提交推断本仓库的信息风格（SKILL.md：优先跟随既有惯例）
    const recentLog = (await api.log(props.repo))
      .slice(0, 10)
      .map((c) => c.subject)
      .join("\n");
    const user = `【仓库近期提交风格】\n${recentLog || "（无历史提交）"}\n\n【暂存区 diff】\n${clipForAI(d)}`;
    applyGenerated(
      await aiComplete(AI_PROMPTS.commitMessage.system(settings.aiCommitLang), user),
    );
  } catch (e) {
    aiErr.value = String(e).replace(/^Error: /, "");
  } finally {
    aiBusy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 已暂存 -->
    <div class="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <span class="text-[11px] uppercase tracking-wider text-muted-foreground">已暂存</span>
      <Badge v-if="staged.length" variant="default">{{ staged.length }}</Badge>
      <!-- 全部取消暂存 -->
      <Button
        v-if="staged.length"
        variant="ghost"
        size="sm"
        class="ml-auto h-6 px-2 text-[11px]"
        @click="
          emit('action', async () => {
            await api.unstage(repo, staged.map((f) => f.path));
            toast(`已取消暂存 ${staged.length} 个文件`);
          })
        "
      >
        全部取消暂存
      </Button>
    </div>
    <ul class="max-h-[34%] overflow-y-auto px-1.5">
      <li
        v-for="f in staged"
        :key="'s' + f.path"
        class="group/li flex cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 whitespace-nowrap hover:bg-muted"
        :class="selKey === 's' + f.path && 'bg-primary/10'"
        @click="onRowClick('s' + f.path, () => emit('openDiff', { path: f.path.split(' -> ').pop()!, cached: !isUnmerged(f), untracked: false, conflict: isUnmerged(f) }))"
        @contextmenu.prevent="fileCtx = { x: $event.clientX, y: $event.clientY, f, cached: true }"
      >
        <component :is="statusMeta(f).icon" :class="statusMeta(f).cls" class="size-4 shrink-0" />
        <Tooltip :text="`${statusMeta(f).desc} · ${f.path}（单击选中 · 双击查看变更）`">
          <span class="truncate text-[12.5px]">
            <template v-if="renameParts(f.path)">
              <span class="text-muted-foreground line-through">{{ renameParts(f.path)![0] }}</span>
              → {{ renameParts(f.path)![1] }}
            </template>
            <template v-else>{{ f.path }}</template>
          </span>
        </Tooltip>
        <Tooltip text="取消暂存">
          <Undo2
            class="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover/li:opacity-80 hover:!opacity-100"
            @click.stop="emit('action', () => api.unstage(repo, [f.path]))"
          />
        </Tooltip>
      </li>
      <li v-if="!staged.length" class="px-3 py-1.5 text-xs text-muted-foreground">无</li>
    </ul>

    <!-- 未暂存 -->
    <div class="mt-2 flex items-center gap-2 border-t border-border px-3 pt-3 pb-1.5">
      <span class="text-[11px] uppercase tracking-wider text-muted-foreground">未暂存</span>
      <Badge v-if="unstaged.length" variant="danger">{{ unstaged.length }}</Badge>
      <Button
        v-if="unstaged.length"
        variant="ghost"
        size="sm"
        class="ml-auto h-6 px-2 text-[11px]"
        @click="
          emit('action', async () => {
            await api.stage(repo, unstaged.map((f) => f.path));
            toast(`已暂存 ${unstaged.length} 个文件`);
          })
        "
      >
        全部暂存
      </Button>
      <Tooltip text="Stash：收纳/恢复改动">
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6"
          :class="!unstaged.length && 'ml-auto'"
          aria-label="Stash 菜单"
          @click="toggleStashMenu"
        >
          <Archive class="size-3.5" />
        </Button>
      </Tooltip>
    </div>
    <ul class="min-h-[80px] flex-1 overflow-y-auto px-1.5">
      <li
        v-for="f in unstaged"
        :key="'u' + f.path"
        class="group/li flex cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 whitespace-nowrap hover:bg-muted"
        :class="selKey === 'u' + f.path && 'bg-primary/10'"
        @click="onRowClick('u' + f.path, () => emit('openDiff', { path: f.path, cached: false, untracked: f.x === '?', conflict: isUnmerged(f) }))"
        @contextmenu.prevent="fileCtx = { x: $event.clientX, y: $event.clientY, f, cached: false }"
      >
        <component :is="statusMeta(f).icon" :class="statusMeta(f).cls" class="size-4 shrink-0" />
        <Tooltip :text="`${statusMeta(f).desc} · ${f.path}（单击选中 · 双击查看变更）`">
          <span class="truncate text-[12.5px]">{{ f.path }}</span>
        </Tooltip>
        <Tooltip text="暂存">
          <Plus
            class="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover/li:opacity-80 hover:!opacity-100"
            @click.stop="emit('action', () => api.stage(repo, [f.path]))"
          />
        </Tooltip>
      </li>
      <li v-if="!unstaged.length" class="px-3 py-1.5 text-xs text-muted-foreground">无</li>
    </ul>

    <!-- 文件右键菜单（ui/ContextMenu 统一渲染） -->
    <ContextMenu
      v-if="fileCtx"
      :x="fileCtx.x"
      :y="fileCtx.y"
      :items="[
        { label: '查看文件变更历史', fn: () => emit('fileHistory', fileCtx!.f.path.split(' -> ').pop()!) },
        { label: '在历史区按此文件过滤', fn: () => emit('filterHistory', fileCtx!.f.path.split(' -> ').pop()!) },
        { label: '复制路径', fn: () => copyPath(fileCtx!.f.path) },
        ...(fileCtx!.f.x === '?'
          ? [{
              label: '加入 .gitignore',
              fn: () => emit('action', () => api.ignoreAdd(repo, fileCtx!.f.path)),
            } as MenuItem]
          : []),
        ...(fileCtx!.cached
          ? []
          : [
              {
                label: fileCtx!.f.x === '?' ? '删除文件' : '丢弃更改（不可恢复）',
                danger: true,
                fn: () =>
                  emit('discard', {
                    path: fileCtx!.f.path,
                    cached: false,
                    untracked: fileCtx!.f.x === '?',
                  }),
              } as MenuItem,
            ]),
      ]"
      @close="fileCtx = null"
    />

    <!-- 提交区：固定底部卡片 -->
    <div class="shrink-0 space-y-2 border-t border-border bg-card/60 p-3">
      <div class="relative">
        <Textarea
          v-model="message"
          rows="4"
          class="pl-8 pr-9"
          placeholder="提交信息…  Ctrl+⏎ 提交"
          @keydown.ctrl.enter="canCommit && doCommit()"
        />
        <Tooltip text="复用最近提交信息">
          <Button
            variant="ghost"
            size="icon"
            class="absolute top-1.5 left-1.5 h-6 w-6"
            :disabled="busy || !recentMessages?.length"
            aria-label="复用最近提交信息"
            @click="recentMsgMenu = { x: $event.clientX, y: $event.clientY }"
          >
            <History class="size-3.5" />
          </Button>
        </Tooltip>
        <Tooltip text="AI 生成提交信息">
          <Button
            variant="ghost"
            size="icon"
            class="absolute top-1.5 right-1.5 h-6 w-6"
            :disabled="aiBusy || !staged.length || busy"
            @click="genCommitMsg"
          >
            <Spinner v-if="aiBusy" :size="13" />
            <Sparkles v-else class="size-3.5 text-primary" />
          </Button>
        </Tooltip>
      </div>
      <div v-if="aiErr" class="text-[11px] leading-relaxed text-destructive">{{ aiErr }}</div>
      <!-- 已有草稿时不静默覆盖：覆盖 / 保留，二选一 -->
      <div
        v-if="pendingMsg"
        class="flex items-center gap-2 rounded border border-[var(--c-conf)]/40 bg-[var(--c-conf)]/10 px-2 py-1 text-[11px]"
      >
        <span class="flex-1">已生成新的提交信息，覆盖已输入的内容？</span>
        <Button variant="secondary" size="sm" class="h-5 px-1.5 text-[11px]" @click="applyPending">覆盖</Button>
        <Button variant="ghost" size="sm" class="h-5 px-1.5 text-[11px]" @click="pendingMsg = ''">保留原内容</Button>
      </div>
      <!-- 勾选框与 amend/撤销 icons 同行，省纵向空间；两者改写历史，确认框在 App 侧 -->
      <div class="flex items-center gap-1.5">
        <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input v-model="pushAfterCommit" type="checkbox" class="accent-[var(--primary)]" />
          提交后推送到远程
        </label>
        <Tooltip text="追加到上次提交（amend）">
          <Button
            variant="ghost"
            size="icon"
            class="ml-auto size-8 shrink-0"
            :disabled="busy || commitCount < 1 || (!staged.length && !message.trim())"
            aria-label="追加到上次提交"
            @click="askAmend"
          >
            <GitCommitHorizontal class="size-4" />
          </Button>
        </Tooltip>
        <Tooltip text="撤销上次提交">
          <Button
            variant="ghost"
            size="icon"
            class="size-8 shrink-0"
            :disabled="busy || commitCount <= 1"
            aria-label="撤销上次提交"
            @click="emit('undo')"
          >
            <RotateCcw class="size-4" />
          </Button>
        </Tooltip>
      </div>
      <Button variant="default" class="w-full" :disabled="!canCommit" @click="doCommit">
        <Spinner v-if="busy" :size="14" />
        {{ busy ? "处理中…" : `提交${staged.length ? ` (${staged.length})` : ""}` }}
      </Button>
    </div>

    <!-- 最近提交信息选择菜单 -->
    <ContextMenu
      v-if="recentMsgMenu"
      :x="recentMsgMenu.x"
      :y="recentMsgMenu.y"
      :items="recentMsgItems()"
      @close="recentMsgMenu = null"
    />

    <!-- stash 下拉菜单：收纳入口 + 记录列表（恢复/恢复并删除/删除） -->
    <div
      v-if="stashMenuOpen"
      class="fixed inset-0 z-30"
      @click="stashMenuOpen = false"
      @contextmenu.prevent="stashMenuOpen = false"
    >
      <div
        class="fixed max-h-[60vh] w-[300px] overflow-y-auto rounded-md border border-border bg-card py-1 shadow-xl"
        :style="{ left: stashAnchor.x + 'px', top: stashAnchor.y + 'px' }"
      >
        <div class="px-3 py-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">
          Stash · 暂存架
        </div>
        <button
          v-if="unstaged.length || staged.length"
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs hover:bg-muted"
          @click.stop="openStashPush"
        >
          <Archive class="mr-1.5 inline size-3" />
          收纳当前改动…
        </button>
        <div v-if="stashErr" class="px-3 py-2 text-[11px] text-destructive">{{ stashErr }}</div>
        <div v-else-if="stashEntries === null" class="px-3 py-2">
          <Spinner label="加载中…" />
        </div>
        <template v-else>
          <div
            v-for="e in stashEntries"
            :key="e.index"
            class="group/st flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
            :title="`${e.subject} · ${e.date}\n右侧图标：恢复（保留记录）/ 恢复并删除（pop）/ 删除记录`"
          >
            <Archive class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ e.subject }}</span>
            <span class="hidden shrink-0 items-center gap-1 group-hover/st:flex">
              <Tooltip text="恢复（保留记录，可再次恢复）">
                <RotateCcw
                  class="size-3.5 hover:text-primary"
                  @click.stop="stashRestore(e.index, false)"
                />
              </Tooltip>
              <Tooltip text="恢复并删除记录（pop）">
                <ArchiveRestore
                  class="size-3.5 hover:text-primary"
                  @click.stop="stashRestore(e.index, true)"
                />
              </Tooltip>
              <Tooltip text="仅删除记录（不恢复）">
                <Trash2
                  class="size-3.5 hover:text-destructive"
                  @click.stop="emit('stashDrop', e.index, e.subject)"
                />
              </Tooltip>
            </span>
          </div>
          <div v-if="!stashEntries.length" class="px-3 py-2 text-xs text-muted-foreground">
            暂无 stash 记录
          </div>
        </template>
      </div>
    </div>

    <!-- stash 收纳弹窗 -->
    <div
      v-if="stashPushOpen"
      class="fixed inset-0 z-40 grid place-items-center bg-black/50"
      @click.self="stashPushOpen = false"
    >
      <div class="w-[380px] rounded-lg border border-border bg-card p-4 shadow-xl">
        <div class="mb-2 font-medium">收纳改动到 Stash</div>
        <Input v-model="stashMsg" placeholder="备注（可选）" />
        <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input v-model="stashUntracked" type="checkbox" class="accent-[var(--primary)]" />
          包含未跟踪文件
        </label>
        <p class="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          把已暂存与未暂存的改动一起收进暂存架，工作区恢复干净；稍后可从 stash 菜单恢复。
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="stashPushOpen = false">取消</Button>
          <Button variant="default" size="sm" :disabled="busy" @click="doStashPush">收纳</Button>
        </div>
      </div>
    </div>
  </div>
</template>
