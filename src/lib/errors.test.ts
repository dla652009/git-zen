// 错误翻译自检（node --experimental-strip-types src/lib/errors.test.ts）
// 规则是「谁先命中谁说了算」，所以顺序本身就是契约：这里钉的是几个踩过的顺序坑。
import { humanize, humanizeMsg } from "./errors.ts";

// 没配 origin 时 git 会连打两行，第二行更像「认证失败」——必须让「没有配置远程」先命中
const noRemote = `fatal: 'origin' does not appear to be a git repository
fatal: Could not read from remote repository.

Please make sure you have the correct access rights and the repository exists.`;
assert(humanize(noRemote).msg.includes("没有配置 origin"), "没配远程不能被说成认证失败");

// 远程分支已被别人删掉 / 本地分支名写错：都要是人话，不能漏成英文原文
assert(humanize("error: unable to delete 'x': remote ref does not exist").msg.includes("远程没有这个分支"), "remote ref");
assert(humanize("error: branch 'feat/x' not found.").msg.includes("分支不存在"), "branch not found");
assert(
  humanize("error: pathspec 'feat/x' did not match any file(s) known to git").msg.includes("不存在"),
  "pathspec",
);

// 分支被 worktree 占用：git 2.56 报 used by worktree，旧规则写的是 used as worktree
assert(humanize("error: cannot delete branch 'x' used by worktree at 'D:/a'").msg.includes("占用"), "used by worktree");
assert(humanize("error: Cannot delete branch 'x' checked out at 'D:/a'").msg.includes("当前所在的分支"), "cannot delete branch");

// 兜底：不认识的原样给出，并剥掉 Error: 前缀（组件里 String(new Error(...)) 很常见）
assert(humanizeMsg(new Error("磁盘已满")) === "磁盘已满", "剥 Error: 前缀");
assert(humanize("some unknown git failure").msg === "some unknown git failure", "未知错误原文");
assert(humanize("nothing to commit, working tree clean").detail === "nothing to commit, working tree clean", "命中时保留原始 stderr");

console.log("errors tests passed");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`errors 自检失败: ${msg}`);
}
