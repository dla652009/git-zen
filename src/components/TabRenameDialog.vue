<script setup lang="ts">
import { imeGuard } from "../lib/imeGuard";
import { Button, Input } from "@/components/ui";

// open 由 App.vue 的 renameTarget 推导（overlayLayers.tabRename 指向它）
const open = defineModel<boolean>("open", { required: true });
const draft = defineModel<string>("draft", { required: true });

defineProps<{ path: string }>();

const emit = defineEmits<{ confirm: [] }>();

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
    aria-labelledby="dlg-rename-tab-title"
    @click.self="open = false"
  >
    <div class="w-dlg-sm surface rounded-lg p-5 pop-in">
      <div id="dlg-rename-tab-title" class="mb-3 text-base font-semibold">重命名仓库选项卡</div>
      <Input
        v-model="draft"
        v-focus
        @keydown.enter.prevent="imeConfirm"
        @keydown.esc="imeClose"
      />
      <p class="mt-1.5 truncate text-xs text-muted-foreground">{{ path }}</p>
      <div class="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="open = false">取消</Button>
        <Button variant="default" size="sm" @click="emit('confirm')">确定</Button>
      </div>
    </div>
  </div>
</template>
