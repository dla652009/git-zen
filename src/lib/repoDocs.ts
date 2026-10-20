// 仓库自述文档：给 AI 一份「这个仓库自己写明的约定」，避免它只能从提交历史里猜风格。
// 只读，路径固定为几个常见文件名，读不到就返回空串（多数仓库根本没有这些文件）。
import * as api from "../gitApi";

// 按优先级排列：第一条命中就停。约定俗成的贡献文档位置（GitHub/GitLab 都认 .github/）
const CONVENTION_FILES = [
  "CONTRIBUTING.md",
  "CONTRIBUTING.zh-CN.md",
  "CONTRIBUTING.zh_CN.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "docs/COMMITS.md",
  ".gitmessage",
];

// 只取前 6KB：约定文档动辄几百行，全塞给模型既贵又容易把重点冲掉
const CONVENTION_BYTES = 6_000;

/** 读仓库的提交规范文档，返回正文；没有则返回空串 */
export async function readCommitConvention(repo: string): Promise<string> {
  for (const path of CONVENTION_FILES) {
    try {
      const text = await api.readRepoFile(repo, path, CONVENTION_BYTES);
      if (text && text.trim()) return text.trim();
    } catch {
      // 单个候选读失败（权限/编码）不影响继续试下一个
    }
  }
  return "";
}
