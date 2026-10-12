import type { Directive } from "vue";
import { nextTick } from "vue";

/**
 * v-trap —— 模态弹层的焦点陷阱。
 *
 * 挂在弹层最外层容器（带 role="dialog" 的那个元素）上，负责三件事：
 *   1. 打开时把焦点移进弹层；若内部已有元素拿到焦点则不抢（尊重 v-focus 与「初始焦点给取消」）
 *   2. Tab / Shift+Tab 在弹层内循环，不再穿透到遮罩背后
 *   3. 关闭时把焦点还给打开它的那个元素
 *
 * 刻意**不处理 Esc**：全局 closeTopOverlay() 已有一套分层关闭链，重复处理会打架。
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video[controls]",
  "audio[controls]",
  // details 的 summary 默认可聚焦，但它没有 tabindex 属性，靠下面那条匹配不到。
  // 漏了它会出真问题：错误框里「详细信息」是唯一的 summary，此时陷阱内只剩「确认」一个
  // 可聚焦元素，first === last，Tab 被永远拦在「确认」上，summary 变成键盘不可达。
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** checkVisibility 在较新的 WebView2 才有，取不到就退回 getClientRects */
type MaybeCheckVisibility = HTMLElement & {
  checkVisibility?: (opts?: { checkVisibilityCSS?: boolean }) => boolean;
};

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
  const check = (el as MaybeCheckVisibility).checkVisibility;
  if (typeof check === "function") return check.call(el, { checkVisibilityCSS: true });
  return el.getClientRects().length > 0;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

interface TrapState {
  /** 打开弹层前持有焦点的元素，关闭时还给它 */
  opener: HTMLElement | null;
  onKeydown: (e: KeyboardEvent) => void;
}

const traps = new WeakMap<HTMLElement, TrapState>();

export const vTrap: Directive<HTMLElement> = {
  mounted(el) {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;

    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables(el);
      if (!list.length) {
        e.preventDefault(); // 没有可聚焦元素，焦点留在弹层上
        el.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const cur = document.activeElement as HTMLElement | null;
      // 焦点不在弹层内（例如被脚本挪到 body），下一次 Tab 直接拉回来
      if (!cur || !el.contains(cur)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && cur === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault();
        first.focus();
      }
    };

    traps.set(el, { opener, onKeydown });
    el.addEventListener("keydown", onKeydown);

    // 容器自身可聚焦：弹层内没有任何可聚焦元素时，焦点至少有个落脚点
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");

    // 兜底聚焦放到 nextTick，顺序上就永远安全：
    // 若内部已有 v-focus 或调用方自己 nextTick 聚焦了某个元素，这里会看到焦点已在弹层内而跳过；
    // 若两者都没做，才由这里把焦点移进弹层。不依赖 Vue 子先父后的 mounted 顺序。
    nextTick(() => {
      if (!el.isConnected) return;
      if (el.contains(document.activeElement)) return;
      (focusables(el)[0] ?? el).focus();
    });
  },

  unmounted(el) {
    const s = traps.get(el);
    if (!s) return;
    el.removeEventListener("keydown", s.onKeydown);
    traps.delete(el);
    if (s.opener && s.opener.isConnected) s.opener.focus();
  },
};
