'use strict';
/* Auto captions: speech-to-text (English, Bengali and more), a caption editor,
   SRT import/export, and caption rendering that is included in every export.
   Engines:
     - Cloud:      Groq Whisper large-v3 with the user's own free API key (best accuracy, incl. Bengali)
     - On device:  Whisper via transformers.js in a Web Worker (private, works offline after the first download) */

const WHISPER_LANG = { auto: null, en: 'english', bn: 'bengali', hi: 'hindi', ar: 'arabic', es: 'spanish', ur: 'urdu' };
const selCap = () => S.caps.find(c => c.id === S.capSel) || null;

/* ---------- rendering ---------- */
function drawCaptions(t) {
  const cp = S.caps.find(c => t >= c.from && t < c.to);
  if (!cp || !cp.text) return;
  const st = S.capStyle, W = cv.width, H = cv.height, F = Math.min(W, H) / 720;
  const px = st.size * F, maxW = W * 0.88;
  let text = cp.text.replace(/\s+/g, ' ').trim();
  if (st.upper) text = text.toUpperCase();
  ctx.save();
  ctx.font = `${st.bold ? 800 : 600} ${px}px ${FONT}`;
  // wrap into lines
  const words = text.split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (cur && ctx.measureText(test).width > maxW) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  const lh = px * 1.3, pad = px * 0.28;
  const age = t - cp.from;
  let a = 1, sc = 1;
  if (st.anim === 'pop') { const p = clamp(age / 0.18, 0, 1); sc = 0.85 + 0.15 * easeOutBack(p); a = clamp(age / 0.08, 0, 1); }
  else if (st.anim === 'fade') a = clamp(age / 0.2, 0, 1);
  ctx.globalAlpha = a;
  ctx.translate(W / 2, st.y * H);
  ctx.scale(sc, sc);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const top = -(lines.length * lh) / 2;
  lines.forEach((ln, i) => {
    const y = top + lh * (i + 0.5);
    if (st.bgOn) {
      const w = ctx.measureText(ln).width;
      ctx.globalAlpha = a * 0.72;
      ctx.fillStyle = st.bg;
      rr(-w / 2 - pad, y - lh / 2 + 2, w + pad * 2, lh - 4, px * 0.22);
      ctx.fill();
      ctx.globalAlpha = a;
    } else {
      ctx.lineWidth = px / 6;
      ctx.strokeStyle = 'rgba(0,0,0,.9)';
      ctx.strokeText(ln, 0, y);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(ln, 0, y);
  });
  ctx.restore();
}

/* ---------- segments -> captions ---------- */
function splitSegment(s, max = 64) {
  const text = (s.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const words = text.split(' '), parts = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { parts.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) parts.push(cur);
  const total = parts.reduce((n, p) => n + p.length, 0) || 1, dur = Math.max(0.1, s.end - s.start);
  let t = s.start;
  return parts.map(p => { const d = dur * p.length / total; const r = { from: t, to: t + d, text: p }; t += d; return r; });
}
function applySegments(segs) {
  touch('caps' + nid());
  const out = [];
  segs.forEach(s => splitSegment(s).forEach(p => out.push({ id: nid(), from: p.from, to: p.to, text: p.text })));
  out.sort((a, b) => a.from - b.from);
  out.forEach((c, i) => {
    if (c.to - c.from < 0.5) c.to = c.from + 0.5;
    const nx = out[i + 1];
    if (nx && c.to > nx.from) c.to = Math.max(c.from + 0.2, nx.from);
    c.from = +c.from.toFixed(2); c.to = +c.to.toFixed(2);
  });
  S.caps = out;
  S.capSel = out.length ? out[0].id : -1;
  refreshAll();
}

/* ---------- audio for the speech engine ---------- */
async function captionAudio() {
  if (!S.total) return null;
  if ([...S.clips, ...S.audio].some(x => x.blob && x.blob.size > 300 * 1048576)) throw new Error('A file is very large for on-phone transcription');
  const buf = await mixAudio(S.total, 16000);
  if (!buf) return null;
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const mono = new Float32Array(buf.length);
  let peak = 0;
  for (let i = 0; i < mono.length; i++) { mono[i] = (a[i] + b[i]) / 2; const v = Math.abs(mono[i]); if (v > peak) peak = v; }
  return peak < 0.001 ? null : mono;
}

/* ---------- engine: Groq (cloud) ---------- */
async function groqTranscribe(mono, lang, key) {
  const sr = 16000, chunkS = 600, segs = [];
  const nChunks = Math.ceil(mono.length / (chunkS * sr));
  for (let i = 0; i < nChunks; i++) {
    if (cancelled) return null;
    setBusy(`Transcribing… (${i + 1} of ${nChunks})`, 0.2 + 0.7 * i / nChunks);
    const part = mono.subarray(i * chunkS * sr, Math.min(mono.length, (i + 1) * chunkS * sr));
    const fd = new FormData();
    fd.append('file', wavBlob([part], sr), 'audio.wav');
    fd.append('model', 'whisper-large-v3');
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'segment');
    fd.append('temperature', '0');
    if (lang && lang !== 'auto') fd.append('language', lang);
    let res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
    } catch (e) { throw new Error('Could not reach Groq. Check your internet connection.'); }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error.message; } catch (e) { }
      throw new Error(res.status === 401 ? 'Groq rejected the API key. Check it and try again.'
        : res.status === 429 ? 'Groq rate limit reached. Wait a minute and try again.'
          : (msg || 'Groq error ' + res.status));
    }
    const j = await res.json();
    (j.segments || []).forEach(s => {
      if (s.no_speech_prob > 0.7 && s.avg_logprob < -0.7) return; // skip hallucinated text over silence
      segs.push({ start: s.start + i * chunkS, end: s.end + i * chunkS, text: (s.text || '').trim() });
    });
    if (!j.segments && j.text) segs.push({ start: i * chunkS, end: i * chunkS + part.length / sr, text: j.text.trim() });
  }
  return segs;
}

