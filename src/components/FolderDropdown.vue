<script setup lang="ts">
// 分组文件夹下拉（M16 16.2 收尾）。open 状态、拖拽机与分组 CRUD 全留 App.vue：
// 这里只负责渲染、成员过滤，以及打开后把当前仓库滚进视野。
import { computed, nextTick, ref, watch } from "vue";
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
  "open-mgr": [];
  "member-activate": [path: string];
  "remove-member": [path: string];
  "drag-member": [e: MouseEvent, path: string, name: string];
}>();

const panelEl = ref<HTMLElement | null>(null);

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
</script>

<template>
  <div v-if="dd" class="fixed inset-0 z-40" @click="emit('close')" @contextmenu.prevent="emit('close-force')">
    <div
      ref="panelEl"
      class="fixed max-h-[60vh] w-[260px] overflow-y-auto surface-menu rounded-sm py-1 pop-in"
      :style="{ left: dd.x + 'px', top: dd.y + 'px' }"
    >
      <div class="px-3 pt-3 pb-1.5 text-2xs font-semibold tracking-wide text-muted-foreground tabular-nums">
        {{ dd.group }} · {{ members.length }} 个仓库
      </div>
      <div
        v-for="r in members"
        :key="r.path"
        :data-folder-active="r.path === currentRepo ? '1' : undefined"
        class="group/member flex items-center gap-1 transition-colors duration-fast hover:bg-hover"
        :class="r.path === currentRepo && 'bg-primary-soft text-primary'"
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
          <span class="truncate">{{ r.name }}</span>
        </button>
        <Tooltip text="移出分组">
          <button
            class="mr-1 shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/member:opacity-100 hover:text-destructive"
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
      <div class="mt-1 border-t border-border/60 pt-1">
        <button
          class="block w-full cursor-pointer px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-fast hover:bg-hover"
          @click.stop="emit('open-mgr')"
        >
          管理分组…
        </button>
      </div>
    </div>
  </div>
</template>
