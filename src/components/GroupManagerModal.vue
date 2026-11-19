<script setup lang="ts">
// 分组顺序、成员归属与持久化仍由 App 管理；此处只维护弹窗内的浏览和勾选状态。
import { computed, nextTick, ref, watch } from "vue";
import {
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  FolderPlus,
  GripVertical,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "@lucide/vue";
import { VueDraggable } from "vue-draggable-plus";
import { Button, Input } from "@/components/ui";

interface GroupRepo {
  path: string;
  name: string;
  group?: string;
}

const props = defineProps<{
  repos: GroupRepo[];
  currentRepo: string;
  highlighted: (group: string) => boolean;
  initialGroup?: string;
  /** 只隐藏标签栏入口，不改变分组和仓库归属。 */
  hidden: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  close: [];
  create: [];
  rename: [group: string];
  delete: [group: string];
  "add-member": [group: string, path: string];
  "remove-member": [path: string];
  "add-members": [group: string, paths: string[]];
  "drag-member": [e: MouseEvent, path: string, name: string];
  "groups-change": [list: string[]];
  "toggle-hidden": [group: string];
}>();

const groups = defineModel<string[]>("groupList", { required: true });
type MemberView = "members" | "add";
const expanded = ref("");
const memberView = ref<MemberView>("members");
const search = ref("");
const picked = ref<Set<string>>(new Set());
const membersTab = ref<HTMLButtonElement | null>(null);
const addTab = ref<HTMLButtonElement | null>(null);

watch(
  () => groups.value,
  (list) => {
    if (list.includes(expanded.value)) return;
    const want = props.initialGroup;
    expanded.value = want && list.includes(want) ? want : (list[0] ?? "");
  },
  { immediate: true },
);
watch(expanded, () => {
  picked.value = new Set();
  search.value = "";
  memberView.value = "members";
});

const memberCount = (g: string) => props.repos.filter((r) => r.group === g).length;
const groupActive = (g: string) => props.repos.some((r) => r.group === g && r.path === props.currentRepo);
const ungrouped = computed(() => props.repos.filter((r) => !r.group).length);
const members = computed(() => props.repos.filter((r) => r.group === expanded.value));
const available = computed(() => props.repos.filter((r) => r.group !== expanded.value));
const matchSearch = (r: GroupRepo): boolean => {
  const q = search.value.trim().toLowerCase();
  return !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q);
};
const candidates = computed(() => available.value.filter(matchSearch));
const membersShown = computed(() => members.value.filter(matchSearch));
// 选择与搜索独立：隐藏在其他搜索结果中的选择仍要参与数量与跨组提示。
const pickedRepos = computed(() => available.value.filter((r) => picked.value.has(r.path)));
const pickedFromOther = computed(() => pickedRepos.value.filter((r) => r.group).length);
const allPicked = computed(
  () => candidates.value.length > 0 && candidates.value.every((r) => picked.value.has(r.path)),
);
const somePicked = computed(
  () => !allPicked.value && candidates.value.some((r) => picked.value.has(r.path)),
);

