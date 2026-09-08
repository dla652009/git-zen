// 轻量成功提示：模块级单例，任何地方 import { toast() } 直接调用，免 props/emits 层层传递。
// 只承载「成功反馈」；错误仍走居中确认框
import { reactive } from "vue";

export interface ToastItem {
  id: number;
  text: string;
}

export const toasts = reactive<ToastItem[]>([]);
let seq = 0;

export function toast(text: string) {
  const id = ++seq;
  toasts.push({ id, text });
  if (toasts.length > 4) toasts.shift();
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i !== -1) toasts.splice(i, 1);
  }, 2400);
}
