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
  <Transition name="dlg">
    <div
      v-if="open"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-group-name-title"
      @click.self="open = false"
    >
      <div class="dialog-shell surface rounded-lg pop-in" :class="mode === 'create' ? 'w-dlg-lg' : 'w-dlg-sm'">
        <header class="dialog-header">
          <div id="dlg-group-name-title" class="dialog-title">{{ mode === 'create' ? '新建分组' : '重命名分组' }}</div>
        </header>
        <div class="dialog-body space-y-4">
          <label class="dialog-field text-xs">
            <span class="font-medium">分组名称</span>
            <Input v-model="name" v-focus placeholder="例如：前端 / 后端" @keydown.enter.prevent="imeConfirm" @keydown.esc="imeClose" />
          </label>
          <div v-if="err" role="alert" class="text-xs text-destructive">{{ err }}</div>
          <template v-if="mode === 'create'">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="font-medium">同时加入仓库 <span class="font-normal text-muted-foreground">（可选）</span></span>
              <span class="shrink-0 text-muted-foreground tabular-nums">已选 {{ picks.length }}</span>
            </div>
            <p class="text-xs leading-relaxed text-muted-foreground">一个仓库只属于一个分组。选择已有分组的仓库，会将它移入新分组。</p>
            <div class="max-h-[min(280px,40vh)] overflow-y-auto rounded-sm border border-border p-1">
              <button
                v-for="r in repos"
                :key="r.path"
                type="button"
                class="flex w-full cursor-pointer items-start gap-2 rounded-sm p-2 text-left text-xs transition-colors duration-fast"
                :class="picks.includes(r.path) ? 'bg-row-selected' : 'hover:bg-hover'"
                :aria-pressed="picks.includes(r.path)"
                :title="r.path"
                @click="togglePick(r.path)"
              >
                <span class="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-xs border" :class="picks.includes(r.path) ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"><Check v-if="picks.includes(r.path)" class="size-2.5" /></span>
                <span class="min-w-0 flex-1"><span class="block truncate font-medium">{{ r.name }}</span><span class="mt-0.5 block truncate" :class="picks.includes(r.path) ? 'text-foreground' : 'text-muted-foreground'">{{ r.path }}</span></span>
                <span class="max-w-[110px] shrink-0 truncate rounded-xs bg-muted px-1.5 py-0.5" :class="picks.includes(r.path) ? 'text-foreground' : 'text-muted-foreground'" :title="r.group || '未分组'">{{ r.group ? '来自「' + r.group + '」' : '未分组' }}</span>
              </button>
              <div v-if="!repos.length" class="px-3 py-5 text-center text-xs text-muted-foreground">还没有打开的仓库，可先创建空分组。</div>
            </div>
          </template>
        </div>
        <footer class="dialog-footer">
          <Button variant="ghost" size="sm" @click="open = false">取消</Button>
          <Button variant="default" size="sm" :disabled="!name.trim()" @click="emit('confirm')">{{ mode === 'create' ? '创建分组' : '保存名称' }}</Button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
