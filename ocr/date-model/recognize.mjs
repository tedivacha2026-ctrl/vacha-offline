import * as ort from './ort.wasm.min.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./', import.meta.url).href;
let model;

async function getModel() {
  if (!model) {
    model = Promise.all([
      ort.InferenceSession.create(new URL('./ppocr-v4-rec.onnx', import.meta.url).href, {
        executionProviders: ['wasm']
      }),
      fetch(new URL('./characters.json', import.meta.url)).then(response => {
        if (!response.ok) throw Error('Zeichentabelle ist nicht verfügbar.');
        return response.json();
      })
    ]).catch(error => { model = null; throw error; });
  }
  return model;
}

async function readCrop(bitmap, rect, session, characters, minimumWidth = 192) {
  const [left, top, right, bottom] = rect;
  const width = (right - left) * bitmap.width, height = (bottom - top) * bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.height = 48;
  canvas.width = Math.min(768, Math.ceil(canvas.height * width / height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, left * bitmap.width, top * bitmap.height, width, height, 0, 0, canvas.width, canvas.height);
  const paddedWidth = Math.max(minimumWidth, Math.ceil(canvas.width / 32) * 32);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const plane = paddedWidth * canvas.height, input = new Float32Array(3 * plane);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const src = (y * canvas.width + x) * 4, dst = y * paddedWidth + x;
      for (let channel = 0; channel < 3; channel++) {
        input[channel * plane + dst] = pixels[src + 2 - channel] / 127.5 - 1;
      }
    }
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, canvas.height, paddedWidth]);
  const result = (await session.run({ [session.inputNames[0]]: tensor }))[session.outputNames[0]];
  try {
    const [, steps, classes] = result.dims;
    let text = '', confidence = 1, previous = 0;
    for (let step = 0; step < steps; step++) {
      const offset = step * classes;
      let best = 0;
      for (let i = 1; i < classes; i++) {
        if (result.data[offset + i] > result.data[offset + best]) best = i;
      }
      if (best && best !== previous) {
        text += characters[best] || '';
        if (text.length <= 10) confidence = Math.min(confidence, result.data[offset + best]);
      }
      previous = best;
    }
    return { text, confidence };
  } finally {
    tensor.dispose();
    result.dispose();
  }
}

async function readDateFromCrops(image, crops, session, characters, parseDate, trained = false) {
  const candidates = new Map();
  for (const crop of crops) {
    const { text, confidence } = await readCrop(image, crop, session, characters, trained ? 320 : 192);
    // Require a valid date with both separators. Compare overlapping lines
    // before suggesting a date if the individual characters were uncertain.
    const match = text.trim().match(/^(\d{2}[.\/-]\d{2}[.\/-](?:20\d{2}|\d{2}))(?!\d)/);
    const date = match && confidence >= (trained ? 0.45 : 0.5) && parseDate(match[1]);
    if (date) {
      const candidate = candidates.get(date) || { count: 0, confidence: 0 };
      candidate.count++;
      candidate.confidence = Math.max(candidate.confidence, confidence);
      candidates.set(date, candidate);
    }
  }
  if (candidates.size !== 1) return [];
  const [[date, candidate]] = candidates;
  const verified = trained ? candidate.count >= 2 && candidate.confidence >= 0.75 :
    candidate.count >= 2 || candidate.confidence >= 0.85;
  return verified ? [date] : [];
}

function turnedImage(bitmap, degrees) {
  const canvas = document.createElement('canvas');
  canvas.width = degrees === 180 ? bitmap.width : bitmap.height;
  canvas.height = degrees === 180 ? bitmap.height : bitmap.width;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(degrees * Math.PI / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return canvas;
}

function commonCrops(image) {
  const landscape = image.width / image.height > 1.8;
  const crops = landscape ? [[0, 0, 1, 1], [0, 0, 0.68, 0.6]] : [];
  crops.push([0.22, 0.497, 0.50, 0.575], [0.24, 0.50, 0.50, 0.576],
    [0.15, 0.54, 0.58, 0.63], [0.12, 0.64, 0.58, 0.74], [0.12, 0.75, 0.58, 0.86]);
  return crops;
}

const extraCrops = [0.18, 0.26, 0.34, 0.42, 0.50, 0.60, 0.68, 0.76, 0.84].flatMap(center =>
  [[0.22, center - 0.04, 0.50, center + 0.04], [0.24, center - 0.037, 0.50, center + 0.037],
    [0.06, center - 0.06, 0.50, center + 0.06], [0.43, center - 0.06, 0.91, center + 0.06]]);

export async function readDateLine(data, parseDate, focused = false, parseLabelled = () => []) {
  const [session, characters] = await getModel();
  const bitmap = await createImageBitmap(await (await fetch(data)).blob());
  try {
    const attempt = (image, crops) => readDateFromCrops(image, crops, session, characters, parseDate);
    const direct = await attempt(bitmap, commonCrops(bitmap));
    if (direct.length) return direct;
    const { locateTextLines } = await import('./text-lines.mjs');
    const lines = await locateTextLines(bitmap).catch(() => []);
    const marked = new Set(), unmarked = new Set();
    for (const rect of lines) {
      const result = await readCrop(bitmap, rect, session, characters);
      const text = result.text.trim();
      if (result.confidence < 0.5) continue;
      for (const date of parseLabelled(text)) marked.add(date);
      const fullDate = /^(\d{2}[.\/-]\d{2}[.\/-](?:20\d{2}|\d{2}))(?!\d)/;
      const match = text.match(fullDate);
      const date = match && parseDate(match[1]);
      if (!date) continue;
      if (result.confidence >= 0.85) {
        unmarked.add(date);
        continue;
      }
      // Re-read the first part of the detected line to exclude trailing lot codes.
      const [left, top, right, bottom] = rect;
      for (const fraction of [0.53, 0.63]) {
        const prefix = await readCrop(bitmap, [left, top, left + (right - left) * fraction, bottom], session, characters);
        const prefixDate = prefix.text.trim().match(fullDate);
        if (prefix.confidence >= 0.5 && prefixDate && parseDate(prefixDate[1]) === date) {
          unmarked.add(date);
          break;
        }
      }
    }
    if (marked.size) return [...marked];
    if (unmarked.size) return [...unmarked];
    const { locateDateStamps } = await import('./date-localizer.mjs');
    const proposals = await locateDateStamps(bitmap).catch(() => []);
    const localized = await readDateFromCrops(bitmap, proposals, session, characters, parseDate, true);
    if (localized.length) return localized;
    if (focused) {
      const dates = await attempt(bitmap, extraCrops);
      if (dates.length) return dates;
    }
    if (!focused && bitmap.width <= bitmap.height) return [];
    const dates = new Set();
    for (const degrees of [90, 270, 180]) {
      const image = turnedImage(bitmap, degrees);
      try {
        for (const date of await attempt(image, commonCrops(image))) dates.add(date);
        if (dates.size > 1) return [];
      } finally {
        image.width = image.height = 0;
      }
    }
    return [...dates];
  } finally { bitmap.close(); }
}
