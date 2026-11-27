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
  function openExamples() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('vacha-learning-examples', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('examples', { keyPath: 'id' });
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

  async function exportExamples() {
    const database = await openExamples();
    let examples;
    try {
      examples = await new Promise((resolve, reject) => {
        const request = database.transaction('examples').objectStore('examples').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
    if (!examples.length) throw Error('Auf diesem Gerät sind noch keine Lernbeispiele gespeichert.');
    const data = { schemaVersion: 1, exportedAt: new Date().toISOString(), examples };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = 'Vacha-Lernbeispiele.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    msg(examples.length + ' Lernbeispiel(e) exportiert.');
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
