// 生成 git-zen 应用图标（多尺寸 ICO，圆形泳道主题：深空底 + 紫罗兰主色）
// 运行：node scripts/gen-icon.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 在 1024x1024 超采样画布上作画，再降采样到各尺寸 ----
const S = 1024;
const px = new Float32Array(S * S * 3); // 线性叠加

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  // 圆形裁剪：圆外一律不画（留 2px 抗锯齿过渡带）
  const dc = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
  if (dc > CLIP_R + 1) return;
  const i = (y * S + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
}

function fillCircle(cx, cy, rad, [r, g, b]) {
  const x0 = Math.floor(cx - rad),
    x1 = Math.ceil(cx + rad);
  for (let y = Math.floor(cy - rad); y <= cy + rad; y++)
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.min(1, Math.max(0, rad - d)); // 1px 边缘抗锯齿
      if (a > 0) blend(x, y, r, g, b, a);
    }
}

function strokeLine(x1, y1, x2, y2, w, color) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, w / 2, color);
  }
}

const CX = S / 2,
  CY = S / 2,
  CLIP_R = 470;
const BG = [0.063, 0.063, 0.078]; // #101014 深空底
const VIOLET = [0.545, 0.498, 0.961]; // #8b7ff5 主色（外环）
const VIOLET_LITE = [0.659, 0.62, 1.0]; // #a89eff 提交节点
const TEAL = [0.29, 0.62, 0.76]; // 辅助色

// 外环：先整盘紫色，再叠小一号的底色，留出 ~26px 环
fillCircle(CX, CY, CLIP_R, VIOLET);
fillCircle(CX, CY, CLIP_R - 28, BG);

// 泳道：主竖线（紫）+ 一条分叉弧线（青）回主线
strokeLine(430, 240, 430, 784, 54, VIOLET);
for (let i = 0; i < 40; i++) {
  const t = i / 39;
  const y = 350 + t * 320;
  const x = 430 + Math.sin(t * Math.PI) * 200; // 鼓向右边的弧
  const nextY = 350 + ((i + 1) / 39) * 320;
  const nextX = 430 + Math.sin(((i + 1) / 39) * Math.PI) * 200;
  strokeLine(x, y, nextX, nextY, 44, TEAL);
}
// 提交节点
fillCircle(430, 270, 72, VIOLET_LITE);
fillCircle(630, 510, 62, TEAL);
fillCircle(430, 750, 72, VIOLET_LITE);

// ---- 降采样输出各尺寸 ----
function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const f = S / size;
  // 圆形透明度：圆外 alpha=0（四角透明），边缘 1px 抗锯齿
  const rc = (CLIP_R - 1) / f; // 目标尺寸下的圆半径
  const cc = size / 2 - 0.5;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0;
      // 简单盒滤波：每目标像素取 f 个源像素的步进采样
      const step = Math.max(1, Math.floor(f / 2));
      let n = 0;
      for (let sy = Math.floor(y * f); sy < (y + 1) * f; sy += step)
        for (let sx = Math.floor(x * f); sx < (x + 1) * f; sx += step) {
          const i = (sy * S + sx) * 3;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          n++;
        }
      const o = ((size - 1 - y) * size + x) * 4; // ICO 是自底向上
      out[o] = Math.round((b / n) * 255);
      out[o + 1] = Math.round((g / n) * 255);
      out[o + 2] = Math.round((r / n) * 255);
      const d = Math.hypot(x - cc, y - cc);
      out[o + 3] = Math.round(Math.max(0, Math.min(1, rc - d)) * 255);
    }
  return out;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => ({ size: s, data: render(s) }));

// 组装 ICO
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + images.length * 16;
for (const img of images) {
  // PNG 封装（Vista+ 支持 ICO 内嵌 PNG）
  const e = Buffer.alloc(16);
  e[0] = img.size === 256 ? 0 : img.size;
  e[1] = img.size === 256 ? 0 : img.size;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.data.length, 8); // 暂存 BMP 大小，PNG 则替换
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += img.data.length;
}
// 直接用原始 BMP 数据（无 PNG 编码器依赖）
offset = 6 + images.length * 16;
entries.length = 0;
const bmps = [];
for (const img of images) {
  const s = img.size;
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(s, 4);
  dib.writeInt32LE(s * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  const andMask = Buffer.alloc(s * Math.ceil(s / 32) * 4);
  const bmp = Buffer.concat([dib, img.data, andMask]);
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(bmp.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  bmps.push(bmp);
  offset += bmp.length;
}
mkdirSync(join(root, "src-tauri/icons"), { recursive: true });
writeFileSync(
  join(root, "src-tauri/icons/icon.ico"),
  Buffer.concat([header, ...entries, ...bmps]),
);
console.log("icon.ico:", sizes.join("/"), "written");
