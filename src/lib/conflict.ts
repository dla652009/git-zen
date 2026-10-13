// 未合并（冲突中）的 porcelain 状态码：UU AA DD AU UA DU UD。
// 抽成公共模块是因为两处都要用：ChangesPanel 靠它决定要不要显示冲突横幅，
// App.vue 靠它区分「合并失败到底是冲突（正常，等用户解决）还是真失败」。
import type { StatusFile } from "../gitApi";

export function isUnmerged(f: StatusFile): boolean {
  return (
    f.x === "U" ||
    f.y === "U" ||
    (f.x === "A" && f.y === "A") ||
    (f.x === "D" && f.y === "D")
  );
}
