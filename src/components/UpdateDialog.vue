<script setup lang="ts">
// 新版本提示 / 下载进度 / 安装失败重试。
// 收成一个组件而不是散在 App 里：这三种状态互斥且共用同一套布局，
// 分开写必然出现「进度条和错误框同时挂着」这类叠状态。
//
// 布局分工：版本号与状态在固定标题区，版本说明（可能很长）和错误正文各自在框内滚动，
// 动作固定在底部。下载中不给关闭入口 —— 中途取消会留下半截文件，重启一次就好。
import { computed } from "vue";
import { Download, TriangleAlert } from "@lucide/vue";
import { Button } from "@/components/ui";
import type { UpdaterPhase } from "@/composables/useUpdater";

const phase = defineModel<UpdaterPhase>("phase", { required: true });

const emit = defineEmits<{ install: []; later: []; retry: []; close: [] }>();

/** 只有这三种状态值得占屏幕 */
const visible = computed(() =>
  ["available", "downloading", "ready", "error"].includes(phase.value.kind),
);
const percent = computed(() => {
  const p = phase.value;
  return p.kind === "downloading" ? p.percent : 0;
});
</script>

<template>
  <Transition name="dlg">
    <div
      v-if="visible"
      v-trap
      class="fixed inset-0 z-50 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-update-title"
      @click.self="phase.kind === 'downloading' ? null : emit('close')"
    >
      <div class="dialog-shell w-dlg-md surface rounded-lg pop-in">
        <header class="dialog-header">
          <div class="flex items-center gap-2">
            <Download class="size-4 shrink-0 text-primary" aria-hidden="true" />
            <div id="dlg-update-title" class="dialog-title min-w-0 flex-1 truncate">
              <template v-if="phase.kind === 'available'">有新版本 {{ phase.version }}</template>
              <template v-else-if="phase.kind === 'downloading'">正在下载 {{ phase.version }}</template>
              <template v-else-if="phase.kind === 'ready'">安装完成，即将重启</template>
              <template v-else>更新失败</template>
            </div>
            <span v-if="phase.kind === 'downloading'" class="shrink-0 text-xs text-muted-foreground tabular-nums">
              {{ percent < 0 ? "下载中…" : percent + "%" }}
            </span>
          </div>
          <p v-if="phase.kind === 'available' && phase.date" class="mt-1 text-xs text-muted-foreground">
            发布于 {{ phase.date }}
          </p>
          <p v-else-if="phase.kind === 'downloading'" class="mt-1 text-xs text-muted-foreground">
            下载期间不能关闭这个窗口，完成后会自动重启。
          </p>
        </header>

        <div class="dialog-body">
          <!-- 更新说明：git-zen 的 release notes 是 markdown，这里按纯文本展示。
               渲染 markdown 要引一个解析器，为一段版本说明不值得 -->
          <template v-if="phase.kind === 'available'">
            <pre
              v-if="phase.notes"
              class="rounded-sm bg-muted/60 p-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words"
              >{{ phase.notes }}</pre
            >
            <p v-else class="text-xs text-muted-foreground">本次更新没有附说明。</p>
          </template>

          <template v-else-if="phase.kind === 'downloading'">
            <div class="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                class="h-full rounded-full bg-primary transition-[width] duration-200"
                :style="{ width: percent < 0 ? '100%' : percent + '%' }"
                :class="percent < 0 && 'animate-pulse'"
              />
            </div>
            <p class="mt-2 text-xs tabular-nums text-muted-foreground">
              {{ percent < 0 ? "总大小未知，正在下载…" : `已完成 ${percent}%` }}
            </p>
          </template>

          <template v-else-if="phase.kind === 'ready'">
            <p class="text-xs leading-relaxed text-muted-foreground">应用会自动重启，无需手动操作。</p>
          </template>

          <template v-else-if="phase.kind === 'error'">
            <div class="flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2.5 py-2">
              <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
              <span class="min-w-0 flex-1 break-words text-xs leading-relaxed text-destructive">{{ phase.message }}</span>
            </div>
            <p class="mt-2 text-xs leading-relaxed text-muted-foreground">
              网络中断或安装包校验失败时常见，稍后重试通常就能过去；也可以先关掉，之后在设置 › 关于里再试。
            </p>
          </template>
        </div>

        <!-- 下载中与安装完成都不给任何按钮：中途取消会留下半截文件，重启一次就好。
             没有动作就不画动作区，否则底部会挂着一条空的分隔线。 -->
        <footer v-if="phase.kind === 'available' || phase.kind === 'error'" class="dialog-footer">
          <template v-if="phase.kind === 'available'">
            <Button variant="ghost" size="sm" @click="emit('later')">稍后</Button>
            <Button variant="default" size="sm" @click="emit('install')">下载并安装</Button>
          </template>
          <template v-else>
            <Button variant="ghost" size="sm" @click="emit('close')">关闭</Button>
            <Button variant="default" size="sm" @click="emit('retry')">重试</Button>
          </template>
        </footer>
      </div>
    </div>
  </Transition>
</template>
