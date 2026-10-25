import type { Bitmap } from './escpos';

// The café logo as a black-and-white picture for the receipt printer: the dark lettering prints, the orange
// background stays paper-white. It's cropped to the lettering and centred on the paper.
const isDark = (rgba: ArrayLike<number>, i: number, threshold: number) => rgba[i + 3] > 128 && 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] < threshold;

// The smallest box around the dark pixels, so the picture has no blank margins.
export function darkBox(rgba: ArrayLike<number>, width: number, height: number, threshold = 110) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!isDark(rgba, (y * width + x) * 4, threshold)) continue;
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

// One bit per dot, rows as wide as the paper, the picture centred.
export function toBitmap(rgba: ArrayLike<number>, width: number, height: number, paperDots: number, threshold = 110): Bitmap {
  const bytesPerRow = paperDots / 8, data = new Uint8Array(bytesPerRow * height), left = Math.max(0, Math.floor((paperDots - width) / 2));
  for (let y = 0; y < height; y++) for (let x = 0; x < width && left + x < paperDots; x++) {
    if (isDark(rgba, (y * width + x) * 4, threshold)) data[y * bytesPerRow + ((left + x) >> 3)] |= 0x80 >> ((left + x) & 7);
  }
  return { width: paperDots, height, data };
}

const cache = new Map<string, Promise<Bitmap | null>>();
// Loads and converts the logo once per paper width. Resolves to null if it can't, and the receipt prints the
// café's name in large letters instead.
export function receiptLogo(url: string, paperDots: number): Promise<Bitmap | null> {
  const key = `${url}|${paperDots}`;
  if (!cache.has(key)) cache.set(key, (async () => {
    const img = new Image();
    img.src = url;
    await img.decode();
    // Find the lettering on a small copy, then draw just that part at print size.
    const probe = document.createElement('canvas'), scale = 600 / img.naturalWidth;
    probe.width = 600; probe.height = Math.round(img.naturalHeight * scale);
    const pc = probe.getContext('2d', { willReadFrequently: true })!;
    pc.drawImage(img, 0, 0, probe.width, probe.height);
    const box = darkBox(pc.getImageData(0, 0, probe.width, probe.height).data, probe.width, probe.height);
    if (!box) return null;
    const width = Math.round(paperDots * 0.72), height = Math.max(1, Math.round(box.height * width / box.width));
    const out = document.createElement('canvas'); out.width = width; out.height = height;
    const oc = out.getContext('2d', { willReadFrequently: true })!;
    oc.drawImage(img, box.x / scale, box.y / scale, box.width / scale, box.height / scale, 0, 0, width, height);
    return toBitmap(oc.getImageData(0, 0, width, height).data, width, height, paperDots);
  })().catch(() => null));
  return cache.get(key)!;
}
