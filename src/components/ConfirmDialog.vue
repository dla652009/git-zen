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
  /** 默认 destructive：这个框原本只为删除/丢弃/强推这类操作而生。
   *  推送前预览是「确认但不是破坏」，传 default 才不会误用红色当主按钮 */
  okVariant?: "destructive" | "default";
  /** 结构化清单（如待推送的提交）。有它就用列表渲染，正文只留一句结论 */
  details?: { hash: string; text: string }[];
  /** 清单下面的一行补充说明（例如「可在设置里关掉」） */
  note?: string;
  /** 本次推送的增删行数。用 diff 的两组色（bg+text）渲染成小胶囊：
   *  直接拿 --c-add/--c-del 当文字色在 catppuccin-latte(4.18) 与 one-dark(3.73) 上不达 4.5，
   *  而 --diff-add-text 对 --diff-add-bg 这组本来就按文字阈值入过门 */
  stats?: { add: number; del: number };
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
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{{ body }}</span>
        <span v-if="stats" class="inline-flex items-center gap-1 font-mono text-xs">
          <span class="rounded bg-[var(--diff-add-bg)] px-1.5 py-0.5 text-[var(--diff-add-text)]">
            +{{ stats.add }}
          </span>
          <span class="rounded bg-[var(--diff-del-bg)] px-1.5 py-0.5 text-[var(--diff-del-text)]">
            −{{ stats.del }}
          </span>
        </span>
      </div>
      <div
        v-if="details?.length"
        class="mt-3 max-h-56 overflow-auto rounded-md border border-border-soft bg-background/40 p-2"
      >
        <div
          v-for="d in details"
          :key="d.hash + d.text"
          class="flex gap-2 py-0.5 text-xs"
        >
          <code class="shrink-0 font-mono text-muted-foreground">{{ d.hash }}</code>
          <span class="min-w-0 break-words">{{ d.text }}</span>
        </div>
      </div>
      <p v-if="note" class="mt-2 text-xs text-muted-foreground">{{ note }}</p>
      <label v-if="checkbox" class="mt-2 flex cursor-pointer items-center gap-2 text-xs">
        <input v-model="checked" type="checkbox" class="accent-[var(--primary)]" />
        {{ checkbox }}
      </label>
      <div class="mt-5 flex justify-end gap-2">
        <!-- 危险操作的安全默认：焦点落「取消」，Enter 天然触发取消而非确认 -->
        <Button v-focus variant="ghost" size="sm" @click="open = false">取消</Button>
        <Button :variant="okVariant ?? 'destructive'" size="sm" @click="emit('confirm')">
          {{ okText ?? "确认执行" }}
        </Button>
      </div>
    </div>
  </div>
</template>
