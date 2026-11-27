import * as ort from './ort.wasm.min.mjs';

const width = 192, height = 256, stride = 4;
let localizer;

function loadLocalizer() {
  if (!localizer) {
    localizer = ort.InferenceSession.create(new URL('./date-localizer.onnx', import.meta.url).href, {
      executionProviders: ['wasm']
    }).catch(error => { localizer = null; throw error; });
  }
  return localizer;
}

export async function locateDateStamps(image) {
  const session = await loadLocalizer();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const offset = i * 4;
    data[i] = (0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2]) / 127.5 - 1;
  }
  const input = new ort.Tensor('float32', data, [1, 1, height, width]);
  try {
    const result = (await session.run({ [session.inputNames[0]]: input }))[session.outputNames[0]];
    try {
      const [, , rows, columns] = result.dims;
      const n = rows * columns, values = result.data;
      const candidates = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[b] - values[a]);
      const boxes = [];
      for (const i of candidates) {
        const x = (i % columns + values[n + i] * 2) * stride / width;
        const y = (Math.floor(i / columns) + values[2 * n + i] * 2) * stride / height;
        if (boxes.some(box => Math.abs(box.x - x) < 0.11 && Math.abs(box.y - y) < 0.037)) continue;
        const w = Math.max(0.06, Math.min(0.65, values[3 * n + i]));
        const h = Math.max(0.025, Math.min(0.23, values[4 * n + i]));
        boxes.push({ x, y, w, h });
        if (boxes.length === 4) break;
      }
      return boxes.flatMap(({ x, y, w, h }) => [
        [1.12, 1.20, 0, 0], [1.36, 1.38, 0, 0], [1.56, 1.40, 0, 0],
        // If the heat map centers on the beginning of a stamp, inspect the
        // rest of that row at a tighter height to avoid the lot line below.
        [1.48, 0.78, 0.40, -0.13], [1.55, 0.79, 0.42, -0.12], [1.40, 0.84, 0.39, -0.15]
      ].map(([sx, sy, dx, dy]) => {
        const left = x + w * (dx - sx / 2), top = y + h * (dy - sy / 2);
        const right = x + w * (dx + sx / 2), bottom = y + h * (dy + sy / 2);
        return [Math.max(0, left), Math.max(0, top), Math.min(1, right), Math.min(1, bottom)];
      }).filter(([left, top, right, bottom]) => right > left && bottom > top));
    } finally { result.dispose(); }
  } finally { input.dispose(); }
}
