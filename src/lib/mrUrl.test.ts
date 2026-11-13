// mrUrl.ts 自检：node --experimental-strip-types src/lib/mrUrl.test.ts
//
// 这里守的是「菜单里点新建 MR 会打开哪个页面」：主机识别错、分支参数拼错，
// 用户看到的是 404 或被平台拒绝的表单，而不会报错——只能靠这组断言兜住。
import assert from "node:assert";
import { buildMrUrl, normalizeMrPresets } from "./mrUrl.ts";

const build = (originUrl: string, srcBranch: string, dstBranch?: string, template?: string) =>
  buildMrUrl({ originUrl, srcBranch, dstBranch, template });

// ---- GitHub：https / scp 两种 origin，.git 后缀都要剥掉 ----
assert.equal(
  build("https://github.com/acme/app.git", "feature/login", "main"),
  "https://github.com/acme/app/compare/main...feature/login?expand=1",
  "GitHub https + dst",
);
assert.equal(
  build("git@github.com:acme/app.git", "fix", "dev"),
  "https://github.com/acme/app/compare/dev...fix?expand=1",
  "GitHub scp + dst",
);
assert.equal(
  build("https://github.com/acme/app", "fix"),
  "https://github.com/acme/app/compare/fix?expand=1",
  "GitHub 无 dst：只预填源分支",
);

// ---- GitLab：查询参数值要编码，自建 host 与多级 group 都要认 ----
assert.equal(
  build("https://gitlab.com/group/app.git", "feat", "main"),
  "https://gitlab.com/group/app/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main",
  "GitLab.com + dst",
);
assert.equal(
  build("git@gitlab.mycompany.com:team/sub/app.git", "fix/x", "main"),
  "https://gitlab.mycompany.com/team/sub/app/-/merge_requests/new?merge_request[source_branch]=fix%2Fx&merge_request[target_branch]=main",
  "自建 GitLab + 多级 group + 分支斜杠编码",
);
assert.equal(
  build("https://gitlab.com/group/app", "feat"),
  "https://gitlab.com/group/app/-/merge_requests/new?merge_request[source_branch]=feat",
  "GitLab 无 dst：不带 target 参数",
);

// ---- Gitee：compare 必须两端都有分支 ----
assert.equal(
  build("https://gitee.com/acme/app.git", "feat", "main"),
  "https://gitee.com/acme/app/compare/feat...main",
  "Gitee + dst",
);
assert.equal(build("https://gitee.com/acme/app.git", "feat"), null, "Gitee 无 dst 返回 null");

// ---- Bitbucket：source / dest 查询参数 ----
assert.equal(
  build("git@bitbucket.org:acme/app.git", "feat/x", "main"),
  "https://bitbucket.org/acme/app/pull-requests/new?source=feat%2Fx&dest=main",
  "Bitbucket + dst",
);
assert.equal(
  build("https://bitbucket.org/acme/app.git", "feat"),
  null,
  "Bitbucket 无 dst 返回 null",
);

// ---- 自定义模板：{src} {dst} {repo} 直接替换 ----
assert.equal(
  build(
    "https://git.example.com/acme/app.git",
    "feat",
    "main",
    "https://git.example.com/{repo}/merge/new?from={src}&to={dst}",
  ),
  "https://git.example.com/acme/app/merge/new?from=feat&to=main",
  "模板替换（未知主机也能用）",
);
assert.equal(
  build("https://git.example.com/acme/app.git", "feat", "", "https://x/{repo}?src={src}&dst={dst}"),
  null,
  "模板含 {dst} 但无上游：返回 null，不做空串修补",
);
assert.equal(
  build("https://git.example.com/acme/app.git", "feat", "", "https://x/{repo}/merge?src={src}"),
  "https://x/acme/app/merge?src=feat",
  "模板不含 {dst} 时无上游也能用",
);

// ---- 无法构造的输入 ----
assert.equal(build("https://git.example.com/acme/app.git", "feat", "main"), null, "不认识的 host");
assert.equal(build("", "feat", "main"), null, "origin 为空");
assert.equal(build("https://github.com/acme/app.git", "", "main"), null, "源分支为空");

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
