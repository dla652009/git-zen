<script setup lang="ts">
import { ref, computed, reactive, watch, nextTick, type Component } from "vue";
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
  Archive,
  ArchiveRestore,
  Trash2,
  ChevronDown,
  Folder,
  ListTree,
  List,
  Search,
  X,
} from "@lucide/vue";
import * as api from "../gitApi";
import type { Status, StatusFile, StashEntry } from "../gitApi";
import type { DiffTarget } from "./DiffViewer.vue";
import { AI_PROMPTS, aiComplete, clipForAI } from "../ai";
import { settings } from "../settings";
import { humanizeMsg } from "../lib/errors";
import { isUnmerged } from "../lib/conflict";
import { buildFileRows, displayPath, tailName, type FileRow } from "../lib/fileTree";
import {
  Button,
  Badge,
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
  /** App 每改动一次 stash 就自增：菜单开着时据此重取列表（index 是位置，过期列表会点错记录） */
  stashRev?: number;
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
  abortMerge: []; // 放弃合并（App 侧确认）
  // 丢弃暂存区全部改动（App 侧确认：新增文件删不删要用户定）
  discardStaged: [p: { paths: string[]; count: number; newCount: number; conflictCount: number }];
}>();

// 切仓库时收起 stash 菜单/弹窗，避免上一仓库的列表串到新仓库
watch(
  () => props.repo,
  () => {
    stashMenuOpen.value = false;
    stashPushOpen.value = false;
    stashPopConfirm.value = null;
    // AI 报错属于上一个仓库的那次尝试，不该跟着新仓库继续挂着
    aiErr.value = "";
    aiHint.value = false;
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
// 「恢复并删除」会丢掉 stash 记录，先弹确认（与 App.vue 的危险确认同款：焦点默认落「取消」）
const stashPopConfirm = ref<StashEntry | null>(null);
const stashPopCancelBtn = ref<{ $el: HTMLButtonElement } | null>(null);

// 每次打开菜单都重取：stash 列表会被别处改动（终端里的 git stash、App 自己的删除）
async function loadStash() {
  stashErr.value = "";
  stashEntries.value = null; // null = 加载中
  try {
    stashEntries.value = await api.stashList(props.repo);
  } catch (e) {
    stashErr.value = humanizeMsg(e);
  }
}
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
  await loadStash();
}
// 删除记录后 index 整体前移（stash@{0}、stash@{1}… 是位置，不是身份），所以列表必须重取：
// 留着旧列表不只是显示不对，下一次「恢复」会落到另一条记录上。列表是懒加载的、
// 不在 App 统一重拉的 status/log/branches 里，所以靠 stashRev 自增来通知。
watch(
  () => props.stashRev,
  () => {
    if (stashMenuOpen.value) void loadStash();
  },
);
// 恢复：pop=true 恢复并删除记录（冲突时 git 自动保留），pop=false 仅恢复
function stashRestore(index: number, pop: boolean) {
  stashMenuOpen.value = false;
  emit("action", async () => {
    await api.stashApply(props.repo, index, pop);
    toast(pop ? "已恢复并移除记录" : "已恢复（记录保留）");
  });
}
// pop=true 的入口先走这一步：确认按钮是破坏性红色，Esc/取消直接关掉
function askStashPop(e: StashEntry) {
  stashMenuOpen.value = false;
  stashPopConfirm.value = e;
  nextTick(() => stashPopCancelBtn.value?.$el.focus());
}
function closeStashPop() {
  stashPopConfirm.value = null;
}
function confirmStashPop() {
  const e = stashPopConfirm.value;
  if (!e) return;
  stashPopConfirm.value = null;
  stashRestore(e.index, true);
}
function onStashPopKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") closeStashPop();
}
// 这个弹窗不进 App.vue 的 overlayOrder（那是顶层浮层的表），Esc 自己收
watch(stashPopConfirm, (open, _prev, onCleanup) => {
  if (!open) return;
  window.addEventListener("keydown", onStashPopKeydown);
  onCleanup(() => window.removeEventListener("keydown", onStashPopKeydown));
});
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

