/* Local, offline OCR for Vacha Offline. Gemini remains a separate optional action. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let running = false, workerStatus = '';
  let workerPromise = null;
  const ignored = /zutaten|nährwert|naehrwert|fett|kohlenhydrat|zucker|protein|eiweiß|salz|sodium|kcal|kj|energie|hersteller|anschrift|lagerung|portion|je 100|pro 100|www\.|gmbh|ingredient|nutri|warning|recycling/i;
  const uiLine = /produktfotos|aus galerie|galerie wählen|foto aufnehmen|artikelname|vacha offline|netz verfügbar|abgleich|etikett kopieren|lokal speichern|produktdaten|barcode \/ interne nummer|produktfoto|gemini erkennen|preis|pfand|inhalt|einheit|barcode|mhd|datum/i;

  function report(id, text) {
    const node = $(id);
    if (node) node.textContent = text;
  }

  async function getWorker(statusId) {
    workerStatus = statusId;
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
          if (item.status === 'loading language traineddata') report(workerStatus, 'Lade lokale Sprachdaten …');
          if (item.status === 'recognizing text') report(workerStatus, 'Lese Foto: ' + Math.round((item.progress || 0) * 100) + '%');
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

  function parseDates(lines, isDatePhoto, requireSeparators = false) {
    const markedDates = new Set(), stampDates = new Set(), separatedDates = new Set();
    const datePattern = /(?<!\d)(\d{1,2}\s*[.\/-]\s*\d{1,2}\s*[.\/-]\s*(?:20\d{2}|\d{2})|\d{8}|\d{6})(?!\d)/g;
    const bestBefore = /\b(?:mhd|bb[de]?)(?:[\s-]*date)?\b|mindestens\s+haltbar|best\s+before/i;
    const dateMarker = new RegExp(bestBefore.source + '|\\bexp(?:iry)?\\b|zu\\s+verbrauchen\\s+bis', 'i');
    const monthPattern = /(?<![\d.\/-])(0?[1-9]|1[0-2])\s*[.\/-]\s*(20\d{2})(?![\d.\/-])/g;
    const otherMarker = /\b(?:mfg|prod|lot|charge)\b|hergestellt|abgefüllt|production\s+date/i;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], previous = lines[i - 1] || '';
      const label = line.match(dateMarker);
      const previousLabel = previous.match(dateMarker);
      const followsLabel = previousLabel && !/\d/.test(previous.slice(previousLabel.index + previousLabel[0].length));
      const marked = !!label || (!otherMarker.test(line) && followsLabel);
      if (!marked && (!isDatePhoto || otherMarker.test(line) || (otherMarker.test(previous) && !/\d/.test(previous)))) continue;
      const value = label ? line.slice(label.index + label[0].length).split(otherMarker)[0] : line;
      const monthOnly = (label && bestBefore.test(label[0])) ||
        (!label && marked && bestBefore.test(previousLabel[0]));
      if (monthOnly) {
        const compact = value.replace(/\s*([.\/-])\s*/g, '$1');
        for (const match of compact.matchAll(monthPattern)) {
          const month = Number(match[1]), year = Number(match[2]);
          const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
          markedDates.add(lastDay + '.' + String(month).padStart(2, '0') + '.' + year);
        }
      }
      for (const match of value.matchAll(datePattern)) {
        if (requireSeparators && !/[.\/-]/.test(match[1])) continue;
        let raw = match[1].replace(/\s/g, '');
        if (/^\d{4}20\d{2}$/.test(raw)) raw = raw.replace(/^(\d{2})(\d{2})(\d{4})$/, '$1.$2.$3');
        const date = parseDate(raw);
        if (date) (marked ? markedDates : /[.\/-]/.test(match[1]) ? separatedDates : stampDates).add(date);
      }
    }
    const candidates = separatedDates.size ? separatedDates : stampDates;
    return [...(markedDates.size ? markedDates : candidates.size === 1 ? candidates : [])];
  }

  function parseText(text, photos) {
    const lines = text.split(/[\r\n]+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const nameLines = lines.map((line, index) => {
      const letters = (line.match(/[a-zäöüß]/gi) || []).length;
      const words = line.match(/[a-zäöüß][a-zäöüß'&-]*/gi) || [];
      if (line.length < 4 || line.length > 58 || letters < 4 || !words.length || ignored.test(line) || uiLine.test(line) || /\b(?:g|kg|ml|cl|dl|l|kcal|kj)\b/i.test(line)) return null;
      const digitCount = (line.match(/\d/g) || []).length;
      if (digitCount > 2 || letters / Math.max(1, line.replace(/\s/g, '').length) < .58) return null;
      const score = Math.min(letters, 28) + (words.length >= 2 && words.length <= 5 ? 7 : 0) - (words.length === 1 ? 6 : 0) - Math.max(0, words.length - 5) * 5 - digitCount * 3;
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
      if (ignored.test(line) || /abtropf|drained|zubereit|prepared|\/\s*100|\bje\b|\bpro\b/i.test(line)) return;
      const net = /netto|net\s*(?:weight|wt|content)|inhalt|füllmenge|net\s*quantity/i.test(line);
      for (const match of line.matchAll(/(?:^|[^\d.,])(?:(\d{1,2})\s*[x×]\s*)?(\d{1,4}(?:[.,]\d{1,3})?)\s*(kg|mg|ml|cl|dl|g|l)\b/gi)) {
        const parsed = parseCatalogQuantity(match[2] + ' ' + match[3]);
        if (!parsed) continue;
        const amount = Math.round(parsed.quantity * Number(match[1] || 1) * 1e6) / 1e6;
        if (amount > 0 && amount <= 100000) {
          const score = (net ? 10 : 0) + (match[1] ? 3 : 0);
          weights.push({ amount, unit: parsed.unit, score });
        }
      }
    });

    const dates = parseDates(lines, photos.some(photo => photo.role === 'date'));

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
    return { name, weights, dates, price: prices[0] || '', deposit: deposits[0] || '' };
  }

  function gtin(value) {
    if (!/^(?:\d{8}|\d{12,14})$/.test(value) || /^0+$/.test(value)) return false;
    const digits = [...value].reverse().map(Number);
    return digits.reduce((sum, digit, i) => sum + digit * (i % 2 ? 3 : 1), 0) % 10 === 0;
  }

  function barcodeText(text) {
    return [...text.matchAll(/\b\d(?:[ \t-]?\d){7,13}\b/g)]
      .map(m => m[0].replace(/\D/g, '')).filter(gtin);
  }

  async function retryStamp(worker, data) {
    const bitmap = await createImageBitmap(await (await fetch(data)).blob());
    try {
      // Try sparse text on a larger, higher-contrast image. The lower crop
      // gives small stamps more pixels and reduces surrounding packaging text.
      const passes = [
        [0, 1, false], [0.42, 1, false], [0.42, 0.78, true], [0, 1, true],
        // On these stamps the date is commonly at the start of the first row.
        [0, 0.42, true, 0, 0.52, '7'],
        [0, 0.65, true, 0, 0.62, '7'],
        [0, 0.72, true, 0, 1, '7'],
        [0.48, 0.65, true, 0.13, 0.61, '7']
      ];
      for (const [top, bottom, joinDots, left = 0, right = 1, mode = '11'] of passes) {
        const y = Math.round(bitmap.height * top), height = Math.max(1, Math.round(bitmap.height * bottom) - y);
        const x = Math.round(bitmap.width * left), width = Math.max(1, Math.round(bitmap.width * right) - x);
        const scale = Math.min(mode === '7' ? 5 : 3, 1800 / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        ctx.filter = 'grayscale(1) contrast(2.6)';
        ctx.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
        if (joinDots) {
          // Darken each pixel with its neighbors so the separated ink dots form strokes.
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const w = canvas.width, h = canvas.height;
          const horizontal = new Uint8Array(w * h);
          const radius = Math.max(1, Math.min(8, Math.round(scale * (mode === '7' ? 1.7 : 0.8))));
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              let darkest = 255;
              for (let x = Math.max(0, col - radius); x <= Math.min(w - 1, col + radius); x++) {
                darkest = Math.min(darkest, pixels.data[(row * w + x) * 4]);
              }
              horizontal[row * w + col] = darkest;
            }
          }
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              let darkest = 255;
              for (let y = Math.max(0, row - radius); y <= Math.min(h - 1, row + radius); y++) {
                darkest = Math.min(darkest, horizontal[y * w + col]);
              }
              const i = (row * w + col) * 4;
              pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = darkest;
            }
          }
          ctx.putImageData(pixels, 0, 0);
        }
        try {
          await worker.setParameters({ tessedit_pageseg_mode: mode });
          const {data: result} = await worker.recognize(canvas);
          const dates = parseDates(result.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean), true, mode === '7');
          if (dates.length) return dates;
        } finally { await worker.setParameters({ tessedit_pageseg_mode: '3' }); }
      }
      return [];
    } finally { bitmap.close(); }
  }

  window.vachaReadPhotoDate = async photo => {
    if (running) throw Error('Eine lokale Erkennung läuft bereits.');
    running = true;
    const draft = photoGalleryDraft, data = photo.data;
    const active = () => !$('edit').hidden && draft === photoGalleryDraft && draft.includes(photo) && photo.data === data;
    try {
      report('localOcrStatus', 'Lese Datumsstempel …');
      const worker = await getWorker('localOcrStatus');
      const {data: result} = await worker.recognize(data);
      let dates = parseDates(result.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean), true);
      if (!dates.length) dates = await retryStamp(worker, data);
      if (!active()) return;
      if (!dates.length) {
        const note = 'Kein eindeutiges MHD gefunden. Bitte das Datum vom Stempel in „Neue MHD“ eintragen.';
        report('localOcrStatus', note);
        msg(note, true);
        return;
      }
      const field = $('dates'), entries = field.value.split(/[;\n]+/).map(value => value.trim()).filter(Boolean);
      for (const value of dates) {
        if (!entries.some(entry => {
          try { return date(entry) === date(value); } catch (_) { return entry === value; }
        })) entries.push(value);
      }
      field.value = entries.join('; ');
      const note = 'MHD aus dem Foto: ' + dates.join(', ') + '. Bitte mit dem Stempel vergleichen.';
      report('localOcrStatus', note);
      msg(note);
    } finally { running = false; }
  };

  async function recognize(photos, statusId) {
    if (!photos.length || photos.length > 5) throw Error('Bitte 1 bis 5 Fotos pro Artikel auswählen.');
    const barcodeHits = new Set(), printedCodes = new Set(), names = [], weights = [];
    const fields = { dates: [] };
    let ocrFailed = false;
    const worker = await getWorker(statusId).catch(() => null);
    for (const [i, photo] of photos.entries()) {
      report(statusId, 'Lokal: lese Foto ' + (i + 1) + ' von ' + photos.length + ' …');
      const barcodes = await window.vachaBarcodeFromPhoto(photo.data, true);
      barcodes.forEach(value => barcodeHits.add(value));
      let text;
      try {
        if (!worker) throw Error();
        text = (await worker.recognize(photo.data)).data.text || '';
      } catch (_) {
        ocrFailed = true;
        continue;
      }
      barcodeText(text).forEach(value => printedCodes.add(value));
      const parsed = parseText(text, [photo]);
      if (photo.role !== 'date') {
        if (parsed.name) names.push({ name: parsed.name, score: photo.role === 'front' ? 4 : photo.role === 'code' ? 0 : 2 });
        for (const weight of parsed.weights) weights.push({ ...weight, score: weight.score + (photo.role === 'front' ? 2 : 0) });
      }
      if (!parsed.dates.length && photo.role === 'date') {
        parsed.dates = await retryStamp(worker, photo.data).catch(() => []);
      }
      fields.dates.push(...parsed.dates);
      fields.price ||= parsed.price;
      fields.deposit ||= parsed.deposit;
    }
    const candidates = [...(barcodeHits.size ? barcodeHits : printedCodes)];
    const codes = candidates.filter((code, i) => candidates.findIndex(other =>
      code.padStart(14, '0') === other.padStart(14, '0')) === i);
    fields.barcode = codes.length === 1 ? codes[0] : '';
    names.sort((a, b) => b.score - a.score);
    fields.name = names[0]?.name || '';
    weights.sort((a, b) => b.score - a.score);
    const top = weights[0];
    const metric = w => (['kg', 'l'].includes(w.unit) ? 1000 : 1) * w.amount;
    const distinct = top && weights.some(w => w.score === top.score &&
      (metric(w) !== metric(top) || /g$/.test(w.unit) !== /g$/.test(top.unit)));
    fields.weight = distinct ? null : top;
    fields.dates = [...new Set(fields.dates)].join('; ');
    return { fields, codes, ocrFailed };
  }

  async function productData(photos, statusId, currentBarcode, active) {
    const result = await recognize(photos, statusId);
    const { fields, codes } = result;
    if (!active()) return null;
    const current = currentBarcode();
    const conflict = codes.length > 1 || (current && fields.barcode &&
      current.padStart(14, '0') !== fields.barcode.padStart(14, '0'));
    const code = conflict ? '' : current || fields.barcode;
    const normalized = value => articleCode(value).padStart(14, '0');
    const known = code && view().arts.find(a => normalized(a.id) === normalized(code));
    const saved = code && S.catalog?.[code];
    if (code && !known && !saved) report(statusId, 'Gleiche Barcode mit der Artikeldatenbank ab …');
    const product = known || saved || (code && await lookupCatalog(code));
    if (!active() || current !== currentBarcode()) return null;
    const catalogWeight = product?.quantity && ['g', 'kg', 'ml', 'l'].includes(product.unit)
      ? { amount: product.quantity, unit: product.unit } : null;
    return { ...result, known, conflict, query: fields.name, values: {
      barcode: conflict ? '' : fields.barcode,
      name: product?.name || (conflict ? '' : fields.name),
      ...(catalogWeight || (!conflict && fields.weight) || {}),
      dates: fields.dates, price: fields.price, deposit: fields.deposit
    }};
  }

  function fillFields(values, read, write) {
    const changed = [];
    for (const [key, title] of Object.entries({
      barcode: 'Barcode', name: 'Name', quantity: 'Inhalt', unit: 'Einheit',
      dates: 'MHD', price: 'Preis', deposit: 'Pfand'
    })) {
      const value = key === 'quantity' ? values.amount : values[key];
      const currentUnit = read('unit');
      if (key === 'quantity' && currentUnit && currentUnit !== values.unit) continue;
      if (key === 'unit' && read('quantity') && !changed.includes('Inhalt')) continue;
      if (String(read(key) ?? '').trim() || !String(value ?? '').trim()) continue;
      if (write(key, value)) changed.push(title);
    }
    return changed;
  }

  function status(result, changed) {
    if (result.conflict) return 'Widersprüchliche Barcodes. Bitte Barcode und Fotos vergleichen.';
    const note = changed.length ? 'Vorschläge: ' + changed.join(', ') + '. Bitte prüfen.' :
      'Keine weiteren Vorschläge eingetragen. Bitte Angaben am Produkt prüfen.';
    return result.ocrFailed ? 'Texterkennung teilweise nicht verfügbar. ' + note : note;
  }

  function freezePhotos(photos) {
    return photos.map(({ data, role }) => ({ data, role }));
  }

  function samePhotos(copy, current) {
    return copy.length === current.length && copy.every((p, i) =>
      p.data === current[i].data && p.role === current[i].role);
  }

  function renderPhotoMatches(items, active, known) {
    const host = $('photoProductMatches');
    host.replaceChildren();
    host.hidden = !items.length && !known;
    if (known) host.append(btn('Vorhandenen Artikel „' + known.name + '“ ergänzen', async () => {
      if (active()) await openKnownArticle(known.id);
    }));
    if (items.length) host.append(el('b', 'Passende Artikeldaten aus dem Fototext'));
    for (const item of items) {
      const text = [item.name, item.barcode, item.quantity && item.unit ? item.quantity + ' ' + item.unit : '', item.source].filter(Boolean).join(' · ');
      host.append(btn(text, () => {
        if (!active() || editing) return;
        const barcode = $('ean').value.trim();
        if (barcode && item.barcode && barcode !== item.barcode &&
          !confirm('Barcode ' + barcode + ' durch ' + item.barcode + ' ersetzen?')) return;
        $('name').value = item.name;
        if (item.barcode) $('ean').value = item.barcode;
        if (item.quantity && item.unit) {
          $('quantity').value = String(item.quantity).replace('.', ',');
          $('unit').value = item.unit;
        }
        label();
        host.hidden = true;
      }));
    }
  }

  async function recognizeProduct() {
    const draft = photoGalleryDraft, photos = freezePhotos(draft), article = editing;
    const active = () => !$('edit').hidden && draft === photoGalleryDraft && article === editing && samePhotos(photos, draft);
    $('photoProductMatches').hidden = true;
    const result = await productData(photos, 'localOcrStatus', () => $('ean').value.trim(), active);
    if (!result || !active()) return;
    const id = key => key === 'barcode' ? 'ean' : key;
    const changed = fillFields(result.values, key => $(id(key)).value, (key, value) => {
      const input = $(id(key));
      if (input.disabled) return false;
      input.value = ['quantity', 'price', 'deposit'].includes(key) ? String(value).replace('.', ',') : value;
      return true;
    });
    label();
    const note = status(result, changed);
    const mhdHint = photos.some(p => p.role === 'date') && !result.values.dates ? ' Kein eindeutiges MHD gefunden. Bitte das Datum vom Stempel in „Neue MHD“ eintragen.' : '';
    report('localOcrStatus', note + mhdHint);
    if (result.known && !editing) renderPhotoMatches([], active, result.known);
    if (result.conflict || editing || $('ean').value.trim()) return;
    const currentName = $('name').value;
    const activeQuery = () => active() && currentName === $('name').value && !$('ean').value.trim();
    if (result.query) renderPhotoMatches(localCatalogSuggestions(result.query), activeQuery);
    const category = await window.vachaClassifyProductPhotos(photos.filter(p => p.role === 'front' || p.role === 'all' || !p.role), text => {
      if (activeQuery()) report('localOcrStatus', text);
    }).catch(() => null);
    if (!activeQuery()) return;
    const categoryName = category?.confidence >= 0.65 ? category.name : '';
    report('localOcrStatus', note + mhdHint + (categoryName ? ' Bild-KI: Produktgruppe „' + categoryName + '“.' : ''));
    if (result.query) await searchCatalogSuggestions(result.query, {
      category: categoryName ? category.label : undefined,
      active: activeQuery,
      renderMatches: items => { if (activeQuery()) renderPhotoMatches(items, activeQuery); }
    });
  }

  async function recognizeBulk() {
    const groups = bulkGroupsList();
    if (!groups.length) throw Error('Bitte zuerst Fotos auswählen.');
    if (groups.some(g => g.photos.length > 5)) throw Error('Pro Artikelgruppe sind höchstens 5 Fotos möglich.');
    const notes = [];
    for (const group of groups) {
      const photos = freezePhotos(group.photos), d = bulkData[group.id] || (bulkData[group.id] = {});
      const active = () => !$('bulk').hidden && bulkData[group.id] === d &&
        samePhotos(photos, bulkGroupsList().find(g => g.id === group.id)?.photos || []);
      if (!active()) continue;
      const result = await productData(photos, 'bulkLocalOcrStatus', () => String(d.barcode || '').trim(), active);
      if (!result || !active()) continue;
      const changed = fillFields(result.values, key => d[key], (key, value) => { d[key] = value; return true; });
      if (result.conflict || result.ocrFailed) notes.push('Gruppe ' + group.id + ' – ' + status(result, changed));
    }
    if (!$('bulk').hidden) renderBulk();
    report('bulkLocalOcrStatus', notes.join(' ') || 'Vorschläge für die Gruppen geprüft. Bitte mit den Produkten vergleichen.');
  }

  function bindRecognition(id, statusId, run) {
    $(id).onclick = act(async () => {
      if (running) throw Error('Eine lokale Erkennung läuft bereits.');
      running = true;
      $(id).disabled = true;
      try { await run(); }
      catch (error) { report(statusId, error.message); throw error; }
      finally { running = false; $(id).disabled = false; }
    });
  }

  bindRecognition('aiLocal', 'localOcrStatus', recognizeProduct);
  bindRecognition('bulkLocalOcr', 'bulkLocalOcrStatus', recognizeBulk);
})();
