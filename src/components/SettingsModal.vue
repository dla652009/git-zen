<script setup lang="ts">
import { computed, reactive, ref, onMounted } from "vue";
import { X, Palette, UserCog, Keyboard, User, Bot, Plus, Globe, Workflow as WorkflowIcon, ChevronDown, ChevronUp } from "@lucide/vue";
import { THEMES, settings, type Settings } from "../settings";
import * as api from "../gitApi";
import { aiVerify } from "../ai";
import { workflows } from "../workflowStore";
import { newFlowId, type BranchRef, type Workflow, type WorkflowStep } from "../workflow";
import { Button, Input, Spinner, Select, Switch } from "@/components/ui";
import CommitHeatmap from "./CommitHeatmap.vue";

const props = defineProps<{ repo: string; initialTab?: string }>();
const emit = defineEmits<{ close: [] }>();

// 草稿编辑，保存才写回（写回后 watcher 自动持久化+生效）
const draft = reactive<Settings>({ ...settings });
const tab = ref<"user" | "ai" | "appearance" | "personal" | "workflow" | "remote" | "shortcuts">(
  (props.initialTab as "user" | "ai" | "appearance" | "personal" | "workflow" | "shortcuts") || "user"
);

// AI 配置验通
const verifying = ref(false);
const verifyErr = ref("");

// 仓库网页链接：按仓库存 localStorage（gz.remoteLinks），留空自动推断
const remoteLink = ref("");
const originUrl = ref("");

// 用户信息是仓库级 git config，不属于应用设置，单独存取
const userName = ref("");
const userEmail = ref("");
onMounted(async () => {
  if (props.repo) {
    try {
      originUrl.value = await api.remoteUrl(props.repo);
    } catch (e) {
      // 不再完全静默：无远程/命令失败时在输入框 placeholder 可见（空串 → placeholder 提示）
      originUrl.value = "";
      console.warn("[git-zen] 读取 origin 失败:", e);
    }
  }
  const custom =
    (JSON.parse(localStorage.getItem("gz.remoteLinks") ?? "{}") as Record<string, string>)[props.repo] ?? "";
  // 默认填充 origin URL；用户改过则显示自定义值
  remoteLink.value = custom || originUrl.value;
  if (!props.repo) return;
  try {
    const [n, e] = await api.getUser(props.repo);
    userName.value = n;
    userEmail.value = e;
  } catch {
    /* 无仓库或非 git 目录时静默 */
  }
});

async function save() {
  // AI 配了 Key 才验通；失败不关弹窗，展示错误
  if (draft.aiBaseUrl.trim() && draft.aiApiKey.trim()) {
    verifyErr.value = "";
    verifying.value = true;
    try {
      await aiVerify(draft.aiBaseUrl, draft.aiApiKey);
    } catch (e) {
      verifyErr.value = String(e).replace(/^Error: /, "");
      verifying.value = false;
      return;
    }
    verifying.value = false;
  }
  Object.assign(settings, draft);
  if (props.repo && (userName.value.trim() || userEmail.value.trim())) {
    api.configUser(props.repo, userName.value.trim(), userEmail.value.trim()).catch(() => {});
  }
  // 仓库链接写回 per-repo map
  const links = JSON.parse(localStorage.getItem("gz.remoteLinks") ?? "{}") as Record<string, string>;
  const link = remoteLink.value.trim();
  if (props.repo) {
    // 与 origin 相同 → 视为自动推断（存空）
    if (link && link !== originUrl.value) links[props.repo] = link;
    else delete links[props.repo];
    localStorage.setItem("gz.remoteLinks", JSON.stringify(links));
    remoteLink.value = link;
  }
  emit("close");
}

// Esc 关闭统一走 App 的 closeTopOverlay 分层链（此前这里的监听从未清理，一并移除）

