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
  <Transition name="dlg">
    <div
      v-if="open"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-create-branch-title"
      @click.self="open = false"
    >
      <div class="dialog-shell w-dlg-md surface rounded-lg pop-in">
        <header class="dialog-header">
          <div id="dlg-create-branch-title" class="dialog-title">新建分支</div>
        </header>
        <div class="dialog-body space-y-4">
          <div class="dialog-two-fields">
            <label class="dialog-field text-xs">
              <span class="font-medium">分支前缀</span>
              <Select v-model="prefix" label="分支前缀" :options="[{ value: '', label: '无前缀' }, ...prefixes.map((p: string) => ({ value: p, label: p }))]" />
            </label>
            <label class="dialog-field text-xs">
              <span class="font-medium">分支名称</span>
              <Input v-model="name" placeholder="输入分支名称" @keydown.enter.prevent="imeConfirm" />
            </label>
          </div>
          <div class="rounded-sm border border-border bg-muted p-3 text-xs leading-relaxed">
            <span class="text-muted-foreground">基于当前分支</span>
            <div class="mt-1 break-all font-mono">{{ status?.branch || '—' }}</div>
            <p class="mt-1 text-muted-foreground">创建成功后自动切换到新分支。</p>
          </div>
        </div>
        <footer class="dialog-footer">
          <Button variant="ghost" size="sm" @click="open = false">取消</Button>
          <Button variant="default" size="sm" :disabled="!name.trim() || busy" @click="emit('confirm')">创建分支</Button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
