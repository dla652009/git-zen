// M6 AI 能力统一入口：OpenAI 兼容 chat/completions，前端直调（tauri-plugin-http 放行跨域）。
// 约定：所有 AI 功能只读消费 diff/log 文本、产文本，不写工作区；一律经 aiComplete() 调用。
import { fetch } from "@tauri-apps/plugin-http";
import { readJsonObject } from "./lib/safeJson";
import { settings } from "./settings";

const TIMEOUT_MS = 30_000;
const TIMEOUT_MSG = "AI 请求超时（30s）";

// 进行中的请求。用户关掉 AI 弹窗后请求没必要再跑满 30s，统一取消。
const inflight = new Set<AbortController>();
// 取消序号：abortAi() 递增。跨过取消点之后才失败的杂项错误（例如响应体读到一半被掐断）
// 同样算「用户取消」，否则关掉弹窗后还会冒出一个无意义的错误框。
let abortSeq = 0;

/** 用户主动取消（关弹窗）——UI 见到它应当静默，不要弹错误 */
export class AiAbortError extends Error {
  constructor(message = "AI 请求已取消") {
    super(message);
    this.name = "AiAbortError";
  }
}

/** 是否是「用户主动取消」（与超时、网络失败区分开） */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AiAbortError";
}

/** 取消全部进行中的 AI 请求；没有请求时是安全 no-op */
export function abortAi(): void {
  abortSeq++;
  for (const c of inflight) c.abort();
  inflight.clear();
}

/** signal 一 abort 就立刻 reject——不等宿主 promise 自己结束（取消后它不保证会 settle） */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AiAbortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 统一发请求：超时与取消都真正走 AbortController（原来 TIMEOUT_MS 只是个标志位，
 * 请求本身会一直挂着）。超时抛超时错误、用户取消抛 AiAbortError，其余归为网络不通。
 */
async function aiFetch(
  url: string,
  init: RequestInit,
  netMsg: string,
): Promise<Response> {
  const ac = new AbortController();
  inflight.add(ac);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, TIMEOUT_MS);
  try {
    return await abortable(fetch(url, { ...init, signal: ac.signal }), ac.signal);
  } catch (e) {
    if (ac.signal.aborted) {
      throw timedOut ? new Error(TIMEOUT_MSG) : new AiAbortError();
    }
    // 原始错误必须带出来：插件的 scope 拦截、DNS 失败、证书错误在界面上长得一模一样，
    // 统一替换成「网络不通」时根本无从定位（本地 Base URL 连不上就是这么被藏起来的）
    const raw = e instanceof Error ? e.message : String(e);
    if (/url not allowed on the configured scope/i.test(raw)) {
      throw new Error(`${netMsg} —— 该地址不在应用的网络白名单内（${raw}）`);
    }
    throw new Error(`${netMsg}（${raw}）`);
  } finally {
    clearTimeout(timer);
    inflight.delete(ac);
  }
}

// diff 过长截断：模型上下文有限，二进制段已在后端剔除
export function clipForAI(text: string, maxChars = 16_000): string {
  if (text.length <= maxChars) return text;
  // 往回退到最近的换行：硬切会切在 hunk 中间，模型看到半行 diff 容易编出并不存在的改动；
  // 退到行边界最多损失一行。同时别把代理对（emoji 等）劈成两半，那会渲染成 U+FFFD。
  let cut = text.lastIndexOf("\n", maxChars);
  if (cut < maxChars - 2000) cut = maxChars; // 整段没有换行（超长单行）：只能硬切
  const head = text.slice(0, cut);
  const safe = /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
  return `${safe}\n…（diff 过长已截断，原文共 ${text.length} 字符）`;
}

function statusToText(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "API Key 无效或没有权限";
    case 404:
      return "接口不存在：检查 Base URL 是否以 /v1 结尾、模型名是否正确";
    case 429:
      return "请求过于频繁（限频），稍后再试";
    case 500:
    case 502:
    case 503:
      return "AI 服务端错误，稍后再试";
    default:
      return `AI 请求失败（HTTP ${status}）`;
  }
}

