// 生成托盘和应用图标（纯 Node，无依赖）：事件点的菱形标记。
//   assets/trayTemplate.png(+@2x)  macOS 菜单栏模板图标（黑色，系统自动适配深浅色）
//   assets/tray.png(+@2x)          Windows/Linux 托盘图标（琥珀色）
//   assets/icon.png                512x512 应用图标（打包时转换成 .icns/.ico）
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(out, { recursive: true });

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 4x4 超采样抗锯齿。shape(x,y) 返回 0..1 的覆盖度（x,y 为 0..1 的归一化坐标）。 */
function render(size, color, shape) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cover = 0, r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = (x + (sx + 0.5) / SS) / size, py = (y + (sy + 0.5) / SS) / size;
      const s = shape(px, py); // {alpha, rgb?}
      if (s.alpha > 0) { const c = s.rgb ?? color; r += c[0] * s.alpha; g += c[1] * s.alpha; b += c[2] * s.alpha; a += s.alpha; cover++; }
    }
    const n = SS * SS, o = (y * size + x) * 4;
    if (a > 0) { buf[o] = Math.round(r / a); buf[o + 1] = Math.round(g / a); buf[o + 2] = Math.round(b / a); }
    buf[o + 3] = Math.round((a / n) * 255);
  }
  return buf;
}

const diamond = (rad) => (x, y) => ({ alpha: Math.abs(x - 0.5) + Math.abs(y - 0.5) <= rad ? 1 : 0 });

const roundRect = (x, y, r) => {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0), dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
};

const write = (name, size, color, shape) => writeFileSync(path.join(out, name), png(size, size, render(size, color, shape)));

write('trayTemplate.png', 16, [0, 0, 0], diamond(0.42));
write('trayTemplate@2x.png', 32, [0, 0, 0], diamond(0.42));
write('tray.png', 16, [255, 184, 77], diamond(0.42));
write('tray@2x.png', 32, [255, 184, 77], diamond(0.42));
write('icon.png', 512, [255, 184, 77], (x, y) => {
  if (!roundRect(x, y, 0.22)) return { alpha: 0 };
  if (Math.abs(x - 0.5) + Math.abs(y - 0.5) <= 0.27) return { alpha: 1, rgb: [255, 184, 77] };
  if (Math.abs(x - 0.5) + Math.abs(y - 0.5) <= 0.31) return { alpha: 1, rgb: [0, 217, 255] }; // 青色描边，呼应播放头
  return { alpha: 1, rgb: [10, 10, 12] };
});
console.log('icons written to', out);
