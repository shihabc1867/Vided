'use strict';
/* Audio editor: waveforms, trim, fades, noise reduction, normalize, rumble filter,
   and "extract audio from a video clip". Everything runs on the phone. */

const PEAK_N = 1600;

/* ---------- decoding / WAV helpers ---------- */
async function decodeBlob(blob, sr) {
  const ctx = new OfflineAudioContext(2, sr, sr);
  return ctx.decodeAudioData(await blob.arrayBuffer());
}
function wavBlob(chs, sr) {
  const n = chs[0].length, nc = chs.length, bytes = n * nc * 2;
  const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const x = Math.max(-1, Math.min(1, chs[c][i]));
      v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
const chansOf = buf => { const o = []; for (let c = 0; c < buf.numberOfChannels; c++) o.push(buf.getChannelData(c)); return o; };

/* ---------- waveform ---------- */
function peaksOf(buf) {
  const n = PEAK_N, out = new Float32Array(n), len = buf.length;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * len / n), e = Math.floor((i + 1) * len / n);
      const step = Math.max(1, ((e - s) / 200) | 0);
      let m = 0;
      for (let j = s; j < e; j += step) { const v = Math.abs(d[j]); if (v > m) m = v; }
      if (m > out[i]) out[i] = m;
    }
  }
  let mx = 0;
  for (let i = 0; i < n; i++) if (out[i] > mx) mx = out[i];
  if (mx > 0) for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / mx * 0.95);
  return out;
}
async function ensurePeaks(it) {
  if (it.peaks || it._pk) return;
  if (!it.blob || it.blob.size > 80 * 1048576) { it._pk = 'skip'; return; }
  it._pk = 'busy';
  try {
    const buf = await decodeBlob(it.blob, 22050);
    it.peaks = peaksOf(buf);
    it._pk = null;
  } catch (e) { it._pk = 'fail'; }
  drawTimeline();
  if (it.id === S.asel) drawWave();
}
function drawPeaks(g, pk, x, y, w, h, f0, f1, color) {
  if (!pk || !(f1 > f0)) return;
  const n = pk.length, mid = y + h / 2, cols = Math.max(1, Math.floor(w / 2));
  g.fillStyle = color || 'rgba(255,255,255,.7)';
  for (let i = 0; i < cols; i++) {
    const a = f0 + (f1 - f0) * i / cols, b = f0 + (f1 - f0) * (i + 1) / cols;
    const i0 = Math.max(0, Math.floor(a * n)), i1 = Math.max(i0 + 1, Math.ceil(b * n));
    let m = 0;
    for (let j = i0; j < i1 && j < n; j++) if (pk[j] > m) m = pk[j];
    const hh = Math.max(1, m * h);
    g.fillRect(x + i * 2, mid - hh / 2, 1.5, hh);
  }
}

