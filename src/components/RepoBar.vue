<script setup lang="ts">
// 仓库选项卡栏（M16 16.2 拆出）：分组文件夹 + 未分组仓库，可拖动排序；最右侧是总览 / 分组管理入口。
// 顺序（gz.barOrder）、分组数据、拖拽命中判定都留在 App.vue：这里只渲染并把交互 emit 回去。
import { ChevronDown, Folder, FolderGit2, FolderPlus, GitBranch, LayoutGrid, X } from "@lucide/vue";
import { VueDraggable } from "vue-draggable-plus";
import { Button, Tooltip } from "@/components/ui";

// 与 App.vue 的 BarEntry 同构：不为它反向依赖 App
interface BarGroup {
  kind: "group";
  name: string;
}
interface BarRepo {
  kind: "repo";
  path: string;
}
type BarEntry = BarGroup | BarRepo;

interface RepoMeta {
  name: string;
}

interface BarMoveEvent {
  dragged?: HTMLElement;
  related?: HTMLElement;
}
interface BarEndEvent {
  item?: HTMLElement;
  originalEvent?: MouseEvent;
}

const props = defineProps<{
  currentRepo: string;
  // 只读查仓库名（App 的 repoByPath）
  repoByPath: ReadonlyMap<string, RepoMeta>;
  // 当前展开的分组名（App 的 folderDd?.group），只用于 aria-expanded
  openFolder: string;
  groupCount: (group: string) => number;
  isGroupActive: (group: string) => boolean;
  folderHighlighted: (group: string) => boolean;
  // 仓库 tab 悬停文件夹时是否阻止 Sortable 换位，由 App 的拖拽逻辑决定。
  // Vue 的 emit 会丢掉监听器返回值，这一项必须当函数 prop 直接调用，
  // 返回值才能经 VueDraggable 的 @move 回到 Sortable
  onBarMove: (evt: BarMoveEvent) => boolean | void;
  /** 工作树身份表（键是归一化路径）。命中说明这个 tab 是一个工作树目录：
   *  isMain 区分主工作树 / 从属工作树，mainPath 给出归属。
   *  显式标出来是因为「哪个是我 clone 的原始目录」光看路径名看不出来 —— 尤其当
   *  主仓库叫 x、工作树叫 x-fix 时，用户根本没有依据判断谁是谁。
   *  不自动归组：用户亲手排的选项卡顺序不该被猜。 */
  worktreeInfo: ReadonlyMap<string, { isMain: boolean; mainPath: string }>;
}>();

const emit = defineEmits<{
  "switch-repo": [path: string];
  "close-tab": [path: string];
  "folder-toggle": [name: string, ev: MouseEvent | KeyboardEvent];
  "folder-menu": [ev: MouseEvent, name: string];
  "tab-menu": [ev: MouseEvent, path: string];
  "open-overview": [];
  "open-group-mgr": [];
  "bar-start": [];
  "bar-end": [ev: BarEndEvent];
}>();

// tab 的 tooltip：主工作树要说明「工作树都是从属它」，从属的要指回主仓库路径 ——
// 用户判断身份靠的就是这两句话，别只给路径
function worktreeTip(path: string): string {
  const info = props.worktreeInfo.get(path);
  if (!info) return path;
  return info.isMain
    ? `${path}\n主工作树 · 其他工作树与它共享同一个 .git`
    : `${path}\n工作树 · 属于 ${info.mainPath}`;
}

// 拖拽排序写回 App 的 barOrder（gz.barOrder 的持久化在 App 的 deep watch 里）
const barOrder = defineModel<BarEntry[]>("barOrder", { required: true });
</script>

