(() => {
  const $ = id => document.getElementById(id);
  const search = $('search');
  const scanButton = document.createElement('button');
  scanButton.type = 'button'; scanButton.className = 'secondary'; scanButton.textContent = 'Barcode mit Kamera scannen';
  search.insertAdjacentElement('afterend', scanButton);
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'width:min(92vw,520px);border:0;border-radius:14px;padding:16px;background:#fff;color:#182b40';
  dialog.innerHTML = '<h3>Barcode scannen</h3><video autoplay muted playsinline style="width:100%;max-height:55vh;background:#111;border-radius:8px;object-fit:cover"></video><p class="cameraStatus">Richte die Kamera auf den Barcode.</p><button type="button" class="cameraClose secondary">Abbrechen</button>';
  document.body.append(dialog);
  const video = dialog.querySelector('video'), status = dialog.querySelector('.cameraStatus');
  let stream = null, timer = 0, busy = false;
  function stop() { clearTimeout(timer); timer = 0; busy = false; if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } video.srcObject = null; if (dialog.open) dialog.close(); }
  dialog.querySelector('.cameraClose').onclick = stop;
  dialog.addEventListener('close', () => { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } clearTimeout(timer); });
  function say(text, bad=false) { const m=$('message'); if (m) { m.textContent=text; m.className=bad?'warn':'green'; } }
  async function acceptCode(raw) {
    const code=String(raw||'').trim();
    if (!/^\d{8,14}$/.test(code)) { say('Der erkannte Code ist kein Barcode mit 8–14 Ziffern.',true); return; }
    stop(); search.value=code; search.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>requestAnimationFrame(r));
    const existing=document.querySelector('#results .entry button');
    if (existing) { existing.click(); say('Barcode erkannt – vorhandenen Artikel geöffnet.'); return; }
    $('new').click(); $('ean').value=code; $('name').focus(); say('Barcode erkannt. Artikelnamen und weitere Angaben ergänzen.');
  }
  scanButton.onclick = async () => {
    if (!('BarcodeDetector' in window)) { say('Barcode-Live-Erkennung wird von diesem Browser nicht unterstützt. Nutze das Foto-Feld oder gib die Nummer ein.',true); return; }
    if (!navigator.mediaDevices?.getUserMedia) { say('Kamera nicht verfügbar. Bitte die App über ihre HTTPS-Adresse öffnen.',true); return; }
    try {
      dialog.showModal(); stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
      video.srcObject=stream; await video.play();
      const formats=await BarcodeDetector.getSupportedFormats?.(), wanted=['ean_13','ean_8','upc_a','upc_e','code_128'], supported=formats?.filter(x=>wanted.includes(x));
      const detector=new BarcodeDetector(supported?.length?{formats:supported}:{});
      const scan=async()=>{ if(!stream||busy)return; busy=true; try { const codes=await detector.detect(video); if(codes.length){await acceptCode(codes[0].rawValue);return;} } catch(e) { status.textContent='Noch nicht erkannt – Barcode ganz ins Bild nehmen und ruhig halten.'; } finally { busy=false; } if(stream) timer=setTimeout(scan,220); };
      status.textContent='Richte die Kamera auf den Barcode und halte das Handy ruhig.'; scan();
    } catch(e) { stop(); say(e.name==='NotAllowedError'?'Kamerazugriff abgelehnt. Bitte Kamera für die App freigeben.':'Kamera konnte nicht geöffnet werden: '+(e.message||e),true); }
  };
  const name=document.getElementById('name');
  const label=document.createElement('label'); label.textContent='Artikelnamen vom Etikett vorschlagen (wenn Browser es unterstützt)';
  const input=document.createElement('input'); input.type='file'; input.accept='image/*'; input.setAttribute('capture','environment');
  const note=document.createElement('small'); note.textContent='Der Vorschlag muss vor dem Speichern geprüft werden.';
  name.insertAdjacentElement('afterend',label); label.after(input,note);
  input.onchange=async e=>{ const f=e.target.files?.[0]; if(!f)return; try { if(!('TextDetector' in window)) throw Error('Dieser Browser unterstützt keine lokale Texterkennung. Bitte den Namen eintippen.'); const image=await createImageBitmap(f); try { const lines=await new TextDetector().detect(image), text=lines.map(x=>(x.rawValue||'').trim()).filter(Boolean); if(!text.length) throw Error('Kein lesbarer Name erkannt. Etikett scharf und nah fotografieren.'); name.value=text.sort((a,b)=>b.length-a.length)[0].slice(0,150); name.dispatchEvent(new Event('input',{bubbles:true})); say('Namensvorschlag eingefügt – bitte prüfen.'); } finally { image.close(); } } catch(err) { say(err.message||String(err),true); } finally { e.target.value=''; } };
})();
