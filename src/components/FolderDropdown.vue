<script setup lang="ts">
// 分组文件夹下拉（M16 16.2 收尾）。open 状态、拖拽机与分组 CRUD 全留 App.vue：
// 这里只负责渲染、成员过滤，以及打开后把当前仓库滚进视野。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { Tooltip } from "@/components/ui";

// 自己声明结构类型：字段与 App.vue 的 RepoTab 保持一致，不为它反向依赖 App
interface GroupRepo {
  path: string;
  name: string;
  group?: string;
}

const props = defineProps<{
  dd: { x: number; y: number; group: string } | null;
  repos: GroupRepo[];
  currentRepo: string;
}>();

const emit = defineEmits<{
  close: [];
  "close-force": [];
  /** 带上当前分组名：弹窗直接选中它，省掉打开后再找的一步 */
  "open-mgr": [group: string];
  "member-activate": [path: string];
  "remove-member": [path: string];
  "drag-member": [e: MouseEvent, path: string, name: string];
}>();

const panelEl = ref<HTMLElement | null>(null);
const panelPos = ref({ x: 8, y: 8, maxHeight: 400 });

async function place() {
  const dd = props.dd;
  if (!dd) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxHeight = Math.min(Math.floor(vh * 0.6), Math.max(0, vh - 16));
  panelPos.value = { x: 8, y: 8, maxHeight };
  await nextTick();
  const panel = panelEl.value;
  if (!panel || props.dd !== dd) return;
  panelPos.value = {
    x: Math.max(8, Math.min(dd.x, vw - panel.offsetWidth - 8)),
    y: Math.max(8, Math.min(dd.y, vh - panel.offsetHeight - 8)),
    maxHeight,
  };
}

// 成员自己算：App 的 folderMembers 只有这一处消费者
const members = computed(() => {
  const dd = props.dd;
  return dd ? props.repos.filter((r) => r.group === dd.group) : [];
});

// 分组一多，下拉里哪一行是当前仓库就不好找了：打开后把它滚进视野
watch(
  () => props.dd,
  (dd) => {
    if (!dd) return;
    nextTick(() => {
      panelEl.value?.querySelector('[data-folder-active="1"]')?.scrollIntoView({ block: "nearest" });
    });
  },
  { immediate: true },
);
watch([() => props.dd, members], place, { immediate: true, flush: "post" });
onMounted(() => window.addEventListener("resize", place));
onUnmounted(() => window.removeEventListener("resize", place));
</script>

<template>
  <div v-if="dd" class="fixed inset-0 z-40" @click="emit('close')" @contextmenu.prevent="emit('close-force')">
    <div
      ref="panelEl"
      class="fixed flex w-[300px] max-w-[calc(100vw-16px)] flex-col overflow-hidden surface-menu rounded-sm pop-in"
      :style="{ left: panelPos.x + 'px', top: panelPos.y + 'px', maxHeight: panelPos.maxHeight + 'px' }"
    >
      <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 text-xs">
        <span class="min-w-0 flex-1 truncate font-semibold" :title="dd.group">{{ dd.group }}</span>
        <span class="shrink-0 text-muted-foreground tabular-nums">{{ members.length }} 个仓库</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
      <div
        v-for="r in members"
        :key="r.path"
        :data-folder-active="r.path === currentRepo ? '1' : undefined"
        class="group/member flex items-center gap-1 transition-colors duration-fast"
        :class="r.path === currentRepo ? 'bg-row-selected text-foreground' : 'hover:bg-hover'"
      >
        <button
          class="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-3 py-1.5 text-left text-xs select-none"
          :title="`${r.path} · 按住可拖到标签栏移出分组，或拖到别的文件夹换组`"
          @mousedown="emit('drag-member', $event, r.path, r.name)"
          @click.stop="emit('member-activate', r.path)"
        >
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="r.path === currentRepo ? 'bg-primary' : 'bg-border'"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ r.name }}</span>
            <span class="mt-0.5 block truncate text-xs" :class="r.path === currentRepo ? 'text-foreground' : 'text-muted-foreground'">{{ r.path }}</span>
          </span>
        </button>
        <Tooltip text="移出分组">
          <button
            class="mr-2 shrink-0 cursor-pointer rounded-xs p-1 text-muted-foreground transition-colors duration-fast hover:text-destructive"
            aria-label="移出分组"
            @mousedown.stop
            @click.stop="emit('remove-member', r.path)"
          >
            <X class="size-3" />
          </button>
        </Tooltip>
      </div>
      <div v-if="!members.length" class="px-3 py-2 text-xs text-muted-foreground">
        空分组 · 用标签栏右侧的「管理分组」添加仓库
      </div>
      </div>
      <div class="shrink-0 border-t border-border/60 py-1">
        <button
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-fast hover:bg-hover"
          @click.stop="emit('open-mgr', dd!.group)"
        >
          管理分组…
        </button>
      </div>
    </div>
  </div>
</template>
