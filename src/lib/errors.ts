// git stderr -> 人话。放在 lib 里而不是 App.vue 内，是因为组件内联的错误提示
// （AI 生成、diff 加载、文件历史、stash 列表……）同样需要它——过去那些地方直出英文原文，
// 用户会看到 `fatal: not a git repository`。匹配不到就原文展示，并在 detail 里保留原始 stderr。
export function humanize(raw: unknown): { msg: string; detail?: string } {
  // 剥掉 `String(new Error("x"))` 带出来的 "Error: " 前缀——兜底分支直接展示 msg，
  // 不剥的话用户会看到「Error: 磁盘已满」。命中规则时 detail 仍保留原始 stderr。
  const s = String(raw).replace(/^Error: /, "");
  const rules: [RegExp, string][] = [
    [/has no upstream|no tracking information/i, "当前分支没有上游，先在终端执行一次：git push -u origin <分支名>"],
    // 只说「先 Pull 再 Push」会把人引去把远程旧提交合回来、造出多余的合并提交；
    // amend / 撤销提交之后本来就该用 force-with-lease 覆盖自己那一条，两条路都给出来
    [
      /rejected.*fetch first|non-fast-forward/i,
      "推送被拒：远程有本地没有的提交。若这些提交是别人推的，先 Pull 合并再 Push；若只是你刚 amend / 撤销提交改写了历史，用顶部 ↑N 里的「强制推送（--force-with-lease）」",
    ],
    [/nothing to commit/i, "没有可提交的内容：先暂存文件"],
    [/cherry-pick is now empty|previous cherry-pick/i, "该提交的改动已在当前分支上（空拣选），无需重复 cherry-pick"],
    [/already exists and is not an empty directory/i, "目标目录已存在且非空：换一个目录名或位置"],
    [/could not read from remote repository/i, "无法读取远程仓库：URL 错误、无权访问或认证失败"],
    [/repository .* does not exist/i, "仓库不存在：检查 URL 拼写与访问权限"],
    [/authentication|permission denied|could not read Username|403/i, "认证失败：请检查系统 git 凭据（credential helper / ssh key）"],
    [/does not appear to be a git repository|No configured push destination/i, "远程不可用：没有配置 origin（先在终端 git remote add origin <url>）或地址失效"],
    [/not a git repository/i, "所选目录不是 Git 仓库"],
    [/does not have any commits yet/i, "空仓库：还没有任何提交"],
    [/conflict/i, "产生合并冲突：在左侧解决冲突文件后暂存并提交，或用「放弃合并」退出"],
    [/failed to connect|connection timed out|could not resolve host/i, "网络不通：无法连接远程仓库"],
    [/not fully merged|used as worktree/i, "该分支尚未合并或有其他占用，为防误删请到终端确认处理"],
  ];
  const hit = rules.find(([re]) => re.test(s));
  return hit ? { msg: hit[1], detail: s } : { msg: s };
}

/** 组件内联错误提示用的一行版：拿到人话，不关心原始 stderr */
export function humanizeMsg(raw: unknown): string {
  return humanize(raw).msg;
}
