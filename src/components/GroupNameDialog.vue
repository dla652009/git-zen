<script setup lang="ts">
import { Check } from "@lucide/vue";
import { imeGuard } from "../lib/imeGuard";
import { Button, Input } from "@/components/ui";

// open 由 App.vue 的 groupModal 推导（overlayLayers.groupModal 指向它）；建组/改名的逻辑也留在 App
const open = defineModel<boolean>("open", { required: true });
const name = defineModel<string>("name", { required: true });
const picks = defineModel<string[]>("picks", { required: true });

// 自己声明结构类型：三个字段不值得为它反向依赖 App.vue 的 RepoTab
interface GroupRepo {
  path: string;
  name: string;
  group?: string;
}

defineProps<{ mode: "create" | "rename"; err: string; repos: GroupRepo[] }>();

const emit = defineEmits<{ confirm: [] }>();

// 单纯的选择态，勾选结果由 App 的 confirmGroupModal 消费
function togglePick(path: string) {
  picks.value = picks.value.includes(path)
    ? picks.value.filter((p) => p !== path)
    : [...picks.value, path];
}

// IME 守卫：键盘事件在本组件模板上，守卫也就得在这。只能挂 keydown（见 lib/imeGuard.ts）
const imeConfirm = imeGuard(() => emit("confirm"));
const imeClose = imeGuard(() => {
  open.value = false;
});
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-group-name-title"
    @click.self="open = false"
  >
    <div class="w-dlg-sm surface rounded-lg p-5 pop-in">
      <div id="dlg-group-name-title" class="mb-3 text-base font-semibold">{{ mode === "create" ? "新建分组" : "重命名分组" }}</div>
      <Input
        v-model="name"
        v-focus
        placeholder="分组名，如：前端 / 后端"
        @keydown.enter.prevent="imeConfirm"
        @keydown.esc="imeClose"
      />
      <!-- 新建时顺带归组：从标签栏拖进文件夹对键盘/单窗口用户不友好，这里给一条鼠标直路 -->
      <template v-if="mode === 'create'">
        <div class="mt-3 mb-1 text-xs text-muted-foreground">顺带加入仓库（可选，一个仓库只属一个分组）：</div>
        <div class="max-h-40 overflow-y-auto rounded-md border border-border/70 p-1">
          <button
            v-for="r in repos"
            :key="r.path"
            class="flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs transition-colors duration-fast hover:bg-hover"
            :class="picks.includes(r.path) && 'bg-primary-soft'"
            @click="togglePick(r.path)"
          >
            <span
              class="flex size-3.5 shrink-0 items-center justify-center rounded-xs border"
              :class="picks.includes(r.path) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"
            >
              <Check v-if="picks.includes(r.path)" class="size-2.5" />
            </span>
            <span class="truncate">{{ r.name }}</span>
            <span class="ml-auto truncate text-xs text-muted-foreground">
              {{ r.group ? `来自「${r.group}」` : "未分组" }}
            </span>
          </button>
          <div v-if="!repos.length" class="px-1.5 py-1 text-xs text-muted-foreground">还没有仓库</div>
        </div>
      </template>
      <div v-if="err" class="mt-1.5 text-xs text-destructive">{{ err }}</div>
      <div class="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="open = false">取消</Button>
        <Button variant="default" size="sm" :disabled="!name.trim()" @click="emit('confirm')">
          确定
        </Button>
      </div>
    </div>
  </div>
</template>
