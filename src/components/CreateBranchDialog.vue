<script setup lang="ts">
import type { Status } from "../gitApi";
import { imeGuard } from "../lib/imeGuard";
import { Button, Input, Select } from "@/components/ui";

// open 与草稿都留在 App.vue（overlayLayers 的 Esc 分层关闭表要指向 open，见 AGENTS.md 硬性规则 6）
const open = defineModel<boolean>("open", { required: true });
const prefix = defineModel<string>("prefix", { required: true });
const name = defineModel<string>("name", { required: true });

defineProps<{
  prefixes: string[];
  status: Status | null;
  busy: boolean;
}>();

const emit = defineEmits<{ confirm: [] }>();

// IME 守卫：键盘事件在本组件模板上，守卫也就得在这。只能挂 keydown（见 lib/imeGuard.ts）
const imeConfirm = imeGuard(() => emit("confirm"));
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-create-branch-title"
    @click.self="open = false"
  >
    <div class="w-dlg-md surface rounded-lg p-5 pop-in">
      <div id="dlg-create-branch-title" class="mb-3 text-base font-semibold">新建分支</div>
      <div class="flex gap-2">
        <Select
          v-model="prefix"
          class="w-32 shrink-0"
          :options="[
            { value: '', label: '无前缀' },
            ...prefixes.map((p: string) => ({ value: p, label: p })),
          ]"
        />
        <Input v-model="name" placeholder="分支名" @keydown.enter.prevent="imeConfirm" />
      </div>
      <p class="mt-2 text-xs text-muted-foreground">
        基于当前分支 {{ status?.branch || "—" }} 创建并自动切换。
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
