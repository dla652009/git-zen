// 生成 git-zen 应用图标（多尺寸 ICO，泳道主题：暗底 + 绿色提交节点 + 分支曲线）
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

// 圆角方块背景
function roundedRect(margin, radius, color) {
    for (let y = margin; y < S - margin; y++)
        for (let x = margin; x < S - margin; x++) {
            // 到圆角的距离
            const dx = Math.max(
                margin + radius - (x + 0.5),
                x + 0.5 - (S - margin - radius),
                0,
            );
            const dy = Math.max(
                margin + radius - (y + 0.5),
                y + 0.5 - (S - margin - radius),
                0,
            );
            const d = Math.hypot(dx, dy) - radius;
            if (d < 0) blend(x, y, ...color, Math.min(1, -d));
        }
}

const BG = [0.086, 0.098, 0.11]; // #161923 近似
const GREEN = [0.29, 0.76, 0.36]; // #4ac25b
const BLUE = [0.29, 0.62, 0.76];

roundedRect(64, 180, BG);

// 泳道：主竖线 + 一条分叉弧线回到主线
strokeLine(400, 220, 400, 804, 56, GREEN);
// 分叉：从主线中部弯到右侧再汇回
for (let i = 0; i < 40; i++) {
    const t = i / 39;
    const y = 340 + t * 340;
    const x = 400 + Math.sin(t * Math.PI) * 240; // 鼓向右边的弧
    const nextY = 340 + ((i + 1) / 39) * 340;
    const nextX = 400 + Math.sin(((i + 1) / 39) * Math.PI) * 240;
    strokeLine(x, y, nextX, nextY, 48, BLUE);
}
// 提交节点
fillCircle(400, 250, 78, GREEN);
fillCircle(628, 510, 66, BLUE);
fillCircle(400, 770, 78, GREEN);

// ---- 降采样输出各尺寸 ----
function render(size) {
    const out = Buffer.alloc(size * size * 4);
    const f = S / size;
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
            out[o + 3] = 255;
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
