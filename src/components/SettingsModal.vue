<script setup lang="ts">
import { computed, reactive, ref, nextTick, onMounted, watch, type Component } from "vue";
import {
  X, Palette, UserCog, Keyboard, User, Bot, Plus, Globe, Workflow as WorkflowIcon, ChevronDown,
  GripVertical, Pin, Pencil, Trash2, TriangleAlert, Copy,
  GitBranch, GitBranchPlus, GitMerge, ArrowDownToLine, ArrowUpFromLine, Undo2, Upload,
} from "@lucide/vue";
import { VueDraggable } from "vue-draggable-plus";
import {
  THEMES,
  settings,
  clampFontSize,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  type Settings,
} from "../settings";
import * as api from "../gitApi";
import { aiVerify, isAbortError } from "../ai";
import { readJsonObject } from "../lib/safeJson";
import { humanizeMsg } from "../lib/errors";
import { workflows } from "../workflowStore";
import { newFlowId, type BranchRef, type Workflow, type WorkflowStep } from "../workflow";
import { Button, Input, Spinner, Select, Switch, Tooltip } from "@/components/ui";
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
    readJsonObject<Record<string, string>>("gz.remoteLinks", {})[props.repo] ?? "";
  // 默认填充 origin URL；用户改过则显示自定义值
  remoteLink.value = custom || originUrl.value;
  if (!props.repo) return;
  try {
    const [n, e] = await api.getUser(props.repo);
    userName.value = n;
    userEmail.value = e;
  } catch (e) {
    // 后端已用 `config --default ""` 把「没配过」与真失败分开，走到这里说明仓库真的读不了；
    // 不再完全静默——留一条日志，输入框保持空的 placeholder 提示用户去配
    userName.value = "";
    userEmail.value = "";
    console.warn("[git-zen] 读取提交者信息失败:", e);
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
      verifying.value = false;
      // 关设置页会 abortAi()：那是用户自己的动作，不算「验通失败」，别报红字
      if (isAbortError(e)) return;
      verifyErr.value = humanizeMsg(e);
      return;
    }
    verifying.value = false;
  }
  Object.assign(settings, draft);
  if (props.repo && (userName.value.trim() || userEmail.value.trim())) {
    api.configUser(props.repo, userName.value.trim(), userEmail.value.trim()).catch(() => {});
  }
  // 仓库链接写回 per-repo map
  const links = readJsonObject<Record<string, string>>("gz.remoteLinks", {});
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
// 删除工作流：改用真确认框。原来的两段式按钮（点一次变「确认删除？」再点一次）
// 既容易被误点，也没说清删的是哪个工作流。
const delFlow = ref<Workflow | null>(null);
const delCancelBtn = ref<{ $el: HTMLButtonElement } | null>(null);
function openDeleteFlow(w: Workflow) {
  delFlow.value = w;
  // 危险操作的安全默认：焦点落「取消」
  nextTick(() => delCancelBtn.value?.$el.focus());
}
function confirmDeleteFlow() {
  const w = delFlow.value;
  delFlow.value = null;
  if (!w) return;
  workflows.splice(workflows.indexOf(w), 1);
  if (wfExpanded.value === w.id) wfExpanded.value = "";
}
function addFlow() {
  const wf: Workflow = { id: newFlowId(), name: `工作流 ${workflows.length + 1}`, steps: [] };
  workflows.push(wf);
  wfExpanded.value = wf.id;
}
// 复制：深拷贝后插在原工作流后面。步骤是嵌套结构，浅拷贝会让两份共用同一个 steps
// 数组（改一个另一个跟着变），所以走 JSON 往返 —— 工作流数据是纯 JSON，没有函数/Date。
function copyFlow(w: Workflow) {
  const i = workflows.indexOf(w);
  if (i < 0) return;
  const copy: Workflow = JSON.parse(JSON.stringify(w));
  copy.id = newFlowId();
  copy.name = `${w.name} 副本`;
  copy.pinned = false; // 钉住名额只有 3 个，副本不该悄悄占掉一个
  workflows.splice(i + 1, 0, copy);
  wfExpanded.value = copy.id;
}
// 复制步骤：同样深拷贝后插在下一步，省去重新配一遍参数
function copyStep(w: Workflow, i: number) {
  const s = w.steps[i];
  if (!s) return;
  w.steps.splice(i + 1, 0, JSON.parse(JSON.stringify(s)) as WorkflowStep);
}
function renameFlow(w: Workflow) {
  wfRename.value = { id: w.id, draft: w.name };
  // 打开即选中原名，改名不用先手动清空
  nextTick(() => wfRenameInput.value?.$el.select());
}
const wfRename = ref<{ id: string; draft: string } | null>(null);
const wfRenameInput = ref<{ $el: HTMLInputElement } | null>(null);
// 输入法组词中的 Enter 是确认候选词，不该顺手提交半成品名称
function onRenameEnter(e: KeyboardEvent) {
  if (e.isComposing) return;
  confirmFlowRename();
}
function confirmFlowRename() {
  const r = wfRename.value;
  const name = r?.draft.trim();
  wfRename.value = null;
  if (!r || !name) return;
  const wf = workflows.find((x) => x.id === r.id);
  if (wf) wf.name = name;
}
// workflows 是 store 里的 reactive 数组，不能整体赋值（会切断 App.vue 持有的引用），
// 拖拽的 v-model 赋值转成原地 splice
const flowList = computed<Workflow[]>({
  get: () => workflows,
  set: (v) => workflows.splice(0, workflows.length, ...v),
});

