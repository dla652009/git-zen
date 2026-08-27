<script setup lang="ts">
import { ref, computed, reactive, type Component } from "vue";
import {
  Plus,
  Undo2,
  FilePlus,
  FilePen,
  FileMinus,
  FileQuestion,
  FileSymlink,
  Sparkles,
  History,
} from "@lucide/vue";
import * as api from "../gitApi";
import type { Status, StatusFile } from "../gitApi";
import type { DiffTarget } from "./DiffViewer.vue";
import { AI_PROMPTS, aiComplete, clipForAI } from "../ai";
import { settings } from "../settings";
import { Button, Textarea, Tooltip, Spinner } from "@/components/ui";

const props = defineProps<{
  repo: string;
  status: Status | null;
  busy: boolean;
}>();

// 所有操作都抛回 App.run() 统一执行+刷新；diff 打开事件抛给 App
const emit = defineEmits<{
  action: [fn: () => Promise<unknown>];
  openDiff: [target: DiffTarget];
  discard: [target: DiffTarget]; // 右键丢弃更改（App 侧二次确认）
  fileHistory: [path: string]; // 右键查看该文件历史
}>();

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

// 状态 → 图标 + 颜色 + 中文说明（替代字母徽标）
const STATUS_META: Record<string, { icon: Component; cls: string; desc: string }> = {
  A: { icon: FilePlus, cls: "text-emerald-400", desc: "新增" },
  M: { icon: FilePen, cls: "text-sky-400", desc: "修改" },
  D: { icon: FileMinus, cls: "text-rose-400", desc: "删除" },
  R: { icon: FileSymlink, cls: "text-violet-400", desc: "重命名" },
  "?": { icon: FileQuestion, cls: "text-amber-400", desc: "未跟踪" },
  U: { icon: FileQuestion, cls: "text-amber-400", desc: "冲突/未合并" },
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
  });
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
    message.value = await aiComplete(
      AI_PROMPTS.commitMessage.system(settings.aiCommitLang),
      user,
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
      <Button
        v-if="staged.length"
        variant="ghost"
        size="sm"
        class="ml-auto h-6 px-2 text-[11px]"
        @click="emit('action', () => api.unstage(repo, staged.map((f) => f.path)))"
      >
        全部取消暂存
      </Button>
    </div>
    <ul class="max-h-[34%] overflow-y-auto px-1.5">
      <li
        v-for="f in staged"
        :key="'s' + f.path"
        class="group/li flex cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 whitespace-nowrap hover:bg-muted"
        @dblclick="emit('openDiff', { path: f.path.split(' -> ').pop()!, cached: true, untracked: false })"
        @contextmenu.prevent="fileCtx = { x: $event.clientX, y: $event.clientY, f, cached: true }"
      >
        <component :is="statusMeta(f).icon" :class="statusMeta(f).cls" class="size-4 shrink-0" />
        <Tooltip :text="`${statusMeta(f).desc} · ${f.path}（双击查看变更）`">
          <span class="truncate text-[12.5px]">
            <template v-if="renameParts(f.path)">
              <span class="text-muted-foreground line-through">{{ renameParts(f.path)![0] }}</span>
              → {{ renameParts(f.path)![1] }}
            </template>
            <template v-else>{{ f.path }}</template>
          </span>
        </Tooltip>
        <Undo2
          class="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover/li:opacity-80 hover:!opacity-100"
          title="取消暂存"
          @click.stop="emit('action', () => api.unstage(repo, [f.path]))"
        />
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
        @click="emit('action', () => api.stage(repo, unstaged.map((f) => f.path)))"
      >
        全部暂存
      </Button>
    </div>
    <ul class="min-h-[80px] flex-1 overflow-y-auto px-1.5">
      <li
        v-for="f in unstaged"
        :key="'u' + f.path"
        class="group/li flex cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 whitespace-nowrap hover:bg-muted"
        @dblclick="emit('openDiff', { path: f.path, cached: false, untracked: f.x === '?' })"
        @contextmenu.prevent="fileCtx = { x: $event.clientX, y: $event.clientY, f, cached: false }"
      >
        <component :is="statusMeta(f).icon" :class="statusMeta(f).cls" class="size-4 shrink-0" />
        <Tooltip :text="`${statusMeta(f).desc} · ${f.path}（双击查看变更）`">
          <span class="truncate text-[12.5px]">{{ f.path }}</span>
        </Tooltip>
        <Plus
          class="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover/li:opacity-80 hover:!opacity-100"
          title="暂存"
          @click.stop="emit('action', () => api.stage(repo, [f.path]))"
        />
      </li>
      <li v-if="!unstaged.length" class="px-3 py-1.5 text-xs text-muted-foreground">无</li>
    </ul>

    <!-- 未暂存文件右键菜单：丢弃更改 -->
    <div v-if="fileCtx" class="fixed inset-0 z-30" @click="fileCtx = null" @contextmenu.prevent="fileCtx = null">
      <div
        class="fixed min-w-[150px] rounded-md border border-border bg-card py-1 shadow-xl"
        :style="{ left: fileCtx.x + 'px', top: fileCtx.y + 'px' }"
      >
        <button
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs hover:bg-muted"
          @click.stop="
            () => {
              const p = fileCtx!.f.path.split(' -> ').pop()!;
              fileCtx = null;
              emit('fileHistory', p);
            }
          "
        >
          查看文件变更历史
        </button>
        <button
          v-if="!fileCtx!.cached"
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-destructive hover:bg-muted"
          @click.stop="
            () => {
              const f = fileCtx!.f;
              fileCtx = null;
              emit('discard', { path: f.path, cached: false, untracked: f.x === '?' });
            }
          "
        >
          {{ fileCtx.f.x === '?' ? '删除文件' : '丢弃更改（不可恢复）' }}
        </button>
      </div>
    </div>

    <!-- 提交区：固定底部卡片 -->
    <div class="shrink-0 space-y-2 border-t border-border bg-card/60 p-3">
      <div class="relative">
        <Textarea
          v-model="message"
          rows="4"
          class="pr-9"
          placeholder="提交信息…  Ctrl+⏎ 提交"
          @keydown.ctrl.enter="canCommit && doCommit()"
        />
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
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input v-model="pushAfterCommit" type="checkbox" class="accent-[var(--primary)]" />
        提交后推送到远程
      </label>
      <Button variant="default" class="w-full" :disabled="!canCommit" @click="doCommit">
        <Spinner v-if="busy" :size="14" />
        {{ busy ? "处理中…" : `提交${staged.length ? ` (${staged.length})` : ""}` }}
      </Button>
    </div>
  </div>
</template>
