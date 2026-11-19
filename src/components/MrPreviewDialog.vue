<script setup lang="ts">
// 新建 MR 预览：AI 生成标题/描述，用户可改，最后打开平台的「新建」页。
//
// 语义必须先说清：这里**不创建** MR（平台创建要走 API + token，本应用只有系统 git 凭据），
// 打开的是预填好标题/描述的页面，最后那下 Create 由用户自己点。文案里不出现「创建」。
//
// 布局分工：标题区固定（含源/目标分支上下文），描述是主编辑区（占满剩余高度、可拖拽调高），
// 动作固定在底部；长错误与长描述都在框内消化，不把按钮挤出屏幕。
import { ArrowRight, GitMerge } from "@lucide/vue";
import { Button, Input, Spinner, Textarea } from "@/components/ui";

// open 与字段都留在 App.vue（overlayLayers.mrPreview 的 Esc 分层关闭要指向 open，见 AGENTS.md 规则 6）
const open = defineModel<boolean>("open", { required: true });
const title = defineModel<string>("title", { required: true });
const body = defineModel<string>("body", { required: true });

defineProps<{
  /** 源 / 目标分支：只读展示，生成与打开都基于发起时的快照 */
  src: string;
  dst: string;
  busy: boolean;
  err: string;
  /** false = 主机不支持 URL 预填，复制标题正文到剪贴板 */
  supportsPrefill: boolean;
}>();

const emit = defineEmits<{ regen: []; confirm: []; copy: [] }>();
</script>

<template>
  <Transition name="dlg">
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-mr-title"
    @click.self="open = false"
  >
    <!-- 比标准表单宽一档：描述是主编辑区，448px 里写不了两句 -->
    <div class="dialog-shell w-dlg-lg surface rounded-lg pop-in">
      <header class="dialog-header">
        <div class="flex items-center gap-2">
          <GitMerge class="size-4 shrink-0 text-primary" aria-hidden="true" />
          <div id="dlg-mr-title" class="dialog-title min-w-0 flex-1">新建合并请求</div>
        </div>
        <!-- 分支上下文单独成块：它是这次生成的输入快照，不该和标题挤在同一行被读成标题的一部分 -->
        <div class="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
          <span class="shrink-0 text-muted-foreground">源</span>
          <code class="min-w-0 break-all rounded-xs bg-muted px-1.5 py-0.5 font-mono text-foreground">{{
            src || "—"
          }}</code>
          <ArrowRight class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="shrink-0 text-muted-foreground">目标</span>
          <code class="min-w-0 break-all rounded-xs bg-muted px-1.5 py-0.5 font-mono text-foreground">{{
            dst || "—"
          }}</code>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
          {{ supportsPrefill
            ? "打开预填了标题与描述的页面，最后一步「创建」由你确认。"
            : "当前主机不支持 URL 预填：会先复制标题与描述，打开新建页后粘贴即可。" }}
        </p>
      </header>

      <div class="dialog-body flex flex-col gap-3">
        <Spinner v-if="busy" label="正在读取 diff 与生成标题、描述…" />

        <template v-else>
          <div
            v-if="err"
            class="flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
          >
            <span class="min-w-0 flex-1 break-words leading-relaxed">{{ err }}</span>
            <Button variant="quiet" size="sm" class="shrink-0" @click="emit('regen')">重试</Button>
          </div>

          <div class="dialog-field">
            <label for="mr-preview-title" class="text-xs font-semibold text-foreground">标题</label>
            <Input id="mr-preview-title" v-model="title" placeholder="合并请求标题" />
          </div>

          <!-- 描述是主编辑区：占满正文剩余高度，长描述在框内滚动 -->
          <div class="dialog-field min-h-0 flex-1">
            <label for="mr-preview-body" class="text-xs font-semibold text-foreground">描述</label>
            <Textarea
              id="mr-preview-body"
              v-model="body"
              class="min-h-56 flex-1 resize-y"
              placeholder="合并请求描述（可编辑）"
            />
          </div>
        </template>
      </div>

      <footer class="dialog-footer">
        <!-- 关闭会走到 App 的 watch 里 abortAi()，请求真的被掐掉：生成中必须写成「取消生成」，
             不能只写「关闭」——那会让人以为请求还在后台跑 -->
        <Button variant="ghost" size="sm" @click="open = false">
          {{ busy ? "取消生成" : "取消" }}
        </Button>
        <span class="flex-1" />
        <Button
          variant="secondary"
          size="sm"
          :disabled="busy || (!title.trim() && !body.trim())"
          @click="emit('copy')"
        >
          复制到剪贴板
        </Button>
        <Button variant="secondary" size="sm" :disabled="busy" @click="emit('regen')">
          重新生成
        </Button>
        <Button variant="default" size="sm" :disabled="busy" @click="emit('confirm')">
          {{ supportsPrefill ? "打开 MR 页" : "复制并打开 MR 页" }}
        </Button>
      </footer>
    </div>
  </div>
  </Transition>
</template>
