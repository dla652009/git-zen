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
    // 「没有配置远程」时 git 会连打两行：does not appear to be a git repository + could not read
    // from remote repository。必须让前者先命中，否则会把「没配 origin」误诊成认证问题
    [/does not appear to be a git repository|No configured push destination/i, "远程不可用：没有配置 origin（先在终端 git remote add origin <url>）或地址失效"],
    [/could not read from remote repository/i, "无法读取远程仓库：URL 错误、无权访问或认证失败"],
    [/repository .* does not exist/i, "仓库不存在：检查 URL 拼写与访问权限"],
    // 分支不存在必须排在「认证失败」与「冲突」之前：分支名本身可能叫 conflict 或含 403
    [/branch .* not found/i, "分支不存在：检查名字拼写（大小写也要一致）"],
    [/authentication|permission denied|could not read Username|403/i, "认证失败：请检查系统 git 凭据（credential helper / ssh key）"],
    [/not a git repository/i, "所选目录不是 Git 仓库"],
    [/does not have any commits yet/i, "空仓库：还没有任何提交"],
    [/conflict/i, "产生合并冲突：在左侧解决冲突文件后暂存并提交，或用「放弃合并」退出"],
    [/failed to connect|connection timed out|could not resolve host/i, "网络不通：无法连接远程仓库"],
    [/remote ref does not exist/i, "远程没有这个分支：可能已被别人删除，或名字拼写有误"],
    [/pathspec .* did not match/i, "目标分支或文件不存在：可能已被删除，或名字拼写有误"],
    [/cannot delete branch/i, "不能删除这个分支：它是当前所在的分支，或正被另一个工作树检出 —— 换到那个工作树处理，或先在终端 git worktree 清理"],
    [/not fully merged/i, "该分支尚未合并：强删会丢掉上面的提交，确认后到终端用 -D"],
    [/used (as|by) worktree/i, "这个分支正被某个工作树占用，先切到别的分支再删"],
    [
      /empty string is not a valid pathspec/i,
      "分支名为空：仓库可能处于游离 HEAD（不在任何分支上），先切到一个分支再重试",
    ],
    [
      /not currently on a branch/i,
      "仓库处于游离 HEAD（不在任何分支上），没有分支可推送：先切到一个分支",
    ],
  ];
  const hit = rules.find(([re]) => re.test(s));
  return hit ? { msg: hit[1], detail: s } : { msg: s };
}

/** 组件内联错误提示用的一行版：拿到人话，不关心原始 stderr */
export function humanizeMsg(raw: unknown): string {
  return humanize(raw).msg;
}
