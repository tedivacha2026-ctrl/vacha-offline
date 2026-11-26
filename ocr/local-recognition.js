/* Local, offline OCR for Vacha Offline. Gemini remains a separate optional action. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let workerPromise = null;
  const ignored = /zutaten|nährwert|naehrwert|fett|kohlenhydrat|zucker|protein|eiweiß|salz|sodium|kcal|kj|energie|hersteller|anschrift|lagerung|portion|je 100|pro 100|www\.|gmbh|ingredient|nutri|warning|recycling/i;

  function report(id, text) {
    const node = $(id);
    if (node) node.textContent = text;
  }

  async function getWorker(statusId) {
    if (!workerPromise) workerPromise = (async () => {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = new URL('./ocr/tesseract.min.js', location.href).href;
          script.onload = resolve;
          script.onerror = () => reject(Error('Lokale Texterkennung konnte nicht geladen werden. App einmal mit Internet öffnen.'));
          document.head.append(script);
        });
      }
      return window.Tesseract.createWorker(['deu', 'eng'], 1, {
        workerPath: new URL('./ocr/worker.min.js', location.href).href,
        corePath: new URL('./ocr/core/tesseract-core-lstm.wasm.js', location.href).href,
        langPath: new URL('./ocr/lang', location.href).href,
        cacheMethod: 'write',
        gzip: true,
        logger: item => {
          if (item.status === 'loading language traineddata') report(statusId, 'Lade lokale Sprachdaten …');
          if (item.status === 'recognizing text') report(statusId, 'Lese Foto: ' + Math.round((item.progress || 0) * 100) + '%');
        }
      });
    })().catch(error => { workerPromise = null; throw error; });
    return workerPromise;
  }

  function parseDate(raw) {
    let d, m, y;
    if (/^\d{6}$/.test(raw)) {
      d = +raw.slice(0, 2); m = +raw.slice(2, 4); y = +raw.slice(4, 6); y += y < 70 ? 2000 : 1900;
    } else {
      const parts = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2}|20\d{2})$/);
      if (!parts) return '';
      d = +parts[1]; m = +parts[2]; y = +parts[3]; if (y < 100) y += y < 70 ? 2000 : 1900;
    }
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return '';
    return String(d).padStart(2, '0') + '.' + String(m).padStart(2, '0') + '.' + y;
  }

  function parseText(text, photos) {
    const lines = text.split(/[\r\n]+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const nameLines = lines.map((line, index) => {
      const letters = (line.match(/[a-zäöüß]/gi) || []).length;
      const words = line.match(/[a-zäöüß][a-zäöüß'&-]*/gi) || [];
      if (line.length < 4 || line.length > 58 || letters < 7 || words.length < 2 || ignored.test(line) || /\b(?:g|kg|ml|cl|dl|l|kcal|kj)\b/i.test(line)) return null;
      const digitCount = (line.match(/\d/g) || []).length;
      if (digitCount > 2 || letters / Math.max(1, line.replace(/\s/g, '').length) < .58) return null;
      const score = Math.min(letters, 28) + (words.length >= 2 && words.length <= 5 ? 7 : 0) - Math.max(0, words.length - 5) * 5 - digitCount * 3;
      return { line, index, score };
    }).filter(Boolean);
    nameLines.sort((a, b) => b.score - a.score || a.index - b.index);
    let name = '';
    if (nameLines.length) {
      const best = nameLines[0];
      const adjacent = nameLines.find(item => Math.abs(item.index - best.index) <= 1 && item.index !== best.index && (best.line + ' ' + item.line).length <= 88);
      name = adjacent && adjacent.index < best.index ? adjacent.line + ' ' + best.line : adjacent ? best.line + ' ' + adjacent.line : best.line;
    }

    const weights = [];
    lines.forEach(line => {
      if (ignored.test(line)) return;
      const match = line.match(/(\d{1,4}(?:[.,]\d{1,3})?)\s*(kg|g|mg|l|ml|cl|dl)\b/i);
      if (!match) return;
      let amount = Number(match[1].replace(',', '.')), unit = match[2].toLowerCase();
      if (unit === 'mg') { amount /= 1000; unit = 'g'; }
      if (unit === 'cl') { amount *= 10; unit = 'ml'; }
      if (unit === 'dl') { amount *= 100; unit = 'ml'; }
      if (amount > 0 && amount <= 100000 && ['g', 'kg', 'ml', 'l'].includes(unit)) {
        const net = /netto|net\s*(?:weight|wt|content)|inhalt|füllmenge|gewicht|net\s*quantity/i.test(line);
        weights.push({ amount, unit, score: (net ? 10 : 0) + Math.min(amount, 5000) });
      }
    });
    weights.sort((a, b) => b.score - a.score);

    const dates = [];
    const datePattern = /(?<!\d)(\d{1,2}[.\/-]\d{1,2}[.\/-](?:20\d{2}|\d{2})|\d{6})(?!\d)/g;
    const dateMarker = /mhd|mindestens haltbar|best before|bb[de]|exp(?:iry)?|zu verbrauchen bis/i;
    const hasDedicatedDatePhoto = photos.some(photo => photo.role === 'date');
    for (let i = 0; i < lines.length; i++) {
      const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ');
      if (!hasDedicatedDatePhoto && !dateMarker.test(nearby)) continue;
      datePattern.lastIndex = 0;
      let match;
      while ((match = datePattern.exec(lines[i]))) {
        const date = parseDate(match[1]);
        if (date && !dates.includes(date)) dates.push(date);
      }
    }

    const prices = [], deposits = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const context = line + ' ' + (lines[i + 1] || '');
      const match = context.match(/(?:€\s*(\d{1,3}[.,]\d{2})|(\d{1,3}[.,]\d{2})\s*(?:€|EUR))/i);
      const pfand = /pfand|deposit|mehrweg/i.test(context);
      const numericPfand = pfand && !match ? context.match(/(\d{1,2}[.,]\d{2})/) : null;
      const raw = match ? (match[1] || match[2]) : numericPfand?.[1];
      if (!raw) continue;
      const value = raw.replace('.', ',');
      if (pfand) deposits.push(value); else if (/[€]|\bEUR\b/i.test(context)) prices.push(value);
    }
    return { name, weight: weights[0] || null, dates, price: prices[0] || '', deposit: deposits[0] || '' };
  }

  async function recognize(photos, statusId) {
    if (!photos.length) throw Error('Bitte zuerst mindestens ein Foto auswählen.');
    const worker = await getWorker(statusId);
    let text = '';
    const t0 = performance.now();
    for (let i = 0; i < photos.length; i++) {
      report(statusId, 'Lokal: lese Foto ' + (i + 1) + ' von ' + photos.length + ' …');
      const result = await worker.recognize(photos[i].data);
      text += '\n' + (result.data.text || '');
      if (photos[i].role === 'date') text += '\nMHD ';
    }
    const fields = parseText(text, photos);
    for (const photo of photos) {
      if (!fields.barcode && window.vachaBarcodeFromPhoto) {
        try { fields.barcode = await window.vachaBarcodeFromPhoto(photo.data) || ''; } catch (_) {}
      }
    }
    return { fields, seconds: (performance.now() - t0) / 1000 };
  }

  function fillEmpty(id, value, title, changed) {
    const field = $(id);
    if (!field || field.disabled || field.value.trim() || value === undefined || value === null || !String(value).trim()) return;
    field.value = id === 'dates' ? String(value).replace(/,/g, '.') : (['price', 'deposit', 'quantity'].includes(id) ? String(value).replace('.', ',') : String(value));
    changed.push(title);
  }

  async function recognizeProduct() {
    if (!photoGalleryDraft.length) throw Error('Bitte zuerst Produktfotos auswählen.');
    $('aiLocal').disabled = true;
    const t0 = performance.now();
    try {
      const result = await recognize(photoGalleryDraft, 'localOcrStatus');
      const f = result.fields, changed = [];
      fillEmpty('name', f.name, 'Name', changed);
      fillEmpty('ean', f.barcode, 'Barcode', changed);
      if (f.weight) { fillEmpty('quantity', f.weight.amount, 'Inhalt', changed); if (!$('unit').disabled && !$('unit').value) { $('unit').value = f.weight.unit; changed.push('Einheit'); } }
      fillEmpty('dates', f.dates.join('; '), 'MHD', changed);
      fillEmpty('price', f.price, 'Preis', changed);
      fillEmpty('deposit', f.deposit, 'Pfand', changed);
      if (typeof label === 'function') label();
      const total = (performance.now() - t0) / 1000;
      const note = 'Lokale Erkennung: ' + total.toFixed(1) + ' s für ' + photoGalleryDraft.length + ' Foto(s).';
      report('localOcrStatus', note + (changed.length ? ' Vorschläge: ' + changed.join(', ') + '. Bitte prüfen.' : ' Keine passenden Angaben sicher gefunden.'));
      msg(note + (changed.length ? ' Vorschläge eingetragen: ' + changed.join(', ') + '. Bitte prüfen.' : ' Bitte näher fotografieren oder Felder ergänzen.'), !changed.length);
    } finally { $('aiLocal').disabled = false; }
  }

  async function recognizeBulk() {
    const groups = bulkGroupsList();
    if (!groups.length) throw Error('Bitte zuerst Fotos auswählen.');
    $('bulkLocalOcr').disabled = true;
    const t0 = performance.now();
    try {
      const worker = await getWorker('bulkLocalOcrStatus');
      let changedCount = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi], d = bulkData[group.id] || (bulkData[group.id] = {}), photos = group.photos;
        let text = '';
        for (let pi = 0; pi < photos.length; pi++) {
          report('bulkLocalOcrStatus', 'Lokal: Gruppe ' + (gi + 1) + ' von ' + groups.length + ', Foto ' + (pi + 1) + ' von ' + photos.length + ' …');
          const result = await worker.recognize(photos[pi].data);
          text += '\n' + (result.data.text || '');
          if (photos[pi].role === 'date') text += '\nMHD ';
          if (!d.barcode && window.vachaBarcodeFromPhoto) { try { d.barcode = await window.vachaBarcodeFromPhoto(photos[pi].data) || ''; } catch (_) {} }
        }
        const f = parseText(text, photos);
        for (const [key, value] of Object.entries({ name: f.name, price: f.price, deposit: f.deposit, quantity: f.weight?.amount, unit: f.weight?.unit, dates: f.dates.join('; ') })) {
          if ((d[key] === undefined || String(d[key]).trim() === '') && value !== undefined && value !== null && String(value).trim()) { d[key] = value; changedCount++; }
        }
      }
      renderBulk();
      const total = (performance.now() - t0) / 1000, photos = groups.reduce((sum, group) => sum + group.photos.length, 0);
      const note = 'Lokale Erkennung: ' + total.toFixed(1) + ' s für ' + photos + ' Foto(s) in ' + groups.length + ' Gruppe(n).';
      report('bulkLocalOcrStatus', note + (changedCount ? ' Vorschläge eingetragen. Bitte prüfen.' : ' Keine passenden Angaben sicher gefunden.'));
      msg(note + (changedCount ? ' Vorschläge eingetragen. Bitte prüfen.' : ' Bitte Felder ergänzen.'), !changedCount);
    } finally { $('bulkLocalOcr').disabled = false; }
  }

  $('aiLocal').onclick = act(recognizeProduct);
  $('bulkLocalOcr').onclick = act(recognizeBulk);
})();
