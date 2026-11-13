<script setup lang="ts">
// 自绘窗口标题栏 —— tauri.conf.json 里 decorations:false 之后，窗口唯一的镶边就是它。
//
// 拖动与「双击最大化」都交给 Tauri 内置的 data-tauri-drag-region="deep"：它已经处理了
// 「点在按钮/链接上不算拖动」「双击切换最大化」「双击时禁止选中文字」（见 tauri 的
// src/window/scripts/drag.js）。自己再写一遍 mousedown 只会多一处和它抢事件的代码。
//
// 最大化图标必须靠 onResized 回来同步：双击、Win+↑、拖到屏幕上沿贴边都不经过本组件的点击。
//
// z-[90]：弹窗的遮罩在 z-30..80，但真窗口的标题栏永远可拖可关，不能被自己的弹窗盖住。
import { onMounted, onUnmounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, GitBranch, Minus, Square, X } from "@lucide/vue";

withDefaults(defineProps<{ title?: string }>(), { title: "Git Zen" });

const appWindow = getCurrentWindow();
const maximized = ref(false);
let unlisten: (() => void) | undefined;
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

// 拖动时 onResized 每帧都触发，而最大化态只在松手/双击后才变：节流到 120ms 少几次 IPC
async function syncMaximized() {
  try {
    maximized.value = await appWindow.isMaximized();
  } catch {
    /* 关窗过程中 IPC 会失败，图标错一下不值当冒泡 */
  }
}

function scheduleSync() {
  clearTimeout(timer);
  timer = setTimeout(() => void syncMaximized(), 120);
}

async function toggleMaximize() {
  try {
    await appWindow.toggleMaximize();
  } catch {
    /* 同上：窗口控制属非关键路径 */
  }
}

async function minimize() {
  try {
    await appWindow.minimize();
  } catch {
    /* 同上 */
  }
}

async function close() {
  try {
    await appWindow.close();
  } catch {
    /* 同上 */
  }
}

onMounted(async () => {
  void syncMaximized();
  const off = await appWindow.onResized(scheduleSync);
  // 监听注册是异步的：期间组件已卸载就别留下野监听
  if (disposed) off();
  else unlisten = off;
});

onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
  unlisten?.();
});
</script>

<template>
  <div
    data-titlebar
    class="relative z-[90] flex h-8 shrink-0 select-none items-center gap-2 border-b border-border bg-card pl-3 pr-1.5 text-xs text-muted-foreground"
    data-tauri-drag-region="deep"
  >
    <GitBranch class="size-3.5 shrink-0" aria-hidden="true" />
    <span class="truncate">{{ title }}</span>
    <span class="flex-1" />

    <div class="flex items-center gap-0.5 self-stretch">
      <button
        type="button"
        data-caption-btn="min"
        aria-label="最小化"
        title="最小化"
        class="grid w-11 place-items-center rounded-sm text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground"
        @click="minimize"
      >
        <Minus class="size-3.5" />
      </button>
      <button
        type="button"
        data-caption-btn="max"
        :aria-label="maximized ? '向下还原' : '最大化'"
        :title="maximized ? '向下还原' : '最大化'"
        class="grid w-11 place-items-center rounded-sm text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground"
        @click="toggleMaximize"
      >
        <Copy v-if="maximized" class="size-3.5" />
        <Square v-else class="size-3" />
      </button>
      <button
        type="button"
        data-caption-btn="close"
        aria-label="关闭"
        title="关闭"
        class="grid w-11 place-items-center rounded-sm text-muted-foreground transition-colors duration-fast hover:bg-[var(--btn-danger-bg)] hover:text-[var(--btn-danger-fg)]"
        @click="close"
      >
        <X class="size-4" />
      </button>
    </div>
  </div>

  <!-- 无边框窗口没有系统镶边：这 1px 内描边让窗口在任何桌面背景上都有一条清楚的边界。
       纯装饰，不吃鼠标事件，也不参与布局。 -->
  <div class="pointer-events-none fixed inset-0 z-[100] ring-1 ring-border/70 ring-inset" />
</template>
