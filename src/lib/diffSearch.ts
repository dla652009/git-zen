// diff 内搜索：把 patch 行切成「命中 / 非命中」片段，DiffViewer 与 FileHistoryModal 共用。
//
// 只做纯计算（不碰 DOM、不持有状态）：「当前停在第几个命中」「要不要滚过去」属于组件。
// 这样两个弹窗的高亮行为必然一致，而且能用自检脚本钉住（见 diffSearch.test.ts）。

/** 行内片段 */
export interface Segment {
  /** 片段文本 */
  t: string;
  /** 这一段本身是不是命中 */
  hit: boolean;
  /** 该命中在全部命中里的序号（从 0 起）；非命中片段恒为 -1 */
  at: number;
}

/** 同一行里的一次命中 */
export interface Hit {
  /** 行在所属段 lines 里的下标 */
  row: number;
  /** 起始下标（含） */
  start: number;
  /** 结束下标（不含） */
  end: number;
}

export interface SectionSearch {
  /** 与 lines 等长；查询为空时是 []，组件据此走原来的纯文本渲染 */
  rows: Segment[][];
  hits: Hit[];
}

export interface SearchResult {
  sections: SectionSearch[];
  /** 全部命中，按「段 → 行 → 列」顺序展开 —— 跨文件跳转靠它 */
  hits: { section: number; row: number; at: number }[];
  count: number;
}

/**
 * 大小写折叠。只在折叠不改变长度时才采用结果。
 *
 * 'İ'.toLowerCase() 会变成两个码元，拿折叠后的串算下标就会错位、把高亮画到别的字上；
 * 这种情况只好退回大小写敏感匹配 —— 少匹配几个字符，好过画错位置。
 * 两侧用同一条规则，所以不会出现「text 折叠了、needle 没折叠」的错配。
 */
function fold(s: string): string {
  const lower = s.toLowerCase();
  return lower.length === s.length ? lower : s;
}

/** 一行里全部出现位置（不重叠，从左往右） */
function hitsInRow(text: string, needle: string): [number, number][] {
  const hay = fold(text);
  const ned = fold(needle);
  if (!ned) return [];
  const out: [number, number][] = [];
  let i = 0;
  for (;;) {
    const k = hay.indexOf(ned, i);
    if (k < 0) break;
    out.push([k, k + ned.length]);
    i = k + ned.length; // 从命中末尾继续，所以 'aa' 在 'aaaa' 里是两处而不是三处
  }
  return out;
}

/** 在若干段（每个文件一段）里查找 query。query 去首尾空白后为空则直接返回空结果 */
export function searchSections(
  sections: { file: string; lines: { text: string }[] }[],
  query: string,
): SearchResult {
  if (!query.trim()) {
    return { sections: sections.map(() => ({ rows: [], hits: [] })), hits: [], count: 0 };
  }

  const out: SearchResult = { sections: [], hits: [], count: 0 };
  for (let si = 0; si < sections.length; si++) {
    const lines = sections[si]!.lines;
    const rows: Segment[][] = [];
    const hits: Hit[] = [];
    for (let row = 0; row < lines.length; row++) {
      const text = lines[row]!.text;
      const found = hitsInRow(text, query.trim());
      if (!found.length) {
        // 空行也要给一个空格片段：diff 靠「行里有点东西」撑行高，
        // 返回空数组会让这一行塌掉（原来渲染的是 `l.text || " "`）
        rows.push([{ t: text || " ", hit: false, at: -1 }]);
        continue;
      }
      const segs: Segment[] = [];
      let pos = 0;
      for (const [s, e] of found) {
        if (s > pos) segs.push({ t: text.slice(pos, s), hit: false, at: -1 });
        segs.push({ t: text.slice(s, e), hit: true, at: out.count });
        hits.push({ row, start: s, end: e });
        out.hits.push({ section: si, row, at: out.count });
        out.count++;
        pos = e;
      }
      if (pos < text.length) segs.push({ t: text.slice(pos), hit: false, at: -1 });
      rows.push(segs);
    }
    out.sections.push({ rows, hits });
  }
  return out;
}
