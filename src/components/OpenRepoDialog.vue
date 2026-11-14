<script setup lang="ts">
// 打开仓库（本地 / 从远程克隆）。状态与回调全留在 App.vue：
// openModal 的取值由使用处的 v-if 保证非空，overlayLayers / Esc 分层关闭仍指向 App 的 openModal。
// 键盘事件也 emit 回 App，由 App 侧的 imeGuard 常量承接（守卫只留一份）。
import { Download, FolderOpen, FolderPlus } from "@lucide/vue";
import { Button, Input, Spinner } from "@/components/ui";

defineProps<{
  open: "choose" | "remote";
  cloneParent: string;
  cloneBusy: boolean;
  cloneErr: string;
  cloneErrDetail: string;
}>();

const url = defineModel<string>("remoteUrlInput", { required: true });
const cloneName = defineModel<string>("cloneName", { required: true });

const emit = defineEmits<{
  close: [e?: KeyboardEvent];
  "confirm-clone": [e?: KeyboardEvent];
  "start-clone": [];
  "pick-parent": [];
  "choose-local": [];
  remote: [];
  "init-repo": [];
  "touch-name": [];
}>();
</script>

<template>
  <div
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="open === 'choose' ? 'dlg-open-repo-title' : 'dlg-clone-title'"
    @click.self="emit('close')"
  >
    <div class="w-dlg-lg surface rounded-lg p-5 pop-in">
      <!-- 选择入口 -->
      <template v-if="open === 'choose'">
        <div id="dlg-open-repo-title" class="mb-3 text-base font-semibold">打开仓库</div>
        <div class="grid grid-cols-2 gap-3">
          <button
            class="cursor-pointer rounded-md surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-primary/5 hover:shadow-elev-2"
            @click="emit('choose-local')"
          >
            <FolderOpen class="mb-1.5 size-5 text-primary" />
            <span class="block text-sm font-medium">本地目录</span>
            <span class="mt-0.5 block text-xs text-muted-foreground">选择本机已有的 Git 仓库</span>
          </button>
          <button
            class="cursor-pointer rounded-md surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-primary/5 hover:shadow-elev-2"
            @click="emit('remote')"
          >
            <Download class="mb-1.5 size-5 text-primary" />
            <span class="block text-sm font-medium">从远程克隆</span>
            <span class="mt-0.5 block text-xs text-muted-foreground">输入 URL 克隆到本地并打开</span>
          </button>
          <!-- 第三个动作横跨整行：三个等宽卡片在 520px 里太挤，而且它本来就比前两个少见 -->
          <button
            class="col-span-2 flex cursor-pointer items-center gap-3 rounded-md surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-primary/5 hover:shadow-elev-2"
            @click="emit('init-repo')"
          >
            <FolderPlus class="size-5 shrink-0 text-primary" />
            <span class="min-w-0">
              <span class="block text-sm font-medium">初始化新仓库</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">把选中的空目录 git init 后打开</span>
            </span>
          </button>
        </div>
      </template>
      <!-- 远程克隆表单 -->
      <template v-else>
        <div id="dlg-clone-title" class="mb-3 text-base font-semibold">从远程克隆</div>
        <Input
          v-model="url"
          v-focus
          placeholder="远程地址：https://host/user/repo.git 或 git@host:user/repo.git"
          @keydown.esc="emit('close', $event)"
        />
        <div class="mt-2 flex items-center gap-2">
          <Button variant="secondary" size="sm" class="shrink-0" @click="emit('pick-parent')">
            选择位置…
          </Button>
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" :title="cloneParent">
            {{ cloneParent || "未选择克隆到哪个目录" }}
          </span>
        </div>
        <Input
          v-model="cloneName"
          class="mt-2"
          placeholder="目录名（输入地址后自动推断，可修改）"
          @input="emit('touch-name')"
          @keydown.enter.prevent="emit('confirm-clone', $event)"
          @keydown.esc="emit('close', $event)"
        />
        <div v-if="cloneErr" class="mt-2 text-xs text-destructive">
          {{ cloneErr }}
          <details v-if="cloneErrDetail" class="mt-1">
            <summary class="cursor-pointer text-muted-foreground">详细信息</summary>
            <pre class="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{{ cloneErrDetail }}</pre>
          </details>
        </div>
        <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
          将克隆到「位置 / 目录名」，完成后自动打开。认证走系统凭据（credential helper / ssh key）。
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" @click="emit('close')">取消</Button>
          <Button
            variant="default"
            size="sm"
            :disabled="!url.trim() || !cloneParent || !cloneName.trim() || cloneBusy"
            @click="emit('start-clone')"
          >
            <Spinner v-if="cloneBusy" :size="14" />
            {{ cloneBusy ? "克隆中…" : "克隆并打开" }}
          </Button>
        </div>
      </template>
    </div>
  </div>
</template>
