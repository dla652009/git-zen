<script setup lang="ts">
import type { Status } from "../gitApi";
import { imeGuard } from "../lib/imeGuard";
import { Button, Input } from "@/components/ui";

// open 与草稿都留在 App.vue（overlayLayers 的 Esc 分层关闭表要指向 open，见 AGENTS.md 硬性规则 6）
const open = defineModel<boolean>("open", { required: true });
const name = defineModel<string>("name", { required: true });
const msg = defineModel<string>("msg", { required: true });

defineProps<{
  tagTarget: string | null;
  status: Status | null;
  busy: boolean;
}>();

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
      aria-labelledby="dlg-create-tag-title"
      @click.self="open = false"
    >
      <div class="dialog-shell w-dlg-md surface rounded-lg pop-in">
        <header class="dialog-header">
          <div id="dlg-create-tag-title" class="dialog-title">新建标签</div>
        </header>
        <div class="dialog-body space-y-4">
          <label class="dialog-field text-xs">
            <span class="font-medium">标签名称</span>
            <Input v-model="name" v-focus placeholder="例如 v1.0.0" @keydown.enter.prevent="imeConfirm" @keydown.esc="imeClose" />
          </label>
          <label class="dialog-field text-xs">
            <span class="font-medium">附注信息 <span class="font-normal text-muted-foreground">（可选）</span></span>
            <Input v-model="msg" placeholder="填写后创建附注标签" @keydown.esc="imeClose" />
          </label>
          <div class="rounded-sm border border-border bg-muted p-3 text-xs">
            <span class="text-muted-foreground">标签指向</span>
            <div class="mt-1 break-all font-mono">{{ tagTarget || ('当前 HEAD · ' + (status?.branch || '—')) }}</div>
          </div>
        </div>
        <footer class="dialog-footer">
          <Button variant="ghost" size="sm" @click="open = false">取消</Button>
          <Button variant="default" size="sm" :disabled="!name.trim() || busy" @click="emit('confirm')">创建标签</Button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