// 非流式调用：部分模型/中转不支持 SSE，统一一次性返回 + 前端 Spinner
export async function aiComplete(
  system: string,
  user: string,
): Promise<string> {
  if (!settings.aiBaseUrl.trim()) throw new Error("未配置 AI Base URL");
  const url = `${settings.aiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.aiApiKey.trim())
    headers.Authorization = `Bearer ${settings.aiApiKey}`;

  const seq = abortSeq;
  const res = await aiFetch(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.aiModel.trim() || "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.7,
      }),
    },
    "网络不通：无法连接 AI 服务",
  );
  if (!res.ok) {
    // 把服务端返回的真实原因带出来（如 model not found / 配额不足），否则无法定位生成失败的原因
    const body = await res.text().catch(() => "");
    let detail = "";
    if (body) {
      try {
        const j = JSON.parse(body);
        detail = (j?.error?.message as string) ?? body.slice(0, 300);
      } catch {
        detail = body.slice(0, 300);
      }
    }
    // 取消会把错误响应体的读取掐断，这时别把「用户取消」报成 HTTP 失败
    if (seq !== abortSeq) throw new AiAbortError();
    throw new Error(
      `${statusToText(res.status)}${detail ? `：${detail}` : ""}`,
    );
  }
  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
  } catch {
    // 取消会把响应体流掐断，这不是「返回了坏内容」
    if (seq !== abortSeq) throw new AiAbortError();
    throw new Error(
      "AI 返回了无法解析的内容（非 JSON），请检查 Base URL 是否正确",
    );
  }
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("AI 返回了空内容");
  return content;
}

// 设置保存时的轻量验通（显式传参，验的是草稿值不是已存值）
export async function aiVerify(baseUrl: string, apiKey: string): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = {};
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;
  const res = await aiFetch(url, { headers }, "网络不通：无法连接该 Base URL");
  if (!res.ok) throw new Error(statusToText(res.status));
}

// 功能点提示词集中在这
export const AI_PROMPTS = {
  commitMessage: {
    // 提交信息规范：跟随仓库既有风格，风格不明显时用 Conventional Commits；祈使语气、无尾句号、
    // 不硬凑 type/scope、跟随仓库主导语言；只基于 diff 本身，不臆造行为。
    system(lang: string) {
      return `你是资深工程师。根据给定的暂存区 diff 写一条 Git 提交信息。

规则：
1. 优先参考「仓库近期提交」的风格惯例；风格不明显时采用 Conventional Commits：type(scope): 主题。
2. type 反映意图：feat/fix/refactor/docs/test/build/ci/perf/chore。项目不用就不用，不硬凑 scope。
3. 主题祈使语气、简洁具体，不加句号；避免空泛描述（如“更新代码”）和与变更无关的实现细节。
4. 多部分变更可在空一行后附 1-3 条要点正文，只在主题讲不清关键背景/兼容性影响时才写。
5. 跟随仓库主导语言（若近期提交主要是中文则用中文，英文则用英文）。
6. 只基于 diff 描述真实行为，不要臆造变更未实现的内容。

只输出提交信息本身，不要任何解释或 Markdown 标记。提交信息语言：${lang}。`;
    },
  },
  explainDiff: {
    system:
      "你是资深工程师。用中文向同事解释这段代码变更：先一句话概括改了什么、为什么，再用要点列出关键改动。语言精炼，不要复述代码。",
  },
  reviewUnpushed: {
    system:
      "你是严格的 code reviewer。审查以下未推送的提交变更，用中文按三节输出：【问题】明确的 bug 或逻辑错误；【风险】潜在隐患（边界/并发/安全/性能）；【建议】可选的改进。每节若无内容写「无明显问题」。不要复述 diff。",
  },
  conflictExplain: {
    system:
      "你是资深工程师。这是一个合并冲突文件的 combined diff（双状态列分别表示相对 ours/theirs 两个版本的增删）。用中文解读：先用一句话说明双方各改了什么、为什么可能冲突，再用要点列出每处冲突区域双方的意图与建议的解决方向。只做只读解读，不要输出代码补丁。",
  },
  releaseNotes: {
    system: `你是发布负责人。根据给定的提交清单（hash/日期/作者/主题）生成一份中文 Release Notes（Markdown）：
1. 按变更性质分组：新功能 / 问题修复 / 优化重构 / 其他；琐碎的内部提交（chore、ci 等）归入「其他」或省略。
2. 每条一行，描述用户可感知的变化（意思相近的提交合并成一条），格式：- 描述 (hash)。
3. 开头可加一句话总述本版本整体内容。
4. 只基于清单归纳，不要臆造清单之外的内容。
只输出 Markdown 正文。`,
  },
};

// ---- AI 结果本地缓存（localStorage，FIFO 上限 30 条）----
// Review 按 repo::分支 键存（推送成功后调 aiCacheDelete 清除）；
// DiffViewer 解释按 repo::路径(或commit hash) 键存。
const AI_CACHE_LIMIT = 30;

function loadBucket(bucket: string): Record<string, string> {
  // 坏数据 / 被存成数组或字符串时退回空桶
  return readJsonObject<Record<string, string>>(`gz.ai.${bucket}`, {});
}

export function aiCacheRead(bucket: string, id: string): string | undefined {
  return loadBucket(bucket)[id];
}

export function aiCacheWrite(bucket: string, id: string, text: string): void {
  const b = loadBucket(bucket);
  b[id] = text;
  const keys = Object.keys(b);
  if (keys.length > AI_CACHE_LIMIT) delete b[keys[0]]; // FIFO 淘汰最旧
  localStorage.setItem(`gz.ai.${bucket}`, JSON.stringify(b));
}

export function aiCacheDelete(bucket: string, id: string): void {
  const b = loadBucket(bucket);
  if (id in b) {
    delete b[id];
    localStorage.setItem(`gz.ai.${bucket}`, JSON.stringify(b));
  }
}
