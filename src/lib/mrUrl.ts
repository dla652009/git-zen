// MR / PR 新建页链接推断（纯函数，无 DOM / Tauri 依赖，便于 node 自检）。
//
// 输入只有 origin URL、当前分支与上游分支，输出可直接 openUrl 的链接。
// 认识 GitHub / GitLab / Gitee / Bitbucket；其余平台交给用户在设置里填模板。

/** 用户预设的 MR 快捷项：src 为空 = 点击时取当前分支；dst 必填 */
export interface MrPreset {
  src?: string;
  dst: string;
}

export interface MrUrlInput {
  /** origin URL，如 https://github.com/o/r.git 或 git@github.com:o/r.git */
  originUrl: string;
  /** 用户自定义模板（设置页），占位符 {src} {dst} {repo}；空 = 自动推断 */
  template?: string;
  /** 当前分支（MR 源分支） */
  srcBranch: string;
  /** 目标分支（upstream 短名剥掉 origin/），空 = 当前分支无上游 */
  dstBranch?: string;
  /** AI 生成的标题 / 描述：主机支持时才拼进 URL */
  title?: string;
  body?: string;
}

export interface MrUrlResult {
  /** 可直接 openUrl 的新建页链接 */
  url: string;
  /** 该主机是否支持用 URL 预填标题/描述；false 时前端退化为复制到剪贴板 */
  supportsPrefill: boolean;
}

interface ParsedOrigin {
  host: string;
  path: string;
}

/** 归一 origin：scp 风格与 http(s) 都变成 host + 仓库路径（去 .git、去尾斜杠） */
function parseOrigin(originUrl: string): ParsedOrigin | null {
  const raw = originUrl.trim();
  if (!raw) return null;

  let host = "";
  let path = "";
  // git@host:group/repo.git（也容忍其他 user@host:path 写法）
  let m = raw.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
  if (m) {
    host = m[1]!;
    path = m[2]!;
  } else {
    m = raw.match(/^https?:\/\/([^/\s]+)\/(.+)$/i);
    if (!m) return null;
    host = m[1]!;
    path = m[2]!;
  }

  path = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!host || !path) return null;
  return { host: host.toLowerCase().replace(/^www\./, ""), path };
}

function isGitHub(host: string) {
  return host === "github.com";
}
function isGitLab(host: string) {
  return host.includes("gitlab");
}
function isGitee(host: string) {
  return host === "gitee.com" || host.endsWith(".gitee.com");
}
function isBitbucket(host: string) {
  return host === "bitbucket.org" || host.endsWith(".bitbucket.org");
}

/** base 的路径段：GitLab 多级 group 全保留；其他平台取前两段（owner/repo） */
function baseSegments(host: string, segments: string[]) {
  return isGitLab(host) ? segments : segments.slice(0, 2);
}

/**
 * 收敛 localStorage 里的预设：非数组 → 空，丢掉 dst 为空的行，两端 trim，src 空则不存。
 * 存储内容可被手改，读取时不能假设形状是对的；保存时也走这里，过滤规则只有一份。
 */
export function normalizeMrPresets(raw: unknown): MrPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: MrPreset[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const rec = it as { src?: unknown; dst?: unknown };
    const src = typeof rec.src === "string" ? rec.src.trim() : "";
    const dst = typeof rec.dst === "string" ? rec.dst.trim() : "";
    if (!dst) continue;
    out.push(src ? { src, dst } : { dst });
  }
  return out;
}

/** 查询串值编码：统一 %20，避免 + 在个别平台被当成字面加号 */
function qv(v: string) {
  return encodeURIComponent(v);
}

/**
 * 构造 MR / PR 新建页链接。
 * 返回 null = 无法构造（origin 无法解析 / 主机不认识 / 缺源分支 / 模板需要 {dst} 但没有上游）。
 * supportsPrefill=false 的主机（Bitbucket / 自定义模板）仍返回基础页面，由前端改为复制标题正文。
 */
