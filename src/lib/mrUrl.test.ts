// mrUrl.ts 自检：node --experimental-strip-types src/lib/mrUrl.test.ts
//
// 这里守的是「菜单里点新建 MR 会打开哪个页面」：主机识别错、分支参数拼错，
// 用户看到的是 404 或被平台拒绝的表单，而不会报错——只能靠这组断言兜住。
// buildMrUrl 返回 { url, supportsPrefill }：后者决定标题/描述走 URL 预填还是剪贴板。
import assert from "node:assert";
import {
  buildMrUrl,
  mrPrefillToClipboard,
  normalizeMrPresets,
  parseMrDraft,
} from "./mrUrl.ts";

const build = (originUrl: string, srcBranch: string, dstBranch?: string, template?: string) =>
  buildMrUrl({ originUrl, srcBranch, dstBranch, template });
const url = (originUrl: string, srcBranch: string, dstBranch?: string, template?: string) =>
  build(originUrl, srcBranch, dstBranch, template)?.url ?? null;

// ---- GitHub：https / scp 两种 origin，.git 后缀都要剥掉 ----
assert.equal(
  url("https://github.com/acme/app.git", "feature/login", "main"),
  "https://github.com/acme/app/compare/main...feature/login?expand=1",
  "GitHub https + dst",
);
assert.equal(
  url("git@github.com:acme/app.git", "fix", "dev"),
  "https://github.com/acme/app/compare/dev...fix?expand=1",
  "GitHub scp + dst",
);
assert.equal(
  url("https://github.com/acme/app", "fix"),
  "https://github.com/acme/app/compare/fix?expand=1",
  "GitHub 无 dst：只预填源分支",
);

// ---- GitHub 标题/描述预填：expand=1 之后追加，值编码 ----
assert.deepEqual(
  buildMrUrl({
    originUrl: "https://github.com/acme/app.git",
    srcBranch: "feat/x",
    dstBranch: "main",
    title: "feat: 加登录",
    body: "第一点\n第二点 & 兼容性",
  }),
  {
    url: "https://github.com/acme/app/compare/main...feat/x?expand=1&title=feat%3A%20%E5%8A%A0%E7%99%BB%E5%BD%95&body=%E7%AC%AC%E4%B8%80%E7%82%B9%0A%E7%AC%AC%E4%BA%8C%E7%82%B9%20%26%20%E5%85%BC%E5%AE%B9%E6%80%A7",
    supportsPrefill: true,
  },
  "GitHub 预填 title/body 并编码换行",
);

// ---- GitLab：查询参数值要编码，自建 host 与多级 group 都要认 ----
assert.equal(
  url("https://gitlab.com/group/app.git", "feat", "main"),
  "https://gitlab.com/group/app/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main",
  "GitLab.com + dst",
);
assert.equal(
  url("git@gitlab.mycompany.com:team/sub/app.git", "fix/x", "main"),
  "https://gitlab.mycompany.com/team/sub/app/-/merge_requests/new?merge_request[source_branch]=fix%2Fx&merge_request[target_branch]=main",
  "自建 GitLab + 多级 group + 分支斜杠编码",
);
assert.equal(
  url("https://gitlab.com/group/app", "feat"),
  "https://gitlab.com/group/app/-/merge_requests/new?merge_request[source_branch]=feat",
  "GitLab 无 dst：不带 target 参数",
);
assert.equal(
  url(
    "https://gitlab.com/group/app",
    "feat",
    "main",
    undefined,
  ),
  "https://gitlab.com/group/app/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main",
  "GitLab 基础链接形态不变",
);
assert.equal(
  buildMrUrl({
    originUrl: "https://gitlab.com/group/app",
    srcBranch: "feat",
    dstBranch: "main",
    title: "标题",
    body: "正文",
  })?.url,
  "https://gitlab.com/group/app/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main&merge_request[title]=%E6%A0%87%E9%A2%98&merge_request[description]=%E6%AD%A3%E6%96%87",
  "GitLab 预填 merge_request[title]/[description]",
);

