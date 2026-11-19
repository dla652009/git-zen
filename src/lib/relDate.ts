// 相对时间统一转中文。
//
// 两个来源，别混：
//  1. git log 的 `--date=relative` 给出的是**英文**（"3 days ago"），后端原样塞进 date 字段；
//  2. blame 给的是 epoch 秒，需要自己算差值。
// 界面是中文的，英文 "3 days ago" 直接显示很突兀，所以两种都收口到这里。

// 单位 → 中文量词。不含「前」：复合单位要拼成「2 年 6 个月前」，
// 「前」只加在最末尾一次，否则会读成「2 年前 6 个月前」。
const REL_UNITS: Record<string, string> = {
  second: "秒",
  minute: "分钟",
  hour: "小时",
  day: "天",
  week: "周",
  month: "个月",
  year: "年",
};

// 单段："3 days" / "1 month"。单位词要单独捕获，才能换成中文。
const SEGMENT = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?$/i;

/**
 * git 相对日期（英文）→ 中文。空值原样返回。
 *
 * 必须处理复合单位：git 对跨单位的旧提交输出 `"2 years, 6 months ago"`
 * （不是只有 `"3 days ago"` 一种）。逐段转换后再拼回去，
 * 否则正则匹配不上会退化成「原文去掉 ago」——英文残留还丢了「前」。
 */
export function relDateText(d: string): string {
  if (!d) return "";
  const s = d.trim();

  // 机器时钟或时区导致提交时间在未来，git 会这么说
  if (/^in the future$/i.test(s)) return "未来";

  const m = s.match(/^(.*?)\s+ago$/i);
  if (!m) return s; // 不是相对格式（如 YYYY-MM-DD）：原样透出

  // "3 days" 或 "2 years, 6 months"：按逗号拆开逐段翻译，「前」最后统一加
  const segs = m[1].split(",").map((x) => x.trim());
  const out: string[] = [];
  for (const seg of segs) {
    const hit = seg.match(SEGMENT);
    if (!hit) return s.replace(/\s+ago$/i, ""); // 有不认识的段就整体降级，别拼出半中半英
    out.push(`${hit[1]} ${REL_UNITS[hit[2].toLowerCase()]}`);
  }
  return `${out.join(" ")}前`;
}

/**
 * epoch 秒 → 中文相对时间。用于 blame 这类只有时间戳的地方。
 *
 * 分档必须与 git 一致，否则同一个提交在历史区（git 的英文，经 relDateText 翻译）
 * 和 blame 提示（这里算）会显示成两个数。
 *
 * 以下边界全部来自实测 git 2.47（`git log --date=relative`）：
 *   340 天 → 11 months    345 天 → 12 months   364 天 → 12 months
 *   365 天 → 1 year       400 天 → 1 year, 1 month
 * 注意 345~364 天这一段：git 仍然说「12 months」，要满 365 天才进「年」。
 * 所以不能写成「30 天 = 一个月」（那会在 350 天给出 11 个月）。
 */
const YEAR_DAYS = 365;

export function relFrom(epoch: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor(now / 1000 - epoch));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} 天前`;
  if (d < 89) return `${Math.max(2, Math.floor((d + 3) / 7))} 周前`;

  if (d < YEAR_DAYS) {
    // 月档：git 在 89 天报 3 个月，之后每 30 天左右进一档，到 345 天满 12
    const mo = Math.min(12, Math.floor((d + 15) / 30));
    return `${mo} 个月前`;
  }
  const y = Math.floor(d / YEAR_DAYS);
  const rest = d - y * YEAR_DAYS;
  // 余下不足 30 天不报月（git 的 365~394 天都是「N years」）
  const rm = Math.floor((rest + 15) / 30);
  return rm > 0 ? `${y} 年 ${rm} 个月前` : `${y} 年前`;
}
