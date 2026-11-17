<script setup lang="ts">
// 分组管理弹窗（双栏）：左侧分组列表（新建/重命名/删除/拖排序），
// 右侧当前分组的成员编辑（移出 + 勾选批量加入）。
//
// 为什么是「按分组看成员」而不是「按仓库看分组」：一个仓库只属一个分组，
// 双栏让「往这个分组里塞人」变成一次勾选 + 一次提交，比逐个仓库改归属快得多；
// 左栏顺带承担分组的 CRUD 与排序，与标签栏的视觉顺序一一对应。
//
// CRUD、拖拽机、持久化全留在 App.vue：这里只负责渲染与弹窗内的一次性 UI 状态。
import { computed, ref, watch } from "vue";
import {
  Eye,
  EyeOff,
  Folder,
  FolderClosed,
  FolderPlus,
  GripVertical,
  Pencil,
  Plus,
  Search,
  X,
} from "@lucide/vue";
import { VueDraggable } from "vue-draggable-plus";
import { Button, Input } from "@/components/ui";

// 字段与 App.vue 的 RepoTab 保持一致，不为它反向依赖 App
interface GroupRepo {
  path: string;
  name: string;
  group?: string;
}

const props = defineProps<{
  repos: GroupRepo[];
  currentRepo: string;
  /** 拖拽成员时高亮哪个分组（App 的 itemDrag 状态，纯读） */
  highlighted: (group: string) => boolean;
  /** 从某个分组的入口进来时直接选中它；空 = 默认选第一个 */
  initialGroup?: string;
  /**
   * 已隐藏的分组名。隐藏只影响标签栏是否显示那个文件夹 ——
   * 分组本身、组内仓库、在总览/下拉里的可见性都不变。
   */
  hidden: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  close: [];
  create: [];
  rename: [group: string];
  delete: [group: string];
  "add-member": [group: string, path: string];
  "remove-member": [path: string];
  /** 批量归组：一次提交，App 侧只弹一条 toast */
  "add-members": [group: string, paths: string[]];
  "drag-member": [e: MouseEvent, path: string, name: string];
  "groups-change": [list: string[]];
  /** 隐藏 / 恢复某个分组在标签栏的显示 */
  "toggle-hidden": [group: string];
}>();

// 分组顺序是 App 的持久化状态（gz.groups + 标签栏顺序），这里只做 v-model 桥接
const groups = defineModel<string[]>("groupList", { required: true });

// 弹窗内一次性 UI 状态：关闭即销毁重置（使用处 v-if 控制）
const expanded = ref("");
const search = ref("");
const picked = ref<Set<string>>(new Set());

// 默认选中：从分组入口进来就选它，否则选第一个 —— 进来就是空白右栏
// 等于让用户先做一次无意义的点击。
watch(
  () => groups.value,
  (list) => {
    if (list.includes(expanded.value)) return;
    const want = props.initialGroup;
    expanded.value = want && list.includes(want) ? want : (list[0] ?? "");
  },
  { immediate: true },
);
// 换分组就清空勾选：勾了 A 组的候选、切到 B 组还留着，提交时会归错组
watch(expanded, () => {
  picked.value = new Set();
  search.value = "";
});

const memberCount = (g: string) => props.repos.filter((r) => r.group === g).length;
const groupActive = (g: string) => props.repos.some((r) => r.group === g && r.path === props.currentRepo);
const ungrouped = computed(() => props.repos.filter((r) => !r.group).length);

const members = computed(() =>
  props.repos.filter((r) => r.group === expanded.value),
);

const matchSearch = (r: GroupRepo): boolean => {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  return r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q);
};

/** 可加入：不在当前分组 + 命中搜索 */
const candidates = computed(() =>
  props.repos.filter((r) => r.group !== expanded.value && matchSearch(r)),
);
/** 已加入：命中搜索 */
const membersShown = computed(() => members.value.filter(matchSearch));

const allPicked = computed(
  () => candidates.value.length > 0 && candidates.value.every((r) => picked.value.has(r.path)),
);
/** 选中的里有几个会被从别的分组抢过来（按钮上要写明，否则用户不知道原分组会少人） */
const pickedFromOther = computed(
  () => candidates.value.filter((r) => picked.value.has(r.path) && r.group).length,
);

function togglePick(path: string) {
  const next = new Set(picked.value);
  next.has(path) ? next.delete(path) : next.add(path);
  picked.value = next;
}
function toggleAll() {
  picked.value = allPicked.value
    ? new Set()
    : new Set(candidates.value.map((r) => r.path));
}
function commitPicked() {
  const paths = [...picked.value];
  if (!paths.length || !expanded.value) return;
  emit("add-members", expanded.value, paths);
  picked.value = new Set();
}
</script>

