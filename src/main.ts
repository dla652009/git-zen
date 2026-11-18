import { createApp } from "vue";
import App from "./App.vue";
import { applySettings } from "./settings";
import { vTrap } from "./lib/focusTrap";
import { vFocus } from "./lib/focus";
import "./style.css";

applySettings(); // 主题/字体/diff 颜色在挂载前生效，避免闪默认样式

const app = createApp(App);
app.directive("trap", vTrap);
// v-focus 也全局注册：浮层拆成子组件后，局部指令在子组件模板里会静默失效
app.directive("focus", vFocus);

// ---- 全局崩溃兜底：只记录、不打扰 ----
// 业务错误路径已经有 showError 提示，这里再弹一次只会重复打扰用户；
// 挂上 errorHandler 后 Vue 会吞掉组件异常，不会因单个组件报错整页白屏。
app.config.errorHandler = (err, instance, info) => {
  // 组件名：普通组件取 name，<script setup> 的组件取编译期注入的 __name
  const opts = instance?.$options as unknown as
    | { name?: string; __name?: string }
    | undefined;
  const name = opts?.name ?? opts?.__name ?? "未命名组件";
  console.error(`[git-zen] 组件异常（${name} / ${info}）:`, err);
};

window.addEventListener("unhandledrejection", (e) => {
  console.error("[git-zen] 未处理的 Promise 拒绝:", e.reason);
});

window.addEventListener("error", (e) => {
  console.error("[git-zen] 未捕获的错误:", e.error ?? e.message);
});

// ---- 禁用 WebView 的默认右键菜单 ----
// 桌面应用不该弹出「重新加载 / 检查元素 / 另存为」，那是浏览器的菜单。
// 应用自己的右键菜单（分支、文件、tag、远程）都在各自的 @contextmenu.prevent 里，
// 全局拦截不会影响它们。
//
// 但**输入框要放行**：提交信息框、搜索框、设置里的输入项都依赖原生的
// 剪切/复制/粘贴/全选，拦掉会让这些框变得没法正常用（尤其是粘贴，
// 很多人右键粘贴而不是 Ctrl+V）。
// 用 composedPath 而不是 e.target：输入框在 Shadow DOM 里时 target 会被
// 重定向到宿主元素，拿不到真实焦点元素。
window.addEventListener(
  "contextmenu",
  (e) => {
    const path = e.composedPath();
    const inEditable = path.some((n) => {
      if (!(n instanceof HTMLElement)) return false;
      if (n.isContentEditable) return true;
      return n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement;
    });
    if (inEditable) return; // 放行：保留原生编辑菜单
    e.preventDefault();
  },
  { capture: true }, // 捕获阶段拦，先于组件上的 @contextmenu 生效
);

app.mount("#app");
