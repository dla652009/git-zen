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

// 每条提示自己的倒计时。鼠标停上去时整组暂停 —— 展开是为了读，
// 读到一半被自己触发的超时收走，展开就成了摆设。
interface TimerState {
  startedAt: number;
  remaining: number;
  handle: ReturnType<typeof setTimeout> | null;
}
const timers = new Map<number, TimerState>();
let paused = false;

function armTimer(id: number, st: TimerState) {
  st.startedAt = Date.now();
  st.handle = setTimeout(() => dismiss(id), st.remaining);
}

function dismiss(id: number) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i !== -1) toasts.splice(i, 1);
  timers.delete(id);
}

export function toast(text: string, kind: ToastKind = "success") {
  const id = ++seq;
  toasts.push({ id, text, kind });
  // 超出上限丢掉最旧的一条：它的计时器也要一起清，否则会在 id 早已消失后触发一次空查找
  while (toasts.length > 4) {
    const dropped = toasts.shift();
    if (dropped) {
      const st = timers.get(dropped.id);
      if (st?.handle) clearTimeout(st.handle);
      timers.delete(dropped.id);
    }
  }
  const st: TimerState = { startedAt: 0, remaining: DURATION, handle: null };
  timers.set(id, st);
  // 展开状态下新来的那条同样不自动消失：用户正停在那里看
  if (!paused) armTimer(id, st);
}

/** 暂停整组倒计时（鼠标移入展开时调用） */
export function pauseToasts() {
  if (paused) return;
  paused = true;
  const now = Date.now();
  for (const st of timers.values()) {
    if (st.handle !== null) {
      clearTimeout(st.handle);
      st.handle = null;
      st.remaining = Math.max(0, st.remaining - (now - st.startedAt));
    }
  }
}

/** 恢复倒计时（鼠标移出时调用）：按各自的剩余时间继续，而不是重新计满 */
export function resumeToasts() {
  if (!paused) return;
  paused = false;
  for (const [id, st] of timers) {
    if (st.handle === null) armTimer(id, st);
  }
}