// ---- 变更列表的目录树 ----
// 折叠状态只活在内存里（与分支树的折叠一致，都不跨重启保留）。
// key 自带 section 命名空间（"sd:src" / "uf:a.txt"），所以两个列表共用一个 Set 不会互相干扰。
const collapsedDirs = ref(new Set<string>());
function toggleDir(key: string) {
  const next = new Set(collapsedDirs.value);
  if (!next.delete(key)) next.add(key);
  collapsedDirs.value = next;
}

// 过滤框：树解决了「文件去哪了」，剩下的问题是「文件在哪」。
// 过滤在建树之前做，所以不会留下空目录；命中时目录一律展开，否则命中的文件会被藏起来。
const fileFilter = ref("");

// 视图切换：目录树 ↔ 平铺。偏好写在 settings 里而不是组件内 —— 能跨重启保留，
// 也和主题、字号这些界面偏好待在同一处。
const flatView = computed(() => settings.changeView === "flat");
function toggleChangeView() {
  settings.changeView = flatView.value ? "tree" : "flat";
}

// pathOf 给的是 git 认的新路径；matchOf 额外把 porcelain 的原始串（重命名是 "old -> new"）
// 也算进过滤 —— 用旧名也能搜到，这是它一直以来的行为，重构时别弄丢
const stagedRows = computed(() =>
  buildFileRows(staged.value, displayPath, {
    section: "s",
    collapsed: collapsedDirs.value,
    filter: fileFilter.value,
    flat: flatView.value,
    matchOf: (f) => f.path,
  })
);
const unstagedRows = computed(() =>
  buildFileRows(unstaged.value, displayPath, {
    section: "u",
    collapsed: collapsedDirs.value,
    filter: fileFilter.value,
    flat: flatView.value,
    matchOf: (f) => f.path,
  })
);

// 目录行的暂存/取消暂存：git 的 pathspec 本来就认目录，把目录当路径传进去就会展开整棵子树
function stageDir(row: FileRow) {
  emit("action", async () => {
    await api.stage(props.repo, [row.path]);
    toast(`已暂存 ${row.label}`);
  });
}
function unstageDir(row: FileRow) {
  emit("action", async () => {
    await api.unstage(props.repo, [row.path]);
    toast(`已取消暂存 ${row.label}`);
  });
}

// 树里位置已经表达了目录，重命名行只显示两个**文件名**（完整路径在 tooltip 里）；
// 两个名字相同（整目录改名，位移已经说明了一切）时返回 null，退化成只显示文件名
function renameNames(f: StatusFile): [string, string] | null {
  const rp = renameParts(f.path);
  if (!rp) return null;
  const a = tailName(rp[0]);
  const b = tailName(rp[1]);
  return a === b ? null : [a, b];
}

function label(f: StatusFile): string {
  if (f.x === "?") return "?"; // 未跟踪
  return (f.y !== " " ? f.y : f.x).toUpperCase();
}

// 有未合并文件 = 合并/rebase 冲突进行中，此时必须给用户一个「放弃合并」的出口，
// 否则只能自己去终端 merge --abort（这是唯一会把用户踢出应用的高频场景）
const conflictFiles = computed(() => (props.status?.files ?? []).filter(isUnmerged));

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

// 传给 git 的必须是新路径（rename 整串 git 不认）；显示仍走 renameParts
function filePath(f: StatusFile): string {
  return f.path.split(" -> ").pop()!;
}

