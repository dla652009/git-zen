<script lang="ts">
/** 一屏总览用的行数据：由 App 用 Promise.all(status) 拉好后传入 */
export interface RepoOverviewRow {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  /** 变更文件数 */
  dirty: number;
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Play, Workflow as WorkflowIcon } from "@lucide/vue";
import { Button, ContextMenu, Spinner } from "@/components/ui";
import type { MenuItem } from "@/components/ui";

// 全部已打开仓库的状态总览：多仓库时要一屏看完谁落后、谁有未提交改动，
// 并支持一次性拉取。数据与拉取动作留在 App。
const open = defineModel<boolean>("open", { required: true });

const props = defineProps<{
  rows: RepoOverviewRow[];
  loading: boolean;
  /** 工作流名字列表：勾选仓库后从这里挑一个跑 */
  workflows: string[];
}>();

const emit = defineEmits<{
  openRepo: [path: string];
  pullAll: [];
  refresh: [];
  runWorkflow: [name: string, paths: string[]];
  manageWorkflows: [];
}>();

const stats = computed(() => {
  const dirty = props.rows.filter((r) => r.dirty > 0).length;
  const behind = props.rows.filter((r) => r.behind > 0).length;
  return { total: props.rows.length, dirty, behind };
});

// 勾选：默认全不选，显式勾了才批量执行 —— 免得打开就看不出「这条会动别人仓库」
// 存 path 而不是下标：行会随刷新重排
const picked = ref<string[]>([]);
watch(
  () => open.value,
  (v) => {
    if (v) picked.value = [];
  },
);
// 仓库被关掉后它的 path 不该再留在勾选里
watch(
  () => props.rows.map((r) => r.path).join("|"),
  () => {
    const live = new Set(props.rows.map((r) => r.path));
    picked.value = picked.value.filter((p) => live.has(p));
  },
);
function toggle(path: string) {
  picked.value = picked.value.includes(path)
    ? picked.value.filter((p) => p !== path)
    : [...picked.value, path];
}
const allPicked = computed(
  () => props.rows.length > 0 && picked.value.length === props.rows.length,
);
function toggleAll() {
  picked.value = allPicked.value ? [] : props.rows.map((r) => r.path);
}

const menuPos = ref<{ x: number; y: number } | null>(null);
function openMenu(ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = { x: r.right - 220, y: r.bottom + 4 };
}
const menuItems = computed<MenuItem[]>(() => [
  ...props.workflows.map((name) => ({
    label: name,
    fn: () => emit("runWorkflow", name, [...picked.value]),
  })),
  ...(props.workflows.length ? [{ label: "", separator: true }] : []),
  { label: "管理工作流…", fn: () => emit("manageWorkflows") },
]);
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-repos-title"
    @click.self="open = false"
  >
    <div class="w-dlg-xl surface rounded-lg p-5 pop-in">
      <div class="flex items-center gap-2">
        <div id="dlg-repos-title" class="text-base font-semibold">所有仓库</div>
        <span class="flex-1" />
        <Button variant="ghost" size="sm" :disabled="loading" @click="emit('refresh')">
          刷新
        </Button>
        <Button
          variant="secondary"
          size="sm"
          :disabled="loading || !rows.length || !stats.behind"
          @click="emit('pullAll')"
        >
          全部拉取
        </Button>
        <Button
          variant="secondary"
          size="sm"
          :disabled="loading || !picked.length"
          :title="picked.length ? `对已勾选的 ${picked.length} 个仓库执行` : '先勾选仓库'"
          @click="openMenu"
        >
          <WorkflowIcon class="size-3.5" />
          运行工作流
          <span v-if="picked.length" class="text-xs text-muted-foreground">{{ picked.length }}</span>
          <Play class="size-3 rotate-90" />
        </Button>
      </div>

      <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <label class="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            class="size-3.5 accent-[var(--primary)]"
            :checked="allPicked"
            :indeterminate.prop="picked.length > 0 && !allPicked"
            @change="toggleAll"
          >
          全选
        </label>
        <span>
          共 {{ stats.total }} 个仓库 · {{ stats.dirty }} 个有未提交改动 ·
          {{ stats.behind }} 个落后远端
        </span>
      </div>

      <div class="mt-3 max-h-80 min-h-24 overflow-auto rounded-md border border-border-soft bg-background/40 p-1">
        <div v-if="loading" class="grid h-24 place-items-center">
          <Spinner label="同步中…" />
        </div>
        <div
          v-else-if="!rows.length"
          class="grid h-24 place-items-center text-xs text-muted-foreground"
        >
          还没有打开任何仓库
        </div>
        <template v-else>
          <div
            v-for="r in rows"
            :key="r.path"
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors duration-fast hover:bg-hover"
          >
            <input
              :id="`repo-pick-${r.path}`"
              type="checkbox"
              class="size-3.5 shrink-0 cursor-pointer accent-[var(--primary)]"
              :checked="picked.includes(r.path)"
              :aria-label="`选择 ${r.name}`"
              @change="toggle(r.path)"
            >
            <button
              type="button"
              class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
              :title="r.path"
              @click="emit('openRepo', r.path)"
            >
              <span class="w-36 shrink-0 truncate font-medium">{{ r.name }}</span>
              <code class="w-32 shrink-0 truncate font-mono text-muted-foreground">{{ r.branch || "—" }}</code>
              <span class="flex w-24 shrink-0 items-center gap-1.5 font-mono text-[var(--c-conf)]">
                <span v-if="r.ahead">↑{{ r.ahead }}</span>
                <span v-if="r.behind">↓{{ r.behind }}</span>
              </span>
              <span
                class="min-w-0 flex-1 truncate text-right"
                :class="r.dirty ? '' : 'text-muted-foreground'"
              >
                {{ r.dirty ? `${r.dirty} 个变更` : "干净" }}
              </span>
            </button>
          </div>
        </template>
      </div>

      <div class="mt-5 flex justify-end">
        <Button variant="ghost" size="sm" @click="open = false">关闭</Button>
      </div>
    </div>
    <ContextMenu
      v-if="menuPos"
      :x="menuPos.x"
      :y="menuPos.y"
      :items="menuItems"
      @close="menuPos = null"
    />
  </div>
</template>
