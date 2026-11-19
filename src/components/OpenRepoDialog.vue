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
    @click.self="!cloneBusy && emit('close')"
  >
    <div class="dialog-shell w-dlg-lg surface rounded-lg pop-in">
      <template v-if="open === 'choose'">
        <header class="dialog-header">
          <div id="dlg-open-repo-title" class="dialog-title">打开仓库</div>
        </header>
        <div class="dialog-body">
          <div class="repo-entry-grid">
            <button
              class="cursor-pointer rounded-sm surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-hover"
              @click="emit('choose-local')"
            >
              <FolderOpen class="mb-2 size-5 text-primary" />
              <span class="block text-sm font-medium">本地目录</span>
              <span class="mt-1 block text-xs leading-relaxed text-muted-foreground">选择本机已有的 Git 仓库</span>
            </button>
            <button
              class="cursor-pointer rounded-sm surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-hover"
              @click="emit('remote')"
            >
              <Download class="mb-2 size-5 text-primary" />
              <span class="block text-sm font-medium">从远程克隆</span>
              <span class="mt-1 block text-xs leading-relaxed text-muted-foreground">输入远程地址，克隆后自动打开</span>
            </button>
            <button
              class="repo-entry-wide flex cursor-pointer items-center gap-3 rounded-sm surface-panel p-4 text-left transition-colors duration-fast hover:border-primary/60 hover:bg-hover"
              @click="emit('init-repo')"
            >
              <FolderPlus class="size-5 shrink-0 text-primary" />
              <span class="min-w-0"><span class="block text-sm font-medium">初始化新仓库</span><span class="mt-1 block text-xs leading-relaxed text-muted-foreground">在选中的目录中创建 Git 仓库</span></span>
            </button>
          </div>
        </div>
        <footer class="dialog-footer">
          <Button variant="ghost" size="sm" @click="emit('close')">关闭</Button>
        </footer>
      </template>
      <template v-else>
        <header class="dialog-header">
          <div id="dlg-clone-title" class="dialog-title">从远程克隆</div>
        </header>
        <div class="dialog-body space-y-4">
          <label class="dialog-field text-xs">
            <span class="font-medium">远程地址</span>
            <Input v-model="url" v-focus :disabled="cloneBusy" placeholder="HTTPS 地址或 SSH 地址" @keydown.esc="emit('close', $event)" />
          </label>
          <div class="dialog-field text-xs">
            <span class="font-medium">保存位置</span>
            <div class="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" :disabled="cloneBusy" @click="emit('pick-parent')">选择位置…</Button>
              <span class="min-w-0 flex-1 break-all text-muted-foreground" :title="cloneParent">{{ cloneParent || '尚未选择位置' }}</span>
            </div>
          </div>
          <label class="dialog-field text-xs">
            <span class="font-medium">目录名称</span>
            <Input v-model="cloneName" :disabled="cloneBusy" placeholder="根据远程地址推断，也可自行修改" @input="emit('touch-name')" @keydown.enter.prevent="emit('confirm-clone', $event)" @keydown.esc="emit('close', $event)" />
          </label>
          <div class="rounded-sm border border-border bg-muted p-3 text-xs">
            <span class="text-muted-foreground">克隆目标</span>
            <div class="mt-1 break-all font-mono">{{ cloneParent && cloneName.trim() ? cloneParent.replace(/[\/]+$/, '') + '/' + cloneName.trim() : '选择位置并填写目录名后显示' }}</div>
          </div>
          <div v-if="cloneErr" role="alert" class="text-xs leading-relaxed text-destructive">
            {{ cloneErr }}
            <details v-if="cloneErrDetail" class="mt-2 rounded-sm border border-border p-2">
              <summary class="cursor-pointer text-muted-foreground">详细信息</summary>
              <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ cloneErrDetail }}</pre>
            </details>
          </div>
        </div>
        <footer class="dialog-footer">
          <span v-if="cloneBusy" class="mr-auto text-xs text-muted-foreground">正在克隆，请稍候…</span>
          <Button variant="ghost" size="sm" :disabled="cloneBusy" @click="emit('close')">取消</Button>
          <Button variant="default" size="sm" :disabled="!url.trim() || !cloneParent || !cloneName.trim() || cloneBusy" @click="emit('start-clone')"><Spinner v-if="cloneBusy" :size="14" />{{ cloneBusy ? '克隆中…' : '克隆并打开' }}</Button>
        </footer>
      </template>
    </div>
  </div>
</template>