<template>
  <div data-tab-bar class="flex items-end border-b border-border bg-card">
    <VueDraggable
      v-model="barOrder"
      :animation="150"
      :force-fallback="true"
      fallback-class="opacity-70"
      tag="div"
      class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2"
      @start="emit('bar-start')"
      @move="(evt) => props.onBarMove(evt)"
      @end="(evt) => emit('bar-end', evt)"
    >
      <template
        v-for="item in barOrder"
        :key="item.kind === 'group' ? `group:${item.name}` : `repo:${item.path}`"
      >
        <!-- 分组文件夹：点击弹出成员下拉，激活仓库在组内时高亮；拖仓库到此处松手可归组 -->
        <div
          v-if="item.kind === 'group'"
          data-group-folder
          :data-group-folder-name="item.name"
          tabindex="0"
          role="button"
          aria-haspopup="menu"
          :aria-expanded="openFolder === item.name"
          class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs whitespace-nowrap transition-colors duration-fast select-none outline-none focus-visible:outline-2 focus-visible:outline-primary/60 focus-visible:-outline-offset-1"
          :class="[
            folderHighlighted(item.name)
              ? 'border-primary/60 bg-primary/10 text-primary ring-1 ring-primary/40'
              : isGroupActive(item.name)
                ? 'border-border bg-background font-medium text-foreground'
                : 'border-transparent text-muted-foreground transition-colors duration-fast hover:bg-hover',
          ]"
          :title="`分组「${item.name}」· ${groupCount(item.name)} 个仓库 · 点击展开；拖仓库到此处可收进分组，右键可重命名/删除`"
          @click.stop="emit('folder-toggle', item.name, $event)"
          @keydown.enter.prevent="emit('folder-toggle', item.name, $event)"
          @keydown.space.prevent="emit('folder-toggle', item.name, $event)"
          @contextmenu.prevent.stop="emit('folder-menu', $event, item.name)"
        >
          <Folder
            class="size-3.5 shrink-0"
            :class="folderHighlighted(item.name) || isGroupActive(item.name) ? 'text-primary' : 'opacity-70'"
          />
          <!-- 分组名长起来会挤爆标签栏：截断 + 成员数，让每个文件夹的宽度可预期 -->
          <span class="max-w-[140px] truncate">{{ item.name }}</span>
          <span class="text-2xs text-muted-foreground">{{ groupCount(item.name) }}</span>
          <ChevronDown class="size-3 opacity-50" />
        </div>
        <!-- 仓库选项卡 -->
        <div
          v-else
          :data-repo-path="item.path"
          class="group/tab flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs whitespace-nowrap transition-colors duration-fast select-none"
          :class="[
            item.path === currentRepo
              ? 'border-border bg-background font-medium text-foreground'
              : 'border-transparent text-muted-foreground transition-colors duration-fast hover:bg-hover',
          ]"
          @click="emit('switch-repo', item.path)"
          @contextmenu.prevent="emit('tab-menu', $event, item.path)"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="item.path === currentRepo ? 'bg-primary' : 'bg-border group-hover/tab:bg-muted-foreground'"
          />
          <!-- 身份图标：主工作树=实心仓库，从属工作树=分支。图标先于名字，
               扫读时眼睛先落在形状上，比读完名字再分辨快得多 -->
          <component
            :is="worktreeInfo.get(item.path)?.isMain ? FolderGit2 : GitBranch"
            v-if="worktreeInfo.has(item.path)"
            class="size-3 shrink-0"
            :class="worktreeInfo.get(item.path)?.isMain ? 'opacity-80' : 'opacity-60'"
            aria-hidden="true"
          />
          <Tooltip :text="worktreeTip(item.path)">
            <span class="max-w-[120px] truncate">{{ repoByPath.get(item.path)?.name }}</span>
          </Tooltip>
          <!-- 主 / 工作树：文字标，图标太淡，一眼分不出来时才需要文字 -->
          <span
            v-if="worktreeInfo.has(item.path)"
            class="shrink-0 rounded-xs px-1 text-2xs leading-4"
            :class="
              worktreeInfo.get(item.path)?.isMain
                ? 'bg-muted text-muted-foreground'
                : 'bg-[var(--badge-info-bg)] text-[var(--badge-info-fg)]'
            "
          >{{ worktreeInfo.get(item.path)?.isMain ? "主" : "工作树" }}</span>
          <X
            class="size-3 opacity-0 transition-opacity duration-fast group-hover/tab:opacity-60 hover:!opacity-100 hover:text-destructive"
            aria-label="关闭仓库选项卡"
            @mousedown.stop
            @click.stop="emit('close-tab', item.path)"
          />
        </div>
      </template>
    </VueDraggable>
    <Tooltip text="所有仓库总览">
      <Button
        variant="ghost"
        size="icon"
        class="mr-1 mb-0.5 h-6 w-6 shrink-0"
        aria-label="所有仓库总览"
        @click="emit('open-overview')"
      >
        <LayoutGrid class="size-4" />
      </Button>
    </Tooltip>
    <Tooltip text="管理分组">
      <Button variant="ghost" size="icon" class="mr-1 mb-0.5 h-6 w-6 shrink-0" @click="emit('open-group-mgr')">
        <FolderPlus class="size-4" />
      </Button>
    </Tooltip>
  </div>
</template>
