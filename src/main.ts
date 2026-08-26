import { createApp } from "vue";
import App from "./App.vue";
import { applySettings } from "./settings";
import "./style.css";

applySettings(); // 主题/字体/diff 颜色在挂载前生效，避免闪默认样式
createApp(App).mount("#app");
