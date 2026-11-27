import * as ort from './ort.wasm.min.mjs';

let detector;

function getDetector() {
  if (!detector) {
    detector = ort.InferenceSession.create(new URL('./ppocr-v4-det.onnx', import.meta.url).href, {
      executionProviders: ['wasm']
    }).catch(error => { detector = null; throw error; });
  }
  return detector;
}

function components(scores, width, height) {
  const mask = Uint8Array.from(scores, score => score >= 0.3 ? 1 : 0);
  const queue = new Int32Array(mask.length);
  const boxes = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let end = 1, left = width, top = height, right = 0, bottom = 0, strength = 0;
    queue[0] = start;
    mask[start] = 0;
    for (let i = 0; i < end; i++) {
      const point = queue[i], x = point % width, y = Math.floor(point / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      strength += scores[point];
      for (const neighbor of [x > 0 ? point - 1 : -1, x < width - 1 ? point + 1 : -1, point - width, point + width]) {
        if (!mask[neighbor]) continue;
        mask[neighbor] = 0;
        queue[end++] = neighbor;
      }
    }
    const lineWidth = right - left + 1, lineHeight = bottom - top + 1;
    if (lineWidth < 24 || lineHeight < 5 || lineWidth / lineHeight < 2 || strength / end < 0.45) continue;
    const padding = lineHeight * 0.35;
    boxes.push({
      score: strength / end,
      rect: [Math.max(0, left - padding * 2) / width, Math.max(0, top - padding) / height,
        Math.min(width, right + 1 + padding * 2) / width, Math.min(height, bottom + 1 + padding) / height]
    });
  }
  return boxes.sort((a, b) => b.score - a.score).slice(0, 24).map(box => box.rect);
}

export async function locateTextLines(image) {
  const session = await getDetector();
  const scale = 768 / Math.max(image.width, image.height);
  const width = Math.max(32, Math.round(image.width * scale / 32) * 32);
  const height = Math.max(32, Math.round(image.height * scale / 32) * 32);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const plane = width * height, data = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    for (let channel = 0; channel < 3; channel++) {
      data[channel * plane + i] = rgba[i * 4 + 2 - channel] / 127.5 - 1;
    }
  }
  const input = new ort.Tensor('float32', data, [1, 3, height, width]);
  try {
    const result = (await session.run({ [session.inputNames[0]]: input }))[session.outputNames[0]];
    try {
      const [, , h, w] = result.dims;
      return components(result.data, w, h);
    } finally { result.dispose(); }
  } finally { input.dispose(); }
}