/* big waveform in the Audio tab */
function drawWave() {
  const cvw = $('aWave');
  if (!cvw) return;
  const a = selAudio();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cvw.clientWidth || 300, H = 84;
  cvw.width = Math.round(W * dpr); cvw.height = Math.round(H * dpr);
  const g = cvw.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#12121a'; g.fillRect(0, 0, W, H);
  if (!a) return;
  if (!a.peaks) {
    g.fillStyle = '#7d7d92'; g.font = '12px system-ui,sans-serif'; g.textBaseline = 'middle';
    g.fillText(a._pk === 'fail' || a._pk === 'skip' ? 'Waveform not available' : 'Loading waveform…', 10, H / 2);
    return;
  }
  drawPeaks(g, a.peaks, 0, 4, W, H - 8, 0, 1, 'rgba(160,255,210,.9)');
  // dim the trimmed-away parts
  const x0 = a.in / a.dur * W, x1 = a.out / a.dur * W;
  g.fillStyle = 'rgba(0,0,0,.6)';
  g.fillRect(0, 0, x0, H); g.fillRect(x1, 0, W - x1, H);
  g.strokeStyle = '#7a5cff'; g.lineWidth = 2;
  g.strokeRect(x0 + 1, 1, Math.max(2, x1 - x0 - 2), H - 2);
  // fade ramps
  const L = alen(a);
  g.strokeStyle = '#ffd166'; g.lineWidth = 1.5;
  if (a.fi > 0) { const fw = a.fi / a.dur * W; g.beginPath(); g.moveTo(x0, H - 3); g.lineTo(x0 + fw, 3); g.stroke(); }
  if (a.fo > 0) { const fw = a.fo / a.dur * W; g.beginPath(); g.moveTo(x1 - fw, 3); g.lineTo(x1, H - 3); g.stroke(); }
  // playhead
  const pt = S.t - a.start;
  if (pt >= 0 && pt <= L) {
    const x = (a.in + pt) / a.dur * W;
    g.strokeStyle = '#ff4d6d'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
}

/* ---------- Audio tab ---------- */
function refreshAudio() {
  const sel = $('aSel');
  sel.innerHTML = '';
  S.audio.forEach((a, i) => {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = (i + 1) + '. ' + a.name;
    sel.appendChild(o);
  });
  sel.style.display = S.audio.length ? '' : 'none';
  const a = selAudio();
  $('n-audio').classList.toggle('off', !a);
  if (a) {
    sel.value = a.id;
    setR('aVol', a.vol);
    $('aStart').value = +a.start.toFixed(2);
    setR('aIn', a.in, 0, Math.max(0.1, a.dur - 0.1));
    setR('aOut', a.out, 0.1, a.dur);
    setR('aFi', a.fi || 0); setR('aFo', a.fo || 0);
  }
  const c = selClip();
  $('n-clipfade').classList.toggle('off', !c || c.type !== 'video');
  if (c) { setR('cfi', c.fi || 0); setR('cfo', c.fo || 0); }
  [...S.clips, ...S.audio].forEach(ensurePeaks);
  drawWave();
}
const withAudio = (key, fn) => e => {
  const a = selAudio(); if (!a) return;
  touch(key);
  fn(a, e);
  drawWave(); drawTimeline();
};
$('aSel').onchange = e => { S.asel = +e.target.value; refreshAudio(); drawTimeline(); };
$('aVol').oninput = withAudio('avol', (a, e) => { a.vol = +e.target.value; });
$('aStart').oninput = withAudio('astart', (a, e) => { a.start = Math.max(0, +e.target.value || 0); });
$('aIn').oninput = withAudio('ain', (a, e) => { a.in = Math.min(+e.target.value, a.out - 0.1); });
$('aOut').oninput = withAudio('aout', (a, e) => { a.out = Math.max(+e.target.value, a.in + 0.1); });
$('aFi').oninput = withAudio('afi', (a, e) => { a.fi = Math.min(+e.target.value, alen(a)); });
$('aFo').oninput = withAudio('afo', (a, e) => { a.fo = Math.min(+e.target.value, alen(a)); });
$('aNow').onclick = () => {
  const a = selAudio(); if (!a) return;
  touch('anow' + nid());
  a.start = +S.t.toFixed(1);
  refreshAudio(); drawTimeline();
};
$('aDel').onclick = () => {
  const a = selAudio(); if (!a) return;
  touch('adel' + nid());
  a.el.pause();
  S.audio = S.audio.filter(x => x.id !== a.id);
  S.asel = S.audio.length ? S.audio[0].id : -1;
  refreshAll();
};
$('cfi').oninput = e => { const c = selClip(); if (!c) return; touch('cfi'); c.fi = +e.target.value; };
$('cfo').oninput = e => { const c = selClip(); if (!c) return; touch('cfo'); c.fo = +e.target.value; };
$('aWave').addEventListener('click', e => {
  const a = selAudio(); if (!a) return;
  const r = $('aWave').getBoundingClientRect();
  const srcT = (e.clientX - r.left) / r.width * a.dur;
  seek(a.start + (srcT - a.in));
  drawWave();
});

/* ---------- processing ---------- */
function setBusy(msg, prog) {
  $('busy').classList.add('on');
  $('busyMsg').textContent = msg;
  $('busyProg').value = prog || 0;
}
function clearBusy() { $('busy').classList.remove('on'); }

async function useAudioBlob(a, blob) {
  const el = new Audio();
  el.preload = 'auto';
  el.src = URL.createObjectURL(blob);
  await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('Could not load the processed audio')); });
  touch('audiofx' + nid());
  a.el.pause();
  a.el = el; a.blob = blob; a.mkey = 'm' + nid();
  a.src = null; a.gain = null; a.peaks = null; a._pk = null;
  wire(a);
  refreshAll();
  markDirty();
}

