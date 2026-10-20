<script lang="ts">
/** 一屏总览用的行数据：由 App 用 Promise.all(status) 拉好后传入 */
export interface RepoOverviewRow {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  /** 变更文件数 */
  dirty: number;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { Button, Spinner } from "@/components/ui";

// 全部已打开仓库的状态总览：多仓库时要一屏看完谁落后、谁有未提交改动，
// 并支持一次性拉取。数据与拉取动作留在 App。
const open = defineModel<boolean>("open", { required: true });

const props = defineProps<{ rows: RepoOverviewRow[]; loading: boolean }>();

const emit = defineEmits<{ openRepo: [path: string]; pullAll: []; refresh: [] }>();

const stats = computed(() => {
  const dirty = props.rows.filter((r) => r.dirty > 0).length;
  const behind = props.rows.filter((r) => r.behind > 0).length;
  return { total: props.rows.length, dirty, behind };
});
</script>

<template>
  <div
    v-if="open"
    v-trap
    class="fixed inset-0 z-40 grid place-items-center bg-scrim"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dlg-repos-title"
    @click.self="open = false"
  >
    <div class="w-dlg-xl surface rounded-lg p-5 pop-in">
      <div class="flex items-center gap-2">
        <div id="dlg-repos-title" class="text-base font-semibold">所有仓库</div>
        <span class="flex-1" />
        <Button variant="ghost" size="sm" :disabled="loading" @click="emit('refresh')">
          刷新
        </Button>
        <Button
          variant="secondary"
          size="sm"
          :disabled="loading || !rows.length || !stats.behind"
          @click="emit('pullAll')"
        >
          全部拉取
        </Button>
      </div>

      <p class="mt-1 text-xs text-muted-foreground">
        共 {{ stats.total }} 个仓库 · {{ stats.dirty }} 个有未提交改动 ·
        {{ stats.behind }} 个落后远端
      </p>

      <div class="mt-3 max-h-80 min-h-24 overflow-auto rounded-md border border-border-soft bg-background/40 p-1">
        <div v-if="loading" class="grid h-24 place-items-center">
          <Spinner label="同步中…" />
        </div>
        <div
          v-else-if="!rows.length"
          class="grid h-24 place-items-center text-xs text-muted-foreground"
        >
          还没有打开任何仓库
        </div>
        <template v-else>
          <button
            v-for="r in rows"
            :key="r.path"
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 text-left text-xs transition-colors duration-fast hover:bg-hover"
            :title="r.path"
            @click="emit('openRepo', r.path)"
          >
            <span class="w-36 shrink-0 truncate font-medium">{{ r.name }}</span>
            <code class="w-32 shrink-0 truncate font-mono text-muted-foreground">{{ r.branch || "—" }}</code>
            <span class="flex w-24 shrink-0 items-center gap-1.5 font-mono text-[var(--c-conf)]">
              <span v-if="r.ahead">↑{{ r.ahead }}</span>
              <span v-if="r.behind">↓{{ r.behind }}</span>
            </span>
            <span
              class="min-w-0 flex-1 truncate text-right"
              :class="r.dirty ? '' : 'text-muted-foreground'"
            >
              {{ r.dirty ? `${r.dirty} 个变更` : "干净" }}
            </span>
          </button>
        </template>
      </div>

      <div class="mt-5 flex justify-end">
        <Button variant="ghost" size="sm" @click="open = false">关闭</Button>
      </div>
    </div>
  </div>
</template>
