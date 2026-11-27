/* On-device broad product-group classifier. It never uploads photos. */
(function () {
  'use strict';
  let modelPromise = null;
  const scriptPromises = new Map();
  const labelsDE = {
    Beauty_PersonalCare: 'Pflege / Kosmetik',
    Food_Snacks: 'Lebensmittel / Snacks',
    Household_Cleaning: 'Wasch- und Reinigungsmittel',
    Pet_Food: 'Tierfutter'
  };

  function loadScript(src) {
    if (scriptPromises.has(src)) return scriptPromises.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Erkennungsmodul konnte nicht geladen werden: ' + src));
      document.head.appendChild(script);
    });
    scriptPromises.set(src, promise);
    return promise;
  }

  async function getModel() {
    if (!modelPromise) {
      modelPromise = (async () => {
        await loadScript('./ml/tf.min.js');
        await loadScript('./ml/tf-tflite.min.js');
        if (!window.tf || !window.tflite) throw new Error('Lokale Bild-KI konnte nicht gestartet werden.');
        window.tflite.setWasmPath(new URL('./ml/wasm/', document.baseURI).href);
        await window.tf.ready();
        const [model, labelsResponse] = await Promise.all([
          window.tflite.loadTFLiteModel('./ml/vacha-product-model.tflite'),
          fetch('./ml/labels.json')
        ]);
        if (!labelsResponse.ok) throw new Error('KI-Kategorien konnten nicht geladen werden.');
        const labels = await labelsResponse.json();
        return {model, labels};
      })().catch(error => { modelPromise = null; throw error; });
    }
    return modelPromise;
  }

  function imageFromData(data) {
    return fetch(data).then(response => response.blob()).then(blob => createImageBitmap(blob));
  }

  async function classifyOne(photo, model, labels) {
    const bitmap = await imageFromData(photo.data);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 224;
      canvas.height = 224;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      ctx.drawImage(bitmap, 0, 0, 224, 224);
      const input = window.tf.tidy(() => window.tf.image.resizeBilinear(window.tf.browser.fromPixels(canvas).toFloat(), [224, 224]).expandDims(0));
      let output;
      try {
        output = model.predict(input);
        const values = await output.data();
        let best = 0;
        for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
        return {label: labels[best] || 'Unbekannt', name: labelsDE[labels[best]] || labels[best] || 'Unbekannt', confidence: Number(values[best]) || 0};
      } finally {
        input.dispose();
        if (output && typeof output.dispose === 'function') output.dispose();
      }
    } finally {
      bitmap.close();
    }
  }

  window.vachaClassifyProductPhotos = async function (photos, onStatus) {
    const selected = (photos || []).filter(photo => photo && photo.data);
    if (!selected.length) throw new Error('Keine Produktfotos zum Erkennen vorhanden.');
    const front = selected.filter(photo => photo.role === 'front');
    const candidates = front.length ? front : selected;
    if (onStatus) onStatus('Lade lokale Bild-KI beim ersten Aufruf …');
    const {model, labels} = await getModel();
    const started = performance.now();
    const scores = new Array(labels.length).fill(0);
    for (let i = 0; i < candidates.length; i++) {
      if (onStatus) onStatus('Lokale Bild-KI: Foto ' + (i + 1) + ' von ' + candidates.length + ' …');
      const result = await classifyOne(candidates[i], model, labels);
      const index = labels.indexOf(result.label);
      if (index >= 0) scores[index] += result.confidence;
    }
    const best = scores.indexOf(Math.max(...scores));
    const confidence = scores[best] / candidates.length;
    return {
      label: labels[best] || 'Unbekannt',
      name: labelsDE[labels[best]] || labels[best] || 'Unbekannt',
      confidence,
      seconds: (performance.now() - started) / 1000,
      photos: candidates.length,
      note: confidence < 0.45 ? 'unsicherer Modellvorschlag' : 'bitte als grobe Kategorie prüfen'
    };
  };
})();