// ---- 工作流管理（M12：配置面在设置页，执行面在工具栏）----
const wfExpanded = ref("");
const deleteArm = ref(""); // 两段式删除：第一次点「删除」进入确认态，再点才真删
function addFlow() {
  const wf: Workflow = { id: newFlowId(), name: `工作流 ${workflows.length + 1}`, steps: [] };
  workflows.push(wf);
  wfExpanded.value = wf.id;
}
function renameFlow(w: Workflow) {
  wfRename.value = { id: w.id, draft: w.name };
}
const wfRename = ref<{ id: string; draft: string } | null>(null);
function confirmFlowRename() {
  const r = wfRename.value;
  const name = r?.draft.trim();
  wfRename.value = null;
  if (!r || !name) return;
  const wf = workflows.find((x) => x.id === r.id);
  if (wf) wf.name = name;
}
function deleteFlow(w: Workflow) {
  if (deleteArm.value === w.id) {
    workflows.splice(workflows.indexOf(w), 1);
    if (wfExpanded.value === w.id) wfExpanded.value = "";
    deleteArm.value = "";
    return;
  }
  deleteArm.value = w.id;
  setTimeout(() => {
    if (deleteArm.value === w.id) deleteArm.value = "";
  }, 2500);
}
function moveStep(w: Workflow, i: number, d: -1 | 1) {
  const j = i + d;
  if (j < 0 || j >= w.steps.length) return;
  const [s] = w.steps.splice(i, 1);
  w.steps.splice(j, 0, s!);
}
const newStepKind = ref<WorkflowStep["kind"]>("checkout");
const newStepMode = ref<BranchRef["mode"]>("fixed");
const newStepName = ref("");
const newStepMsgSource = ref<"ai" | "fixed">("ai");
const newStepMessage = ref("");
const newStepPrefix = ref("");
function addStep(w: Workflow) {
  const s = buildDraftStep();
  if (!s) return;
  w.steps.push(s);
}
function buildDraftStep(): WorkflowStep | null {
  switch (newStepKind.value) {
    case "checkout":
    case "merge":
      if (newStepMode.value === "fixed" && !newStepName.value.trim()) return null;
      return { kind: newStepKind.value, ref: { mode: newStepMode.value, name: newStepName.value.trim() } };
    case "pull":
      return { kind: "pull" };
    case "push":
      return { kind: "push" };
    case "switchBack":
      return { kind: "switchBack" };
    case "createBranch":
      return { kind: "createBranch", prefix: newStepPrefix.value.trim() || undefined };
    case "commitPush": {
      const message = newStepMessage.value.trim();
      if (newStepMsgSource.value === "fixed" && !message) return null;
      return { kind: "commitPush", msgSource: newStepMsgSource.value, message: message || undefined };
    }
  }
}
const KIND_LABELS: Record<WorkflowStep["kind"], string> = {
  checkout: "切换分支",
  pull: "拉取",
  commitPush: "提交推送",
  push: "推送",
  merge: "合并",
  createBranch: "新建分支",
  switchBack: "切回起始分支",
};
const STEP_KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));
const REF_MODE_OPTIONS = [
  { value: "fixed", label: "固定名" },
  { value: "start", label: "起始分支" },
  { value: "ask", label: "运行时输入" },
];
const MSG_SOURCE_OPTIONS = [
  { value: "ai", label: "AI 生成" },
  { value: "fixed", label: "固定文本" },
];
function refOf(s: WorkflowStep): BranchRef | null {
  return s.kind === "checkout" || s.kind === "merge" ? s.ref : null;
}

// 目前为固定快捷键，仅展示；后续可做成可配置
const SHORTCUTS: [string, string][] = [
  ["Ctrl + P", "仓库快速切换器（模糊搜索 + 最近使用排序）"],
  ["Ctrl + Tab / Ctrl + Shift + Tab", "下一个 / 上一个仓库选项卡（仅可见的，分组内不参与）"],
  ["Ctrl + 1..9", "跳到第 N 个可见仓库选项卡（分组内仓库不占号）"],
  ["F5", "刷新仓库状态"],
  ["Ctrl + Enter（提交框内）", "提交"],
  ["双击分支", "切换 / 建立跟踪分支"],
  ["双击历史行", "查看该提交的 diff"],
  ["Esc", "关闭弹窗"],
];

// AI 开关（Switch 用 boolean，与 draft.aiEnabled 'on'/'off' 互转）
const aiOn = computed({
  get: () => draft.aiEnabled === "on",
  set: (v: boolean) => (draft.aiEnabled = v ? "on" : "off"),
});

