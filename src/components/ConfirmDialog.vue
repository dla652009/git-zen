<script setup lang="ts">
import { Button } from "@/components/ui";

// open 由 App.vue 的 confirmState 推导（overlayLayers.confirm 指向它）；
// 确认结果（ok 回调 + run()）留在 App，这里只负责问
const open = defineModel<boolean>("open", { required: true });
const checked = defineModel<boolean>("checked", { required: true });

defineProps<{
  title: string;
  body: string;
  checkbox?: string;
  okText?: string;
}>();

const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-confirm-title"
    @click.self="open = false"
  >
    <div class="w-dlg-md surface rounded-lg p-5 pop-in">
      <div id="dlg-confirm-title" class="mb-3 text-base font-semibold">{{ title }}</div>
      <div>{{ body }}</div>
      <label v-if="checkbox" class="mt-2 flex cursor-pointer items-center gap-2 text-xs">
        <input v-model="checked" type="checkbox" class="accent-[var(--primary)]" />
        {{ checkbox }}
      </label>
      <div class="mt-5 flex justify-end gap-2">
        <!-- 危险操作的安全默认：焦点落「取消」，Enter 天然触发取消而非确认 -->
        <Button v-focus variant="ghost" size="sm" @click="open = false">取消</Button>
        <Button variant="destructive" size="sm" @click="emit('confirm')">
          {{ okText ?? "确认执行" }}
        </Button>
      </div>
    </div>
  </div>
</template>
