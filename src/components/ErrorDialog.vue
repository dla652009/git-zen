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
  <Transition name="dlg">
    <div
      v-if="open"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-error-title"
      @click.self="open = false"
    >
      <div class="dialog-shell w-dlg-md rounded-lg border border-destructive/40 bg-elevated shadow-elev-4 pop-in">
        <header class="dialog-header">
          <div id="dlg-error-title" class="dialog-title text-destructive">操作失败</div>
        </header>
        <div class="dialog-body space-y-4 text-sm leading-relaxed">
          <p class="whitespace-pre-line break-words">{{ message }}</p>
          <details v-if="detail" class="rounded-sm border border-border p-3">
            <summary class="cursor-pointer text-xs text-muted-foreground">查看详细信息</summary>
            <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ detail }}</pre>
          </details>
        </div>
        <footer class="dialog-footer">
          <Button v-if="canRetry" variant="secondary" size="sm" @click="emit('retry')">重试</Button>
          <Button variant="secondary" size="sm" @click="open = false">知道了</Button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
