import { createApp } from "vue";
import App from "./App.vue";
import { applySettings } from "./settings";
import { vTrap } from "./lib/focusTrap";
import "./style.css";

applySettings(); // 主题/字体/diff 颜色在挂载前生效，避免闪默认样式

const app = createApp(App);
app.directive("trap", vTrap);

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

app.mount("#app");
