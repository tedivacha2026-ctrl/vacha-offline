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
  const name=$('name');
  const label=document.createElement('label'); label.textContent='Bis zu 5 Produktfotos aus der Galerie auswählen – Name, Barcode und Inhalt erkennen';
  const input=document.createElement('input'); input.type='file'; input.accept='image/*'; input.multiple=true;
  const note=document.createElement('small'); note.textContent='Die Fotos werden auf diesem Gerät ausgelesen und nicht als Artikelfoto gespeichert. Erkannte Angaben bitte kontrollieren.';
  const result=document.createElement('small'); result.setAttribute('aria-live','polite');
  name.insertAdjacentElement('afterend',label); label.after(input,note,result);
  let ocrWorker=null, ocrLoading=null;
  async function getWorker(){
    if(ocrWorker)return ocrWorker;
    if(!ocrLoading)ocrLoading=(async()=>{
      if(!window.Tesseract){result.textContent='Lade die kostenlose deutsche Texterkennung (einmalig Internet nötig)…'; await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';s.onload=resolve;s.onerror=()=>reject(Error('Texterkennung konnte nicht geladen werden. Internetverbindung prüfen.'));document.head.append(s)});}
      ocrWorker=await Tesseract.createWorker(['deu','eng'],1,{logger:m=>{if(m.status==='recognizing text')result.textContent='Foto wird gelesen: '+Math.round((m.progress||0)*100)+'%'}});
      return ocrWorker;
    })();
    try{return await ocrLoading}catch(e){ocrLoading=null;throw e}
  }
  const skip=/zutaten|nährwert|naehrwert|fett|kohlenhydrat|zucker|eiweiß|protein|salz|hersteller|anschrift|mindestens haltbar|kühl|kuehl|lagerung|portion|je 100|pro 100|www.|https?:|gmbh/i;
  function parseText(text){
    const lines=text.split(/[\r\n]+/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
    const names=lines.filter(x=>x.length>=3&&x.length<=65&&/[a-zäöü]/i.test(x)&&!/^\d+[\d\s.,/-]*$/.test(x)&&!skip.test(x));
    const nameCandidate=names.sort((a,b)=>nameScore(b)-nameScore(a))[0]||'';
    const weights=[];
    for(const line of lines){
      if(/nährwert|naehrwert|fett|kohlenhydrat|zucker|eiweiß|protein|salz|je 100|pro 100/i.test(line))continue;
      const m=line.match(/(?:netto(?:füllmenge)?|inhalt|füllmenge|menge)?[^\d]{0,12}(\d{1,4}(?:[.,]\d{1,3})?)\s*(kg|g|mg|l|ml|cl|dl)\b/i);
      if(m){let q=Number(m[1].replace(',','.')),u=m[2].toLowerCase();if(u==='mg'){q/=1000;u='g'}if(u==='cl'){q*=10;u='ml'}if(u==='dl'){q*=100;u='ml'}if(q>0&&q<100000&&['g','kg','ml','l'].includes(u))weights.push({q,u,priority:/netto|inhalt|füllmenge|menge/i.test(line)?2:1});}
    }
    weights.sort((a,b)=>b.priority-a.priority);
    return {name:nameCandidate,weight:weights[0]||null};
  }
  function nameScore(s){return Math.min(s.length,32)+(/^[A-ZÄÖÜ]/.test(s)?3:0)-(s.split(' ').length>7?12:0)}
  input.onchange=async e=>{
    const files=Array.from(e.target.files||[]);e.target.value='';
    if(!files.length)return;
    if(files.length>5){say('Bitte höchstens 5 Fotos auf einmal auswählen.',true);return;}
    if(name.disabled){say('Texterkennung ist nur beim Anlegen eines neuen Artikels verfügbar.',true);return;}
    try{
      const worker=await getWorker();let allText='',foundBarcode='';
      for(let i=0;i<files.length;i++){
        result.textContent='Lese Foto '+(i+1)+' von '+files.length+'…';
        const image=await createImageBitmap(files[i]);
        try{
          const out=await worker.recognize(image);allText+='\n'+(out.data.text||'');
          if(!foundBarcode&&'BarcodeDetector'in window){try{const fmts=await BarcodeDetector.getSupportedFormats?.(),wanted=['ean_13','ean_8','upc_a','upc_e','code_128'],supported=fmts?.filter(x=>wanted.includes(x));const codes=await new BarcodeDetector(supported?.length?{formats:supported}:{}).detect(image);foundBarcode=codes.find(c=>/^\d{8,14}$/.test(c.rawValue))?.rawValue||''}catch(_){}}
        }finally{image.close()}
      }
      const parsed=parseText(allText);
      if(parsed.name){name.value=parsed.name;name.dispatchEvent(new Event('input',{bubbles:true}))}
      if(parsed.weight){$('quantity').value=String(parsed.weight.q).replace('.',',');$('unit').value=parsed.weight.u;$('quantity').dispatchEvent(new Event('input',{bubbles:true}))}
      if(foundBarcode&&!$('ean').disabled&&!$('ean').value){$('ean').value=foundBarcode;}
      const found=[parsed.name?'Artikelname':'',parsed.weight?'Inhalt/Gewicht':'',foundBarcode?'Barcode':''].filter(Boolean);
      result.textContent=found.length?'Vorschläge eingefügt: '+found.join(', ')+'. Bitte prüfen.':'Text erkannt, aber Name oder Inhalt nicht sicher gefunden. Bitte Felder prüfen und ergänzen.';
      say('Foto-Erkennung abgeschlossen – Angaben bitte vor dem Speichern kontrollieren.');
    }catch(err){result.textContent='';say(err.message||String(err),true)}
  };
})();