// 钉住：工具栏只渲染前 3 个，超出的按钮置灰（见 App.vue 的 pinnedFlows）
const PIN_LIMIT = 3;
const pinnedCount = computed(() => workflows.filter((w) => w.pinned).length);
function togglePin(w: Workflow) {
  if (w.pinned) w.pinned = false;
  else if (pinnedCount.value < PIN_LIMIT) w.pinned = true;
}
function pinHint(w: Workflow): string {
  if (w.pinned) return "取消钉住";
  return pinnedCount.value >= PIN_LIMIT ? `最多钉 ${PIN_LIMIT} 个` : "钉到工具栏";
}

// 步骤类型图标：流程骨架一眼可辨，不必读文字
const STEP_ICONS: Record<WorkflowStep["kind"], Component> = {
  checkout: GitBranch,
  pull: ArrowDownToLine,
  push: ArrowUpFromLine,
  merge: GitMerge,
  createBranch: GitBranchPlus,
  switchBack: Undo2,
  commitPush: Upload,
};
// 会动到工作区或可能中途卡住的步骤，执行前先给个交代
const DANGER_HINTS: Partial<Record<WorkflowStep["kind"], string>> = {
  merge: "合并可能产生冲突，冲突时流程会停在这一步",
  commitPush: "有改动时会 git add -A 把工作区全部改动（含未跟踪文件）一起提交",
};