/* ---------- engine: on-device Whisper ---------- */
function localTranscribe(mono, lang, model) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker('whisper-worker.js', { type: 'module' }); }
    catch (e) { return reject(new Error('This browser cannot run the on-device model')); }
    const t0 = Date.now();
    let stage = 'dl';
    const timer = setInterval(() => {
      if (cancelled) { clearInterval(timer); w.terminate(); resolve(null); }
      else if (stage === 'run') setBusy('Transcribing on your device… ' + Math.round((Date.now() - t0) / 1000) + 's', 0.5);
    }, 500);
    const fail = msg => { clearInterval(timer); w.terminate(); reject(new Error(msg)); };
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') {
        const p = m.p;
        if (p && p.status === 'progress') setBusy('Downloading model… ' + Math.round(p.progress || 0) + '%', 0.1 + 0.3 * (p.progress || 0) / 100);
      } else if (m.type === 'status') {
        stage = /Transcrib/.test(m.msg) ? 'run' : 'dl';
        setBusy(m.msg, 0.45);
      } else if (m.type === 'done') {
        clearInterval(timer); w.terminate();
        resolve(m.chunks.map(c => ({ start: c.timestamp[0] || 0, end: c.timestamp[1] == null ? (c.timestamp[0] || 0) + 3 : c.timestamp[1], text: c.text })));
      } else if (m.type === 'error') fail(m.message);
    };
    w.onerror = () => fail('The on-device model could not start. It needs an internet connection the first time.');
    w.postMessage({ audio: mono, lang: WHISPER_LANG[lang] || null, model }, [mono.buffer]);
  });
}

/* ---------- Generate ---------- */
async function generateCaptions() {
  if (!S.clips.length && !S.audio.length) return toast('Add a clip first');
  const engine = $('cEngine').value, lang = $('cLang').value;
  let key = '';
  if (engine === 'groq') {
    key = $('cKey').value.trim();
    if (!key) return toast('Paste your free Groq API key first');
    try { localStorage.setItem('vided.groq', key); } catch (e) { }
  }
  if (S.caps.length && !confirm('Replace the existing captions?')) return;
  pause();
  cancelled = false;
  setBusy('Preparing audio…', 0.05);
  await sleep(30);
  try {
    const mono = await captionAudio();
    if (cancelled) { clearBusy(); return; }
    if (!mono) throw new Error('No audible speech found. Check that the clip is not muted.');
    setBusy(engine === 'groq' ? 'Sending audio to Groq…' : 'Loading the on-device model…', 0.15);
    const segs = engine === 'groq' ? await groqTranscribe(mono, lang, key) : await localTranscribe(mono, lang, $('cModel').value);
    if (!segs) { clearBusy(); return toast('Cancelled'); }
    if (!segs.length) throw new Error('No speech was recognized.');
    applySegments(segs);
    toast(S.caps.length + ' captions created');
  } catch (e) { toast(e.message || 'Could not create captions'); }
  clearBusy();
}
$('cGen').onclick = generateCaptions;