function switchView(view: MemberView) {
  if (memberView.value === view) return;
  memberView.value = view;
  search.value = "";
  nextTick(() => (view === "members" ? membersTab.value : addTab.value)?.focus());
}
function onSortKeydown(e: KeyboardEvent, group: string) {
  if (e.isComposing || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
  e.preventDefault();
  const from = groups.value.indexOf(group);
  const to = from + (e.key === "ArrowUp" ? -1 : 1);
  if (from < 0 || to < 0 || to >= groups.value.length) return;
  const next = [...groups.value];
  const moved = next.splice(from, 1)[0]!;
  next.splice(to, 0, moved);
  groups.value = next;
  emit("groups-change", next);
  const handle = e.currentTarget as HTMLElement | null;
  nextTick(() => handle?.focus());
}
function onViewKeydown(e: KeyboardEvent) {
  if (e.isComposing || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const next: MemberView = e.key === "Home" ? "members" : e.key === "End" ? "add" : memberView.value === "members" ? "add" : "members";
  switchView(next);
  (next === "members" ? membersTab.value : addTab.value)?.focus();
}
function togglePick(path: string) {
  const next = new Set(picked.value);
  next.has(path) ? next.delete(path) : next.add(path);
  picked.value = next;
}
function toggleAll() {
  const next = new Set(picked.value);
  for (const r of candidates.value) {
    if (allPicked.value) next.delete(r.path);
    else next.add(r.path);
  }
  picked.value = next;
}
function commitPicked() {
  const paths = pickedRepos.value.map((r) => r.path);
  if (!paths.length || !expanded.value) return;
  emit("add-members", expanded.value, paths);
  picked.value = new Set();
  search.value = "";
  memberView.value = "members";
  nextTick(() => membersTab.value?.focus());
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
    <div class="group-manager surface pop-in flex h-[600px] max-h-[calc(100vh-4rem)] w-[840px] max-w-[95vw] flex-col overflow-hidden rounded-lg">
      <header class="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <FolderPlus class="size-5 shrink-0 text-primary" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <div id="dlg-group-mgr-title" class="text-base font-semibold">分组管理</div>
          <div class="mt-0.5 text-xs text-muted-foreground">整理仓库归属，管理标签栏中的分组</div>
        </div>
        <Button variant="quiet" size="icon" aria-label="关闭分组管理" @click="emit('close')">
          <X class="size-4" />
        </Button>
      </header>

      <div class="flex min-h-0 flex-1">
        <aside class="group-manager-sidebar flex w-[216px] max-w-[36%] shrink-0 flex-col border-r border-border bg-card" aria-label="分组列表">
          <div class="flex shrink-0 items-center gap-2 px-3 py-2.5">
            <span class="text-xs font-semibold text-muted-foreground">分组</span>
            <span class="text-xs tabular-nums text-muted-foreground">{{ groups.length }}</span>
            <Button variant="ghost" size="sm" class="ml-auto h-7 gap-1 px-2 text-xs" @click="emit('create')">
              <Plus class="size-3.5" /> 新建
            </Button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            <div v-if="!groups.length" class="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
              还没有分组，点击上方“新建”开始整理。
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
                class="mb-1 flex items-center gap-1 rounded-sm px-1 transition-colors duration-fast"
                :class="[expanded === g ? 'bg-row-selected' : 'hover:bg-hover', highlighted(g) && 'ring-1 ring-primary/60']"
              >
                <button type="button" class="mgr-group-handle grid size-5 shrink-0 cursor-grab place-items-center rounded-xs text-muted-foreground hover:text-foreground focus-visible:text-foreground" title="拖动排序，或聚焦后用上/下方向键调整" :aria-label="`调整分组 ${g} 的顺序，使用上或下方向键`" @keydown="onSortKeydown($event, g)">
                  <GripVertical class="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pr-1 text-left text-sm select-none"
                  :aria-pressed="expanded === g"
                  :title="hidden.has(g) ? `${g}（已在标签栏隐藏）` : g"
                  @click="expanded = g"
                >
                  <Folder class="size-4 shrink-0" :class="expanded === g ? 'text-primary' : 'text-muted-foreground'" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate" :class="expanded === g && 'font-semibold'">{{ g }}</span>
                  <EyeOff v-if="hidden.has(g)" class="size-3 shrink-0" aria-label="已隐藏" />
                  <span v-if="groupActive(g)" class="size-1.5 shrink-0 rounded-full bg-primary" title="当前仓库所在分组" />
                  <span class="shrink-0 text-xs tabular-nums" :class="expanded === g ? 'text-foreground' : 'text-muted-foreground'">{{ memberCount(g) }}</span>
                </button>
              </div>
            </VueDraggable>
          </div>
          <div class="shrink-0 space-y-1 border-t border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <div>拖动手柄，或用方向键排序</div>
            <div class="tabular-nums">{{ repos.length }} 个仓库 · {{ ungrouped }} 个未分组</div>
          </div>
        </aside>

        <section class="flex min-w-0 flex-1 flex-col" aria-label="分组仓库管理">
          <template v-if="expanded">
            <div class="shrink-0 px-4 pt-4">
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <div class="truncate text-base font-semibold" :title="expanded">{{ expanded }}</div>
                  <div class="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {{ hidden.has(expanded) ? '已在标签栏隐藏，组内仓库仍保留' : '此分组显示在标签栏中' }}
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-0.5">
                  <Button variant="quiet" size="icon" class="size-7" title="重命名分组" :aria-label="`重命名分组 ${expanded}`" @click="emit('rename', expanded)">
                    <Pencil class="size-3.5" />
                  </Button>
                  <Button variant="quiet" size="icon" class="size-7" :title="hidden.has(expanded) ? '在标签栏显示' : '在标签栏隐藏'" :aria-label="hidden.has(expanded) ? `显示分组 ${expanded}` : `隐藏分组 ${expanded}`" @click="emit('toggle-hidden', expanded)">
                    <EyeOff v-if="hidden.has(expanded)" class="size-3.5" />
                    <Eye v-else class="size-3.5" />
                  </Button>
                  <Button variant="quiet" size="icon" class="size-7 hover:text-destructive" title="删除分组" :aria-label="`删除分组 ${expanded}`" @click="emit('delete', expanded)">
                    <Trash2 class="size-3.5" />
                  </Button>
                </div>
              </div>
              <div class="mt-3 flex gap-5 border-b border-border" role="tablist" aria-label="仓库管理方式">
                <button
                  id="group-manager-members-tab"
                  ref="membersTab"
                  type="button"
                  role="tab"
                  aria-controls="group-manager-repos"
                  :aria-selected="memberView === 'members'"
                  :tabindex="memberView === 'members' ? 0 : -1"
                  class="flex cursor-pointer items-center gap-1.5 border-b-2 py-2 text-sm transition-colors duration-fast"
                  :class="memberView === 'members' ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
                  @click="switchView('members')"
                  @keydown="onViewKeydown"
                >
                  组内仓库 <span class="rounded-xs bg-muted px-1.5 text-xs tabular-nums">{{ members.length }}</span>
                </button>
                <button
                  id="group-manager-add-tab"
                  ref="addTab"
                  type="button"
                  role="tab"
                  aria-controls="group-manager-repos"
                  :aria-selected="memberView === 'add'"
                  :tabindex="memberView === 'add' ? 0 : -1"
                  class="flex cursor-pointer items-center gap-1.5 border-b-2 py-2 text-sm transition-colors duration-fast"
                  :class="memberView === 'add' ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
                  @click="switchView('add')"
                  @keydown="onViewKeydown"
                >
                  添加仓库 <span class="rounded-xs bg-muted px-1.5 text-xs tabular-nums">{{ available.length }}</span>
                </button>
              </div>
              <div class="relative my-3">
                <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="search" class="h-8 pr-8 pl-8 text-sm" :placeholder="memberView === 'members' ? '搜索组内仓库名称或路径…' : '搜索可加入的仓库名称或路径…'" aria-label="搜索仓库名称或路径" />
                <button v-if="search" type="button" class="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded-xs p-0.5 text-muted-foreground hover:text-foreground" aria-label="清空仓库搜索" @click="search = ''">
                  <X class="size-3.5" />
                </button>
              </div>
            </div>

            <div id="group-manager-repos" class="min-h-0 flex-1 overflow-y-auto px-4 pb-3" role="tabpanel" :aria-labelledby="memberView === 'members' ? 'group-manager-members-tab' : 'group-manager-add-tab'">
              <template v-if="memberView === 'members'">
                <div v-if="membersShown.length" class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span class="min-w-0 flex-1">拖到左侧分组可移动仓库</span>
                  <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-xs" @click="switchView('add')"><Plus class="size-3" /> 添加仓库</Button>
                </div>
                <div
                  v-for="r in membersShown"
                  :key="r.path"
                  class="mb-1 flex items-start gap-2.5 rounded-sm px-2.5 py-2.5 transition-colors duration-fast hover:bg-hover"
                  :title="`${r.path} · 按住可拖到左侧分组`"
                  @mousedown="emit('drag-member', $event, r.path, r.name)"
                >
                  <FolderGit2 class="mt-0.5 size-4 shrink-0" :class="r.path === currentRepo ? 'text-primary' : 'text-muted-foreground'" aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                      <span class="min-w-0 truncate text-sm font-medium">{{ r.name }}</span>
                      <span v-if="r.path === currentRepo" class="shrink-0 rounded-xs bg-muted px-1.5 text-2xs text-muted-foreground">当前</span>
                    </div>
                    <div class="mt-0.5 truncate text-xs text-muted-foreground" :title="r.path">{{ r.path }}</div>
                  </div>
                  <Button variant="quiet" size="icon" class="size-7 shrink-0" title="移出分组，回到标签栏" :aria-label="`将 ${r.name} 移出分组`" @mousedown.stop @click="emit('remove-member', r.path)">
                    <X class="size-3.5" />
                  </Button>
                </div>
                <div v-if="!membersShown.length" class="flex min-h-[180px] flex-col items-center justify-center gap-2 px-4 text-center">
                  <FolderGit2 class="mb-1 size-7 text-muted-foreground" aria-hidden="true" />
                  <div class="text-sm font-medium">{{ search.trim() ? '没有匹配的仓库' : '这个分组还没有仓库' }}</div>
                  <div class="text-xs leading-relaxed text-muted-foreground">{{ search.trim() ? '试试其他名称或路径关键词' : '从已打开的仓库中选择，加入这个分组' }}</div>
                  <Button variant="ghost" size="sm" class="mt-1" @click="search.trim() ? search = '' : switchView('add')">{{ search.trim() ? '清空搜索' : '添加仓库' }}</Button>
                </div>
              </template>

              <template v-else>
                <div v-if="candidates.length" class="mb-2 flex items-center justify-between gap-2 px-2.5 text-xs text-muted-foreground">
                  <label class="flex cursor-pointer items-center gap-2 py-1">
                    <input type="checkbox" class="size-3.5 accent-[var(--primary)]" :checked="allPicked" :indeterminate="somePicked" aria-label="全选当前仓库搜索结果" @change="toggleAll" />
                    {{ search.trim() ? '全选搜索结果' : '全选可加入仓库' }}
                  </label>
                  <span class="shrink-0 tabular-nums">{{ candidates.length }} 个结果</span>
                </div>
                <label
                  v-for="r in candidates"
                  :key="r.path"
                  class="mb-1 flex cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2.5 transition-colors duration-fast"
                  :class="picked.has(r.path) ? 'bg-row-selected' : 'hover:bg-hover'"
                >
                  <input type="checkbox" class="mt-1 size-3.5 shrink-0 accent-[var(--primary)]" :checked="picked.has(r.path)" :aria-label="`选择仓库 ${r.name}`" @change="togglePick(r.path)" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{{ r.name }}</div>
                    <div class="mt-0.5 truncate text-xs" :class="picked.has(r.path) ? 'text-foreground' : 'text-muted-foreground'" :title="r.path">{{ r.path }}</div>
                  </div>
                  <span class="group-manager-origin mt-0.5 max-w-[110px] shrink-0 truncate rounded-xs bg-muted px-1.5 py-0.5 text-2xs" :class="picked.has(r.path) ? 'text-foreground' : 'text-muted-foreground'" :title="r.group ? `将从「${r.group}」移入当前分组` : '当前未分组'">{{ r.group ? `来自 ${r.group}` : '未分组' }}</span>
                </label>
                <div v-if="!candidates.length" class="flex min-h-[180px] flex-col items-center justify-center gap-2 px-4 text-center">
                  <FolderGit2 class="mb-1 size-7 text-muted-foreground" aria-hidden="true" />
                  <div class="text-sm font-medium">{{ search.trim() ? '没有匹配的仓库' : repos.length ? '所有仓库都已在此分组' : '还没有打开任何仓库' }}</div>
                  <div class="text-xs leading-relaxed text-muted-foreground">{{ search.trim() ? '试试其他名称或路径关键词' : '打开其他仓库后，可以在这里加入分组' }}</div>
                  <Button v-if="search.trim()" variant="ghost" size="sm" class="mt-1" @click="search = ''">清空搜索</Button>
                </div>
              </template>
            </div>
          </template>

          <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <FolderPlus class="size-8 text-muted-foreground" aria-hidden="true" />
            <div class="text-base font-semibold">新建分组，开始整理仓库</div>
            <div class="max-w-[280px] text-sm leading-relaxed text-muted-foreground">把相关仓库放在一起，使用标签栏的分组入口快速切换。</div>
            <Button class="mt-1" @click="emit('create')"><Plus class="size-3.5" /> 新建分组</Button>
          </div>
        </section>
      </div>

      <footer class="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-4 py-3">
        <div class="min-w-0 flex-1 text-xs leading-relaxed" aria-live="polite" aria-atomic="true">
          <template v-if="pickedRepos.length">
            <div class="flex flex-wrap items-center gap-x-2">
              <span class="font-medium tabular-nums">已选择 {{ pickedRepos.length }} 个仓库</span>
              <button type="button" class="cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" @click="picked = new Set()">清空选择</button>
            </div>
            <div v-if="pickedFromOther" class="mt-0.5 text-muted-foreground">其中 {{ pickedFromOther }} 个将从其他分组移入</div>
          </template>
          <span v-else class="text-muted-foreground">{{ memberView === 'add' && expanded ? '勾选仓库后，点击“加入选中”完成归组' : '分组设置与成员调整即时生效' }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button :variant="memberView === 'add' || pickedRepos.length ? 'secondary' : 'default'" @click="emit('close')">关闭</Button>
          <Button v-if="expanded && (memberView === 'add' || pickedRepos.length)" variant="default" :disabled="!pickedRepos.length" @click="commitPicked">加入选中<span v-if="pickedRepos.length" class="tabular-nums">（{{ pickedRepos.length }}）</span></Button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
@media (max-width: 640px) {
  .group-manager-sidebar {
    width: 168px;
  }
  .group-manager-origin {
    max-width: 76px;
  }
}
</style>
