// M6 AI 能力统一入口：OpenAI 兼容 chat/completions，前端直调（tauri-plugin-http 放行跨域）。
// 约定：所有 AI 功能只读消费 diff/log 文本、产文本，不写工作区；一律经 aiComplete() 调用。
import { fetch } from "@tauri-apps/plugin-http";
import { settings } from "./settings";

const TIMEOUT_MS = 30_000;

// diff 过长截断：模型上下文有限，二进制段已在后端剔除
export function clipForAI(text: string, maxChars = 16_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（diff 过长已截断，原文共 ${text.length} 字符）`;
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

export async function aiComplete(
  system: string,
  user: string,
): Promise<string> {
  if (!settings.aiBaseUrl.trim()) throw new Error("未配置 AI Base URL");
  const url = settings.aiBaseUrl.replace(/\/+$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.aiApiKey.trim())
    headers.Authorization = `Bearer ${settings.aiApiKey}`;

  // 插件可能不支持 AbortSignal，超时用竞态兜底
  let timedOut = false;
  const timer = setTimeout(() => (timedOut = true), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
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
    });
  } catch {
    clearTimeout(timer);
    throw new Error(
      timedOut ? "AI 请求超时（30s）" : "网络不通：无法连接 AI 服务",
    );
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(statusToText(res.status));
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("AI 返回了空内容");
  return content;
}

// 设置保存时的轻量验通（显式传参，验的是草稿值不是已存值）
export async function aiVerify(baseUrl: string, apiKey: string): Promise<void> {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = {};
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw new Error("网络不通：无法连接该 Base URL");
  }
  if (!res.ok) throw new Error(statusToText(res.status));
}

// 功能点提示词集中在这
export const AI_PROMPTS = {
  commitMessage: {
    // 吸收 src/ai/skills/git-commit-message/SKILL.md 的规范：
    // 跟随仓库既有风格，风格不明显时用 Conventional Commits；祈使语气、无尾句号、
    // 不硬凑 type/scope、跟随仓库主导语言；只基于 diff 本身，不臆造行为。
    system: `你是资深工程师。根据给定的暂存区 diff 写一条 Git 提交信息。

规则：
1. 优先参考「仓库近期提交」的风格惯例；风格不明显时采用 Conventional Commits：type(scope): 主题。
2. type 反映意图：feat/fix/refactor/docs/test/build/ci/perf/chore。项目不用就不用，不硬凑 scope。
3. 主题祈使语气、简洁具体，不加句号；避免空泛描述（如“更新代码”）和与变更无关的实现细节。
4. 多部分变更可在空一行后附 1-3 条要点正文，只在主题讲不清关键背景/兼容性影响时才写。
5. 跟随仓库主导语言（若近期提交主要是中文则用中文，英文则用英文）。
6. 只基于 diff 描述真实行为，不要臆造变更未实现的内容。

只输出提交信息本身，不要任何解释或 Markdown 标记。`,
  },
  explainDiff: {
    system:
      "你是资深工程师。用中文向同事解释这段代码变更：先一句话概括改了什么、为什么，再用要点列出关键改动。语言精炼，不要复述代码。",
  },
  reviewUnpushed: {
    system:
      "你是严格的 code reviewer。审查以下未推送的提交变更，用中文按三节输出：【问题】明确的 bug 或逻辑错误；【风险】潜在隐患（边界/并发/安全/性能）；【建议】可选的改进。每节若无内容写「无明显问题」。不要复述 diff。",
  },
};
