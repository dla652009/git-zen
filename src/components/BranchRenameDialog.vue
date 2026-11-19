<script setup lang="ts">
import { imeGuard } from "../lib/imeGuard";
import { Button, Input } from "@/components/ui";

// open 由 App.vue 的 branchRename 推导（overlayLayers.branchRename 指向它）
const open = defineModel<boolean>("open", { required: true });
const draft = defineModel<string>("draft", { required: true });

defineProps<{ branchName: string }>();

const emit = defineEmits<{ confirm: [] }>();

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
      aria-labelledby="dlg-rename-branch-title"
      @click.self="open = false"
    >
      <div class="dialog-shell w-dlg-sm surface rounded-lg pop-in">
        <header class="dialog-header">
          <div id="dlg-rename-branch-title" class="dialog-title">重命名分支</div>
        </header>
        <div class="dialog-body space-y-4">
          <div class="rounded-sm border border-border bg-muted p-3 text-xs">
            <span class="text-muted-foreground">原分支名称</span>
            <div class="mt-1 break-all font-mono">{{ branchName }}</div>
          </div>
          <label class="dialog-field text-xs">
            <span class="font-medium">新分支名称</span>
            <Input v-model="draft" v-focus @keydown.enter.prevent="imeConfirm" @keydown.esc="imeClose" />
          </label>
        </div>
        <footer class="dialog-footer">
          <Button variant="ghost" size="sm" @click="open = false">取消</Button>
          <Button variant="default" size="sm" :disabled="!draft.trim()" @click="emit('confirm')">重命名分支</Button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
