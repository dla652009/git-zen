<script setup lang="ts">
import { Button, Input } from "@/components/ui";
import { imeGuard } from "../lib/imeGuard";

// open 由 App.vue 的 confirmState 推导（overlayLayers.confirm 指向它）；
// 确认结果（ok 回调 + run()）留在 App，这里只负责问
const open = defineModel<boolean>("open", { required: true });
const checked = defineModel<boolean>("checked", { required: true });
// 可选单行输入：用于「压成一条」这类需要先让用户改提交信息的确认
const text = defineModel<string>("text", { default: "" });

defineProps<{
  title: string;
  body: string;
  /** 有值时在清单下方渲染一个输入框（标签 + 初值由 App 传入） */
  input?: { label: string; placeholder?: string };
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
   *  直接拿 --c-add/--c-del 当文字色在 catppuccin-latte(4.18) 上不达 4.5（已下线的 one-dark 3.73 同理），
   *  而 --diff-add-text 对 --diff-add-bg 这组本来就按文字阈值入过门 */
  stats?: { add: number; del: number };
}>();

const emit = defineEmits<{ confirm: [] }>();
// 输入框里的 Enter 直接确认；组词中的 Enter 交给输入法
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
      aria-labelledby="dlg-confirm-title"
      @click.self="open = false"
    >
      <div class="dialog-shell w-dlg-md surface rounded-lg pop-in">
        <header class="dialog-header">
          <div id="dlg-confirm-title" class="dialog-title">{{ title }}</div>
        </header>
        <div class="dialog-body space-y-3 text-sm leading-relaxed">
          <p class="whitespace-pre-line break-words">{{ body }}</p>
          <div v-if="stats" class="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums">
            <span class="rounded-xs bg-[var(--diff-add-bg)] px-2 py-1 text-[var(--diff-add-text)]">+{{ stats.add }}</span>
            <span class="rounded-xs bg-[var(--diff-del-bg)] px-2 py-1 text-[var(--diff-del-text)]">−{{ stats.del }}</span>
          </div>
          <div v-if="details?.length" class="rounded-sm border border-border bg-muted p-2">
            <div v-for="d in details" :key="d.hash + d.text" class="flex items-start gap-2 py-1 text-xs">
              <code class="w-[5.5rem] shrink-0 break-all font-mono text-muted-foreground" :title="d.hash">{{ d.hash }}</code>
              <span class="min-w-0 flex-1 break-words">{{ d.text }}</span>
            </div>
          </div>
        </div>
        <footer class="dialog-footer">
          <!-- 校验/输入区与按钮分成两层：校验区自己限高滚动，按钮永远在它下面一行，
               短窗口 + 大字号下也不会出现「按钮被推出可视区」 -->
          <div v-if="input || note || checkbox" class="dialog-validation">
            <label v-if="input" class="dialog-field w-full text-xs">
              <span class="font-medium">{{ input.label }}</span>
              <Input v-model="text" :placeholder="input.placeholder" @keydown.enter.prevent="imeConfirm" />
            </label>
            <p v-if="note" class="w-full text-xs leading-relaxed text-muted-foreground">{{ note }}</p>
            <label v-if="checkbox" class="flex w-full cursor-pointer items-start gap-2 text-xs leading-relaxed">
              <input v-model="checked" type="checkbox" class="mt-0.5 shrink-0 accent-[var(--primary)]" />
              <span>{{ checkbox }}</span>
            </label>
          </div>
          <div class="flex w-full shrink-0 flex-wrap justify-end gap-2">
            <Button v-focus variant="ghost" size="sm" @click="open = false">取消</Button>
            <Button :variant="okVariant ?? 'destructive'" size="sm" @click="emit('confirm')">{{ okText ?? '确认执行' }}</Button>
          </div>
        </footer>
      </div>
    </div>
  </Transition>
</template>
