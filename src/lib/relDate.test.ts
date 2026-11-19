// relDate.ts 自检：node --experimental-strip-types src/lib/relDate.test.ts
//
// 守一件事：git 的 --date=relative 输出的是英文（"3 days ago"），界面是中文的，
// 必须转成「3 天前」；认不出的格式不能硬猜单位，原样透出。
import assert from "node:assert";
import { relDateText, relFrom } from "./relDate.ts";

function eq(label: string, got: string, want: string) {
  assert.equal(got, want, label);
}

// 以下输入全部取自真实 `git log --date=relative` 的输出（git 2.47实测），
// 不要自己编格式：git 不会说 "1 day ago"（那是 "24 hours ago"）、
// 也不会说 "3 months, 2 weeks ago"（跨单位只出现「年+月」）。
eq("秒", relDateText("5 seconds ago"), "5 秒前");
eq("分钟", relDateText("60 minutes ago"), "60 分钟前");
eq("小时", relDateText("24 hours ago"), "24 小时前");
eq("天", relDateText("3 days ago"), "3 天前");
eq("周", relDateText("2 weeks ago"), "2 周前");
eq("月", relDateText("12 months ago"), "12 个月前");
eq("年", relDateText("2 years ago"), "2 年前");
eq("大写单位", relDateText("3 Days Ago"), "3 天前");

// 复合单位：git 对跨单位的旧提交只输出这一种形式，正则只认单单位的话会漏成英文
eq("复合 年+月", relDateText("2 years, 6 months ago"), "2 年 6 个月前");
eq("复合 年+月单数", relDateText("1 year, 6 months ago"), "1 年 6 个月前");
eq("复合 1年1月", relDateText("1 year, 1 month ago"), "1 年 1 个月前");

// 机器时钟/时区导致提交在未来（导入他人仓库常见）
eq("未来", relDateText("in the future"), "未来");
eq("未来大写", relDateText("In The Future"), "未来");

// 不是英文相对格式：原样透出
eq("ISO 日期", relDateText("2026-11-19"), "2026-11-19");
eq("旧短格式", relDateText("10d"), "10d");
eq("空值", relDateText(""), "");
eq("未知英文", relDateText("yesterday"), "yesterday");
// 有一整段认不出来：整体降级，不能拼出「2 年 6 fortnights 前」这种半中半英
eq("片段无法识别", relDateText("2 years, 6 fortnights ago"), "2 years, 6 fortnights");

// epoch → 中文
const now = 1_700_000_000_000;
eq("刚刚", relFrom(now / 1000 - 10, now), "刚刚");
eq("分钟", relFrom(now / 1000 - 120, now), "2 分钟前");
eq("小时", relFrom(now / 1000 - 7200, now), "2 小时前");
eq("天", relFrom(now / 1000 - 86400 * 3, now), "3 天前");
eq("未来时间不出现负数", relFrom(now / 1000 + 999, now), "刚刚");

// 边界对照表：右边注释是同一时刻 git 2.47 的真实输出（实测，非推测）。
// 两处口径必须一致 —— 否则同一个提交在历史区写「12 个月前」、在 blame 提示里写「11 个月前」。
const GIT_BOUNDARIES: [number, string, string][] = [
  [14, "2 周前", "2 weeks ago"],
  [20, "3 周前", "3 weeks ago"],
  [31, "4 周前", "4 weeks ago"],
  [45, "6 周前", "6 weeks ago"],
  [59, "8 周前", "8 weeks ago"],
  [60, "9 周前", "9 weeks ago"],
  [89, "3 个月前", "3 months ago"],
  [180, "6 个月前", "6 months ago"],
  [300, "10 个月前", "10 months ago"],
  [330, "11 个月前", "11 months ago"],
  [340, "11 个月前", "11 months ago"],
  [345, "12 个月前", "12 months ago"],
  [350, "12 个月前", "12 months ago"],
  [364, "12 个月前", "12 months ago"],
  [365, "1 年前", "1 year ago"],
  [370, "1 年前", "1 year ago"],
  [400, "1 年 1 个月前", "1 year, 1 month ago"],
  [730, "2 年前", "2 years ago"],
  [1000, "2 年 9 个月前", "2 years, 9 months ago"],
];
for (const [days, zh, en] of GIT_BOUNDARIES) {
  eq(`${days} 天（git: ${en}）`, relFrom(now / 1000 - 86400 * days, now), zh);
  // 同一天数分两路算：git 的英文经 relDateText、时间戳经 relFrom，必须得到同一个中文
  eq(`${days} 天两路口径一致`, relDateText(en), zh);
}

console.log("relDate.test.ts: all assertions passed");
