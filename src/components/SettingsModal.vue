<script setup lang="ts">
import { computed, reactive, ref, onMounted } from "vue";
import { X, Palette, UserCog, Keyboard, User, Bot, Plus } from "@lucide/vue";
import { THEMES, settings, type Settings } from "../settings";
import * as api from "../gitApi";
import { aiVerify } from "../ai";
import { Button, Input, Spinner, Select, Switch } from "@/components/ui";

const props = defineProps<{ repo: string; initialTab?: string }>();
const emit = defineEmits<{ close: [] }>();

// 草稿编辑，保存才写回（写回后 watcher 自动持久化+生效）
const draft = reactive<Settings>({ ...settings });
const tab = ref<"user" | "ai" | "appearance" | "personal" | "shortcuts">(
  (props.initialTab as "user" | "ai" | "appearance" | "personal" | "shortcuts") || "user"
);

// AI 配置验通
const verifying = ref(false);
const verifyErr = ref("");

// 用户信息是仓库级 git config，不属于应用设置，单独存取
const userName = ref("");
const userEmail = ref("");
onMounted(async () => {
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
  emit("close");
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
window.addEventListener("keydown", onKey);

// 目前为固定快捷键，仅展示；后续可做成可配置
const SHORTCUTS: [string, string][] = [
  ["Ctrl + Tab / Ctrl + Shift + Tab", "下一个 / 上一个仓库选项卡"],
  ["Ctrl + 1..9", "跳到第 N 个仓库选项卡"],
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
  { id: "shortcuts", label: "快捷键", icon: Keyboard },
] as const;
</script>

<template>
  <div class="fixed inset-0 z-30 flex items-center justify-center bg-black/50" @click.self="emit('close')">
    <div class="flex h-[440px] w-[640px] overflow-hidden rounded-lg border border-border bg-card shadow-xl">
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
