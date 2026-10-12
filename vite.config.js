import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// 从模块 id 里取 npm 包名。pnpm 的真实路径长这样：
//   <root>/node_modules/.pnpm/vue@3.5.13/node_modules/vue/dist/runtime-dom.esm-bundler.js
// 取「最后一个 /node_modules/」之后的片段，对 hoisted 与 .pnpm 两种布局都成立。
function packageNameOf(id) {
  const clean = id.split("?")[0].replace(/\\/g, "/");
  const marker = "/node_modules/";
  const at = clean.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = clean.slice(at + marker.length).split("/");
  if (!parts[0]) return null;
  // 作用域包 @scope/name
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

// markdown-it 及它的运行时依赖：单独成 chunk，避免整包跟着主包一起失效
const MARKDOWN_PACKAGES = new Set([
  "markdown-it",
  "mdurl",
  "uc.micro",
  "entities",
  "linkify-it",
  "punycode.js",
]);

// 分包策略：只拆「大且稳定」的第三方依赖，业务代码仍留在主 chunk。
// 桌面应用从本地磁盘加载，首屏收益有限，拆包主要让缓存失效更精确。
function manualChunks(id) {
  const pkg = packageNameOf(id);
  if (!pkg) return undefined;
  if (pkg === "vue" || pkg.startsWith("@vue/")) return "vendor-vue";
  if (MARKDOWN_PACKAGES.has(pkg)) return "vendor-markdown";
  if (pkg === "@lucide/vue") return "vendor-icons";
  return undefined;
}

// Tauri CLI 在 `tauri dev` / `tauri build` 时会注入 TAURI_ENV_PLATFORM（windows/darwin/linux）
const isWindows = process.env.TAURI_ENV_PLATFORM === "windows";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Tauri 官方模板的做法：src-tauri/target 下有上千个 cargo 产物，
    // 不排除掉会让 chokidar 白盯一堆文件、HMR 抖动
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // 转译目标：Windows 端是 WebView2（Chromium），macOS 是 WKWebView，Linux 是 WebKitGTK。
    // chrome105 覆盖 WebView2；其余平台保守取 safari13（对应 macOS 10.15 的 WKWebView 下限，
    // 同时满足 Tauri 2 要求的 webkit2gtk-4.1）。直接 `vite build` 时没有 TAURI_ENV_PLATFORM，
    // 会落到 safari13——宁可多转译一点，也不让某个平台加载不了。
    target: isWindows ? "chrome105" : "safari13",
    // release 优先包体积：默认不产出 sourcemap。
    // 需要排查打包后的问题时，改成 sourcemap: "hidden"（生成 .map 但不在文件末尾留注释），
    // 或临时设成 true；也可以在 tauri dev 下用 TAURI_ENV_DEBUG 环境变量打开。
    sourcemap: false,
    rollupOptions: {
      output: { manualChunks },
    },
  },
});