/* ---------- SRT ---------- */
const srtTime = s => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(sec)},${p(ms === 1000 ? 999 : ms, 3)}`;
};
function toSRT(caps) {
  return caps.slice().sort((a, b) => a.from - b.from).map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.text}\n`).join('\n');
}
function parseSRT(txt) {
  const out = [];
  const tm = s => { const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0').slice(0, 3)) / 1000 : null; };
  txt.replace(/\r/g, '').split(/\n\s*\n/).forEach(block => {
    const ln = block.split('\n').filter(l => l.trim() !== '');
    const i = ln.findIndex(l => l.includes('-->'));
    if (i < 0) return;
    const [a, b] = ln[i].split('-->');
    const from = tm(a), to = tm(b), text = ln.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (from != null && to != null && text) out.push({ from, to, text });
  });
  return out;
}
$('cSrtOut').onclick = () => {
  if (!S.caps.length) return toast('No captions to export');
  const url = URL.createObjectURL(new Blob([toSRT(S.caps)], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'captions.srt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
$('cSrtIn').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const items = parseSRT(await f.text());
  if (!items.length) return toast('No captions found in that file');
  touch('srt' + nid());
  S.caps = items.map(c => ({ id: nid(), ...c }));
  S.capSel = S.caps[0].id;
  refreshAll();
  toast(items.length + ' captions imported');
};

/* ---------- editor list ---------- */
function refreshCaps() {
  const box = $('cList');
  if (!box) return;
  box.innerHTML = '';
  S.caps.slice().sort((a, b) => a.from - b.from).forEach(cp => {
    const row = document.createElement('div');
    row.className = 'caprow' + (cp.id === S.capSel ? ' cur' : '');
    const go = document.createElement('button');
    go.textContent = '▶';
    go.title = 'Jump here';
    go.onclick = () => { S.capSel = cp.id; seek(cp.from + 0.01); refreshCaps(); drawTimeline(); };
    const f = document.createElement('input'); f.type = 'number'; f.step = '0.1'; f.min = '0'; f.value = cp.from;
    const t = document.createElement('input'); t.type = 'number'; t.step = '0.1'; t.min = '0'; t.value = cp.to;
    const x = document.createElement('input'); x.type = 'text'; x.value = cp.text;
    const d = document.createElement('button'); d.textContent = '✕'; d.className = 'danger'; d.title = 'Delete';
    f.oninput = () => { touch('cf' + cp.id); cp.from = Math.max(0, +f.value || 0); if (cp.to <= cp.from) cp.to = cp.from + 0.3; drawTimeline(); };
    t.oninput = () => { touch('ct' + cp.id); cp.to = Math.max(cp.from + 0.1, +t.value || 0); drawTimeline(); };
    x.oninput = () => { touch('cx' + cp.id); cp.text = x.value; drawTimeline(); };
    x.onfocus = () => { S.capSel = cp.id; row.parentNode.querySelectorAll('.caprow').forEach(r => r.classList.toggle('cur', r === row)); };
    d.onclick = () => { touch('cdel' + nid()); S.caps = S.caps.filter(c => c.id !== cp.id); if (S.capSel === cp.id) S.capSel = -1; refreshAll(); };
    row.append(go, f, t, x, d);
    box.appendChild(row);
  });
  if (!S.caps.length) box.innerHTML = '<div class="hint">No captions yet. Tap “Create captions” or add one manually.</div>';
  // style controls
  const st = S.capStyle;
  setR('cSize', st.size); setR('cY', Math.round(st.y * 100));
  $('cColor').value = st.color; $('cBg').value = st.bg;
  $('cBgOn').checked = st.bgOn; $('cUpper').checked = st.upper; $('cAnim').value = st.anim;
}
$('cAdd').onclick = () => {
  touch('cadd' + nid());
  const c = { id: nid(), from: +S.t.toFixed(2), to: +(S.t + 2).toFixed(2), text: 'New caption' };
  S.caps.push(c); S.capSel = c.id;
  refreshAll();
};
$('cClear').onclick = () => {
  if (!S.caps.length) return;
  if (!confirm('Delete all captions?')) return;
  touch('cclr' + nid());
  S.caps = []; S.capSel = -1;
  refreshAll();
};
$('cShiftGo').onclick = () => {
  const d = +$('cShift').value || 0;
  if (!d || !S.caps.length) return;
  touch('cshift' + nid());
  S.caps.forEach(c => { c.from = Math.max(0, +(c.from + d).toFixed(2)); c.to = Math.max(c.from + 0.1, +(c.to + d).toFixed(2)); });
  refreshAll();
};
const styleSet = (key, fn) => e => { touch(key); fn(S.capStyle, e); };
$('cSize').oninput = styleSet('csize', (s, e) => { s.size = +e.target.value; });
$('cY').oninput = styleSet('cy', (s, e) => { s.y = (+e.target.value) / 100; });
$('cColor').oninput = styleSet('ccolor', (s, e) => { s.color = e.target.value; });
$('cBg').oninput = styleSet('cbg', (s, e) => { s.bg = e.target.value; s.bgOn = true; $('cBgOn').checked = true; });
$('cBgOn').onchange = styleSet('cbgon' + nid(), (s, e) => { s.bgOn = e.target.checked; });
$('cUpper').onchange = styleSet('cupper' + nid(), (s, e) => { s.upper = e.target.checked; });
$('cAnim').onchange = styleSet('canim' + nid(), (s, e) => { s.anim = e.target.value; });

/* engine UI */
function syncCapEngine() {
  const g = $('cEngine').value === 'groq';
  $('cGroqBox').style.display = g ? '' : 'none';
  $('cLocalBox').style.display = g ? 'none' : '';
}
$('cEngine').onchange = syncCapEngine;
try { $('cKey').value = localStorage.getItem('vided.groq') || ''; } catch (e) { }
$('cKeyClear').onclick = () => { $('cKey').value = ''; try { localStorage.removeItem('vided.groq'); } catch (e) { } toast('Key removed from this phone'); };
syncCapEngine();
refreshCaps();