// 丢弃暂存区全部改动时要交给 git 的路径。重命名行必须**同时给旧名和新名** ——
// 旧名在 HEAD 里会被还原，新名不在 HEAD 里会被删除，只给一个会留下「D old.txt」这种残缺状态。
// 未跟踪文件不在暂存区，天生不会进这个列表。
function stagedPaths(): string[] {
  const out: string[] = [];
  for (const f of staged.value) {
    const rp = renameParts(f.path);
    if (rp) out.push(rp[0], rp[1]);
    else out.push(filePath(f));
  }
  return out;
}
function askDiscardStaged() {
  emit("discardStaged", {
    paths: stagedPaths(),
    // paths 里重命名算两个，所以文件数单独给，免得确认框报错数量
    count: staged.value.length,
    // x === "A" 的文件在 HEAD 里不存在，删不删磁盘上的文件得用户在确认框里定
    newCount: staged.value.filter((f) => f.x === "A").length,
    // 冲突文件按 HEAD 版本解决等于放弃已手动解决的内容，确认框要单独提示
    conflictCount: staged.value.filter(isUnmerged).length,
  });
}

const canCommit = computed(
  () => !props.busy && staged.value.length > 0 && message.value.trim().length > 0
);

// 勾选「提交后推送到远程」时，提交完自动 push（无上游自动 -u）
const pushAfterCommit = ref(false);

// 输入法组词中的 Ctrl+Enter 不该提交——此时 message 里还没有候选词
function onCommitKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (canCommit.value) doCommit();
}
function doCommit() {
  // 绑定仓库与分支：提交与推送之间用户可能切走选项卡（切仓库不拦 busy），
  // 而 props.repo 是响应式的 —— 第二次读取会拿到新仓库，改动就被推到别的仓库去了
  const repo = props.repo;
  const branch = props.status?.branch ?? "";
  emit("action", async () => {
    await api.commit(repo, message.value);
    drafts.set(repo, ""); // 清的是这个仓库的草稿，不是「当前」仓库的
    if (pushAfterCommit.value) await api.push(repo, branch);
    toast(pushAfterCommit.value ? "已提交并推送" : "已提交");
  });
}

// ---- B6：AI 生成的信息不静默覆盖已输入草稿——挂起待确认（覆盖 / 保留原内容）----
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
// 这个位置承载两种东西，生命周期不同，不能混为一谈：
//   前置条件提示 —— 「你点了但什么都没发生」的原因，条件一满足就该自己退场
//     （给它关闭按钮等于把「没做的事」说成做了）；
//   请求失败 —— 常带可执行的解决办法（例如「换个模型代号」），交给用户点 × 收起。
//     不猜秒数自动消失：读到一半就没了比一直挂着更糟。
const aiHint = ref(false);

// 前置条件成立后提示自己退场，不需要用户动手
watch([() => settings.aiEnabled, () => staged.value.length], () => {
  if (aiHint.value) {
    aiErr.value = "";
    aiHint.value = false;
  }
});

