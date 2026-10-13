<script setup lang="ts">
import { Button } from "@/components/ui";

// open 由 App.vue 的 error 推导（overlayLayers.error 指向它）
const open = defineModel<boolean>("open", { required: true });

defineProps<{
  message: string;
  detail: string;
  // 只有 run() 包起来的操作才有重试入口，校验类错误不传
  canRetry: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-error-title"
    @click.self="open = false"
  >
    <!-- 错误框不用 surface：它要保持红色描边，会和 surface 自带的 border 打架 -->
    <div class="w-dlg-md rounded-lg border border-destructive/40 bg-elevated p-5 shadow-elev-4 pop-in">
      <div id="dlg-error-title" class="mb-3 text-base font-semibold text-destructive">操作失败</div>
      <div>{{ message }}</div>
      <details v-if="detail" class="mt-2">
        <summary class="cursor-pointer text-xs text-muted-foreground">详细信息</summary>
        <pre class="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{{ detail }}</pre>
      </details>
      <div class="mt-5 flex justify-end gap-2">
        <!-- 只对 run() 包起来的操作给重试：那是「重放一次同样的调用」，校验类错误重试没意义 -->
        <Button v-if="canRetry" variant="secondary" size="sm" @click="emit('retry')">重试</Button>
        <Button variant="secondary" size="sm" @click="open = false">知道了</Button>
      </div>
    </div>
  </div>
</template>
