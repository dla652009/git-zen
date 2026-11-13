// MR / PR 新建页链接推断（纯函数，无 DOM / Tauri 依赖，便于 node 自检）。
//
// 输入只有 origin URL、当前分支与上游分支，输出可直接 openUrl 的链接。
// 认识 GitHub / GitLab / Gitee / Bitbucket；其余平台交给用户在设置里填模板。

export interface MrUrlInput {
  /** origin URL，如 https://github.com/o/r.git 或 git@github.com:o/r.git */
  originUrl: string;
  /** 用户自定义模板（设置页），占位符 {src} {dst} {repo}；空 = 自动推断 */
  template?: string;
  /** 当前分支（MR 源分支） */
  srcBranch: string;
  /** 目标分支（upstream 短名剥掉 origin/），空 = 当前分支无上游 */
  dstBranch?: string;
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
 * 构造 MR / PR 新建页链接。
 * 返回 null = 无法构造（origin 无法解析 / 主机不认识 / 缺源分支 / 模板需要 {dst} 但没有上游）。
 */
export function buildMrUrl(input: MrUrlInput): string | null {
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

  // 自定义模板优先：纯文本替换，不做任何修补——缺 {dst} 是用户配置问题，直接判不可用
  const template = (input.template ?? "").trim();
  if (template) {
    if (!dst && template.includes("{dst}")) return null;
    return template
      .replace(/\{src\}/g, src)
      .replace(/\{dst\}/g, dst)
      .replace(/\{repo\}/g, repo);
  }

  if (isGitHub(origin.host)) {
    return dst
      ? `${base}/compare/${dst}...${src}?expand=1`
      : `${base}/compare/${src}?expand=1`;
  }
  if (isGitLab(origin.host)) {
    // query 值必须编码：分支名里的 / 不编码会被上游当成路径
    const q = `merge_request[source_branch]=${encodeURIComponent(src)}`;
    return dst
      ? `${base}/-/merge_requests/new?${q}&merge_request[target_branch]=${encodeURIComponent(dst)}`
      : `${base}/-/merge_requests/new?${q}`;
  }
  if (isGitee(origin.host)) {
    // Gitee 的 compare 必须两端都有分支，没有上游就没有可跳转的页面
    return dst ? `${base}/compare/${src}...${dst}` : null;
  }
  if (isBitbucket(origin.host)) {
    return dst
      ? `${base}/pull-requests/new?source=${encodeURIComponent(src)}&dest=${encodeURIComponent(dst)}`
      : null;
  }
  return null;
}
