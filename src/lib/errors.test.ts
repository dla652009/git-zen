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

// 删当前分支：git 2.56 的真实文案是「cannot delete branch ... used by worktree」——
// 「不能删除这个分支」必须排在「未合并」与「worktree 占用」之前，否则用户看到的是别的建议
assert(
  humanize("error: cannot delete branch 'main' used by worktree at 'C:/repo'").msg.includes(
    "不能删除这个分支",
  ),
  "删当前分支的真实文案",
);
assert(humanize("error: The branch 'feat/x' is not fully merged.").msg.includes("尚未合并"), "not fully merged");
assert(humanize("error: Cannot delete branch 'x' checked out at 'D:/a'").msg.includes("不能删除这个分支"), "旧文案也命中");

// 分支名本身可能叫 conflict 或含 403：「分支不存在」必须先于「冲突」「认证失败」命中
assert(humanize("error: branch 'conflict' not found").msg.includes("分支不存在"), "分支名含 conflict");
assert(humanize("error: branch 'x403y' not found").msg.includes("分支不存在"), "分支名含 403");

// Windows 保留设备名：git 读不出来必然 ENOENT，必须给能照着做的提示而不是原始 stderr。
// 真实报错形如：
//   error: open("CON"): No such file or directory
//   error: unable to index file 'CON'
//   fatal: adding files failed
const reserved = humanize(
  `error: open("CON"): No such file or directory
error: unable to index file 'CON'
fatal: adding files failed`,
);
assert(reserved.msg.includes("保留设备名"), "Windows 保留名给出人话解释");
assert(reserved.detail?.includes("unable to index file"), "保留原始 stderr");
// 带扩展名同样是保留名（CON.txt 在 Win32 层一样被重定向到设备）
assert(humanize(`error: open("src/CON.txt"): No such file or directory`).msg.includes("保留设备名"), "CON.txt 也命中");
assert(humanize(`error: open("NUL"): No such file or directory`).msg.includes("保留设备名"), "NUL 命中");
// 其它原因导致的 index 失败不能被误判成保留名
assert(humanize("error: unable to index file 'a.txt'").msg.includes("保留设备名") === false, "普通 index 失败不误判");

// 兜底：不认识的原样给出，并剥掉 Error: 前缀（组件里 String(new Error(...)) 很常见）
assert(humanizeMsg(new Error("磁盘已满")) === "磁盘已满", "剥 Error: 前缀");
assert(humanize("some unknown git failure").msg === "some unknown git failure", "未知错误原文");
assert(humanize("nothing to commit, working tree clean").detail === "nothing to commit, working tree clean", "命中时保留原始 stderr");

console.log("errors tests passed");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`errors 自检失败: ${msg}`);
}
