<script setup lang="ts">
// 新版本提示 / 下载进度 / 安装失败重试。
// 收成一个组件而不是散在 App 里：这三种状态互斥且共用同一套布局，
// 分开写必然出现「进度条和错误框同时挂着」这类叠状态。
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
      <div class="w-dlg-md surface rounded-lg p-5 pop-in">
        <div id="dlg-update-title" class="mb-1 flex items-center gap-2 text-base font-semibold">
          <Download class="size-4 text-primary" />
          <template v-if="phase.kind === 'available'">有新版本 {{ phase.version }}</template>
          <template v-else-if="phase.kind === 'downloading'">正在下载 {{ phase.version }}</template>
          <template v-else-if="phase.kind === 'ready'">安装完成，即将重启</template>
          <template v-else>更新失败</template>
        </div>

        <!-- 更新说明：git-zen 的 release notes 是 markdown，这里按纯文本展示。
             渲染 markdown 要引一个解析器，为一段版本说明不值得 -->
        <template v-if="phase.kind === 'available'">
          <p v-if="phase.date" class="mb-2 text-xs text-muted-foreground">发布于 {{ phase.date }}</p>
          <pre
            v-if="phase.notes"
            class="mb-3 max-h-52 overflow-y-auto rounded-sm bg-muted/60 p-2.5 text-xs leading-relaxed whitespace-pre-wrap"
            >{{ phase.notes }}</pre
          >
          <p v-else class="mb-3 text-xs text-muted-foreground">本次更新没有附说明。</p>
        </template>

        <template v-else-if="phase.kind === 'downloading'">
          <div class="mt-3 mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-200"
              :style="{ width: percent < 0 ? '100%' : percent + '%' }"
              :class="percent < 0 && 'animate-pulse'"
            />
          </div>
          <p class="text-xs tabular-nums text-muted-foreground">
            {{ percent < 0 ? "下载中…" : percent + "%" }}
          </p>
        </template>

        <template v-else-if="phase.kind === 'error'">
          <div class="flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2.5 py-2">
            <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span class="min-w-0 flex-1 break-words text-xs text-destructive">{{ phase.message }}</span>
          </div>
        </template>

        <div class="mt-5 flex items-center justify-end gap-2">
          <template v-if="phase.kind === 'available'">
            <Button variant="ghost" size="sm" @click="emit('later')">稍后</Button>
            <Button variant="default" size="sm" @click="emit('install')">下载并安装</Button>
          </template>
          <template v-else-if="phase.kind === 'error'">
            <Button variant="ghost" size="sm" @click="emit('close')">关闭</Button>
            <Button variant="default" size="sm" @click="emit('retry')">重试</Button>
          </template>
          <!-- 下载中不给任何按钮：中途取消会留下半截文件，重启一次就好 -->
        </div>
      </div>
    </div>
  </Transition>
</template>