/* FFT (radix 2, in place) */
function makeFFT(n) {
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2), rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  return (re, im, inv) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sg = inv ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tr = re[l] * cos[k] + sg * im[l] * sin[k];
          const ti = -sg * re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tr; im[l] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  };
}

/* Spectral noise reduction: learn the noise from the quietest parts, then gate/subtract it. */
async function denoiseChannel(x, strength, onProg) {
  const N = 1024, H = 256, B = N / 2 + 1;
  const fft = makeFFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const xp = new Float32Array(x.length + 2 * N);
  xp.set(x, N);
  const nF = Math.floor((xp.length - N) / H) + 1;
  const re = new Float32Array(N), im = new Float32Array(N);

  // 1) frame energies (time domain) -> quietest frames
  const en = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    let e = 0; const o = f * H;
    for (let i = 0; i < N; i += 4) { const v = xp[o + i] * win[i]; e += v * v; }
    en[f] = e;
  }
  const sorted = Float32Array.from(en).sort();
  const thr = sorted[Math.floor(nF * 0.15)];
  const noise = new Float32Array(B);
  let cnt = 0;
  const stride = Math.max(1, Math.floor(nF * 0.15 / 300));
  for (let f = 0; f < nF && cnt < 400; f += 1) {
    if (en[f] > thr || (f % stride)) continue;
    const o = f * H;
    for (let i = 0; i < N; i++) { re[i] = xp[o + i] * win[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < B; k++) noise[k] += Math.hypot(re[k], im[k]);
    cnt++;
  }
  if (!cnt) return x;
  for (let k = 0; k < B; k++) noise[k] /= cnt;

  // 2) subtract
  const alpha = 1 + 1.6 * strength;
  const floorG = Math.pow(10, -(8 + 16 * strength) / 20);
  const out = new Float32Array(xp.length);
  const prev = new Float32Array(B).fill(1), g = new Float32Array(B), gs = new Float32Array(B);
  for (let f = 0; f < nF; f++) {
    const o = f * H;
    for (let i = 0; i < N; i++) { re[i] = xp[o + i] * win[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < B; k++) {
      const m = Math.hypot(re[k], im[k]) + 1e-12;
      let v = 1 - alpha * noise[k] / m;
      if (v < floorG) v = floorG;
      g[k] = v;
    }
    for (let k = 0; k < B; k++) {
      const sm = (g[Math.max(0, k - 1)] + g[k] * 2 + g[Math.min(B - 1, k + 1)]) / 4;
      gs[k] = Math.max(sm, prev[k] * 0.8);
      prev[k] = gs[k];
    }
    for (let k = 0; k < N; k++) { const gk = gs[k < B ? k : N - k]; re[k] *= gk; im[k] *= gk; }
    fft(re, im, true);
    for (let i = 0; i < N; i++) out[o + i] += re[i] / N * win[i];
    if (f % 300 === 0) { if (onProg) onProg(f / nF); await sleep(0); if (cancelled) return null; }
  }
  const res = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) res[i] = out[i + N] / 1.5;
  return res;
}