// 拖拽之外的键盘路径：Alt+↑/↓（拖拽对纯键盘用户不可达）
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
const newStepLabel = ref("");
const addStepErr = ref("");
// 静默失败会让人以为按钮坏了：说清缺哪一项
function missingHint(): string {
  const k = newStepKind.value;
  if ((k === "checkout" || k === "merge") && newStepMode.value === "fixed")
    return "请先填分支名，或把模式改成「起始分支」/「运行时输入」";
  if (k === "commitPush" && newStepMsgSource.value === "fixed")
    return "请先填固定提交信息，或把信息来源改成「AI 生成」";
  return "当前配置不完整，请检查后再添加";
}
function addStep(w: Workflow) {
  const s = buildDraftStep();
  if (!s) {
    addStepErr.value = missingHint();
    return;
  }
  addStepErr.value = "";
  w.steps.push(s);
}
// 开始补配置就把提示收起来
watch(
  [newStepKind, newStepMode, newStepName, newStepMsgSource, newStepMessage, newStepLabel],
  () => (addStepErr.value = ""),
);
function buildDraftStep(): WorkflowStep | null {
  switch (newStepKind.value) {
    case "checkout":
    case "merge":
      if (newStepMode.value === "fixed" && !newStepName.value.trim()) return null;
      return {
        kind: newStepKind.value,
        ref: {
          mode: newStepMode.value,
          name: newStepName.value.trim(),
          // label 只对「运行时输入」有意义（describeStep / flowInputSlots 会用它）
          label: newStepMode.value === "ask" ? newStepLabel.value.trim() || undefined : undefined,
        },
      };
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
// 输入法组词中的 Enter 是确认候选词，不该顺手把半成品前缀加进去
function onPrefixEnter(e: KeyboardEvent) {
  if (e.isComposing) return;
  e.preventDefault();
  addPrefix();
}
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
  <div
    v-trap
    class="fixed inset-0 z-30 flex items-center justify-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-settings-title"
    @click.self="emit('close')"
  >
    <!-- 880x520：热力图满幅 + 各页留白；窗口过小时回退 95vw/95vh（热力图横向滚动，内容区滚动） -->
    <div class="pop-in surface flex h-[520px] max-h-[95vh] w-[880px] max-w-[95vw] overflow-hidden rounded-lg">
      <!-- 左侧导航 -->
      <nav class="w-36 shrink-0 space-y-0.5 border-r border-border bg-muted/30 p-2">
        <button
          v-for="item in NAV"
          :key="item.id"
          :class="[
            'flex w-full cursor-pointer items-center gap-2 rounded-sm px-3 py-1.5 text-left text-base transition-colors duration-fast',
            tab === item.id ? 'bg-primary-soft font-medium text-primary' : 'text-muted-foreground hover:bg-hover',
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
          <span id="dlg-settings-title" class="font-medium">设置</span>
          <span class="flex-1" />
          <Button variant="ghost" size="icon" @click="emit('close')"><X class="size-4" /></Button>
        </header>

        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <!-- 用户信息（仓库级） -->
          <template v-if="tab === 'user'">
            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">提交者信息</h3>
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
              <p class="mt-2 text-xs text-muted-foreground">
                保存到当前仓库的 git config（{{ props.repo || "未选择仓库" }}）
              </p>
            </section>

            <!-- 提交热力图（只统计上方邮箱名下的提交） -->
            <section v-if="props.repo">
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">提交热力图</h3>
              <CommitHeatmap :repo="props.repo" :author-email="userEmail" />
            </section>
          </template>

          <!-- AI -->
          <template v-else-if="tab === 'ai'">
            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">AI 服务（OpenAI 兼容协议）</h3>
              <div class="mb-4 flex items-center justify-between rounded-md border border-border bg-muted/25 px-3 py-2">
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
              <p class="mt-2 text-xs text-muted-foreground">
                兼容 OpenAI/DeepSeek/Kimi 等任意兼容服务；本地 Ollama 填
                http://localhost:11434/v1 且 Key 留空。Key 存本机 localStorage，不会上传。
              </p>
            </section>
          </template>

          <!-- 外观 -->
          <template v-else-if="tab === 'appearance'">
            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">主题</h3>
              <div class="grid grid-cols-4 gap-1.5">
                <button
                  v-for="t in THEMES"
                  :key="t.id"
                  :class="[
                    'cursor-pointer rounded-md border px-2 py-1.5 text-xs transition-colors duration-fast',
                    draft.theme === t.id
                      ? 'border-primary/60 bg-primary-soft text-primary'
                      : 'border-border hover:bg-hover',
                  ]"
                  @click="draft.theme = t.id"
                >
                  {{ t.label }}
                </button>
              </div>
            </section>

            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">字体</h3>
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
                  <!-- 数字框而不是滑杆：滑杆滑不出精确值，也没法一眼看出当前是几号。
                       夹取放在 change（失焦/回车）而不是 input —— 边打字边夹会把
                       「1」→ 14、「16」打成「146」→ 17，根本没法输。 -->
                  <Input
                    v-model.number="draft.fontSize"
                    type="number"
                    :min="FONT_SIZE_MIN"
                    :max="FONT_SIZE_MAX"
                    step="1"
                    class="h-7 w-16 text-sm"
                    @change="draft.fontSize = clampFontSize(draft.fontSize)"
                  />
                  <span class="text-xs text-muted-foreground"
                    >px（{{ FONT_SIZE_MIN }}–{{ FONT_SIZE_MAX }}）</span
                  >
                </div>
              </div>
            </section>
          </template>

          <!-- 个性化 -->
          <template v-else-if="tab === 'personal'">
            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">分支前缀（可多个）</h3>
              <!-- tag 式编辑：回车/逗号添加，点 × 删除；存储仍是逗号分隔字符串，创建弹窗下拉自动同步 -->
              <div class="flex min-h-[32px] flex-wrap items-center gap-1.5 rounded-md border border-border bg-input-bg px-2 py-1.5">
                <span
                  v-for="p in prefixList"
                  :key="p"
                  class="flex items-center gap-1 rounded-xs bg-primary-soft px-1.5 py-0.5 font-mono text-xs text-primary"
                >
                  {{ p }}
                  <X class="size-3 cursor-pointer hover:text-destructive" @click="removePrefix(p)" />
                </span>
                <input
                  v-model="prefixInput"
                  placeholder="输入前缀后回车，如 feat/"
                  class="min-w-[140px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  @keydown.enter="onPrefixEnter"
                  @keydown.,.prevent="addPrefix"
                  @blur="addPrefix"
                />
              </div>
              <p class="mt-2 text-xs text-muted-foreground">
                新建分支弹窗的前缀下拉会同步这里；名字已含前缀时不重复加。
              </p>
            </section>

            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">性能</h3>
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
              <p class="mt-2 text-xs text-muted-foreground">
                最近打开的仓库切换时直接恢复快照秒开；开了很多仓库时调大更顺。只存内存不落盘，调大对内存影响很小。
              </p>
            </section>

          </template>

          <!-- 工作流 -->
          <template v-else-if="tab === 'workflow'">
            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">什么是工作流</h3>
              <p class="mb-4 text-xs leading-relaxed text-muted-foreground">
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
              <VueDraggable
                v-model="flowList"
                :animation="150"
                :force-fallback="true"
                fallback-class="opacity-70"
                handle=".flow-handle"
                tag="div"
              >
                <div v-for="w in workflows" :key="w.id" class="mb-3 rounded-md border border-border">
                  <div class="flex items-center gap-2 px-3 py-2">
                    <GripVertical
                      class="flow-handle size-3.5 shrink-0 cursor-grab text-muted-foreground"
                      @click.stop
                    />
                    <button
                      class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-base"
                      @click="wfExpanded = wfExpanded === w.id ? '' : w.id"
                    >
                      <ChevronDown
                        class="size-3 shrink-0 text-muted-foreground transition-transform duration-fast"
                        :class="wfExpanded !== w.id && '-rotate-90'"
                      />
                      <WorkflowIcon class="size-3.5 shrink-0 text-primary" />
                      <span class="truncate font-medium">{{ w.name }}</span>
                      <span class="shrink-0 text-xs text-muted-foreground">{{ w.steps.length }} 步</span>
                    </button>
                    <Tooltip :text="pinHint(w)">
                      <Button
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7"
                        :class="w.pinned ? 'text-primary' : 'text-muted-foreground'"
                        :disabled="!w.pinned && pinnedCount >= PIN_LIMIT"
                        :aria-pressed="!!w.pinned"
                        :aria-label="`${w.pinned ? '取消钉住' : '钉住'} ${w.name}`"
                        @click="togglePin(w)"
                      >
                        <Pin class="size-3.5" :fill="w.pinned ? 'currentColor' : 'none'" />
                      </Button>
                    </Tooltip>
                    <Tooltip text="复制">
                      <Button
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 text-muted-foreground hover:text-primary"
                        :aria-label="`复制 ${w.name}`"
                        @click="copyFlow(w)"
                      >
                        <Copy class="size-3.5" />
                      </Button>
                    </Tooltip>
                    <Tooltip text="重命名">
                      <Button
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 text-muted-foreground hover:text-primary"
                        :aria-label="`重命名 ${w.name}`"
                        @click="renameFlow(w)"
                      >
                        <Pencil class="size-3.5" />
                      </Button>
                    </Tooltip>
                    <Tooltip text="删除">
                      <Button
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 text-muted-foreground hover:text-destructive"
                        :aria-label="`删除 ${w.name}`"
                        @click="openDeleteFlow(w)"
                      >
                        <Trash2 class="size-3.5" />
                      </Button>
                    </Tooltip>
                  </div>
                <div v-if="wfExpanded === w.id" class="border-t border-border/60 px-3 py-2.5">
                  <!-- 步骤卡：拖拽排序（键盘走 Alt+↑/↓）+ 类型图标 + 参数行内编辑 -->
                  <VueDraggable
                    v-model="w.steps"
                    :animation="150"
                    :force-fallback="true"
                    fallback-class="opacity-70"
                    handle=".step-handle"
                    tag="div"
                  >
                    <div
                      v-for="(s, si) in w.steps"
                      :key="si"
                      tabindex="0"
                      role="group"
                      :aria-label="`第 ${si + 1} 步：${KIND_LABELS[s.kind]}，Alt+↑/↓ 可调整顺序`"
                      class="mb-1.5 rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 outline-none focus-visible:border-primary/60"
                      @keydown.alt.up.prevent="moveStep(w, si, -1)"
                      @keydown.alt.down.prevent="moveStep(w, si, 1)"
                    >
                      <div class="flex items-center gap-2">
                        <GripVertical
                          class="step-handle size-3.5 shrink-0 cursor-grab text-muted-foreground"
                          @click.stop
                        />
                        <span
                          class="grid size-5 shrink-0 place-items-center rounded-xs bg-primary-soft text-2xs font-medium text-primary"
                        >{{ si + 1 }}</span>
                        <component :is="STEP_ICONS[s.kind]" class="size-3.5 shrink-0 text-muted-foreground" />
                        <span class="w-16 shrink-0 text-xs font-medium">{{ KIND_LABELS[s.kind] }}</span>
                        <Tooltip v-if="DANGER_HINTS[s.kind]" :text="DANGER_HINTS[s.kind]!">
                          <TriangleAlert class="size-3.5 shrink-0 text-[var(--c-mod)]" />
                        </Tooltip>
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
                            <Input
                              v-else-if="refOf(s)!.mode === 'ask'"
                              :model-value="refOf(s)!.label ?? ''"
                              class="h-7 min-w-0 flex-1 text-xs"
                              placeholder="提示文字（可选，如「发布分支」）"
                              @update:model-value="(v: string | number) => { const r = refOf(s); if (r) r.label = String(v) || undefined; }"
                            />
                            <span v-else class="min-w-0 flex-1 text-xs text-muted-foreground">
                              使用执行开始时的当前分支
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
                            <span v-else class="min-w-0 flex-1 text-xs text-muted-foreground">执行时由 AI 读取暂存区 diff 生成</span>
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
                            class="min-w-0 flex-1 text-xs text-muted-foreground"
                          >{{ s.kind === "pull" ? "拉取并合并远程更新" : s.kind === "push" ? "推送当前分支（无上游自动 -u）" : "回到执行开始时所在的分支" }}</span>
                        </div>
                        <Tooltip text="复制步骤">
                          <Button
                            variant="ghost"
                            size="icon"
                            class="ml-auto h-7 w-7 text-muted-foreground hover:text-primary"
                            aria-label="复制步骤"
                            @click="copyStep(w, si)"
                          >
                            <Copy class="size-3.5" />
                          </Button>
                        </Tooltip>
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
                  </VueDraggable>
                  <div
                    v-if="!w.steps.length"
                    class="mb-2 rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground"
                  >
                    还没有步骤，从下面添加第一步。
                  </div>
                  <!-- 添加步骤 -->
                  <div class="rounded-md border border-dashed border-border px-2.5 py-2.5">
                    <div class="mb-2 text-xs text-muted-foreground">添加步骤</div>
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
                        <Input
                          v-else-if="newStepMode === 'ask'"
                          v-model="newStepLabel"
                          class="h-8 min-w-0 flex-1 text-xs"
                          placeholder="提示文字（可选，如「发布分支」）"
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
                    <p v-if="addStepErr" class="mt-1.5 text-xs text-destructive">{{ addStepErr }}</p>
                  </div>
                </div>
              </div>
              </VueDraggable>
            </section>
          </template>

          <!-- 远程 -->
          <template v-else-if="tab === 'remote'">
            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">远程仓库路径</h3>
              <Input v-model="remoteLink" :placeholder="originUrl || '未配置 origin 远程'" />
              <p class="mt-2 text-xs text-muted-foreground">
                默认填充 origin URL（{{ originUrl || "未配置" }}），可改为任意网页链接；
                主页状态栏「远程」按钮会打开它。清空保存则恢复自动推断。
              </p>
            </section>
          </template>

          <!-- 快捷键 -->
          <template v-else>
            <section>
              <h3 class="mb-2 text-xs tracking-wide text-muted-foreground">快捷键列表</h3>
              <div class="divide-y divide-border rounded-md border border-border">
                <div
                  v-for="[keys, desc] in SHORTCUTS"
                  :key="keys"
                  class="flex items-center justify-between gap-4 px-3 py-2"
                >
                  <span class="shrink-0 rounded-xs bg-muted px-1.5 py-0.5 font-mono text-xs">{{ keys }}</span>
                  <span class="text-right text-xs text-muted-foreground">{{ desc }}</span>
                </div>
              </div>
            </section>
          </template>
        </div>

        <!-- 底部操作条 -->
        <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <span v-if="verifyErr" class="mr-auto text-xs text-destructive">{{ verifyErr }}</span>
          <Button variant="ghost" size="sm" :disabled="verifying" @click="emit('close')">取消</Button>
          <Button variant="default" size="sm" :disabled="verifying" @click="save">
            <Spinner v-if="verifying" :size="14" />
            {{ verifying ? "验通中…" : "保存" }}
          </Button>
        </footer>
      </div>
    </div>

    <!-- 删除工作流确认：组件内独立浮层，风格对齐 App.vue 的危险操作确认框。
         不进 overlays 的 overlayOrder —— 那张表是 App.vue 顶层浮层的，登记它得同步改 App.vue；
         Esc 因此由自己捕获（同 ContextMenu 的做法）。 -->
    <div
      v-if="delFlow"
      v-trap
      class="fixed inset-0 z-50 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-wf-del-title"
      @click.self="delFlow = null"
      @keydown.esc.stop="delFlow = null"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-wf-del-title" class="mb-1.5 font-medium">删除工作流</div>
        <div>确定删除「{{ delFlow.name }}」？删除后不可恢复。</div>
        <div class="mt-3 flex justify-end gap-2">
          <Button ref="delCancelBtn" variant="ghost" size="sm" @click="delFlow = null">取消</Button>
          <Button variant="destructive" size="sm" @click="confirmDeleteFlow">确认删除</Button>
        </div>
      </div>
    </div>

    <!-- 重命名工作流：pencil 按钮此前只写 wfRename、模板里没有对应 UI（点了没反应），这里补上输入框。
         同样不进 overlayOrder，Esc 自己捕获（同上面的删除确认框）。 -->
    <div
      v-if="wfRename"
      v-trap
      class="fixed inset-0 z-50 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-wf-rename-title"
      @click.self="wfRename = null"
      @keydown.esc.stop="wfRename = null"
    >
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-wf-rename-title" class="mb-2 font-medium">重命名工作流</div>
        <Input
          ref="wfRenameInput"
          v-model="wfRename.draft"
          placeholder="工作流名称"
          @keydown.enter="onRenameEnter"
        />
        <div class="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="wfRename = null">取消</Button>
          <Button variant="default" size="sm" :disabled="!wfRename.draft.trim()" @click="confirmFlowRename">保存</Button>
        </div>
      </div>
    </div>
  </div>
</template>
