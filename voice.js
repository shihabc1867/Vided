'use strict';
/* Voice-over recording, auto-ducking (music gets quieter while someone speaks) and beat sync.
   Everything runs on the phone. */

/* =====================  Speech detection + ducking  ===================== */
const SPEECH = new Map();          // mkey -> { iv: [[start,end],...] in source seconds, p: Promise }
let speechVer = 0;

async function detectSpeech(blob) {
  const sr = 16000, buf = await decodeBlob(blob, sr);
  const n = buf.length, ch = buf.numberOfChannels, win = 800;      // 50 ms
  const frames = Math.floor(n / win), rms = new Float32Array(frames);
  const d = [];
  for (let c = 0; c < ch; c++) d.push(buf.getChannelData(c));
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * win; i < (f + 1) * win; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += d[c][i];
      v /= ch;
      s += v * v;
    }
    rms[f] = Math.sqrt(s / win);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const peak = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const thr = Math.max(0.01, floor * 2.5, peak * 0.12);
  const on = Array.from(rms, v => v > thr);
  // merge short gaps (< 0.4 s), then drop very short blips (< 0.15 s)
  const iv = [];
  let s = -1;
  for (let f = 0; f <= frames; f++) {
    if (f < frames && on[f]) { if (s < 0) s = f; }
    else if (s >= 0) { iv.push([s * 0.05, f * 0.05]); s = -1; }
  }
  const merged = [];
  iv.forEach(x => {
    const l = merged[merged.length - 1];
    if (l && x[0] - l[1] < 0.4) l[1] = x[1]; else merged.push([x[0], x[1]]);
  });
  return merged.filter(x => x[1] - x[0] >= 0.15);
}
function speechOf(it) {
  if (!it.blob) return null;
  let r = SPEECH.get(it.mkey);
  if (!r) {
    r = { iv: null, p: null };
    r.p = detectSpeech(it.blob).then(iv => { r.iv = iv; }).catch(() => { r.iv = []; }).then(() => {
      speechVer++;
      if (window.render && !S.exporting) render(true);
    });
    SPEECH.set(it.mkey, r);
  }
  return r;
}
let duckCache = { key: '', iv: [] };
function duckSources() {
  const out = [];
  S.audio.forEach(a => { if (a.voice) out.push({ it: a, tl: s => a.start + (s - a.in), lo: a.in, hi: a.out }); });
  if (S.duck.video) S.clips.forEach(c => { if (c.type === 'video' && c.vol > 0 && c.blob && !isSpecial(c)) out.push({ it: c, tl: s => c.start + (s - c.in) / c.speed, lo: c.in, hi: c.out }); });
  return out;
}
function duckIntervals() {
  const srcs = duckSources();
  const key = speechVer + '|' + srcs.map(s => [s.it.id, s.it.mkey, s.it.start, s.it.in, s.it.out, s.it.speed || 1].join(',')).join(';');
  if (key === duckCache.key) return duckCache.iv;
  const all = [];
  srcs.forEach(s => {
    const r = speechOf(s.it);
    if (!r || !r.iv) return;
    r.iv.forEach(([a, b]) => {
      const lo = Math.max(a, s.lo), hi = Math.min(b, s.hi);
      if (hi > lo) all.push([s.tl(lo), s.tl(hi)]);
    });
  });
  all.sort((x, y) => x[0] - y[0]);
  const merged = [];
  all.forEach(x => {
    const l = merged[merged.length - 1];
    if (l && x[0] - l[1] < 0.3) l[1] = Math.max(l[1], x[1]); else merged.push([x[0], x[1]]);
  });
  duckCache = { key, iv: merged };
  return merged;
}
const ATT = 0.18, REL = 0.6;       // seconds to fade the music down before speech / back up after it
function duckF(t) {
  if (!S.duck.amt) return 1;
  const iv = duckIntervals();
  let depth = 0;
  for (let i = 0; i < iv.length; i++) {
    const s = iv[i][0], e = iv[i][1];
    if (t < s - ATT) break;
    if (t > e + REL) continue;
    const d = t < s ? 1 - (s - t) / ATT : t <= e ? 1 : 1 - (t - e) / REL;
    if (d > depth) depth = d;
  }
  depth = depth * depth * (3 - 2 * depth);
  return 1 - (S.duck.amt / 100) * depth;
}
async function prepareDucking() {
  if (!S.audio.some(a => a.duck)) return;
  await Promise.all(duckSources().map(s => speechOf(s.it)).filter(Boolean).map(r => r.p));
  duckIntervals();
}

/* =====================  Voice-over recording  ===================== */
let VO = null;
const fmtT = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

