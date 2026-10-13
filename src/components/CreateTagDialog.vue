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
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-create-tag-title"
    @click.self="open = false"
  >
    <div class="w-dlg-md surface rounded-lg p-5 pop-in">
      <div id="dlg-create-tag-title" class="mb-3 text-base font-semibold">新建标签</div>
      <Input
        v-model="name"
        v-focus
        placeholder="标签名，如 v1.0.0"
        @keydown.enter.prevent="imeConfirm"
        @keydown.esc="imeClose"
      />
      <Input
        v-model="msg"
        class="mt-2"
        placeholder="附注信息（可选，填写即创建附注标签）"
        @keydown.esc="imeClose"
      />
      <p class="mt-2 text-xs text-muted-foreground">
        基于{{ tagTarget ? `提交 ${tagTarget.slice(0, 10)}` : `当前 HEAD（${status?.branch || "—"}）` }}创建。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" @click="open = false">取消</Button>
        <Button variant="default" size="sm" :disabled="!name.trim() || busy" @click="emit('confirm')">
          创建
        </Button>
      </div>
    </div>
  </div>
</template>
