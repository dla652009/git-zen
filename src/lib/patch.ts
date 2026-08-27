// diff patch → 着色行（DiffViewer 与 FileHistoryModal 共用）
export interface PatchLine {
  cls: string;
  text: string;
}

export function patchLines(text: string): PatchLine[] {
  return text.split("\n").map((l) => {
    if (l.startsWith("@@"))
      return {
        cls: "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]",
        text: l,
      };
    if (l.startsWith("+") && !l.startsWith("+++"))
      return {
        cls: "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]",
        text: l,
      };
    if (l.startsWith("-") && !l.startsWith("---"))
      return {
        cls: "bg-[var(--diff-del-bg)] text-[var(--diff-del-text)]",
        text: l,
      };
    if (
      l.startsWith("diff ") ||
      l.startsWith("index ") ||
      l.startsWith("---") ||
      l.startsWith("+++") ||
      l.startsWith("new file") ||
      l.startsWith("deleted file") ||
      l.startsWith("rename ") ||
      l.startsWith("similarity ")
    )
      return { cls: "text-muted-foreground", text: l };
    return { cls: "", text: l };
  });
}
