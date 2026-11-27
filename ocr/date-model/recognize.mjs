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

async function readCrop(bitmap, rect, session, characters) {
  const [left, top, right, bottom] = rect;
  const width = (right - left) * bitmap.width, height = (bottom - top) * bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.height = 48;
  canvas.width = Math.min(768, Math.ceil(canvas.height * width / height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, left * bitmap.width, top * bitmap.height, width, height, 0, 0, canvas.width, canvas.height);
  const paddedWidth = Math.max(320, canvas.width);
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

export async function readDateLine(data, parseDate) {
  const [session, characters] = await getModel();
  const bitmap = await createImageBitmap(await (await fetch(data)).blob());
  try {
    // Cover a close crop and several likely stamp lines on packaging photos.
    const landscape = bitmap.width / bitmap.height > 1.8;
    const crops = landscape ? [[0, 0, 1, 1], [0, 0, 0.68, 0.6]] : [];
    crops.push([0.22, 0.497, 0.50, 0.575], [0.24, 0.50, 0.50, 0.576],
      [0.15, 0.54, 0.58, 0.63], [0.12, 0.64, 0.58, 0.74], [0.12, 0.75, 0.58, 0.86]);
    const candidates = new Map();
    for (const crop of crops) {
      const { text, confidence } = await readCrop(bitmap, crop, session, characters);
      // Require the full date and both separators. A clipped row or a lot
      // number must not turn into a suggested date.
      const match = text.trim().match(/^(\d{2}[.\/-]\d{2}[.\/-](?:20\d{2}|\d{2}))(?!\d)/);
      const date = match && confidence >= 0.5 && parseDate(match[1]);
      if (date) {
        const candidate = candidates.get(date) || { count: 0, confidence: 0 };
        candidate.count++;
        candidate.confidence = Math.max(candidate.confidence, confidence);
        candidates.set(date, candidate);
      }
    }
    const dates = [...candidates].filter(([, candidate]) => candidate.count >= 2 || candidate.confidence >= 0.85);
    return dates.length === 1 ? [dates[0][0]] : [];
  } finally { bitmap.close(); }
}