async function startVO() {
  if (VO) return stopVO();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return toast('Recording is not supported on this browser');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { return toast(e && e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser settings.' : 'No microphone found'); }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  let mr;
  try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { stream.getTracks().forEach(t => t.stop()); return toast('Could not start the recorder'); }
  const chunks = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  VO = { mr, stream, chunks, at: S.t, t0: performance.now(), timer: null, play: $('aRecPlay').checked && S.total > 0 };
  mr.onstop = () => finishVO(mime);
  mr.start(250);
  if (VO.play) play();
  $('aRec').textContent = '■ Stop recording';
  $('aRec').classList.add('rec');
  VO.timer = setInterval(() => {
    if (!VO) return;
    $('aRecInfo').textContent = 'Recording… ' + fmtT((performance.now() - VO.t0) / 1000);
    if (VO.play && !S.playing && S.t >= S.total - 0.05) stopVO();    // reached the end of the video
  }, 200);
}
function stopVO() {
  if (!VO) return;
  clearInterval(VO.timer);
  try { if (VO.mr.state !== 'inactive') VO.mr.stop(); } catch (e) { }
  VO.stream.getTracks().forEach(t => t.stop());
  pause();
}
async function finishVO(mime) {
  const v = VO;
  VO = null;
  $('aRec').textContent = '● Record voice-over';
  $('aRec').classList.remove('rec');
  $('aRecInfo').textContent = '';
  if (!v) return;
  const raw = new Blob(v.chunks, { type: mime || v.mr.mimeType || 'audio/webm' });
  if (raw.size < 800) return toast('Nothing was recorded');
  setBusy('Saving recording…', 0.4);
  try {
    // MediaRecorder files have no length and cannot be sought reliably, so store a clean WAV instead
    const buf = await decodeBlob(raw, 44100);
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
    const n = S.audio.filter(a => /^Voice-over/.test(a.name)).length + 1;
    const file = new File([wavBlob([mono], 44100)], 'Voice-over ' + n + '.wav', { type: 'audio/wav' });
    await addAudio([file]);
    const a = S.audio[S.audio.length - 1];
    if (a) { a.start = +v.at.toFixed(2); a.vol = 100; a.voice = true; S.asel = a.id; }
    compute(); refreshAll(); markDirty();
    toast('Voice-over added at ' + fmtT(v.at));
  } catch (e) { toast('Could not save the recording'); }
  clearBusy();
}
$('aRec').onclick = startVO;

/* =====================  Beat detection  ===================== */
async function detectBeats(blob) {
  const sr = 22050, buf = await decodeBlob(blob, sr);
  const n = buf.length, ch = buf.numberOfChannels, hop = 256, win = 512;
  const frames = Math.floor((n - win) / hop);
  if (frames < 200) throw new Error('This track is too short to find a beat');
  const d = []; for (let c = 0; c < ch; c++) d.push(buf.getChannelData(c));
  const en = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0, prev = 0;
    for (let i = f * hop; i < f * hop + win; i++) {
      let v = 0; for (let c = 0; c < ch; c++) v += d[c][i]; v /= ch;
      const e = v - 0.97 * prev; prev = v;           // pre-emphasis: favour sharp attacks
      s += e * e;
    }
    en[f] = Math.log(1 + 1000 * s / win);
  }
  const env = new Float32Array(frames);
  for (let f = 1; f < frames; f++) env[f] = Math.max(0, en[f] - en[f - 1]);
  // remove the local average so only real onsets remain
  const m = Math.round(0.5 * sr / hop), cs = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) cs[f + 1] = cs[f] + env[f];
  const on = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { const a = Math.max(0, f - m), b = Math.min(frames, f + m); on[f] = Math.max(0, env[f] - (cs[b] - cs[a]) / (b - a)); }
  const hopS = hop / sr;
  // tempo: autocorrelation of the onset curve between 60 and 180 BPM, with a mild preference for ~120
  const lmin = Math.round(60 / 180 / hopS), lmax = Math.round(60 / 60 / hopS);
  let best = -1, bestL = lmin;
  const ac = [];
  for (let L = lmin; L <= lmax + 1; L++) {
    let s = 0;
    for (let i = 0; i + L < frames; i++) s += on[i] * on[i + L];
    ac[L] = s / (frames - L);
  }
  for (let L = lmin; L <= lmax; L++) {
    const bpm = 60 / (L * hopS), w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const sc = ac[L] * w + 0.5 * (ac[2 * L] || 0) * w * 0.5;
    if (sc > best) { best = sc; bestL = L; }
  }
  // refine to a fractional lag
  const a0 = ac[bestL - 1] || 0, a1 = ac[bestL], a2 = ac[bestL + 1] || 0;
  const den = a0 - 2 * a1 + a2;
  const Lf = bestL + (den < 0 ? 0.5 * (a0 - a2) / den : 0);
  // joint refinement of period and phase: slide a regular grid over the onset curve and keep the best fit
  const near = x => { const i = Math.round(x); return Math.max(on[i] || 0, 0.6 * Math.max(on[i - 1] || 0, on[i + 1] || 0)); };
  let bestP = Lf, bestO = 0, bo = -1;
  for (let L = Lf * 0.985; L <= Lf * 1.015; L += Lf * 0.0005) {
    for (let o = 0; o < L; o += 0.5) {
      let sc = 0;
      for (let k = 0; o + k * L < frames; k++) sc += near(o + k * L);
      if (sc > bo) { bo = sc; bestP = L; bestO = o; }
    }
  }
  const beats = [];
  for (let k = 0; bestO + k * bestP < frames; k++) beats.push(+((bestO + k * bestP) * hopS + win * 0.7 / sr).toFixed(3));   // the energy window starts before the attack it detects
  return { beats, bpm: 60 / (bestP * hopS) };
}
const beatTimes = a => (a.beats || []).filter(b => b >= a.in && b <= a.out).map(b => a.start + (b - a.in));
function drawBeats(g, a, x, y, h) {
  if (!a.beats || !a.beats.length) return;
  g.save();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
  g.beginPath();
  beatTimes(a).forEach(t => { const px = Math.round(PAD + t * pps) + 0.5; g.moveTo(px, y); g.lineTo(px, y + h); });
  g.stroke();
  g.restore();
}
const allBeats = () => S.audio.flatMap(beatTimes).sort((p, q) => p - q);

