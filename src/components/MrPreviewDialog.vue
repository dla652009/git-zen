<script setup lang="ts">
import { Button, Input, Spinner, Textarea } from "@/components/ui";

// open 与字段都留在 App.vue（overlayLayers.mrPreview 的 Esc 分层关闭要指向 open，见 AGENTS.md 规则 6）
const open = defineModel<boolean>("open", { required: true });
const title = defineModel<string>("title", { required: true });
const body = defineModel<string>("body", { required: true });

defineProps<{
  /** 源 / 目标分支：只读展示，生成与打开都基于发起时的快照 */
  src: string;
  dst: string;
  busy: boolean;
  err: string;
  /** false = 主机不支持 URL 预填，复制标题正文到剪贴板 */
  supportsPrefill: boolean;
}>();

const emit = defineEmits<{ regen: []; confirm: []; copy: [] }>();
</script>

<template>
  <Transition name="dlg">
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-mr-title"
    @click.self="open = false"
  >
    <div class="w-dlg-md surface rounded-lg p-5 pop-in">
      <div id="dlg-mr-title" class="mb-1 text-base font-semibold">新建合并请求</div>
      <p class="mb-3 break-all text-xs text-muted-foreground">
        {{ src || "—" }} → {{ dst || "—" }}
      </p>

      <Spinner v-if="busy" label="正在读取 diff 与生成标题、描述…" />

      <div v-else class="space-y-3">
        <div
          v-if="err"
          class="flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
        >
          <span class="min-w-0 flex-1 break-words">{{ err }}</span>
          <Button variant="quiet" size="sm" class="shrink-0" @click="emit('regen')">重试</Button>
        </div>

        <div>
          <label class="mb-1 block text-xs text-muted-foreground">标题</label>
          <Input v-model="title" placeholder="合并请求标题" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-muted-foreground">描述</label>
          <Textarea v-model="body" rows="8" placeholder="合并请求描述（可编辑）" />
        </div>
        <p v-if="!supportsPrefill" class="text-xs text-muted-foreground">
          当前主机不支持 URL 预填：会先复制标题与描述，打开新建页后粘贴即可。
        </p>
      </div>

      <div class="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" @click="open = false">取消</Button>
        <span class="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          :disabled="busy || (!title.trim() && !body.trim())"
          @click="emit('copy')"
        >
          复制到剪贴板
        </Button>
        <Button variant="secondary" size="sm" :disabled="busy" @click="emit('regen')">
          重新生成
        </Button>
        <Button variant="default" size="sm" :disabled="busy" @click="emit('confirm')">
          {{ supportsPrefill ? "打开 MR 页" : "复制并打开 MR 页" }}
        </Button>
      </div>
    </div>
  </div>
  </Transition>
</template>
