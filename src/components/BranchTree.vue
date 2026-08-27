<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown, GitMerge, GitPullRequestArrow, Pencil, Trash2 } from "@lucide/vue";
import type { Branch } from "../gitApi";
import type { BNode } from "../branchTree";
import { Tooltip, Input } from "./ui";

// manage=true 时叶子带 删除/重命名/合并 操作（仅本地分支树开启）
const props = withDefaults(
  defineProps<{ nodes: BNode[]; depth?: number; manage?: boolean }>(),
  { depth: 0, manage: false }
);
const emit = defineEmits<{
  switch: [b: Branch];
  delete: [b: Branch];
  rename: [b: Branch, newName: string];
  merge: [b: Branch]; // 目标分支合并到当前
  mergeInto: [b: Branch]; // 当前分支合并到目标
}>();
// 折叠集合由根共享（v-model），跨层级一致
const collapsed = defineModel<Set<string>>({ required: true });

const editing = ref<string | null>(null); // 正在重命名的分支 path
const editName = ref("");

function startRename(n: BNode) {
  editing.value = n.path;
  editName.value = n.seg;
}
function saveRename(n: BNode) {
  const name = editName.value.trim();
  editing.value = null;
  if (name && name !== n.seg) emit("rename", n.branch!, name);
}

function toggle(path: string) {
  const next = new Set(collapsed.value);
  next.has(path) ? next.delete(path) : next.add(path);
  collapsed.value = next;
}
</script>

<template>
  <template v-for="n in nodes" :key="n.path">
    <!-- 中间节点：可折叠 -->
    <template v-if="n.children.length">
      <div
        class="flex cursor-pointer items-center gap-1 py-1 pr-3 text-xs select-none hover:bg-muted"
        :style="{ paddingLeft: (props.depth ?? 0) * 12 + 12 + 'px' }"
        @click="toggle(n.path)"
      >
        <ChevronDown class="size-3 shrink-0 transition-transform" :class="collapsed.has(n.path) && '-rotate-90'" />
        <Tooltip :text="`${n.seg}（点击展开/收起，含 ${n.count} 个分支）`">
          <span class="truncate text-muted-foreground">{{ n.seg }}</span>
        </Tooltip>
        <span class="shrink-0 text-[10px] opacity-60">{{ n.count }}</span>
      </div>
      <BranchTree
        v-if="!collapsed.has(n.path)"
        v-model="collapsed"
        :nodes="n.children"
        :depth="(props.depth ?? 0) + 1"
        :manage="manage"
        @switch="emit('switch', $event)"
        @delete="emit('delete', $event)"
        @rename="(b, name) => emit('rename', b, name)"
        @merge="emit('merge', $event)"
        @merge-into="emit('mergeInto', $event)"
      />
    </template>

    <!-- 叶子：真实分支 -->
    <li
      v-else-if="editing === n.path"
      class="py-0.5 pr-3"
      :style="{ paddingLeft: (props.depth ?? 0) * 12 + 16 + 'px' }"
      @click.stop
    >
      <Input
        v-model="editName"
        class="h-6 text-xs"
        autofocus
        @keyup.enter="saveRename(n)"
        @keyup.esc="editing = null"
      />
    </li>
    <li
      v-else
      :class="[
        'group/li flex cursor-pointer items-center gap-1 py-1.5 pr-3 hover:bg-muted',
        n.branch?.current && 'font-semibold text-primary',
      ]"
      :style="{ paddingLeft: (props.depth ?? 0) * 12 + 24 + 'px' }"
      @dblclick="!n.branch!.current && emit('switch', n.branch!)"
    >
      <Tooltip :text="`${n.branch!.name}（双击切换）`">
        <span class="truncate">{{ n.seg }}</span>
      </Tooltip>
      <span
        v-if="manage && (n.branch!.ahead > 0 || n.branch!.behind > 0)"
        class="shrink-0 text-[10px] leading-none"
      >
        <span v-if="n.branch!.ahead" class="mr-0.5 text-sky-400/80">↑{{ n.branch!.ahead }}</span>
        <span v-if="n.branch!.behind" class="text-amber-400/80">↓{{ n.branch!.behind }}</span>
      </span>
      <span v-if="manage" class="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/li:opacity-100">
        <template v-if="n.branch!.remote">
          <!-- 远程分支只支持删除（直接作用于远程） -->
          <Tooltip text="删除远程分支">
            <Trash2 class="size-3.5 hover:text-destructive" @click.stop="emit('delete', n.branch!)" />
          </Tooltip>
        </template>
        <template v-else>
          <Tooltip v-if="!n.branch!.current" text="合并到当前分支">
            <GitMerge class="size-3.5 hover:text-primary" @click.stop="emit('merge', n.branch!)" />
          </Tooltip>
          <Tooltip v-if="!n.branch!.current" text="把当前分支合并到该分支（会切过去）">
            <GitPullRequestArrow class="size-3.5 hover:text-primary" @click.stop="emit('mergeInto', n.branch!)" />
          </Tooltip>
          <Pencil class="size-3.5 hover:text-primary" @click.stop="startRename(n)" />
          <Trash2 class="size-3.5 hover:text-destructive" @click.stop="emit('delete', n.branch!)" />
        </template>
      </span>
    </li>
  </template>
</template>

<style scoped>
li svg {
  cursor: pointer;
}
</style>
