<script setup lang="ts">
// 分组管理弹窗（M16 16.2 拆出）。CRUD、拖拽机、持久化全留在 App.vue：
// 这里只负责渲染与弹窗内的一次性 UI 状态（展开的分组、搜索词）。
import { ref, watch } from "vue";
import { ChevronDown, Folder, FolderPlus, GripVertical, Plus, Search, X } from "@lucide/vue";
import { VueDraggable } from "vue-draggable-plus";
import { Button, Input } from "@/components/ui";

// 自己声明结构类型：字段与 App.vue 的 RepoTab 保持一致，不为它反向依赖 App
interface GroupRepo {
  path: string;
  name: string;
  group?: string;
}

const props = defineProps<{
  repos: GroupRepo[];
  currentRepo: string;
  // 拖拽高亮依赖 App 的 itemDrag 状态，用函数 prop 传进来（纯读，不写）
  highlighted: (group: string) => boolean;
}>();

const emit = defineEmits<{
  close: [];
  create: [];
  rename: [group: string];
  delete: [group: string];
  "add-member": [group: string, path: string];
  "remove-member": [path: string];
  "drag-member": [e: MouseEvent, path: string, name: string];
  "groups-change": [list: string[]];
}>();

// 分组顺序是 App 的持久化状态（gz.groups + 标签栏顺序），这里只做 v-model 桥接
const groups = defineModel<string[]>("groupList", { required: true });

// 展开哪个分组、搜索词都只在弹窗内用；弹窗由使用处 v-if 控制，关闭即销毁重置
const expanded = ref("");
const search = ref("");
// 分组被删掉（App 侧 name 确认框）后收起残留的展开态
watch(
  () => groups.value.includes(expanded.value),
  (exists) => {
    if (!exists) expanded.value = "";
  },
);

const memberCount = (g: string) => props.repos.filter((r) => r.group === g).length;
const groupActive = (g: string) => props.repos.some((r) => r.group === g && r.path === props.currentRepo);
function matchRepoSearch(r: GroupRepo): boolean {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  return r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q);
}
// 某个分组「添加仓库」列表：排除已在组内 + 没过搜索词
function candidates(g: string): GroupRepo[] {
  return props.repos.filter((r) => r.group !== g && matchRepoSearch(r));
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
    <div class="flex max-h-[75vh] w-dlg-lg flex-col surface rounded-lg pop-in">
      <header class="flex shrink-0 items-center gap-2 border-b border-border px-5 py-3">
        <FolderPlus class="size-4 text-primary" />
        <span id="dlg-group-mgr-title" class="text-base font-semibold">分组管理</span>
        <span class="flex-1" />
        <Button variant="ghost" size="icon" @click="emit('close')"><X class="size-4" /></Button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <div class="mb-2 flex items-center gap-2">
          <Button variant="secondary" size="sm" @click="emit('create')">
            <Plus class="size-3.5" /> 新建分组
          </Button>
          <div class="relative ml-auto">
            <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              v-model="search"
              class="h-7 w-52 pl-7 text-xs"
              placeholder="搜索仓库：名称或路径"
              aria-label="搜索仓库"
            />
          </div>
        </div>
        <div v-if="!groups.length" class="py-8 text-center text-xs text-muted-foreground">
          还没有分组。新建一个，然后把仓库收进去——标签栏会出现一个文件夹，点击可展开仓库列表。
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
            class="mb-2 rounded-md border transition-colors duration-fast"
            :class="highlighted(g) ? 'border-primary/60 bg-primary-soft' : 'border-border'"
          >
            <div class="flex items-center gap-2 px-3 py-2">
              <GripVertical class="mgr-group-handle size-3.5 shrink-0 cursor-grab text-muted-foreground" @click.stop />
              <button
                class="flex flex-1 cursor-pointer items-center gap-1.5 text-left text-base"
                @click="expanded = expanded === g ? '' : g"
              >
                <ChevronDown
                  class="size-3 text-muted-foreground transition-transform duration-fast"
                  :class="expanded !== g && '-rotate-90'"
                />
                <Folder class="size-3.5 text-primary" />
                <span class="font-medium">{{ g }}</span>
                <span class="text-xs text-muted-foreground">{{ memberCount(g) }} 个仓库</span>
                <span v-if="groupActive(g)" class="size-1.5 rounded-full bg-primary" title="当前打开的仓库在此分组" />
              </button>
              <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="emit('rename', g)">重命名</Button>
              <Button variant="ghost" size="sm" class="h-6 px-2 text-xs text-destructive" @click="emit('delete', g)">
                删除
              </Button>
            </div>
            <!-- 成员编辑：移出 / 添加 -->
            <div v-if="expanded === g" class="border-t border-border/60 px-3 py-2">
              <div
                v-for="r in repos.filter((x) => x.group === g)"
                :key="r.path"
                class="flex cursor-grab items-center gap-2 rounded-sm py-1 text-xs select-none transition-colors duration-fast hover:bg-hover"
                title="按住可拖到上面任意分组"
                @mousedown="emit('drag-member', $event, r.path, r.name)"
              >
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  :class="r.path === currentRepo ? 'bg-primary' : 'bg-border'"
                />
                <span class="shrink-0 font-medium">{{ r.name }}</span>
                <span class="flex-1 truncate text-xs text-muted-foreground">{{ r.path }}</span>
                <button
                  class="cursor-pointer text-muted-foreground transition-colors duration-fast hover:text-destructive"
                  title="移出分组"
                  @mousedown.stop
                  @click="emit('remove-member', r.path)"
                >
                  <X class="size-3" />
                </button>
              </div>
              <div v-if="!memberCount(g)" class="py-1 text-xs text-muted-foreground">空分组</div>
              <div class="mt-1 border-t border-border/60 pt-1.5">
                <div class="mb-1 text-xs text-muted-foreground">添加仓库（一个仓库只属一个分组）：</div>
                <div class="max-h-32 space-y-0.5 overflow-y-auto">
                  <button
                    v-for="r in candidates(g)"
                    :key="r.path"
                    class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-hover"
                    @click="emit('add-member', g, r.path)"
                  >
                    <Plus class="size-3 shrink-0 text-primary" />
                    <span class="truncate">{{ r.name }}</span>
                    <span class="ml-auto truncate text-xs text-muted-foreground">
                      {{ r.group ? `来自「${r.group}」` : "未分组" }}
                    </span>
                  </button>
                  <div v-if="!candidates(g).length" class="px-1.5 py-1 text-xs text-muted-foreground">
                    没有匹配的仓库
                  </div>
                </div>
              </div>
            </div>
          </div>
        </VueDraggable>
      </div>
      <footer class="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        分组像书签文件夹：组内仓库不占选项卡，点文件夹下拉打开。移出/删除分组不会关闭任何仓库。
      </footer>
    </div>
  </div>
</template>