export function buildMrUrl(input: MrUrlInput): MrUrlResult | null {
  const src = input.srcBranch.trim();
  const dst = (input.dstBranch ?? "").trim();
  if (!src) return null;

  const origin = parseOrigin(input.originUrl);
  if (!origin) return null;
  const segments = origin.path.split("/").filter(Boolean);
  // 至少 owner/repo 两段，否则拼不出有效的仓库主页
  if (segments.length < 2) return null;

  const basePath = baseSegments(origin.host, segments).join("/");
  const base = `https://${origin.host}/${basePath}`;
  const repo = basePath;
  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();

  // 自定义模板优先：纯文本替换，不做任何修补——缺 {dst} 是用户配置问题，直接判不可用。
  // 模板是用户手写的，不认识 title/body 占位符，因此不支持预填
  const template = (input.template ?? "").trim();
  if (template) {
    if (!dst && template.includes("{dst}")) return null;
    return {
      url: template
        .replace(/\{src\}/g, src)
        .replace(/\{dst\}/g, dst)
        .replace(/\{repo\}/g, repo),
      supportsPrefill: false,
    };
  }

  if (isGitHub(origin.host)) {
    const path = dst ? `${base}/compare/${dst}...${src}` : `${base}/compare/${src}`;
    const extra = [title && `title=${qv(title)}`, body && `body=${qv(body)}`]
      .filter(Boolean)
      .join("&");
    return {
      url: `${path}?expand=1${extra ? `&${extra}` : ""}`,
      supportsPrefill: true,
    };
  }
  if (isGitLab(origin.host)) {
    // query 值必须编码：分支名里的 / 不编码会被上游当成路径
    // 键名保持字面量（[] 不编码）——已有链接形态不变
    const parts = [
      `merge_request[source_branch]=${qv(src)}`,
      dst && `merge_request[target_branch]=${qv(dst)}`,
      title && `merge_request[title]=${qv(title)}`,
      body && `merge_request[description]=${qv(body)}`,
    ].filter(Boolean);
    return {
      url: `${base}/-/merge_requests/new?${parts.join("&")}`,
      supportsPrefill: true,
    };
  }
  if (isGitee(origin.host)) {
    // Gitee 的 compare 必须两端都有分支，没有上游就没有可跳转的页面；标题/描述保守支持
    if (!dst) return null;
    const extra = [title && `title=${qv(title)}`, body && `body=${qv(body)}`]
      .filter(Boolean)
      .join("&");
    return {
      url: `${base}/compare/${src}...${dst}${extra ? `?${extra}` : ""}`,
      supportsPrefill: true,
    };
  }
  if (isBitbucket(origin.host)) {
    // Bitbucket 新建页不接受预填参数，仍返回基础页，由前端复制标题正文
    return dst
      ? {
          url: `${base}/pull-requests/new?source=${qv(src)}&dest=${qv(dst)}`,
          supportsPrefill: false,
        }
      : null;
  }
  return null;
}

/**
 * 从 AI 输出中拆出标题与正文：第一行标题，其余为正文。
 * 模型偶尔无视约定包了代码块或加了 # 标题标记，这里顺手剥掉，避免用户拿到脏标题。
 */
export function parseMrDraft(raw: string): { title: string; body: string } {
  let text = raw.trim();
  text = text
    .replace(/^```[^\n]*\r?\n/, "")
    .replace(/\r?\n```$/, "")
    .trim();
  const lines = text.split(/\r?\n/);
  const title = (lines.shift() ?? "").replace(/^#+\s*/, "").trim();
  return { title, body: lines.join("\n").trim() };
}

/** 复制到剪贴板的文本：标题 + 空行 + 正文（正文为空时只有标题） */
export function mrPrefillToClipboard(title: string, body: string): string {
  return [title.trim(), body.trim()].filter(Boolean).join("\n\n");
}