<template>
  <div
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-group-mgr-title"
    @click.self="emit('close')"
  >
    <div class="flex h-[560px] max-h-[92vh] w-[720px] max-w-[95vw] flex-col surface rounded-lg pop-in">
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
        <FolderPlus class="size-4 text-primary" />
        <span id="dlg-group-mgr-title" class="text-base font-semibold">分组管理</span>
        <span class="flex-1" />
        <Button variant="ghost" size="icon" aria-label="关闭" @click="emit('close')">
          <X class="size-4" />
        </Button>
      </header>

      <div class="flex min-h-0 flex-1">
        <!-- 左：分组列表（拖排序 / 选中 / 重命名 / 删除） -->
        <div class="flex w-[230px] shrink-0 flex-col border-r border-border">
          <div class="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
            <span class="text-2xs font-semibold tracking-wide text-muted-foreground">分组</span>
            <Button variant="ghost" size="sm" class="ml-auto h-6 px-2 text-xs" @click="emit('create')">
              <Plus class="size-3" /> 新建
            </Button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div
              v-if="!groups.length"
              class="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground"
            >
              还没有分组。<br />新建一个，再从右侧勾选仓库加进来。
            </div>
            <VueDraggable
              v-model="groups"
              :animation="150"
              :force-fallback="true"
              fallback-class="opacity-70"
              handle=".mgr-group-handle"
              tag="div"
              @update:model-value="emit('groups-change', $event)"
            >
              <div
                v-for="g in groups"
                :key="g"
                :data-mgr-group="g"
                class="group/grow mb-0.5 flex cursor-pointer items-center gap-1.5 rounded-sm py-1.5 pr-1 pl-1 text-xs transition-colors duration-fast"
                :class="[
                  expanded === g ? 'bg-primary-soft text-primary' : 'hover:bg-hover',
                  highlighted(g) && 'ring-1 ring-primary/60',
                ]"
                @click="expanded = g"
              >
                <GripVertical
                  class="mgr-group-handle size-3 shrink-0 cursor-grab text-muted-foreground opacity-0 group-hover/grow:opacity-60"
                  @click.stop
                />
                <Folder v-if="!hidden.has(g)" class="size-3.5 shrink-0" />
                <FolderClosed v-else class="size-3.5 shrink-0 opacity-50" />
                <span
                  class="min-w-0 flex-1 truncate font-medium"
                  :class="hidden.has(g) && 'text-muted-foreground line-through'"
                  :title="hidden.has(g) ? `${g}（已在标签栏隐藏）` : g"
                  >{{ g }}</span
                >
                <span
                  v-if="groupActive(g)"
                  class="size-1.5 shrink-0 rounded-full bg-primary"
                  title="当前打开的仓库在此分组"
                />
                <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">{{ memberCount(g) }}</span>
                <!-- 隐藏着的分组把眼睛常驻：它正是恢复入口，藏进 hover 里等于让人找不到怎么解 -->
                <button
                  v-if="hidden.has(g)"
                  class="shrink-0 cursor-pointer rounded-xs p-0.5 text-muted-foreground hover:text-foreground"
                  :title="`在标签栏显示「${g}」`"
                  :aria-label="`显示分组 ${g}`"
                  @click.stop="emit('toggle-hidden', g)"
                >
                  <EyeOff class="size-3" />
                </button>
                <!-- 其余行内操作：hover 才出现，避免每行常年挂三个按钮 -->
                <span
                  class="flex shrink-0 items-center opacity-0 transition-opacity duration-fast group-hover/grow:opacity-100"
                >
                  <button
                    v-if="!hidden.has(g)"
                    class="cursor-pointer rounded-xs p-0.5 text-muted-foreground hover:text-foreground"
                    :title="`在标签栏隐藏「${g}」`"
                    :aria-label="`隐藏分组 ${g}`"
                    @click.stop="emit('toggle-hidden', g)"
                  >
                    <Eye class="size-3" />
                  </button>
                  <button
                    class="cursor-pointer rounded-xs p-0.5 text-muted-foreground hover:text-foreground"
                    title="重命名"
                    @click.stop="emit('rename', g)"
                  >
                    <Pencil class="size-3" />
                  </button>
                  <button
                    class="cursor-pointer rounded-xs p-0.5 text-muted-foreground hover:text-destructive"
                    title="删除分组"
                    @click.stop="emit('delete', g)"
                  >
                    <X class="size-3" />
                  </button>
                </span>
              </div>
            </VueDraggable>
          </div>
          <div class="shrink-0 border-t border-border px-3 py-1.5 text-2xs tabular-nums text-muted-foreground">
            共 {{ repos.length }} 个仓库 · {{ ungrouped }} 个未分组
          </div>
        </div>

        <!-- 右：当前分组的成员 -->
        <div class="flex min-w-0 flex-1 flex-col">
          <template v-if="expanded">
            <div class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
              <Folder class="size-3.5 shrink-0 text-primary" />
              <span class="min-w-0 truncate text-sm font-medium" :title="expanded">{{ expanded }}</span>
              <span class="shrink-0 text-xs tabular-nums text-muted-foreground">
                {{ members.length }} 个仓库
              </span>
              <div class="relative ml-auto">
                <Search
                  class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  v-model="search"
                  class="h-7 w-44 pl-7 text-xs"
                  placeholder="搜索仓库…"
                  aria-label="搜索仓库"
                />
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              <!-- 已在组内 -->
              <div class="mb-1 px-1 text-2xs font-semibold tracking-wide text-muted-foreground">
                已在「{{ expanded }}」
              </div>
              <div
                v-for="r in membersShown"
                :key="r.path"
                class="group/mem flex items-center gap-2 rounded-sm px-1.5 py-1 text-xs transition-colors duration-fast hover:bg-hover"
                :title="`${r.path} · 按住可拖到左侧任意分组`"
                @mousedown="emit('drag-member', $event, r.path, r.name)"
              >
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="r.path === currentRepo ? 'bg-primary' : 'bg-border'"
                />
                <span class="shrink-0 font-medium">{{ r.name }}</span>
                <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ r.path }}</span>
                <button
                  class="shrink-0 cursor-pointer rounded-xs p-0.5 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/mem:opacity-100 hover:text-destructive"
                  title="移出分组"
                  @mousedown.stop
                  @click="emit('remove-member', r.path)"
                >
                  <X class="size-3" />
                </button>
              </div>
              <div
                v-if="!membersShown.length"
                class="px-2 py-3 text-center text-xs text-muted-foreground"
              >
                {{ members.length ? "没有匹配的仓库" : "这个分组还是空的，从下面勾选仓库加进来" }}
              </div>

              <!-- 可加入（批量勾选） -->
              <div class="mt-3 mb-1 flex items-center gap-2 border-t border-border/60 px-1 pt-2">
                <span class="text-2xs font-semibold tracking-wide text-muted-foreground">
                  可加入
                </span>
                <button
                  v-if="candidates.length"
                  class="cursor-pointer text-2xs text-primary hover:underline"
                  @click="toggleAll"
                >
                  {{ allPicked ? "取消全选" : "全选" }}
                </button>
                <span class="flex-1" />
                <Button
                  v-if="picked.size"
                  variant="default"
                  size="sm"
                  class="h-6 px-2 text-xs"
                  @click="commitPicked"
                >
                  加入 {{ picked.size }} 个
                  <span v-if="pickedFromOther" class="font-normal opacity-70">
                    （{{ pickedFromOther }} 个将从其它分组移入）
                  </span>
                </Button>
              </div>
              <label
                v-for="r in candidates"
                :key="r.path"
                class="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs transition-colors duration-fast hover:bg-hover"
              >
                <input
                  type="checkbox"
                  class="size-3.5 shrink-0 accent-[var(--primary)]"
                  :checked="picked.has(r.path)"
                  @change="togglePick(r.path)"
                />
                <span class="shrink-0 font-medium">{{ r.name }}</span>
                <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ r.path }}</span>
                <span class="shrink-0 text-2xs text-muted-foreground">
                  {{ r.group ? `来自「${r.group}」` : "未分组" }}
                </span>
              </label>
              <div
                v-if="!candidates.length"
                class="px-2 py-3 text-center text-xs text-muted-foreground"
              >
                {{ repos.length ? "所有仓库都已在这个分组里" : "还没有打开任何仓库" }}
              </div>
            </div>
          </template>

          <!-- 没有分组时的引导 -->
          <div v-else class="grid flex-1 place-items-center px-8 text-center">
            <div class="flex flex-col items-center gap-2">
              <div class="grid size-11 place-items-center rounded-lg bg-primary-soft">
                <Folder class="size-5 text-primary" />
              </div>
              <div class="text-sm text-muted-foreground">
                {{ groups.length ? "从左侧选一个分组" : "先新建一个分组" }}
              </div>
              <div class="text-xs text-muted-foreground">
                分组像书签文件夹：组内仓库不占标签栏位置，点文件夹下拉打开。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