$('aBeats').onclick = async () => {
  const a = selAudio();
  if (!a) return toast('Select a music track first');
  setBusy('Listening for the beat…', 0.3);
  await sleep(30);
  try {
    const r = await detectBeats(a.blob);
    touch('beats' + nid());
    a.beats = r.beats; a.bpm = +r.bpm.toFixed(1);
    markDirty(); refreshAll();
    toast(`Found ${r.beats.length} beats (about ${Math.round(r.bpm)} BPM)`);
  } catch (e) { toast(e.message || 'Could not find the beat'); }
  clearBusy();
};
$('aBeatClear').onclick = () => {
  const a = selAudio();
  if (!a || !a.beats) return;
  touch('beatclr' + nid());
  a.beats = null; a.bpm = null;
  markDirty(); refreshAll();
};
$('aPrevBeat').onclick = () => {
  const bs = allBeats().filter(b => b < S.t - 0.02);
  if (!bs.length) return toast('No earlier beat');
  seek(bs[bs.length - 1]);
};
$('aNextBeat').onclick = () => {
  const b = allBeats().find(b => b > S.t + 0.02);
  if (b === undefined) return toast('No later beat');
  seek(b);
};
$('aBeatSplit').onclick = () => {
  const c = selClip();
  if (!c || c.type !== 'video') return toast('Select a video clip on the timeline first');
  const every = +$('aBeatEvery').value, bs = allBeats();
  if (!bs.length) return toast('Find beats in a music track first');
  const inside = bs.filter(b => b > c.start + 0.25 && b < c.end - 0.25);
  const cuts = inside.filter((b, i) => i % every === 0);
  if (!cuts.length) return toast('No beats inside this clip');
  if (cuts.length > 80) return toast('That would make ' + cuts.length + ' pieces. Choose "every 2 or 4 beats".');
  const keepT = S.t, before = U.length;
  cuts.forEach(t => { S.t = t; $('bSplit').onclick(); });
  U.length = Math.min(U.length, before + 1);          // the whole thing counts as one undo step
  S.t = clamp(keepT, 0, S.total);
  refreshAll();
  toast('Cut into ' + (cuts.length + 1) + ' pieces on the beat');
};

/* =====================  Panel  ===================== */
function refreshVoice() {
  const a = selAudio();
  if ($('aVoice')) {
    $('aVoice').checked = !!(a && a.voice);
    $('aDuck').checked = !!(a && a.duck);
    $('aBeatInfo').textContent = a && a.beats ? `${a.beats.length} beats · about ${Math.round(a.bpm || 0)} BPM. Beat lines show on the track.` : 'Select a music track and tap “Find beats”.';
  }
  setR('dAmt', S.duck.amt);
  $('dVid').checked = !!S.duck.video;
}
const onAudio = (key, fn) => e => { const a = selAudio(); if (!a) return; touch(key + nid()); fn(a, e); markDirty(); drawTimeline(); };
$('aVoice').onchange = onAudio('avoice', (a, e) => { a.voice = e.target.checked; if (a.voice) a.duck = false; refreshVoice(); });
$('aDuck').onchange = onAudio('aduck', (a, e) => { a.duck = e.target.checked; if (a.duck) a.voice = false; refreshVoice(); });
$('dAmt').oninput = e => { touch('damt'); S.duck.amt = +e.target.value; markDirty(); };
$('dVid').onchange = e => { touch('dvid' + nid()); S.duck.video = e.target.checked; markDirty(); };
refreshVoice();