async function runAudioFx(kind) {
  const a = selAudio();
  if (!a) return toast('Add an audio track first');
  if (a.blob.size > 200 * 1048576) return toast('This file is too large to process on the phone');
  cancelled = false;
  setBusy('Reading audio…', 0.02);
  await sleep(30);
  try {
    const buf = await decodeBlob(a.blob, 48000).catch(() => null);
    if (!buf) throw new Error('Could not read this audio file');
    const sr = buf.sampleRate;
    let chs = chansOf(buf).map(c => Float32Array.from(c));
    if (kind === 'denoise') {
      const strength = (+$('aNr').value) / 100;
      const outs = [];
      for (let c = 0; c < chs.length; c++) {
        setBusy('Reducing noise…' + (chs.length > 1 ? ' (channel ' + (c + 1) + ' of ' + chs.length + ')' : ''), 0.05);
        const r = await denoiseChannel(chs[c], strength, p => { $('busyProg').value = (c + p) / chs.length; });
        if (!r) { clearBusy(); return toast('Cancelled'); }
        outs.push(r);
      }
      chs = outs;
    } else if (kind === 'normalize') {
      let pk = 0;
      chs.forEach(c => { for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > pk) pk = v; } });
      if (pk < 1e-5) throw new Error('This audio is silent');
      const gain = 0.891 / pk;
      chs.forEach(c => { for (let i = 0; i < c.length; i++) c[i] *= gain; });
    } else if (kind === 'hpf') {
      const off = new OfflineAudioContext(chs.length, chs[0].length, sr);
      const b2 = off.createBuffer(chs.length, chs[0].length, sr);
      chs.forEach((c, i) => b2.copyToChannel(c, i));
      const src = off.createBufferSource(); src.buffer = b2;
      const f = off.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 90; f.Q.value = 0.707;
      src.connect(f); f.connect(off.destination); src.start();
      chs = chansOf(await off.startRendering());
    }
    setBusy('Saving…', 0.97);
    await sleep(10);
    await useAudioBlob(a, wavBlob(chs, sr));
    toast(kind === 'denoise' ? 'Noise reduced' : kind === 'normalize' ? 'Volume normalized' : 'Low rumble removed');
  } catch (e) { toast(e.message || 'Audio processing failed'); }
  clearBusy();
}
$('aDenoise').onclick = () => runAudioFx('denoise');
$('aNorm').onclick = () => runAudioFx('normalize');
$('aHpf').onclick = () => runAudioFx('hpf');

/* Pull the sound of a video clip out as its own audio track (trimmed, speed applied). */
async function extractAudio() {
  const c = selClip();
  if (!c || c.type !== 'video') return toast('Select a video clip first');
  if (c.blob.size > 300 * 1048576) return toast('This video is too large to extract audio on the phone');
  cancelled = false;
  setBusy('Extracting audio…', 0.1);
  await sleep(30);
  try {
    const buf = await decodeBlob(c.blob, 48000).catch(() => null);
    if (!buf) throw new Error('This clip has no audio');
    const sr = 48000, L = len(c);
    const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(L * sr)), sr);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;
    src.connect(off.destination);
    src.start(0, c.in, c.out - c.in);
    src.stop(L);
    const out = await off.startRendering();
    const blob = wavBlob(chansOf(out), sr);
    const el = new Audio();
    el.preload = 'auto';
    el.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('Could not load the extracted audio')); });
    touch('extract' + nid());
    const dur = isFinite(el.duration) ? el.duration : L;
    const a = { id: nid(), type: 'audio', name: 'Audio of ' + c.name, blob, mkey: 'm' + nid(), el, dur, in: 0, out: dur, fi: 0, fo: 0, peaks: null, start: c.start, vol: Math.min(200, c.vol), src: null, gain: null };
    S.audio.push(a);
    wire(a);
    S.asel = a.id;
    if ($('aMute').checked) c.vol = 0;
    refreshAll();
    openTab('audio');
    toast('Audio extracted' + ($('aMute').checked ? ' and the clip is muted' : ''));
  } catch (e) { toast(e.message || 'Could not extract audio'); }
  clearBusy();
}
$('aExtract').onclick = extractAudio;

window.addEventListener('resize', drawWave);
refreshAudio();
