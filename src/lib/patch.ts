// diff patch → 着色行 / 按文件分段（DiffViewer 与 FileHistoryModal 共用）
// 支持两种格式：普通 unified diff（diff --git）与合并冲突的 combined diff（diff --cc，
// 双状态列分别表示相对 ours/theirs 两个父版本的增删）

export interface PatchLine {
  cls: string;
  text: string;
  oldLine?: number; // 旧文件行号（context/- 行，unified hunk 内才有）
  newLine?: number; // 新文件行号（context/+ 行，unified hunk 内才有）
}

export interface PatchSection {
  file: string;
  lines: PatchLine[];
}

const ADD = "bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]";
const DEL = "bg-[var(--diff-del-bg)] text-[var(--diff-del-text)]";
// 冲突标记行（<<<<<<< / ======= / >>>>>>>）：琥珀色，与状态图标/Badge warning 同色系
const CONFLICT = "bg-amber-400/15 text-amber-400";
const MUTED = "text-muted-foreground";

// combined diff：2 个状态列；标记行只在结果侧新增（++），两侧增删任一存在即着色
function combinedLine(l: string): PatchLine {
  const c1 = l[0];
  const c2 = l[1];
  if (c1 === "+" && c2 === "+") {
    const t = l.slice(2).trim();
    if (t.startsWith("<<<<<<<") || t === "=======" || t.startsWith(">>>>>>>"))
      return { cls: CONFLICT, text: l };
    return { cls: ADD, text: l };
  }
  if (c1 === "-" && c2 === "-") return { cls: DEL, text: l };
  if (c1 === "+" || c2 === "+") return { cls: ADD, text: l };
  if (c1 === "-" || c2 === "-") return { cls: DEL, text: l };
  return { cls: "", text: l };
}

// hunk 之外的元信息行，两种格式通用（都出现在 hunk 之前）
const META_RE =
  /^(index |--- |\+\+\+|new file|deleted file|rename |similarity |copy |old mode|new mode|Binary files )/;

export function patchLines(text: string): PatchLine[] {
  const out: PatchLine[] = [];
  let combined = false; // 是否处于 diff --cc 段内
  let oldNo = 0; // unified hunk 内的行号游标（@@ 头初始化，供逐行归属/blame 用）
  let newNo = 0;
  for (const l of text.split("\n")) {
    if (l.startsWith("diff --cc ")) {
      combined = true;
      out.push({ cls: MUTED, text: l });
    } else if (l.startsWith("diff ")) {
      combined = false;
      out.push({ cls: MUTED, text: l });
    } else if (l.startsWith("@@@")) {
      // combined 的 hunk 头带三段范围，不高亮成新增色（行号跟踪只做 unified）
      out.push({ cls: MUTED, text: l });
    } else if (META_RE.test(l)) {
      out.push({ cls: MUTED, text: l });
    } else {
      const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldNo = Number(hunk[1]);
        newNo = Number(hunk[2]);
        out.push({ cls: ADD, text: l });
        continue;
      }
      if (combined) {
        out.push(combinedLine(l));
        continue;
      }
      const c = l[0];
      if (c === "+") {
        out.push({ cls: ADD, text: l, newLine: newNo });
        newNo++;
      } else if (c === "-") {
        out.push({ cls: DEL, text: l, oldLine: oldNo });
        oldNo++;
      } else if (c === "@") {
        // 未匹配标准 hunk 头的 @@ 行（如未跟踪文件合成预览的「@@ 新文件 @@」），保持新增底色
        out.push({ cls: ADD, text: l });
      } else {
        out.push({ cls: "", text: l, oldLine: oldNo, newLine: newNo });
        oldNo++;
        newNo++;
      }
    }
  }
  return out;
}

// 按文件切段：unified 头 `diff --git a/<path> b/<path>`（贪婪匹配兼容含空格路径），
// combined 头 `diff --cc <path>`（路径原样跟在后面）
export function patchSections(text: string): PatchSection[] {
  const out: PatchSection[] = [];
  let cur: PatchSection | null = null;
  for (const l of patchLines(text)) {
    const m = l.text.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      cur = { file: m[1], lines: [l] };
      out.push(cur);
    } else if (l.text.startsWith("diff --cc ")) {
      cur = { file: l.text.slice("diff --cc ".length), lines: [l] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(l);
    }
  }
  return out;
}
