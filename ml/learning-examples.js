(() => {
  'use strict';

  // These reviewed labels are training input. For a future release, curate and
  // deduplicate the exported photos, assign product-group labels where needed,
  // and split by product and photo session into training, validation and test
  // sets. Train externally, evaluate on the held-out set against the current
  // app, and export a compatible TFLite model. For product-level predictions,
  // train with product IDs as classes and update the classifier and label map.
  // Publish the model, labels and evaluation report together, bump the
  // service-worker cache, and verify a clean offline installation before release.
  // Date OCR can be fine-tuned externally on cropped stamp images and
  // their printedText transcriptions. Keep batches and near-duplicates
  // together when splitting train/validation/test, and measure exact date
  // and false acceptance of production or lot numbers before shipping.
  function openExamples() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('vacha-learning-examples', 2);
      request.onupgradeneeded = event => {
        if (event.oldVersion < 1) request.result.createObjectStore('examples', { keyPath: 'id' });
        if (event.oldVersion < 2) request.result.createObjectStore('dateExamples', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveExample(photos, fields) {
    const images = photos.map((p, i) => ({ role: p.role || (i === 0 ? 'front' : 'all'), data: p.data }));
    if (images.length < 1 || images.length > 5) throw Error('Bitte 1 bis 5 passende Fotos auswählen.');
    const name = String(fields.name || '').trim(), barcode = String(fields.barcode || '').trim();
    const quantity = number(String(fields.quantity ?? '').trim()), unit = String(fields.unit || '');
    if (!name || name.length > 150) throw Error('Bitte den richtigen Artikelnamen eintragen.');
    if (barcode && !/^\d{8,14}$/.test(barcode)) throw Error('Bitte den Barcode prüfen. Bei Artikeln ohne Barcode das Feld leer lassen.');
    if ((quantity === '') !== (!unit) || quantity === 0 || (unit && !['g', 'kg', 'ml', 'l'].includes(unit))) {
      throw Error('Bitte Packungsinhalt und Einheit prüfen.');
    }
    const example = {
      id: uid(), savedAt: new Date().toISOString(),
      product: { barcode, name, quantity: quantity === '' ? null : quantity, unit },
      photos: images
    };
    const database = await openExamples();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('examples', 'readwrite');
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || Error('Lernbeispiel konnte nicht gespeichert werden.'));
        transaction.objectStore('examples').add(example);
      });
      msg('Lernbeispiel mit ' + images.length + ' Foto(s) lokal gespeichert.');
    } finally { database.close(); }
  }

  async function photoId(data) {
    const bytes = new TextEncoder().encode(data);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  }

  async function storeRequest(store, operation) {
    const database = await openExamples();
    try {
      return await new Promise((resolve, reject) => {
        const request = operation(database.transaction(store).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  }

  function normalizeStamp(raw) {
    if (!/^\d{1,2}\s*[.\/-]\s*\d{1,2}\s*[.\/-]\s*\d{2,4}$|^\d{6}$|^\d{1,2}\s*[.\/-]\s*20\d{2}$/.test(raw)) {
      throw Error('Bitte das Datum wie auf dem Stempel eingeben, z. B. 11/04/28 oder 07.2028.');
    }
    const compact = raw.replace(/\s/g, '');
    const monthYear = compact.match(/^(\d{1,2})[.\/-](20\d{2})$/);
    if (!monthYear) return date(compact);
    const month = Number(monthYear[1]), year = Number(monthYear[2]);
    if (month < 1 || month > 12) throw Error('Monat auf dem Datumsstempel prüfen.');
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }

  async function saveDateExample(data, raw) {
    const normalizedDate = normalizeStamp(raw);
    const id = await photoId(data);
    const database = await openExamples();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('dateExamples', 'readwrite');
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || Error('MHD-Beispiel konnte nicht gespeichert werden.'));
        transaction.objectStore('dateExamples').put({
          id, savedAt: new Date().toISOString(), printedText: raw, date: normalizedDate, photo: data
        });
      });
    } finally { database.close(); }
    return fmt(normalizedDate);
  }

  // Match the exact image only. A barcode or a visually similar package can
  // belong to a different batch and must never inherit its use-by date.
  window.vachaLearnedPhotoDate = async data => {
    if (!crypto.subtle) return '';
    try {
      const id = await photoId(data);
      const example = await storeRequest('dateExamples', store => store.get(id));
      return example ? fmt(example.date) : '';
    } catch (_) { return ''; }
  };

  window.vachaOpenDateExample = photo => {
    const panel = $('photoDateChoices'), draft = photoGalleryDraft, data = photo.data;
    const active = () => !$('edit').hidden && draft === photoGalleryDraft && draft.includes(photo) && photo.data === data;
    panel.replaceChildren();
    panel.hidden = false;
    const preview = el('img');
    preview.src = data;
    preview.alt = 'Foto mit Datumsstempel';
    const caption = el('label', 'Datum genau wie auf dem Stempel eingeben');
    caption.htmlFor = 'dateExampleText';
    const input = el('input');
    input.id = 'dateExampleText';
    input.type = 'text';
    input.placeholder = '11/04/28 oder 07.2028';
    input.maxLength = 20;
    const status = el('small', 'Das Foto und deine Korrektur bleiben in diesem Browser.');
    status.setAttribute('role', 'status');
    const save = btn('MHD-Beispiel lokal speichern', async () => {
      if (!active() || !panel.contains(input) || save.disabled) return;
      save.disabled = true;
      try {
        const value = await saveDateExample(data, input.value.trim());
        if (!active() || !panel.contains(input)) return;
        const field = $('dates');
        const entries = field.value.split(/[;\n]+/).map(entry => entry.trim()).filter(Boolean);
        if (entries.length <= 1) field.value = value;
        status.textContent = 'MHD-Beispiel gespeichert: ' + value + '.' +
          (entries.length > 1 ? ' Im Formular stehen mehrere Daten. Bitte das zutreffende Datum dort korrigieren.' : ' Das Feld „Neue MHD“ wurde korrigiert.');
        msg(status.textContent);
      } catch (error) {
        if (active() && panel.contains(input)) status.textContent = error.message;
      } finally { save.disabled = false; }
    }, 'good');
    panel.append(preview, caption, input, save, status);
    panel.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
  };

  $('correctDateExample').onclick = act(() => {
    const draft = photoGalleryDraft;
    if (draft.length === 1) {
      window.vachaOpenDateExample(draft[0]);
      return;
    }
    const panel = $('photoDateChoices');
    panel.replaceChildren();
    panel.hidden = false;
    panel.append(el('b', 'Auf welchem Foto ist der MHD-Stempel?'));
    draft.forEach((photo, index) => {
      const preview = el('img');
      preview.src = photo.data;
      preview.alt = 'Foto ' + (index + 1);
      panel.append(preview, btn('Foto ' + (index + 1) + ' verwenden', () => {
        if (draft !== photoGalleryDraft || !draft.includes(photo) || $('edit').hidden) return;
        window.vachaOpenDateExample(photo);
      }));
    });
    panel.scrollIntoView({ block: 'center' });
  });

  async function exportExamples() {
    const [examples, dateExamples] = await Promise.all([
      storeRequest('examples', store => store.getAll()),
      storeRequest('dateExamples', store => store.getAll())
    ]);
    if (!examples.length && !dateExamples.length) throw Error('Auf diesem Gerät sind noch keine Lernbeispiele gespeichert.');
    const data = { schemaVersion: 2, exportedAt: new Date().toISOString(), examples, dateExamples };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = 'Vacha-Lernbeispiele.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    msg((examples.length + dateExamples.length) + ' Lernbeispiel(e) exportiert.');
  }

  window.vachaSaveLearningExample = saveExample;
  $('saveLearningExample').onclick = act(async () => {
    const button = $('saveLearningExample');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const barcode = articleCode($('ean').value);
      await saveExample(photoGalleryDraft, {
        barcode: editing && !/^\d{8,14}$/.test(barcode) ? '' : barcode,
        name: $('name').value, quantity: $('quantity').value, unit: $('unit').value
      });
    } finally { button.disabled = false; }
  });
  $('exportLearningExamples').onclick = act(exportExamples);
})();
