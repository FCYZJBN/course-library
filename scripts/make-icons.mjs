// 生成 PWA 图标：node scripts/make-icons.mjs
//
// 不引入任何图形库——手写 PNG 编码（Node 自带 zlib），图案用 4 倍超采样再降采样，
// 这样圆角和斜边不会有锯齿。改图案只要改下面的 draw()。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

// —— PNG 编码 ——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前面加一个 filter 字节（0 = 不过滤）
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// —— 画图：一律在单位坐标系（0..1）里描述，再乘尺寸 ——

const BG = [47, 111, 237];   // 和 --primary 一致
const FG = [255, 255, 255];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 射线法判断点是否在多边形内
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 图案：蓝色圆角方块 + 一本摊开的书。
 * 两页在中缝处下凹（顶边是个浅 V），这个凹口是「书」而不是「三条横杠」的关键。
 * @param {number} pad 四周留白比例。maskable 图标要求内容缩在中心安全区内。
 */
function draw(x, y, pad) {
  const s = 1 - pad * 2;
  const u = (v) => pad + v * s;

  if (!inRoundRect(x, y, pad, pad, 1 - pad, 1 - pad, 0.22 * s)) return [0, 0, 0, 0];

  const X = (v) => u(v);
  const Y = (v) => u(v);

  // 左页 / 右页：外上角高、中缝处低，底边也向外微翘
  const left = [
    [X(0.5), Y(0.42)], [X(0.15), Y(0.32)], [X(0.15), Y(0.62)], [X(0.5), Y(0.74)],
  ];
  const right = [
    [X(0.5), Y(0.42)], [X(0.85), Y(0.32)], [X(0.85), Y(0.62)], [X(0.5), Y(0.74)],
  ];

  if (inPoly(x, y, left) || inPoly(x, y, right)) return [...FG, 255];
  return [...BG, 255];
}

/** 4 倍超采样后取平均，得到抗锯齿的像素 */
function render(size, pad) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = draw(
            (x + (sx + 0.5) / SS) / size,
            (y + (sy + 0.5) / SS) / size,
            pad
          );
          // 按 alpha 加权，避免透明边缘混进黑色
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

mkdirSync(OUT, { recursive: true });

const jobs = [
  ['icon-192.png', 192, 0.02],
  ['icon-512.png', 512, 0.02],
  // maskable：内容要缩进中心 80% 的安全区，否则被系统裁成圆形时书本会被切掉
  ['icon-maskable-512.png', 512, 0.14],
];

for (const [name, size, pad] of jobs) {
  writeFileSync(join(OUT, name), encodePng(size, size, render(size, pad)));
  console.log(`  ${name}  ${size}×${size}`);
}
console.log('图标已生成到 icons/');
