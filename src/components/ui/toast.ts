// 轻量提示：模块级单例，任何地方 import { toast() } 直接调用，免 props/emits 层层传递。
// 只承载「操作结果」这类一次性反馈；需要用户决策的错误仍走居中确认框。
import { reactive } from "vue";

/**
 * success —— 操作成功（默认）
 * info    —— 说明「什么也没发生」的原因（如没有可关闭的选项卡）
 * warn    —— 操作完成了但结果需要留意（如合并留下了冲突）
 */
export type ToastKind = "success" | "info" | "warn";

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

export const toasts = reactive<ToastItem[]>([]);
let seq = 0;

// 2600ms：带图标、字号也放大之后阅读成本下降，时间不必再拉长；
// 拉太长会一直挡着顶部的历史区。
const DURATION = 2600;

export function toast(text: string, kind: ToastKind = "success") {
  const id = ++seq;
  toasts.push({ id, text, kind });
  if (toasts.length > 4) toasts.shift();
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i !== -1) toasts.splice(i, 1);
  }, DURATION);
}