// ---- Gitee：compare 必须两端都有分支 ----
assert.deepEqual(
  build("https://gitee.com/acme/app.git", "feat", "main"),
  { url: "https://gitee.com/acme/app/compare/feat...main", supportsPrefill: true },
  "Gitee + dst",
);
assert.equal(url("https://gitee.com/acme/app.git", "feat"), null, "Gitee 无 dst 返回 null");
assert.equal(
  buildMrUrl({
    originUrl: "https://gitee.com/acme/app.git",
    srcBranch: "feat",
    dstBranch: "main",
    title: "标题",
    body: "正文",
  })?.url,
  "https://gitee.com/acme/app/compare/feat...main?title=%E6%A0%87%E9%A2%98&body=%E6%AD%A3%E6%96%87",
  "Gitee 保守预填 title/body",
);

// ---- Bitbucket：source / dest 查询参数；不支持预填，仍返回基础页 ----
assert.deepEqual(
  build("git@bitbucket.org:acme/app.git", "feat/x", "main"),
  {
    url: "https://bitbucket.org/acme/app/pull-requests/new?source=feat%2Fx&dest=main",
    supportsPrefill: false,
  },
  "Bitbucket + dst 且不支持预填",
);
assert.equal(
  buildMrUrl({
    originUrl: "git@bitbucket.org:acme/app.git",
    srcBranch: "feat/x",
    dstBranch: "main",
    title: "t",
    body: "b",
  })?.url,
  "https://bitbucket.org/acme/app/pull-requests/new?source=feat%2Fx&dest=main",
  "Bitbucket 忽略 title/body",
);
assert.equal(
  url("https://bitbucket.org/acme/app.git", "feat"),
  null,
  "Bitbucket 无 dst 返回 null",
);

// ---- 自定义模板：{src} {dst} {repo} 直接替换，不支持预填 ----
assert.deepEqual(
  build(
    "https://git.example.com/acme/app.git",
    "feat",
    "main",
    "https://git.example.com/{repo}/merge/new?from={src}&to={dst}",
  ),
  {
    url: "https://git.example.com/acme/app/merge/new?from=feat&to=main",
    supportsPrefill: false,
  },
  "模板替换（未知主机也能用）",
);
assert.equal(
  build("https://git.example.com/acme/app.git", "feat", "", "https://x/{repo}?src={src}&dst={dst}"),
  null,
  "模板含 {dst} 但无上游：返回 null，不做空串修补",
);
assert.equal(
  url("https://git.example.com/acme/app.git", "feat", "", "https://x/{repo}/merge?src={src}"),
  "https://x/acme/app/merge?src=feat",
  "模板不含 {dst} 时无上游也能用",
);

// ---- 无法构造的输入 ----
assert.equal(build("https://git.example.com/acme/app.git", "feat", "main"), null, "不认识的 host");
assert.equal(build("", "feat", "main"), null, "origin 为空");
assert.equal(build("https://github.com/acme/app.git", "", "main"), null, "源分支为空");

// ---- AI 输出解析：第一行标题 / 其余正文 ----
assert.deepEqual(
  parseMrDraft("feat: 加登录\n\n- 新增登录页\n- 补兼容性说明"),
  { title: "feat: 加登录", body: "- 新增登录页\n- 补兼容性说明" },
  "标准格式",
);
assert.deepEqual(
  parseMrDraft("```\nfix: 修崩溃\n\n正文一行\n```"),
  { title: "fix: 修崩溃", body: "正文一行" },
  "剥掉代码块围栏",
);
assert.deepEqual(parseMrDraft("## 标题\n正文"), { title: "标题", body: "正文" }, "剥掉 # 标记");
assert.deepEqual(parseMrDraft("只有标题"), { title: "只有标题", body: "" }, "无正文");

// ---- 剪贴板文本：标题 + 空行 + 正文 ----
assert.equal(mrPrefillToClipboard("标题", "正文"), "标题\n\n正文", "标题空行正文");
assert.equal(mrPrefillToClipboard(" 标题 ", "  "), "标题", "正文为空时只有标题");

// ---- 预设收敛：脏数据不当成合法预设，dst 空的行扔掉 ----
assert.deepEqual(
  normalizeMrPresets([
    { src: " feature/x ", dst: " main " },
    { src: "", dst: "develop" },
    { dst: "  " },
    { src: "feat" },
    null,
    "junk",
  ]),
  [{ src: "feature/x", dst: "main" }, { dst: "develop" }],
  "预设 trim、丢空 dst、src 空则不存",
);
assert.deepEqual(normalizeMrPresets({ dst: "main" }), [], "非数组退回空");
assert.deepEqual(normalizeMrPresets(null), [], "null 退回空");

console.log("mrUrl tests passed");