async function genCommitMsg() {
  if (aiBusy.value) return;
  if (settings.aiEnabled !== "on") {
    aiHint.value = true;
    aiErr.value = "AI 功能已关闭：设置 → AI 页可开启";
    return;
  }
  if (!staged.value.length) {
    aiHint.value = true;
    aiErr.value = "先暂存文件，AI 才有 diff 可读";
    return;
  }
  aiBusy.value = true;
  aiErr.value = "";
  // 绑定仓库：diff / log / AI 之间用户可能切走选项卡，三处必须读同一个仓库
  const repo = props.repo;
  try {
    const d = await api.diff(
      repo,
      staged.value.map((f) => filePath(f)),
      true
    );
    // 取最近提交推断本仓库的信息风格（SKILL.md：优先跟随既有惯例）
    const recentLog = (await api.log(repo))
      .slice(0, 10)
      .map((c) => c.subject)
      .join("\n");
    const user = `【仓库近期提交风格】\n${recentLog || "（无历史提交）"}\n\n【暂存区 diff】\n${clipForAI(d)}`;
    const text = await aiComplete(AI_PROMPTS.commitMessage.system(settings.aiCommitLang), user);
    if (props.repo !== repo) return; // 生成期间切走了：结果属于旧仓库，写进去会串草稿
    applyGenerated(text);
  } catch (e) {
    aiHint.value = false;
    aiErr.value = humanizeMsg(e);
  } finally {
    aiBusy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 冲突态横幅：给出「放弃合并」出口，不必回终端 -->
    <div
      v-if="conflictFiles.length"
      class="mx-3 mt-3 flex items-start gap-2 rounded-md border border-[var(--c-mod)]/40 bg-[var(--c-mod)]/10 px-2.5 py-2"
    >
      <GitMerge class="mt-0.5 size-3.5 shrink-0 text-[var(--c-mod)]" />
      <div class="min-w-0 flex-1 text-xs leading-relaxed">
        <div class="font-medium">合并冲突未解决（{{ conflictFiles.length }} 个文件）</div>
        <div class="mt-0.5 text-muted-foreground">
          逐个解决后暂存并提交即完成合并；也可以直接放弃，回到合并前。
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        class="h-6 shrink-0 px-2 text-xs"
        @click="emit('abortMerge')"
      >
        放弃合并
      </Button>
    </div>

    <!-- 过滤框：树解决了「文件去哪了」，剩下的问题是「文件在哪」—— 几十个文件在两个列表里
         各滚一遍太慢。放在面板顶部而不是「未暂存」标题行，因为一个词要同时过滤两个列表，
         而那两个标题行都已经挤满了（标签 + 徽标 + 两个按钮）。 -->
    <div v-if="staged.length + unstaged.length" class="mx-3 mt-2 flex items-center gap-1.5">
      <div class="relative flex-1">
        <Search
        class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        v-model="fileFilter"
        class="h-7 pr-7 pl-7 text-xs"
        placeholder="过滤文件路径"
        aria-label="过滤文件路径"
      />
        <button
          v-if="fileFilter"
          class="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition-colors duration-fast hover:text-foreground"
          aria-label="清空过滤"
          @click="fileFilter = ''"
        >
          <X class="size-3.5" />
        </button>
      </div>
      <!-- 视图切换：图标画的是「切过去会变成什么」，不是当前是什么 —— 配 tooltip 读才没有歧义 -->
      <Tooltip :text="flatView ? '切换到目录树' : '切换到平铺列表'">
        <Button
          variant="ghost"
          size="icon"
          class="h-7 w-7 shrink-0 text-muted-foreground"
          :aria-label="flatView ? '切换到目录树' : '切换到平铺列表'"
          @click="toggleChangeView"
        >
          <ListTree v-if="flatView" class="size-3.5" />
          <List v-else class="size-3.5" />
        </Button>
      </Tooltip>
    </div>

    <!-- 已暂存 -->
    <div class="flex items-center gap-2 px-3 pt-3 pb-1.5">
      <span class="text-2xs font-semibold tracking-wide text-muted-foreground">已暂存</span>
      <Badge v-if="staged.length" variant="default">{{ staged.length }}</Badge>
      <!-- 全部取消暂存 -->
      <Button
        v-if="staged.length"
        variant="ghost"
        size="sm"
        class="ml-auto h-6 px-2 text-xs"
        @click="
          emit('action', async () => {
            await api.unstage(repo, staged.map((f) => filePath(f)));
            toast(`已取消暂存 ${staged.length} 个文件`);
          })
        "
      >
        全部取消暂存
      </Button>
      <Tooltip text="丢弃暂存区的全部改动（还原到上次提交）">
        <Button
          v-if="staged.length"
          variant="ghost"
          size="icon"
          class="h-6 w-6 text-muted-foreground hover:text-destructive"
          aria-label="丢弃暂存区的全部改动"
          @click="askDiscardStaged"
        >
          <Trash2 class="size-3.5" />
        </Button>
      </Tooltip>
    </div>
    <ul class="max-h-[34%] overflow-y-auto px-1.5">
      <template v-for="row in stagedRows" :key="row.key">
        <!-- 目录行：点整行展开/收起，右侧按钮对整棵子树生效 -->
        <li
          v-if="row.kind === 'dir'"
          class="group/li flex cursor-pointer items-center gap-1 rounded-sm py-1.5 pr-2 text-xs whitespace-nowrap transition-colors duration-fast hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary/60 focus-visible:-outline-offset-1"
          :style="{ paddingLeft: 8 + row.depth * 12 + 'px' }"
          tabindex="0"
          role="button"
          :aria-expanded="!row.collapsed"
          @click="toggleDir(row.key)"
          @keydown.enter.prevent="toggleDir(row.key)"
          @keydown.space.prevent="toggleDir(row.key)"
        >
          <ChevronDown
            class="size-3 shrink-0 text-muted-foreground transition-transform duration-fast"
            :class="row.collapsed && '-rotate-90'"
          />
          <Folder class="size-3.5 shrink-0 text-muted-foreground" />
          <Tooltip :text="`${row.path} · 共 ${row.count} 个文件（单击展开/收起）`">
            <span class="truncate text-muted-foreground">{{ row.label }}</span>
          </Tooltip>
          <!-- 收起时才报数量：展开着就能看见里面有几个，再报一遍是噪音 -->
          <span v-if="row.collapsed" class="shrink-0 text-2xs text-muted-foreground">{{ row.count }}</span>
          <Tooltip text="取消暂存此目录下的全部改动">
            <Button
              variant="ghost"
              size="icon"
              class="ml-auto size-6 shrink-0 opacity-60 transition-opacity duration-fast group-hover/li:opacity-100 hover:!opacity-100 focus-visible:opacity-100"
              :aria-label="`取消暂存 ${row.path}`"
              @click.stop="unstageDir(row)"
            >
              <Undo2 class="size-3.5" />
            </Button>
          </Tooltip>
        </li>
        <!-- 文件行：位置已经表达了目录，名字只显示文件名（完整路径在 tooltip 里） -->
        <li
          v-if="row.kind === 'file'"
          class="group/li flex cursor-pointer items-center gap-2 overflow-hidden rounded-sm py-1.5 pr-2 whitespace-nowrap transition-colors duration-fast hover:bg-hover"
          :class="selKey === row.key && 'bg-primary-soft'"
          :style="{ paddingLeft: 8 + row.depth * 12 + 'px' }"
          @click="onRowClick(row.key, () => emit('openDiff', { path: row.path, cached: !isUnmerged(row.item), untracked: false, conflict: isUnmerged(row.item) }))"
          @contextmenu.prevent="fileCtx = { x: $event.clientX, y: $event.clientY, f: row.item, cached: true }"
        >
          <component :is="statusMeta(row.item).icon" :class="statusMeta(row.item).cls" class="size-4 shrink-0" />
          <Tooltip :text="`${statusMeta(row.item).desc} · ${row.item.path}（单击选中 · 再单击查看变更）`">
            <span class="truncate text-sm">
              <template v-if="renameNames(row.item)">
                <span class="text-muted-foreground line-through">{{ renameNames(row.item)![0] }}</span>
                → {{ renameNames(row.item)![1] }}
              </template>
              <template v-else>{{ row.label }}</template>
            </span>
          </Tooltip>
          <Tooltip text="取消暂存">
            <Button
              variant="ghost"
              size="icon"
              class="ml-auto size-6 shrink-0 opacity-60 transition-opacity duration-fast group-hover/li:opacity-100 hover:!opacity-100 focus-visible:opacity-100"
              :aria-label="`取消暂存 ${row.path}`"
              @click.stop="emit('action', () => api.unstage(repo, [row.path]))"
            >
              <Undo2 class="size-3.5" />
            </Button>
          </Tooltip>
        </li>
      </template>
      <li v-if="!staged.length" class="px-3 py-1.5 text-xs text-muted-foreground">无</li>
      <li v-else-if="!stagedRows.length" class="px-3 py-1.5 text-xs text-muted-foreground">
        没有匹配的文件
      </li>
    </ul>

    <!-- 未暂存 -->
    <div class="mt-2 flex items-center gap-2 border-t border-border px-3 pt-3 pb-1.5">
      <span class="text-2xs font-semibold tracking-wide text-muted-foreground">未暂存</span>
      <Badge v-if="unstaged.length" variant="danger">{{ unstaged.length }}</Badge>
      <Button
        v-if="unstaged.length"
        variant="ghost"
        size="sm"
        class="ml-auto h-6 px-2 text-xs"
        @click="
          emit('action', async () => {
            await api.stage(repo, unstaged.map((f) => filePath(f)));
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
      <template v-for="row in unstagedRows" :key="row.key">
        <!-- 目录行：点整行展开/收起，右侧按钮对整棵子树生效 -->
        <li
          v-if="row.kind === 'dir'"
          class="group/li flex cursor-pointer items-center gap-1 rounded-sm py-1.5 pr-2 text-xs whitespace-nowrap transition-colors duration-fast hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary/60 focus-visible:-outline-offset-1"
          :style="{ paddingLeft: 8 + row.depth * 12 + 'px' }"
          tabindex="0"
          role="button"
          :aria-expanded="!row.collapsed"
          @click="toggleDir(row.key)"
          @keydown.enter.prevent="toggleDir(row.key)"
          @keydown.space.prevent="toggleDir(row.key)"
        >
          <ChevronDown
            class="size-3 shrink-0 text-muted-foreground transition-transform duration-fast"
            :class="row.collapsed && '-rotate-90'"
          />
          <Folder class="size-3.5 shrink-0 text-muted-foreground" />
          <Tooltip :text="`${row.path} · 共 ${row.count} 个文件（单击展开/收起）`">
            <span class="truncate text-muted-foreground">{{ row.label }}</span>
          </Tooltip>
          <!-- 收起时才报数量：展开着就能看见里面有几个，再报一遍是噪音 -->
          <span v-if="row.collapsed" class="shrink-0 text-2xs text-muted-foreground">{{ row.count }}</span>
          <Tooltip text="暂存此目录下的全部改动">
            <Button
              variant="ghost"
              size="icon"
              class="ml-auto size-6 shrink-0 opacity-60 transition-opacity duration-fast group-hover/li:opacity-100 hover:!opacity-100 focus-visible:opacity-100"
              :aria-label="`暂存 ${row.path}`"
              @click.stop="stageDir(row)"
            >
              <Plus class="size-3.5" />
            </Button>
          </Tooltip>
        </li>
        <!-- 文件行：位置已经表达了目录，名字只显示文件名（完整路径在 tooltip 里） -->
        <li
          v-if="row.kind === 'file'"
          class="group/li flex cursor-pointer items-center gap-2 overflow-hidden rounded-sm py-1.5 pr-2 whitespace-nowrap transition-colors duration-fast hover:bg-hover"
          :class="selKey === row.key && 'bg-primary-soft'"
          :style="{ paddingLeft: 8 + row.depth * 12 + 'px' }"
          @click="onRowClick(row.key, () => emit('openDiff', { path: row.path, cached: false, untracked: row.item.x === '?', conflict: isUnmerged(row.item) }))"
          @contextmenu.prevent="fileCtx = { x: $event.clientX, y: $event.clientY, f: row.item, cached: false }"
        >
          <component :is="statusMeta(row.item).icon" :class="statusMeta(row.item).cls" class="size-4 shrink-0" />
          <Tooltip :text="`${statusMeta(row.item).desc} · ${row.item.path}（单击选中 · 再单击查看变更）`">
            <span class="truncate text-sm">
              <template v-if="renameNames(row.item)">
                <span class="text-muted-foreground line-through">{{ renameNames(row.item)![0] }}</span>
                → {{ renameNames(row.item)![1] }}
              </template>
              <template v-else>{{ row.label }}</template>
            </span>
          </Tooltip>
          <Tooltip text="暂存">
            <Button
              variant="ghost"
              size="icon"
              class="ml-auto size-6 shrink-0 opacity-60 transition-opacity duration-fast group-hover/li:opacity-100 hover:!opacity-100 focus-visible:opacity-100"
              :aria-label="`暂存 ${row.path}`"
              @click.stop="emit('action', () => api.stage(repo, [row.path]))"
            >
              <Plus class="size-3.5" />
            </Button>
          </Tooltip>
        </li>
      </template>
      <li v-if="!unstaged.length" class="px-3 py-1.5 text-xs text-muted-foreground">无</li>
      <li v-else-if="!unstagedRows.length" class="px-3 py-1.5 text-xs text-muted-foreground">
        没有匹配的文件
      </li>
    </ul>

    <!-- 文件右键菜单（ui/ContextMenu 统一渲染） -->
    <ContextMenu
      v-if="fileCtx"
      :x="fileCtx.x"
      :y="fileCtx.y"
      :items="[
        { label: '查看文件变更历史', fn: () => emit('fileHistory', filePath(fileCtx!.f)) },
        { label: '在历史区按此文件过滤', fn: () => emit('filterHistory', filePath(fileCtx!.f)) },
        { label: '复制路径', fn: () => copyPath(fileCtx!.f.path) },
        ...(fileCtx!.f.x === '?'
          ? [{
              label: '加入 .gitignore',
              fn: () => emit('action', () => api.ignoreAdd(repo, filePath(fileCtx!.f))),
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
                    path: filePath(fileCtx!.f),
                    cached: false,
                    untracked: fileCtx!.f.x === '?',
                  }),
              } as MenuItem,
            ]),
      ]"
      @close="fileCtx = null"
    />

    <!-- 提交区：固定底部卡片 -->
    <div class="shrink-0 space-y-2 border-t border-border bg-card p-3">
      <div class="relative">
        <!-- 字号钉在 text-fixed（固定 px，不跟随「设置 → 字号」）：这里是右栏最大的文字，
             跟着字号放大到 16-17px 会挤掉可见行数 -->
        <Textarea
          v-model="message"
          rows="4"
          class="pr-9 text-fixed"
          placeholder="提交信息…"
          @keydown.ctrl.enter="onCommitKeydown"
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
      <div v-if="aiErr" class="flex items-start gap-1.5 text-xs leading-relaxed text-destructive">
        <span class="flex-1 break-words">{{ aiErr }}</span>
        <!-- 前置条件提示不给关闭按钮：它随条件达成自己消失，关掉反而把「没做的事」说成做了 -->
        <button
          v-if="!aiHint"
          class="shrink-0 rounded-xs p-1 text-destructive transition-opacity duration-fast hover:opacity-60"
          aria-label="关闭提示"
          @click="aiErr = ''"
        >
          <X class="size-3.5" />
        </button>
      </div>
      <!-- 已有草稿时不静默覆盖：覆盖 / 保留，二选一 -->
      <div
        v-if="pendingMsg"
        class="flex items-center gap-2 rounded-md border border-[var(--c-conf)]/40 bg-[var(--c-conf)]/10 px-2 py-1 text-xs"
      >
        <span class="flex-1">已生成新的提交信息，覆盖已输入的内容？</span>
        <Button variant="secondary" size="sm" class="h-5 px-1.5 text-xs" @click="applyPending">覆盖</Button>
        <Button variant="ghost" size="sm" class="h-5 px-1.5 text-xs" @click="pendingMsg = ''">保留原内容</Button>
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

    <!-- stash 下拉菜单：收纳入口 + 记录列表（恢复/恢复并删除/删除） -->
    <div
      v-if="stashMenuOpen"
      class="fixed inset-0 z-30"
      @click="stashMenuOpen = false"
      @contextmenu.prevent="stashMenuOpen = false"
    >
      <div
        class="pop-in surface-menu fixed max-h-[60vh] w-[300px] overflow-y-auto rounded-sm py-1"
        :style="{ left: stashAnchor.x + 'px', top: stashAnchor.y + 'px' }"
      >
        <div class="px-3 py-1 text-2xs font-semibold tracking-wide text-muted-foreground">
          Stash · 暂存架
        </div>
        <button
          v-if="unstaged.length || staged.length"
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs transition-colors duration-fast hover:bg-hover"
          @click.stop="openStashPush"
        >
          <Archive class="mr-1.5 inline size-3" />
          收纳当前改动…
        </button>
        <div v-if="stashErr" class="px-3 py-2 text-xs text-destructive">{{ stashErr }}</div>
        <div v-else-if="stashEntries === null" class="px-3 py-2">
          <Spinner label="加载中…" />
        </div>
        <template v-else>
          <div
            v-for="e in stashEntries"
            :key="e.index"
            class="group/st flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-fast hover:bg-hover"
            :title="`${e.subject} · ${e.date}\n右侧图标：恢复（保留记录）/ 恢复并删除（pop）/ 删除记录`"
          >
            <Archive class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ e.subject }}</span>
            <span
              class="flex shrink-0 items-center gap-1 opacity-60 transition-opacity duration-fast group-hover/st:opacity-100 group-focus-within/st:opacity-100"
            >
              <Tooltip text="恢复（保留记录，可再次恢复）">
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-6 shrink-0 hover:text-primary"
                  :aria-label="`恢复 stash 记录 ${e.subject}`"
                  @click.stop="stashRestore(e.index, false)"
                >
                  <RotateCcw class="size-3.5" />
                </Button>
              </Tooltip>
              <Tooltip text="恢复并删除记录（pop）">
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-6 shrink-0 hover:text-primary"
                  :aria-label="`恢复并删除 stash 记录 ${e.subject}`"
                  @click.stop="askStashPop(e)"
                >
                  <ArchiveRestore class="size-3.5" />
                </Button>
              </Tooltip>
              <Tooltip text="仅删除记录（不恢复）">
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-6 shrink-0 hover:text-destructive"
                  :aria-label="`删除 stash 记录 ${e.subject}`"
                  @click.stop="emit('stashDrop', e.index, e.subject)"
                >
                  <Trash2 class="size-3.5" />
                </Button>
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
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-stash-push-title"
      @click.self="stashPushOpen = false"
    >
      <div class="w-dlg-sm surface rounded-lg p-5 pop-in">
        <div id="dlg-stash-push-title" class="mb-2 font-medium">收纳改动到 Stash</div>
        <Input v-model="stashMsg" placeholder="备注（可选）" />
        <label class="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input v-model="stashUntracked" type="checkbox" class="accent-[var(--primary)]" />
          包含未跟踪文件
        </label>
        <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          把已暂存与未暂存的改动一起收进暂存架，工作区恢复干净；稍后可从 stash 菜单恢复。
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="stashPushOpen = false">取消</Button>
          <Button variant="default" size="sm" :disabled="busy" @click="doStashPush">收纳</Button>
        </div>
      </div>
    </div>

    <!-- 「恢复并删除」确认：pop 会丢掉这条 stash 记录，属破坏性操作 -->
    <div
      v-if="stashPopConfirm"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-stash-pop-title"
      @click.self="closeStashPop"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-stash-pop-title" class="mb-1.5 font-medium">恢复并删除 Stash 记录</div>
        <div>
          将把「{{ stashPopConfirm.subject }}」的改动恢复到工作区，并删除这条 stash 记录。
          改动不会自动回到暂存区，需要重新暂存与提交。
        </div>
        <div class="mt-1.5 text-xs text-muted-foreground">
          如果只是想先试试、稍后还要再恢复，请取消并改用 stash 菜单里的「仅恢复（记录保留）」。
        </div>
        <div class="mt-3 flex justify-end gap-2">
          <Button ref="stashPopCancelBtn" variant="ghost" size="sm" @click="closeStashPop">取消</Button>
          <Button variant="destructive" size="sm" :disabled="busy" @click="confirmStashPop">
            恢复并删除
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
