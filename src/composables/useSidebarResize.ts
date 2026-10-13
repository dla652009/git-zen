// 侧栏拖宽 + 持久化。
// 从 App.vue 抽出来的第一批之一：这块只依赖 window 与 localStorage，没有业务耦合。

import { ref } from "vue";

// 中间区的最小宽度。侧栏上限不能只看固定像素：最小窗口 860px 时 420+520 足够把中间
// 内容挤没（审查实测两侧合计可占 61%），所以上限还要跟窗口宽度取小。
const MIN_CENTER = 460;
const LEFT_MIN = 140;
const LEFT_MAX = 420;
const RIGHT_MIN = 240;
const RIGHT_MAX = 520;

export function useSidebarResize() {
  const leftW = ref(Number(localStorage.getItem("gz.w.left")) || 208);
  const rightW = ref(Number(localStorage.getItem("gz.w.right")) || 320);
  let resizing: "l" | "r" | null = null;

  function maxLeftW() {
    return Math.max(LEFT_MIN, Math.min(LEFT_MAX, window.innerWidth - rightW.value - MIN_CENTER));
  }
  function maxRightW() {
    return Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, window.innerWidth - leftW.value - MIN_CENTER));
  }

  // 窗口变窄时把已存/已拖的宽度收回来。只改 ref 不写回 localStorage——
  // 用户在大窗口下的偏好宽度应该保留，回到大窗口时还能用。
  function clampSidebars() {
    if (leftW.value > maxLeftW()) leftW.value = maxLeftW();
    if (rightW.value > maxRightW()) rightW.value = maxRightW();
  }

  function onResizeMove(e: MouseEvent) {
    if (resizing === "l") leftW.value = Math.min(maxLeftW(), Math.max(LEFT_MIN, e.clientX));
    else rightW.value = Math.min(maxRightW(), Math.max(RIGHT_MIN, window.innerWidth - e.clientX));
  }

  function endResize() {
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", endResize);
    if (resizing) {
      localStorage.setItem(
        resizing === "l" ? "gz.w.left" : "gz.w.right",
        String(resizing === "l" ? leftW.value : rightW.value),
      );
    }
    document.body.style.cursor = "";
    resizing = null;
  }

  function startResize(side: "l" | "r") {
    resizing = side;
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", endResize);
  }

  return { leftW, rightW, startResize, clampSidebars };
}
