<script setup lang="ts">
// 工作树管理（第一期：只读 + 切换）。
//
// 这一版**不做任何写操作** —— 不建目录、不删目录、不动分支。它只回答两个问题：
// 「这个仓库有哪些工作树」和「帮我切到那个目录」。新建/移除/prune 见
// docs/DESIGN-WORKTREE.md 的 S3，还没实现。
//
// 打开与数据都留在 App.vue：弹窗只负责渲染与 emit，
// 这样 overlayLayers.worktree 与 Esc 分层关闭才不会失联。
import { computed } from "vue";
import { AlertTriangle, FolderGit2, GitBranch, Lock } from "@lucide/vue";
import { Badge, Button, Spinner, Tooltip } from "@/components/ui";
import { FLAG_LABEL, type WorktreeRow } from "@/lib/worktree";

const open = defineModel<boolean>("open", { required: true });

const props = defineProps<{
  rows: WorktreeRow[];
  loading: boolean;
  /** 当前正在浏览的仓库路径（用来标「当前」并禁用它自己的切换按钮） */
  currentRepo: string;
  /** 已打开为选项卡的路径集合：这些行不去"添加"，直接切过去 */
  openedPaths: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  /** 切到该目录（App 负责：已打开就 activate，没打开就 addRepo + activate） */
  "open-worktree": [path: string];
  refresh: [];
}>();

const live = computed(() => props.rows.filter((r) => !r.broken));
const broken = computed(() => props.rows.filter((r) => r.broken));

function isCurrent(r: WorktreeRow) {
  return props.openedPaths.has(r.path) && r.path === props.currentRepo;
}

// 分支格：detached 与 locked 要能同时看见 —— 它们是两件事，不能互相顶掉
function branchText(r: WorktreeRow) {
  if (r.occupiedBranch) return r.occupiedBranch;
  return r.detached ? "未检出分支" : "—";
}
</script>

<template>
  <Transition name="dlg">
    <div
      v-if="open"
      v-trap
      class="fixed inset-0 z-40 grid place-items-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dlg-worktree-title"
      @click.self="open = false"
    >
      <div class="dialog-shell w-dlg-xl surface rounded-lg pop-in">
        <header class="dialog-header flex flex-wrap items-start justify-between gap-3">
          <div id="dlg-worktree-title" class="dialog-title">工作树</div>
          <Button variant="ghost" size="sm" :disabled="loading" @click="emit('refresh')">
            <Spinner v-if="loading" :size="12" />
            刷新
          </Button>
        </header>
        <div class="dialog-body">
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
          同一个仓库的多个工作目录，各自检出不同分支、共用一份 <code>.git</code>。
          同一个分支不能同时在两个目录里检出 —— 这正是「切换分支时提示已被占用」的原因。
        </p>

        <div v-if="loading && !rows.length" class="grid h-28 place-items-center">
          <Spinner label="读取中…" />
        </div>
        <div
          v-else-if="!live.length"
          class="mt-3 grid h-24 place-items-center rounded-md border border-border-soft bg-background/40 text-xs text-muted-foreground"
        >
          没有可用的工作树记录
        </div>

        <div v-else class="mt-3 space-y-1 rounded-md border border-border-soft bg-background/40 p-1">
          <div
            v-for="r in live"
            :key="r.path"
            class="group/wt flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors duration-fast"
            :class="isCurrent(r) ? 'bg-row-selected' : 'hover:bg-hover'"
          >
            <component
              :is="r.is_main ? FolderGit2 : GitBranch"
              class="size-3.5 shrink-0"
              :class="isCurrent(r) ? 'text-primary' : 'text-muted-foreground'"
            />
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                <span class="truncate text-xs font-medium">{{ r.name }}</span>
                <Badge v-if="isCurrent(r)" variant="info" class="shrink-0">当前</Badge>
                <Badge v-if="r.is_main" variant="muted" class="shrink-0">
                  {{ FLAG_LABEL.main }}
                </Badge>
                <Tooltip v-if="r.locked" :text="r.lock_reason || '已锁定（未提供原因）'">
                  <Badge variant="warning" class="shrink-0">
                    <Lock class="size-2.5" />
                    {{ FLAG_LABEL.locked }}
                  </Badge>
                </Tooltip>
              </div>
              <div class="mt-0.5 flex items-center gap-1.5 text-xs" :class="isCurrent(r) ? 'text-foreground' : 'text-muted-foreground'">
                <span class="truncate font-mono" :title="r.path">{{ r.path }}</span>
              </div>
              <div class="mt-0.5 flex items-center gap-2 text-xs" :class="isCurrent(r) ? 'text-foreground' : 'text-muted-foreground'">
                <span class="truncate" :class="r.occupiedBranch ? '' : 'italic'">
                  {{ branchText(r) }}
                </span>
                <code class="shrink-0 font-mono">{{ r.shortHead }}</code>
              </div>
            </div>
            <Button
              v-if="!isCurrent(r)"
              variant="secondary"
              size="sm"
              class="shrink-0"
              @click="emit('open-worktree', r.path)"
            >
              {{ openedPaths.has(r.path) ? "切到" : "打开" }}
            </Button>
          </div>
        </div>

        <!-- 失效记录单独一栏：它们点不动，但必须让用户看见，否则「为什么分支还被占用」永远无解 -->
        <div v-if="broken.length" class="mt-3">
          <div class="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <AlertTriangle class="size-3.5" />
            失效记录
          </div>
          <div class="mt-1 space-y-1 rounded-md border border-border-soft bg-background/40 p-1">
            <div
              v-for="r in broken"
              :key="r.path"
              class="flex items-start gap-2 rounded-sm px-2 py-1.5"
            >
              <AlertTriangle class="mt-0.5 size-3 shrink-0 opacity-70" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs" :title="r.path">{{ r.path }}</div>
                <div class="mt-0.5 text-2xs text-muted-foreground">
                  {{ r.missing ? "目录已不存在" : r.prunable_reason || "记录已失效" }}
                  · 它占着的分支需要清理后才能正常使用
                </div>
              </div>
            </div>
          </div>
          <p class="mt-1 text-2xs text-muted-foreground">
            清理失效记录（<code>git worktree prune</code>）还没做，需要时请在终端执行。
          </p>
        </div>

        </div>
        <footer class="dialog-footer">
          <span class="mr-auto min-w-0 flex-1 text-xs text-muted-foreground">
            共 {{ rows.length }} 个工作树 · 本期只支持查看与切换
          </span>
          <Button variant="ghost" size="sm" @click="open = false">关闭</Button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