// 热门字体选项（未安装的字体浏览器会自动回退，不会白屏）
const FONT_OPTIONS = [
  { value: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif', label: "默认（现代系统字体）" },
  { value: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif', label: "Segoe UI Variable" },
  { value: '"Microsoft YaHei", "PingFang SC", sans-serif', label: "微软雅黑" },
  { value: '"Inter", "Noto Sans SC", sans-serif', label: "Inter" },
  { value: '"MiSans", "Segoe UI", sans-serif', label: "MiSans" },
  { value: '"HarmonyOS Sans SC", "Segoe UI", sans-serif', label: "HarmonyOS Sans" },
  { value: '"Source Han Sans SC", "Noto Sans SC", sans-serif', label: "思源黑体" },
  { value: 'Consolas, "Cascadia Code", monospace', label: "等宽 · Consolas" },
];

// 分支前缀：存储为逗号分隔字符串；tag 式编辑
const prefixInput = ref("");
const prefixList = computed(() =>
  draft.branchPrefix
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
);
function addPrefix() {
  const v = prefixInput.value.trim().replace(/[,，]/g, "");
  if (!v) return;
  const list = prefixList.value;
  if (!list.includes(v)) {
    list.push(v);
    draft.branchPrefix = list.join(",");
  }
  prefixInput.value = "";
}
function removePrefix(p: string) {
  draft.branchPrefix = prefixList.value
    .filter((x: string) => x !== p)
    .join(",");
}

const NAV = [
  { id: "user", label: "用户信息", icon: User },
  { id: "ai", label: "AI", icon: Bot },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "personal", label: "个性化", icon: UserCog },
  { id: "workflow", label: "工作流", icon: WorkflowIcon },
  { id: "remote", label: "远程", icon: Globe },
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
] as const;
</script>

<template>
  <div class="fixed inset-0 z-30 flex items-center justify-center bg-black/50" @click.self="emit('close')">
    <!-- 880x520：热力图满幅 + 各页留白；窗口过小时回退 95vw/95vh（热力图横向滚动，内容区滚动） -->
    <div class="flex h-[520px] max-h-[95vh] w-[880px] max-w-[95vw] overflow-hidden rounded-lg border border-border bg-card shadow-xl">
      <!-- 左侧导航 -->
      <nav class="w-36 shrink-0 space-y-0.5 border-r border-border bg-muted/30 p-2">
        <button
          v-for="item in NAV"
          :key="item.id"
          :class="[
            'flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] transition-colors',
            tab === item.id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted',
          ]"
          @click="tab = item.id"
        >
          <component :is="item.icon" class="size-4" />
          {{ item.label }}
        </button>
      </nav>

      <!-- 右侧内容 -->
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex shrink-0 items-center border-b border-border px-4 py-2.5">
          <span class="font-medium">设置</span>
          <span class="flex-1" />
          <Button variant="ghost" size="icon" @click="emit('close')"><X class="size-4" /></Button>
        </header>

        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <!-- 用户信息（仓库级） -->
          <template v-if="tab === 'user'">
            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">提交者信息</h3>
              <div class="space-y-3">
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">名字</label>
                  <Input v-model="userName" placeholder="提交历史中显示的名字" />
                </div>
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">邮箱</label>
                  <Input v-model="userEmail" placeholder="you@example.com" />
                </div>
              </div>
              <p class="mt-2 text-[11px] text-muted-foreground">
                保存到当前仓库的 git config（{{ props.repo || "未选择仓库" }}）
              </p>
            </section>

            <!-- 提交热力图（只统计上方邮箱名下的提交） -->
            <section v-if="props.repo">
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">提交热力图</h3>
              <CommitHeatmap :repo="props.repo" :author-email="userEmail" />
            </section>
          </template>

          <!-- AI -->
          <template v-else-if="tab === 'ai'">
            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">AI 服务（OpenAI 兼容协议）</h3>
              <div class="mb-4 flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
                <span class="text-xs">启用 AI 功能</span>
                <Switch v-model="aiOn" />
              </div>
              <div :class="['space-y-3', aiOn ? '' : 'pointer-events-none opacity-40']">
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">Base URL</label>
                  <Input v-model="draft.aiBaseUrl" placeholder="https://api.openai.com/v1" />
                </div>
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">API Key</label>
                  <Input v-model="draft.aiApiKey" type="password" placeholder="sk-…（本地 Ollama 可留空）" />
                </div>
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">模型</label>
                  <Input v-model="draft.aiModel" placeholder="gpt-4o-mini / deepseek-chat / qwen2.5 …" />
                </div>
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">提交语言</label>
                  <Select
                    v-model="draft.aiCommitLang"
                    class="w-40"
                    :options="[
                      { value: '中文', label: '中文' },
                      { value: 'English', label: 'English' },
                    ]"
                  />
                </div>
              </div>
              <p class="mt-2 text-[11px] text-muted-foreground">
                兼容 OpenAI/DeepSeek/Kimi 等任意兼容服务；本地 Ollama 填
                http://localhost:11434/v1 且 Key 留空。Key 存本机 localStorage，不会上传。
              </p>
            </section>
          </template>

          <!-- 外观 -->
          <template v-else-if="tab === 'appearance'">
            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">主题</h3>
              <div class="grid grid-cols-4 gap-1.5">
                <button
                  v-for="t in THEMES"
                  :key="t.id"
                  :class="[
                    'cursor-pointer rounded-md border px-2 py-1.5 text-xs transition-colors',
                    draft.theme === t.id
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border hover:bg-muted',
                  ]"
                  @click="draft.theme = t.id"
                >
                  {{ t.label }}
                </button>
              </div>
            </section>

            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">字体</h3>
              <div class="space-y-3">
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">UI 字体</label>
                  <Select
                    v-model="draft.fontFamily"
                    :options="FONT_OPTIONS"
                  />
                </div>
                <div class="flex items-center gap-3">
                  <label class="w-16 shrink-0 text-xs text-muted-foreground">字号</label>
                  <input v-model.number="draft.fontSize" type="range" min="11" max="17" class="flex-1 accent-[var(--primary)]" />
                  <span class="w-9 text-right text-xs">{{ draft.fontSize }}px</span>
                </div>
              </div>
            </section>
          </template>

          <!-- 个性化 -->
          <template v-else-if="tab === 'personal'">
            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">分支前缀（可多个）</h3>
              <!-- tag 式编辑：回车/逗号添加，点 × 删除；存储仍是逗号分隔字符串，创建弹窗下拉自动同步 -->
              <div class="flex min-h-[32px] flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
                <span
                  v-for="p in prefixList"
                  :key="p"
                  class="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary"
                >
                  {{ p }}
                  <X class="size-3 cursor-pointer hover:text-destructive" @click="removePrefix(p)" />
                </span>
                <input
                  v-model="prefixInput"
                  placeholder="输入前缀后回车，如 feat/"
                  class="min-w-[140px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  @keydown.enter.prevent="addPrefix"
                  @keydown.,.prevent="addPrefix"
                  @blur="addPrefix"
                />
              </div>
              <p class="mt-2 text-[11px] text-muted-foreground">
                新建分支弹窗的前缀下拉会同步这里；名字已含前缀时不重复加。
              </p>
            </section>

            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">性能</h3>
              <div class="flex items-center gap-3">
                <label class="w-16 shrink-0 text-xs text-muted-foreground">切换缓存</label>
                <input
                  v-model.number="draft.repoCacheSize"
                  type="range"
                  min="1"
                  max="30"
                  class="flex-1 accent-[var(--primary)]"
                />
                <span class="w-14 text-right text-xs">{{ draft.repoCacheSize }} 个仓库</span>
              </div>
              <p class="mt-2 text-[11px] text-muted-foreground">
                最近打开的仓库切换时直接恢复快照秒开；开了很多仓库时调大更顺。只存内存不落盘，调大对内存影响很小。
              </p>
            </section>

          </template>

          <!-- 工作流 -->
          <template v-else-if="tab === 'workflow'">
            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">什么是工作流</h3>
              <p class="mb-4 text-[11px] leading-relaxed text-muted-foreground">
                把「切分支 → 拉取 → 合并 → 推送」这类固定套路串起来，工具栏
                <WorkflowIcon class="inline size-3.5 align-[-2px] text-primary" /> 按钮下拉一键执行。
                步骤自上而下顺序执行，任一步失败立即中止；「提交推送」在有改动时自动全部暂存，无改动时跳过。
              </p>
              <Button variant="secondary" size="sm" class="mb-3" @click="addFlow">
                <Plus class="size-3.5" /> 新建工作流
              </Button>
              <div v-if="!workflows.length" class="py-10 text-center text-xs text-muted-foreground">
                还没有工作流。新建一个试试——先从「切 master → 拉取 → 新建分支」开始。
              </div>
              <div v-for="w in workflows" :key="w.id" class="mb-3 rounded-md border border-border">
                <div class="flex items-center gap-2 px-3 py-2">
                  <button
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[13px]"
                    @click="wfExpanded = wfExpanded === w.id ? '' : w.id"
                  >
                    <ChevronDown
                      class="size-3 shrink-0 text-muted-foreground transition-transform"
                      :class="wfExpanded !== w.id && '-rotate-90'"
                    />
                    <WorkflowIcon class="size-3.5 shrink-0 text-primary" />
                    <span class="truncate font-medium">{{ w.name }}</span>
                    <span class="shrink-0 text-[11px] text-muted-foreground">{{ w.steps.length }} 步</span>
                  </button>
                  <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px]" @click="renameFlow(w)">重命名</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-6 px-2 text-[11px]"
                    :class="deleteArm === w.id && 'text-destructive'"
                    @click="deleteFlow(w)"
                  >
                    {{ deleteArm === w.id ? "确认删除？" : "删除" }}
                  </Button>
                </div>
                <div v-if="wfExpanded === w.id" class="border-t border-border/60 px-3 py-2.5">
                  <!-- 步骤卡：编号 + 类型 + 参数行内编辑 + 上移/下移/删除 -->
                  <div
                    v-for="(s, si) in w.steps"
                    :key="si"
                    class="mb-1.5 rounded-md border border-border/70 bg-muted/20 px-2.5 py-2"
                  >
                    <div class="flex items-center gap-2">
                      <span
                        class="grid size-5 shrink-0 place-items-center rounded bg-primary/15 text-[10px] font-medium text-primary"
                      >{{ si + 1 }}</span>
                      <span class="w-16 shrink-0 text-xs font-medium">{{ KIND_LABELS[s.kind] }}</span>
                      <div class="flex min-w-0 flex-1 items-center gap-1.5">
                        <template v-if="refOf(s)">
                          <Select
                            :model-value="refOf(s)!.mode"
                            class="h-7 w-28 shrink-0 text-xs"
                            :options="REF_MODE_OPTIONS"
                            @update:model-value="(m: string | number) => { const r = refOf(s); if (r) r.mode = m as BranchRef['mode']; }"
                          />
                          <Input
                            v-if="refOf(s)!.mode === 'fixed'"
                            :model-value="refOf(s)!.name ?? ''"
                            class="h-7 min-w-0 flex-1 text-xs"
                            placeholder="分支名"
                            @update:model-value="(v: string | number) => { const r = refOf(s); if (r) r.name = String(v); }"
                          />
                          <span v-else class="min-w-0 flex-1 text-[11px] text-muted-foreground">
                            {{ refOf(s)!.mode === "start" ? "使用执行开始时的当前分支" : "执行时填写分支名" }}
                          </span>
                        </template>
                        <template v-else-if="s.kind === 'commitPush'">
                          <Select
                            :model-value="s.msgSource"
                            class="h-7 w-28 shrink-0 text-xs"
                            :options="MSG_SOURCE_OPTIONS"
                            @update:model-value="(m: string | number) => (s.msgSource = m as 'ai' | 'fixed')"
                          />
                          <Input
                            v-if="s.msgSource === 'fixed'"
                            :model-value="s.message ?? ''"
                            class="h-7 min-w-0 flex-1 text-xs"
                            placeholder="固定提交信息"
                            @update:model-value="(v: string | number) => (s.message = String(v))"
                          />
                          <span v-else class="min-w-0 flex-1 text-[11px] text-muted-foreground">执行时由 AI 读取暂存区 diff 生成</span>
                        </template>
                        <Input
                          v-else-if="s.kind === 'createBranch'"
                          :model-value="s.prefix ?? ''"
                          class="h-7 min-w-0 flex-1 text-xs"
                          placeholder="前缀（可选，如 feat/）；分支名执行时填写"
                          @update:model-value="(v: string | number) => (s.prefix = String(v) || undefined)"
                        />
                        <span
                          v-else
                          class="min-w-0 flex-1 text-[11px] text-muted-foreground"
                        >{{ s.kind === "pull" ? "拉取并合并远程更新" : s.kind === "push" ? "推送当前分支（无上游自动 -u）" : "回到执行开始时所在的分支" }}</span>
                      </div>
                      <div class="ml-auto flex shrink-0 items-center gap-0.5">
                        <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="si === 0" aria-label="上移" @click="moveStep(w, si, -1)">
                          <ChevronUp class="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="si === w.steps.length - 1" aria-label="下移" @click="moveStep(w, si, 1)">
                          <ChevronDown class="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="h-7 w-7 text-muted-foreground hover:text-destructive"
                          aria-label="删除步骤"
                          @click="w.steps.splice(si, 1)"
                        >
                          <X class="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div
                    v-if="!w.steps.length"
                    class="mb-2 rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground"
                  >
                    还没有步骤，从下面添加第一步。
                  </div>
                  <!-- 添加步骤 -->
                  <div class="rounded-md border border-dashed border-border px-2.5 py-2.5">
                    <div class="mb-2 text-[11px] text-muted-foreground">添加步骤</div>
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Select v-model="newStepKind" class="h-8 w-36 shrink-0 text-xs" :options="STEP_KIND_OPTIONS" />
                      <template v-if="newStepKind === 'checkout' || newStepKind === 'merge'">
                        <Select v-model="newStepMode" class="h-8 w-28 shrink-0 text-xs" :options="REF_MODE_OPTIONS" />
                        <Input
                          v-if="newStepMode === 'fixed'"
                          v-model="newStepName"
                          class="h-8 min-w-0 flex-1 text-xs"
                          placeholder="分支名"
                        />
                      </template>
                      <template v-else-if="newStepKind === 'commitPush'">
                        <Select v-model="newStepMsgSource" class="h-8 w-28 shrink-0 text-xs" :options="MSG_SOURCE_OPTIONS" />
                        <Input
                          v-if="newStepMsgSource === 'fixed'"
                          v-model="newStepMessage"
                          class="h-8 min-w-0 flex-1 text-xs"
                          placeholder="固定提交信息"
                        />
                      </template>
                      <Input
                        v-else-if="newStepKind === 'createBranch'"
                        v-model="newStepPrefix"
                        class="h-8 min-w-0 flex-1 text-xs"
                        placeholder="前缀（可选，如 feat/）"
                      />
                      <Button variant="default" size="sm" class="ml-auto h-8 shrink-0" @click="addStep(w)">
                        <Plus class="size-3.5" /> 添加
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </template>

          <!-- 远程 -->
          <template v-else-if="tab === 'remote'">
            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">远程仓库路径</h3>
              <Input v-model="remoteLink" :placeholder="originUrl || '未配置 origin 远程'" />
              <p class="mt-2 text-[11px] text-muted-foreground">
                默认填充 origin URL（{{ originUrl || "未配置" }}），可改为任意网页链接；
                主页状态栏「远程」按钮会打开它。清空保存则恢复自动推断。
              </p>
            </section>
          </template>

          <!-- 快捷键 -->
          <template v-else>
            <section>
              <h3 class="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">快捷键列表</h3>
              <div class="divide-y divide-border rounded-md border border-border">
                <div
                  v-for="[keys, desc] in SHORTCUTS"
                  :key="keys"
                  class="flex items-center justify-between gap-4 px-3 py-2"
                >
                  <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{{ keys }}</span>
                  <span class="text-right text-xs text-muted-foreground">{{ desc }}</span>
                </div>
              </div>
            </section>
          </template>
        </div>

        <!-- 底部操作条 -->
        <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <span v-if="verifyErr" class="mr-auto text-[11px] text-destructive">{{ verifyErr }}</span>
          <Button variant="ghost" size="sm" :disabled="verifying" @click="emit('close')">取消</Button>
          <Button variant="default" size="sm" :disabled="verifying" @click="save">
            <Spinner v-if="verifying" :size="14" />
            {{ verifying ? "验通中…" : "保存" }}
          </Button>
        </footer>
      </div>
    </div>
  </div>
</template>
