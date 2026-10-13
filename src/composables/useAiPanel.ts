// AI 面板：未推送提交的 Review（ahead>0 时工具栏出按钮）与 Release Notes（选 tag 范围汇总提交）。
// 从 App.vue 抽出来的第四批：只依赖「当前仓库、状态、标签、设置引导、错误提示」这几个外部状态，
// ai.ts 的调用、缓存键、提示词都是本模块自己的事。

import { computed, ref, type Ref } from "vue";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../gitApi";
import type { Status, TagEntry } from "../gitApi";
import { AI_PROMPTS, aiComplete, clipForAI, aiCacheRead, aiCacheWrite, aiCacheDelete, isAbortError } from "../ai";
import { settings } from "../settings";
import { humanizeMsg } from "../lib/errors";

export function useAiPanel(opts: {
  repo: Ref<string>;
  status: Ref<Status | null>;
  /** 标签列表声明在本段之后（标签组一节），用取值函数避免初始化顺序依赖 */
  tags: () => TagEntry[];
  showSettingsTab: Ref<string | undefined>;
  showSettings: Ref<boolean>;
  showError: (msg: string) => void;
}) {
  // ---- AI Review 未推送提交（ahead>0 时工具栏出按钮）----
  // 结果按 repo+分支 临时保存：切回来能二次查看；推送成功后清除
  const reviewBusy = ref(false);
  const reviewOpen = ref(false);
  const reviewText = ref("");
  const reviewErr = ref("");
  // 结果持久化在 localStorage（gz.ai.review），重启后仍可二次查看
  const REVIEW_BUCKET = "review";
  function reviewCacheGet(key: string): string | undefined {
    return aiCacheRead(REVIEW_BUCKET, key);
  }
  function reviewCacheSet(key: string, text: string) {
    aiCacheWrite(REVIEW_BUCKET, key, text);
  }
  function reviewKey(): string {
    return `${opts.repo.value}::${opts.status.value?.branch ?? ""}`;
  }
  function aiConfigured(): boolean {
    if (settings.aiEnabled !== "on") return false; // AI 总开关关闭时全部入口引导去设置
    return !!(settings.aiBaseUrl.trim() && (settings.aiApiKey.trim() || settings.aiBaseUrl.includes("localhost")));
  }
  async function startReview(regen: boolean | Event = false) {
    // 注意：模板 @click 不带参时会把 MouseEvent 传进来，只有显式传 true 才算强制重生成
    const forceRegen = regen === true;
    if (!aiConfigured()) {
      // 未配置 → 直接引导到设置 AI 页
      opts.showSettingsTab.value = "ai";
      opts.showSettings.value = true;
      return;
    }
    if (reviewBusy.value || !opts.status.value?.ahead) return;
    const key = reviewKey();
    const cached = reviewCacheGet(key);
    if (!forceRegen && cached !== undefined) {
      // 已有报告直接展示，附重新生成按钮
      reviewText.value = cached;
      reviewErr.value = "";
      reviewOpen.value = true;
      return;
    }
    reviewOpen.value = true;
    reviewBusy.value = true;
    reviewText.value = "";
    reviewErr.value = "";
    try {
      const d = await api.diffUnpushed(opts.repo.value);
      reviewText.value = await aiComplete(
        AI_PROMPTS.reviewUnpushed.system,
        clipForAI(d),
      );
      reviewCacheSet(key, reviewText.value);
    } catch (e) {
      // 关弹窗触发的取消是正常操作，不是错误
      if (isAbortError(e)) return;
      reviewErr.value = humanizeMsg(e);
    } finally {
      reviewBusy.value = false;
    }
  }

  /** 推送成功 / 丢弃未推送提交后清掉该分支的报告缓存（App.vue 两处收口调用） */
  function dropReviewCache() {
    aiCacheDelete(REVIEW_BUCKET, reviewKey());
  }

  const reviewSaved = ref(false);
  async function saveReviewToFile() {
    if (!reviewText.value) return;
    try {
      // saveDialog 也要放进 try：插件调用失败（ACL 未授权 / 后端异常）时它会 reject，
      // 放在 try 外面就成了一次「点了保存、什么都没发生、也没有提示」的未处理 rejection
      const target = await saveDialog({
        title: "保存 AI Review 报告",
        defaultPath: `AI-review-${opts.status.value?.branch ?? "branch"}-${new Date().toISOString().slice(0, 10)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target) return;
      await api.writeTextFile(target, reviewText.value);
      reviewSaved.value = true;
      setTimeout(() => (reviewSaved.value = false), 2000);
    } catch (e) {
      opts.showError(String(e));
    }
  }

  // ---- AI Release Notes：选 tag 范围汇总提交 → Markdown 报告（复用 Review 弹窗骨架）----
  // 默认起点 = describe --tags 的最近 tag；仓库无 tag 时可汇总全部提交
  const notesOpen = ref(false);
  const notesBusy = ref(false);
  const notesText = ref("");
  const notesErr = ref("");
  const notesSaved = ref(false);
  const notesFrom = ref(""); // tag 名；"__all__" = 全部提交
  const notesLatest = ref(""); // HEAD 可达的最近 tag

  const notesOptions = computed(() => {
    const items: { value: string; label: string }[] = [];
    if (notesLatest.value)
      items.push({ value: notesLatest.value, label: `最近标签 ${notesLatest.value}` });
    for (const t of opts.tags()) {
      if (t.name !== notesLatest.value) items.push({ value: t.name, label: t.name });
    }
    if (!items.length) items.push({ value: "__all__", label: "全部提交（仓库还没有标签）" });
    return items;
  });

  async function openReleaseNotes() {
    if (!aiConfigured()) {
      opts.showSettingsTab.value = "ai";
      opts.showSettings.value = true;
      return;
    }
    notesOpen.value = true;
    notesText.value = "";
    notesErr.value = "";
    notesLatest.value = await api.latestTag(opts.repo.value).catch(() => "");
    notesFrom.value = notesLatest.value || "__all__";
    genReleaseNotes();
  }
  async function genReleaseNotes() {
    if (notesBusy.value || !opts.repo.value) return;
    // 绑定仓库：取提交范围与拼提示词之间用户可能切走，否则会把 A 的提交交给 B 的报告
    const path = opts.repo.value;
    notesBusy.value = true;
    notesErr.value = "";
    notesText.value = "";
    try {
      const from = notesFrom.value === "__all__" ? "" : notesFrom.value;
      const list = await api.commitsRange(path, from);
      if (!list.length) {
        notesErr.value = "该范围内没有提交";
        return;
      }
      const user =
        `【仓库】${path.split(/[\\/]/).pop() || path}\n【范围】${from ? `${from}..HEAD` : "全部提交"}\n\n` +
        list.map((c) => `${c.hash} ${c.date} ${c.author} ${c.subject}`).join("\n");
      notesText.value = await aiComplete(AI_PROMPTS.releaseNotes.system, clipForAI(user));
    } catch (e) {
      if (isAbortError(e)) return; // 关弹窗取消，不是失败
      notesErr.value = humanizeMsg(e);
    } finally {
      notesBusy.value = false;
    }
  }
  async function saveNotesToFile() {
    if (!notesText.value) return;
    try {
      // 同上：saveDialog 的 rejection 也要落到错误提示里
      const target = await saveDialog({
        title: "保存 Release Notes",
        defaultPath: `Release-notes-${new Date().toISOString().slice(0, 10)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target) return;
      await api.writeTextFile(target, notesText.value);
      notesSaved.value = true;
      setTimeout(() => (notesSaved.value = false), 2000);
    } catch (e) {
      opts.showError(String(e));
    }
  }

  return {
    reviewBusy,
    reviewOpen,
    reviewText,
    reviewErr,
    reviewSaved,
    startReview,
    saveReviewToFile,
    notesOpen,
    notesBusy,
    notesText,
    notesErr,
    notesSaved,
    notesFrom,
    notesLatest,
    notesOptions,
    openReleaseNotes,
    genReleaseNotes,
    saveNotesToFile,
    dropReviewCache,
  };
}
