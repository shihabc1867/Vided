'use strict';
/* =====================================================================
   Vided — Phase 2
   Multi-clip timeline, transitions, keyframe animation, motion-graphics
   text templates, multi-track audio, undo/redo, real-time export.
   Everything runs in the browser; nothing is uploaded anywhere.
   ===================================================================== */

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = p => p * p * (3 - 2 * p);
const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let uid = 1;
const nid = () => uid++;
const FONT = 'Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 2600);
}

function markDirty() { if (typeof storeDirty === 'function') storeDirty(); }

/* ---------- state ---------- */
const S = {
  clips: [], texts: [], audio: [],
  sel: -1, tsel: -1, asel: -1,
  t: 0, total: 0,
  playing: false, exporting: false, fast: false,
  bg: '#000000', letterbox: false, vignette: false,
  ratio: '9:16', prev: 540
};
const cv = $('cv'), ctx = cv.getContext('2d');
const stage = $('stage');

const PRESETS = {
  '': '',
  bw: 'grayscale(1)',
  noir: 'grayscale(1) contrast(1.4) brightness(.9)',
  sepia: 'sepia(.9)',
  vintage: 'sepia(.5) contrast(.9) brightness(1.1) saturate(.8)',
  warm: 'sepia(.35) saturate(1.4) hue-rotate(-10deg)',
  cool: 'hue-rotate(15deg) saturate(1.2) brightness(1.05)',
  vivid: 'contrast(1.2) saturate(1.6)'
};
const defFilter = () => ({ preset: '', b: 100, c: 100, s: 100, h: 0, bl: 0 });

const selClip = () => S.clips.find(c => c.id === S.sel) || null;
const selText = () => S.texts.find(t => t.id === S.tsel) || null;
const selAudio = () => S.audio.find(a => a.id === S.asel) || null;
const len = c => (c.out - c.in) / c.speed;

/* ---------- slider fields (built from data-* attributes) ---------- */
document.querySelectorAll('.field').forEach(f => {
  const d = f.dataset;
  f.innerHTML = `<label><span>${d.label}</span><b id="v-${d.id}"></b></label>` +
    `<input type="range" id="${d.id}" min="${d.min}" max="${d.max}" step="${d.step}" value="${d.val}">`;
  const inp = f.querySelector('input');
  inp.dataset.unit = d.unit;
  inp.addEventListener('input', () => showVal(inp));
  showVal(inp);
});
function showVal(inp) {
  const step = +inp.step;
  const v = +inp.value;
  const txt = step >= 1 ? Math.round(v) : v.toFixed(step < 0.1 ? 2 : 1);
  $('v-' + inp.id).textContent = txt + (inp.dataset.unit || '');
}
function setR(id, val, min, max) {
  const el = $(id);
  if (min !== undefined) el.min = min;
  if (max !== undefined) el.max = max;
  el.value = val;
  showVal(el);
}

/* ---------- undo / redo ---------- */
const U = [], R = [];
let lastKey = '', lastTouch = 0;
function cloneClip(c) { return { ...c, tr: { ...c.tr }, f: { ...c.f }, kf: c.kf.map(k => ({ ...k })) }; }
function snap() {
  return {
    clips: S.clips.map(cloneClip),
    texts: S.texts.map(t => ({ ...t })),
    audio: S.audio.map(a => ({ ...a })),
    sel: S.sel, tsel: S.tsel, asel: S.asel
  };
}
function restore(s) {
  pauseAllMedia();
  S.clips = s.clips.map(cloneClip);
  S.texts = s.texts.map(t => ({ ...t }));
  S.audio = s.audio.map(a => ({ ...a }));
  S.sel = s.sel; S.tsel = s.tsel; S.asel = s.asel;
  compute();
  S.t = clamp(S.t, 0, S.total);
  refreshAll();
  markDirty();
}
// Call BEFORE a change. Same key within 0.9s = one undo step (slider drags).
function touch(key) {
  const now = Date.now();
  if (key === lastKey && now - lastTouch < 900) { lastTouch = now; return; }
  lastKey = key; lastTouch = now;
  U.push(snap());
  if (U.length > 40) U.shift();
  R.length = 0;
  updUR();
  markDirty();
}
function undo() {
  if (!U.length || S.exporting) return;
  R.push(snap());
  restore(U.pop());
  lastKey = '';
  updUR();
}
function redo() {
  if (!R.length || S.exporting) return;
  U.push(snap());
  restore(R.pop());
  lastKey = '';
  updUR();
}
function updUR() { $('undo').disabled = !U.length; $('redo').disabled = !R.length; }

/* ---------- timeline layout ---------- */
function compute() {
  let end = 0;
  S.clips.forEach((c, i) => {
    const L = len(c);
    let ov = 0;
    if (i > 0 && c.tr.type !== 'none') ov = Math.min(c.tr.dur, 0.45 * len(S.clips[i - 1]), 0.45 * L);
    c.ov = ov;
    c.start = i === 0 ? 0 : end - ov;
    c.end = c.start + L;
    end = c.end;
  });
  S.total = end;
  $('scrub').max = end;
}

/* ---------- keyframes / transform ---------- */
const PK = ['sc', 'px', 'py', 'rot', 'op'];
function pickP(o) { return { sc: o.sc, px: o.px, py: o.py, rot: o.rot, op: o.op }; }
function evalProps(c, lt) {
  const k = c.kf;
  if (!k.length) return pickP(c);
  if (lt <= k[0].t) return pickP(k[0]);
  if (lt >= k[k.length - 1].t) return pickP(k[k.length - 1]);
  for (let i = 0; i < k.length - 1; i++) {
    if (lt < k[i + 1].t) {
      const a = k[i], b = k[i + 1], p = ease((lt - a.t) / (b.t - a.t));
      const o = {};
      PK.forEach(key => { o[key] = a[key] + (b[key] - a[key]) * p; });
      return o;
    }
  }
  return pickP(k[k.length - 1]);
}
function upsertKf(c, t, vals) {
  const ex = c.kf.find(k => Math.abs(k.t - t) < 0.05);
  if (ex) Object.assign(ex, pickP(vals));
  else { c.kf.push({ t, ...pickP(vals) }); c.kf.sort((a, b) => a.t - b.t); }
}
function applyProps(c, obj) {
  if (c.kf.length) {
    const lt = clamp(S.t - c.start, 0, len(c));
    upsertKf(c, lt, { ...evalProps(c, lt), ...obj });
  } else Object.assign(c, obj);
}

/* ---------- audio graph ---------- */
let AC = null, dest = null, master = null;
function initAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  dest = AC.createMediaStreamDestination();
  master = AC.createGain();
  master.connect(dest);
  master.connect(AC.destination);
  S.clips.forEach(wire);
  S.audio.forEach(wire);
}
function wire(it) {
  if (!AC || it.src || it.type === 'image') return;
  it.src = AC.createMediaElementSource(it.el);
  it.gain = AC.createGain();
  it.src.connect(it.gain);
  it.gain.connect(master);
}
function setGain(it, v) {
  if (!it.gain) return;
  try { it.gain.gain.setTargetAtTime(v, AC.currentTime, 0.015); } catch (e) { it.gain.gain.value = v; }
}
function pauseAllMedia() {
  S.clips.forEach(c => { if (c.type === 'video' && !c.el.paused) c.el.pause(); });
  S.audio.forEach(a => { if (!a.el.paused) a.el.pause(); });
}

/* ---------- loading media ---------- */
function loadVideoEl(file) {
  return new Promise((res, rej) => {
    const el = document.createElement('video');
    el.playsInline = true;
    el.preload = 'auto';
    el.src = URL.createObjectURL(file);
    el.onerror = () => rej(new Error('Cannot open ' + (file.name || 'video')));
    el.onloadedmetadata = () => {
      const done = () => {
        if (!el.videoWidth) return rej(new Error('Unsupported video: ' + (file.name || 'video')));
        res(el);
      };
      // Browser-recorded WebM files report an infinite duration until seeked to the end.
      if (el.duration === Infinity || isNaN(el.duration)) {
        el.ontimeupdate = () => { el.ontimeupdate = null; el.currentTime = 0; done(); };
        el.currentTime = 1e7;
      } else done();
    };
  });
}
function thumbOf(src, w, h) {
  const t = document.createElement('canvas');
  t.width = 96; t.height = 54;
  const x = t.getContext('2d');
  const r = Math.max(96 / w, 54 / h);
  try { x.drawImage(src, (96 - w * r) / 2, (54 - h * r) / 2, w * r, h * r); } catch (e) { }
  return t;
}
async function mediaFromBlob(blob, name) {
  if ((blob.type || '').startsWith('image/')) {
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode().catch(() => { throw new Error('Cannot open ' + name); });
    return { type: 'image', el: img, dur: 30, thumb: thumbOf(img, img.naturalWidth, img.naturalHeight) };
  }
  const el = await loadVideoEl(blob);
  await new Promise(r => {
    el.addEventListener('seeked', function f() { el.removeEventListener('seeked', f); r(); });
    el.currentTime = Math.min(0.1, el.duration / 2);
    setTimeout(r, 1500);
  });
  return { type: 'video', el, dur: el.duration, thumb: thumbOf(el, el.videoWidth, el.videoHeight) };
}
async function makeClip(file) {
  const m = await mediaFromBlob(file, file.name);
  return {
    id: nid(), name: file.name, type: m.type, el: m.el, dur: m.dur, thumb: m.thumb,
    blob: file, mkey: 'm' + nid(),
    in: 0, out: m.type === 'image' ? 4 : m.dur, speed: 1, vol: 100,
    tr: { type: 'none', dur: 0.5 }, f: defFilter(), fit: 'contain',
    sc: 100, px: 0, py: 0, rot: 0, op: 100, kf: [],
    start: 0, end: 0, ov: 0, src: null, gain: null
  };
}
async function addMedia(files) {
  let n = 0;
  for (const f of files) {
    try {
      touch('add' + nid());
      const c = await makeClip(f);
      S.clips.push(c);
      wire(c);
      compute();
      S.sel = c.id;
      n++;
    } catch (e) { toast(e.message); U.pop(); }
  }
  if (n) { refreshAll(); }
}
async function addAudio(files) {
  for (const f of files) {
    try {
      touch('addA' + nid());
      const el = new Audio();
      el.preload = 'auto';
      el.src = URL.createObjectURL(f);
      await new Promise((res, rej) => {
        el.onloadedmetadata = () => res();
        el.onerror = () => rej(new Error('Cannot open ' + f.name));
      });
      const a = { id: nid(), type: 'audio', name: f.name, blob: f, mkey: 'm' + nid(), el, dur: isFinite(el.duration) ? el.duration : 600, start: 0, vol: 80, src: null, gain: null };
      S.audio.push(a);
      wire(a);
      S.asel = a.id;
    } catch (e) { toast(e.message); U.pop(); }
  }
  refreshAll();
}

/* ---------- per-frame state: which clips show, and how ---------- */
function transFx(fx, type, p, role) {
  const W = cv.width, e = ease(p);
  const inn = role === 'in';
  switch (type) {
    case 'fade':
      if (inn) { fx.alpha *= e; fx.au *= e; } else fx.au *= 1 - e;
      break;
    case 'dip': {
      const a = inn ? clamp(2 * e - 1, 0, 1) : clamp(1 - 2 * e, 0, 1);
      fx.alpha *= a; fx.au *= a;
      break;
    }
    case 'slideL':
      if (inn) { fx.dx += (1 - e) * W; fx.au *= e; } else { fx.dx -= e * W; fx.au *= 1 - e; }
      break;
    case 'slideR':
      if (inn) { fx.dx -= (1 - e) * W; fx.au *= e; } else { fx.dx += e * W; fx.au *= 1 - e; }
      break;
    case 'zoom':
      if (inn) { fx.alpha *= e; fx.scale *= 1.3 - 0.3 * e; fx.au *= e; } else { fx.scale *= 1 + 0.3 * e; fx.au *= 1 - e; }
      break;
    case 'wipe':
      if (inn) { fx.clip = e; fx.au *= e; } else fx.au *= 1 - e;
      break;
  }
}
function frameState(t) {
  const out = [];
  S.clips.forEach((c, i) => {
    if (!(t >= c.start && t < c.end)) return;
    const fx = { alpha: 1, dx: 0, scale: 1, clip: null, au: 1 };
    const next = S.clips[i + 1];
    if (c.ov > 0 && t < c.start + c.ov) transFx(fx, c.tr.type, (t - c.start) / c.ov, 'in');
    else if (i === 0 && c.tr.type !== 'none' && t < c.start + c.tr.dur) {
      const p = ease(clamp((t - c.start) / c.tr.dur, 0, 1));
      fx.alpha *= p; fx.au *= p;
    }
    if (next && next.ov > 0 && t >= next.start) transFx(fx, next.tr.type, (t - next.start) / next.ov, 'out');
    out.push({ c, fx });
  });
  return out;
}

// Seek a <video> and wait until the frame is ready (used when exporting frame by frame).
function seekEl(el, target) {
  return new Promise(res => {
    if (!el.seeking && Math.abs(el.currentTime - target) < 0.0005 && el.readyState >= 2) return res();
    let done = false;
    const fin = () => { if (done) return; done = true; el.removeEventListener('seeked', fin); clearTimeout(tm); res(); };
    const tm = setTimeout(fin, 2000);
    el.addEventListener('seeked', fin);
    if (!el.paused) el.pause();
    el.currentTime = target;
  });
}

/* ---------- keep <video>/<audio> elements in sync with the playhead ---------- */
function syncMedia(t, st) {
  const fxOf = new Map(st.map(s => [s.c.id, s.fx]));
  S.clips.forEach(c => {
    if (c.type !== 'video') return;
    const fx = fxOf.get(c.id);
    const el = c.el;
    if (fx) {
      const target = clamp(c.in + (t - c.start) * c.speed, 0, Math.max(0, c.dur - 0.02));
      const rate = clamp(c.speed, 0.25, 4);
      if (el.playbackRate !== rate) el.playbackRate = rate;
      if (S.playing) {
        if (el.paused) { el.currentTime = target; el.play().catch(() => { }); }
        else if (Math.abs(el.currentTime - target) > 0.4) el.currentTime = target;
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
      }
      setGain(c, S.playing ? (c.vol / 100) * fx.au : 0);
    } else {
      if (!el.paused) el.pause();
      setGain(c, 0);
      // Warm up the first frame of a clip that is about to start.
      if (c.start > t && c.start - t < 1.2 && !el.seeking && Math.abs(el.currentTime - c.in) > 0.1) el.currentTime = c.in;
    }
  });
  S.audio.forEach(a => {
    const active = t >= a.start && t < a.start + a.dur;
    const el = a.el;
    if (active && S.playing) {
      const target = t - a.start;
      if (el.paused) { el.currentTime = target; el.play().catch(() => { }); }
      else if (Math.abs(el.currentTime - target) > 0.4) el.currentTime = target;
      setGain(a, a.vol / 100);
    } else {
      if (!el.paused) el.pause();
      setGain(a, 0);
    }
  });
}

/* ---------- drawing ---------- */
function filterOf(f, F) {
  const p = [];
  if (f.b !== 100) p.push(`brightness(${f.b}%)`);
  if (f.c !== 100) p.push(`contrast(${f.c}%)`);
  if (f.s !== 100) p.push(`saturate(${f.s}%)`);
  if (f.h) p.push(`hue-rotate(${f.h}deg)`);
  if (f.bl) p.push(`blur(${(f.bl * F).toFixed(1)}px)`);
  if (f.preset) p.push(PRESETS[f.preset]);
  return p.length ? p.join(' ') : 'none';
}
function drawClip(c, t, fx) {
  const W = cv.width, H = cv.height, F = Math.min(W, H) / 720;
  const p = evalProps(c, t - c.start);
  const fr = S.exporting ? c.exFrame : null; // frame from the fast exporter's decoder
  let el = c.el, sw, sh, rw, rh, rot = 0;
  if (fr) {
    rot = c.fs ? c.fs.rot : 0;
    rw = fr.displayWidth; rh = fr.displayHeight;
    sw = rot % 180 ? rh : rw; sh = rot % 180 ? rw : rh;
    el = fr;
  } else {
    sw = rw = c.type === 'video' ? el.videoWidth : el.naturalWidth;
    sh = rh = c.type === 'video' ? el.videoHeight : el.naturalHeight;
  }
  if (!sw || !sh) return;
  const base = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const s = base * (p.sc / 100) * fx.scale;
  ctx.save();
  if (fx.clip !== null) { ctx.beginPath(); ctx.rect(0, 0, W * fx.clip, H); ctx.clip(); }
  ctx.globalAlpha = clamp(fx.alpha * p.op / 100, 0, 1);
  ctx.translate(W / 2 + p.px / 100 * W + fx.dx, H / 2 + p.py / 100 * H);
  ctx.rotate(p.rot * Math.PI / 180);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  ctx.filter = filterOf(c.f, F);
  try { ctx.drawImage(el, -rw * s / 2, -rh * s / 2, rw * s, rh * s); } catch (e) { }
  ctx.restore();
}
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawText(L, t) {
  const W = cv.width, H = cv.height, F = Math.min(W, H) / 720;
  const vis = t >= L.from && t <= L.to;
  const ghost = !vis && L.id === S.tsel && !S.playing && !S.exporting;
  if (!vis && !ghost) { L._box = null; return; }
  const lt = t - L.from, d = Math.max(0.1, L.to - L.from);
  const pin = ghost ? 1 : clamp(lt / 0.45, 0, 1);
  const pout = ghost ? 1 : clamp((L.to - t) / 0.3, 0, 1);
  let a = ghost ? 0.4 : 1, dx = 0, dy = 0, sc = 1, str = L.text;
  switch (L.anim) {
    case 'fade': a *= Math.min(pin, pout); break;
    case 'up': a *= Math.min(pin, pout); dy = (1 - ease(pin)) * 70 * F; break;
    case 'left': dx = -(1 - ease(pin)) * 320 * F; a *= pout; break;
    case 'pop': sc = Math.max(0.01, easeOutBack(pin)); a *= pout; break;
    case 'type': {
      const dur = Math.max(0.3, Math.min(2.5, d * 0.6));
      str = L.text.slice(0, Math.ceil(L.text.length * clamp(lt / dur, 0, 1)));
      a *= pout;
      break;
    }
  }
  const px = L.size * F;
  ctx.save();
  ctx.font = `${L.bold ? 800 : 500} ${px}px ${FONT}`;
  const w = ctx.measureText(L.text || ' ').width;
  const pad = L.bgOn ? px * 0.35 : 0;
  const cx0 = L.x * W + dx, cy0 = L.y * H + dy;
  L._box = { x: cx0 - w / 2 - pad - 12 * F, y: cy0 - px / 2 - pad - 12 * F, w: w + pad * 2 + 24 * F, h: px + pad * 2 + 24 * F };
  ctx.globalAlpha = a;
  ctx.translate(cx0, cy0);
  ctx.scale(sc, sc);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  if (L.bgOn) {
    ctx.fillStyle = L.bg;
    rr(-w / 2 - pad, -px / 2 - pad * 0.6, w + pad * 2, px + pad * 1.2, px * 0.25);
    ctx.fill();
  } else {
    ctx.lineWidth = px / 8;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.strokeText(str, -w / 2, 0);
  }
  ctx.fillStyle = L.color;
  ctx.fillText(str, -w / 2, 0);
  if (L.id === S.tsel && !S.playing && !S.exporting) {
    ctx.globalAlpha = 1;
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#7a5cff';
    ctx.strokeRect(-w / 2 - pad - 8, -px / 2 - pad - 8, w + pad * 2 + 16, px + pad * 2 + 16);
  }
  ctx.restore();
}
function render(noSync) {
  const W = cv.width, H = cv.height;
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = S.bg;
  ctx.fillRect(0, 0, W, H);
  const t = S.total > 0 ? Math.min(S.t, S.total - 0.001) : 0;
  const st = frameState(t);
  if (!noSync) syncMedia(t, st);
  st.forEach(({ c, fx }) => drawClip(c, t, fx));
  if (S.vignette) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.65)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  if (S.letterbox) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H * 0.12);
    ctx.fillRect(0, H * 0.88, W, H * 0.12);
  }
  S.texts.forEach(L => drawText(L, t));
}

/* ---------- canvas size ---------- */
function setSize(short) {
  const r = S.ratio;
  let w, h;
  if (r === '9:16') { w = short; h = Math.round(short * 16 / 9); }
  else if (r === '16:9') { h = short; w = Math.round(short * 16 / 9); }
  else if (r === '1:1') { w = h = short; }
  else { w = short; h = Math.round(short * 5 / 4); }
  cv.width = w & ~1;
  cv.height = h & ~1;
  fitCanvas();
}
function fitCanvas() {
  const aw = stage.clientWidth, ah = stage.clientHeight;
  if (!aw || !ah) return;
  const k = Math.min(aw / cv.width, ah / cv.height);
  cv.style.width = Math.floor(cv.width * k) + 'px';
  cv.style.height = Math.floor(cv.height * k) + 'px';
}

/* ---------- playback ---------- */
async function play() {
  if (!S.clips.length) return toast('Add a clip first');
  initAudio();
  await AC.resume();
  if (S.t >= S.total - 0.05) S.t = 0;
  S.playing = true;
  $('play').innerHTML = '&#9208;';
}
function pause() {
  S.playing = false;
  $('play').innerHTML = '&#9654;';
}
function seek(t) {
  S.t = clamp(t, 0, S.total);
  refreshAnim();
  updateTime();
  drawTimeline();
}
$('play').onclick = () => (S.playing ? pause() : play());
$('toStart').onclick = () => seek(0);
$('toEnd').onclick = () => { pause(); seek(S.total); };
$('scrub').oninput = e => seek(+e.target.value);

let lastNow = performance.now(), lastDraw = 0, lastTl = 0;
function loop(now) {
  const dt = Math.min(0.25, (now - lastNow) / 1000);
  lastNow = now;
  if (S.playing) {
    S.t += dt;
    if (S.t >= S.total) {
      S.t = S.total;
      if (S.exporting) finishExport(); else pause();
    }
  }
  if (!S.fast && (S.playing || now - lastDraw > 120)) { render(); lastDraw = now; }
  if (S.playing && now - lastTl > 90) {
    updateTime();
    drawTimeline();
    lastTl = now;
    if (S.exporting) $('busyProg').value = S.total ? S.t / S.total : 0;
  }
  requestAnimationFrame(loop);
}

function updateTime() {
  $('time').textContent = fmt(S.t) + ' / ' + fmt(S.total);
  $('scrub').value = S.t;
}

/* ---------- timeline canvas ---------- */
const tl = $('tl'), tx = tl.getContext('2d'), wrap = $('tlwrap');
let hits = [], pps = 60;
const PAD = 14, RULER = 22, VH = 52;
function lanesOf(items, gs, ge) {
  const ends = [];
  return items.map(it => {
    let l = ends.findIndex(e => e <= gs(it) + 1e-6);
    if (l < 0) { l = ends.length; ends.push(0); }
    ends[l] = ge(it);
    return l;
  });
}
function drawTimeline() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const tLanes = lanesOf(S.texts, L => L.from, L => L.to);
  const aLanes = lanesOf(S.audio, a => a.start, a => a.start + a.dur);
  const nT = tLanes.length ? Math.max(...tLanes) + 1 : 0;
  const nA = aLanes.length ? Math.max(...aLanes) + 1 : 0;
  const yT = RULER + 4 + VH + 6;
  const yA = yT + nT * 16 + (nT ? 4 : 0);
  const Hpx = yA + nA * 16 + 10;
  const Wpx = Math.max(wrap.clientWidth, Math.ceil(S.total * pps) + PAD * 2 + 80);
  if (tl.width !== Math.round(Wpx * dpr) || tl.height !== Math.round(Hpx * dpr)) {
    tl.width = Math.round(Wpx * dpr);
    tl.height = Math.round(Hpx * dpr);
    tl.style.width = Wpx + 'px';
    tl.style.height = Hpx + 'px';
  }
  tx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tx.clearRect(0, 0, Wpx, Hpx);
  hits = [];

  // ruler
  const step = pps >= 120 ? 1 : pps >= 50 ? 2 : pps >= 30 ? 5 : 10;
  tx.font = '10px system-ui,sans-serif';
  tx.textBaseline = 'top';
  tx.fillStyle = '#7d7d92';
  tx.strokeStyle = '#2f2f40';
  tx.lineWidth = 1;
  for (let s = 0; PAD + s * pps < Wpx; s += step) {
    const x = Math.round(PAD + s * pps) + 0.5;
    tx.beginPath(); tx.moveTo(x, 12); tx.lineTo(x, RULER); tx.stroke();
    tx.fillText(fmt(s).replace('.0', ''), x + 3, 2);
  }

  // video clips
  S.clips.forEach((c, i) => {
    const x = PAD + c.start * pps, w = Math.max(4, (c.end - c.start) * pps), y = RULER + 4;
    tx.save();
    tx.beginPath(); tx.rect(x, y, w, VH); tx.clip();
    tx.fillStyle = c.type === 'image' ? '#3a2f55' : '#27324d';
    tx.fillRect(x, y, w, VH);
    if (c.thumb) {
      const tw = VH * 96 / 54;
      for (let tx0 = x; tx0 < x + w; tx0 += tw) tx.drawImage(c.thumb, tx0, y, tw, VH);
    }
    const g = tx.createLinearGradient(0, y + VH - 18, 0, y + VH);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.75)');
    tx.fillStyle = g; tx.fillRect(x, y + VH - 18, w, 18);
    tx.fillStyle = '#fff'; tx.font = '10px system-ui,sans-serif'; tx.textBaseline = 'alphabetic';
    tx.fillText((i + 1) + ' · ' + c.name + (c.speed !== 1 ? ' · ' + c.speed + 'x' : ''), x + 4, y + VH - 5);
    if (c.ov > 0) {
      tx.fillStyle = 'rgba(122,92,255,.55)';
      tx.fillRect(x, y, c.ov * pps, VH);
      tx.fillStyle = '#fff'; tx.fillText('◇', x + 2, y + 12);
    }
    if (c.kf.length) { tx.fillStyle = '#ffd166'; tx.fillText('◆'.repeat(Math.min(c.kf.length, 6)), x + 4, y + 12 + (c.ov > 0 ? 0 : 0)); }
    tx.restore();
    if (c.id === S.sel) { tx.strokeStyle = '#fff'; tx.lineWidth = 2; tx.strokeRect(x + 1, y + 1, w - 2, VH - 2); }
    hits.push({ x, y, w, h: VH, kind: 'clip', id: c.id });
  });

  // text layers
  S.texts.forEach((L, i) => {
    const x = PAD + L.from * pps, w = Math.max(6, (L.to - L.from) * pps), y = yT + tLanes[i] * 16;
    tx.fillStyle = '#8b5fd6';
    tx.fillRect(x, y, w, 14);
    tx.fillStyle = '#fff'; tx.font = '10px system-ui,sans-serif'; tx.textBaseline = 'middle';
    tx.save(); tx.beginPath(); tx.rect(x, y, w, 14); tx.clip();
    tx.fillText('T ' + L.text, x + 3, y + 7);
    tx.restore();
    if (L.id === S.tsel) { tx.strokeStyle = '#fff'; tx.lineWidth = 2; tx.strokeRect(x + 1, y + 1, w - 2, 12); }
    hits.push({ x, y, w, h: 14, kind: 'text', id: L.id });
  });

  // audio tracks
  S.audio.forEach((a, i) => {
    const x = PAD + a.start * pps, w = Math.max(6, a.dur * pps), y = yA + aLanes[i] * 16;
    tx.fillStyle = '#1f8a5b';
    tx.fillRect(x, y, w, 14);
    tx.fillStyle = '#fff'; tx.font = '10px system-ui,sans-serif'; tx.textBaseline = 'middle';
    tx.save(); tx.beginPath(); tx.rect(x, y, w, 14); tx.clip();
    tx.fillText('♪ ' + a.name, x + 3, y + 7);
    tx.restore();
    if (a.id === S.asel) { tx.strokeStyle = '#fff'; tx.lineWidth = 2; tx.strokeRect(x + 1, y + 1, w - 2, 12); }
    hits.push({ x, y, w, h: 14, kind: 'audio', id: a.id });
  });

  // playhead
  const px = PAD + S.t * pps;
  tx.strokeStyle = '#ff4d6d'; tx.fillStyle = '#ff4d6d'; tx.lineWidth = 2;
  tx.beginPath(); tx.moveTo(px, 0); tx.lineTo(px, Hpx); tx.stroke();
  tx.beginPath(); tx.moveTo(px - 5, 0); tx.lineTo(px + 5, 0); tx.lineTo(px, 8); tx.fill();

  // keep the playhead in view while playing
  if (S.playing) {
    if (px > wrap.scrollLeft + wrap.clientWidth - 30) wrap.scrollLeft = px - 40;
    else if (px < wrap.scrollLeft) wrap.scrollLeft = Math.max(0, px - 40);
  }
}
tl.addEventListener('click', e => {
  const r = tl.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let hit = null;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { hit = h; break; }
  }
  const time = clamp((x - PAD) / pps, 0, S.total);
  if (hit) {
    if (hit.kind === 'clip') { S.sel = hit.id; seek(time); }
    else if (hit.kind === 'text') { S.tsel = hit.id; openTab('text'); }
    else { S.asel = hit.id; openTab('audio'); }
    refreshAll();
  } else seek(time);
});
$('zoom').oninput = e => { pps = +e.target.value; drawTimeline(); };

/* ---------- Media tab ---------- */
$('addMedia').onchange = e => { addMedia([...e.target.files]); e.target.value = ''; };

function refreshMedia() {
  const c = selClip();
  $('n-media').classList.toggle('off', !c);
  if (!c) { $('selInfo').textContent = 'No clip selected. Tap a clip on the timeline.'; return; }
  const i = S.clips.indexOf(c);
  $('selInfo').textContent = `Clip ${i + 1} of ${S.clips.length} · ${c.name} · ${fmt(len(c))}`;
  const img = c.type === 'image';
  setR('trIn', c.in, 0, Math.max(0.1, (img ? 0 : c.dur - 0.1)));
  setR('trOut', c.out, 0.1, c.dur);
  $('trIn').disabled = img;
  $('spd').disabled = img;
  document.querySelector('[data-id="trOut"] label span').textContent = img ? 'Duration' : 'Trim end';
  setR('spd', Math.round(c.speed * 100));
  setR('cvol', c.vol);
  $('cvol').disabled = img;
  $('trType').value = c.tr.type;
  setR('trDur', c.tr.dur);
}
function afterTimingChange(c, jumpTo) {
  compute();
  if (!S.playing && jumpTo !== undefined) S.t = clamp(jumpTo, 0, S.total);
  refreshMedia(); refreshAnim(); updateTime(); drawTimeline();
}
$('trIn').oninput = e => {
  const c = selClip(); if (!c) return;
  touch('trIn');
  c.in = Math.min(+e.target.value, c.out - 0.1);
  afterTimingChange(c, c.start);
};
$('trOut').oninput = e => {
  const c = selClip(); if (!c) return;
  touch('trOut');
  c.out = Math.max(+e.target.value, c.in + 0.1);
  afterTimingChange(c, undefined);
  if (!S.playing) { S.t = clamp(c.end - 0.05, 0, S.total); updateTime(); drawTimeline(); }
};
$('spd').oninput = e => {
  const c = selClip(); if (!c || c.type === 'image') return;
  touch('spd');
  c.speed = (+e.target.value) / 100;
  afterTimingChange(c);
};
$('cvol').oninput = e => { const c = selClip(); if (!c) return; touch('cvol'); c.vol = +e.target.value; };
$('trType').onchange = e => {
  const c = selClip(); if (!c) return;
  touch('trType' + nid());
  c.tr.type = e.target.value;
  afterTimingChange(c);
};
$('trDur').oninput = e => {
  const c = selClip(); if (!c) return;
  touch('trDur');
  c.tr.dur = +e.target.value;
  afterTimingChange(c);
};

$('bSplit').onclick = () => {
  let c = selClip();
  const t = S.t;
  if (!c || !(t > c.start + 0.1 && t < c.end - 0.1)) {
    c = S.clips.find(k => t > k.start + 0.1 && t < k.end - 0.1) || null;
  }
  if (!c) return toast('Move the playhead inside a clip to split it');
  touch('split' + nid());
  const lt = t - c.start;
  const srcT = c.in + lt * c.speed;
  const b = dupClip(c);
  b.name = c.name;
  b.in = srcT;
  b.tr = { type: 'none', dur: 0.5 };
  if (c.kf.length) {
    const mid = evalProps(c, lt);
    b.kf = [{ t: 0, ...mid }, ...c.kf.filter(k => k.t > lt + 0.01).map(k => ({ ...k, t: k.t - lt }))];
    c.kf = [...c.kf.filter(k => k.t < lt - 0.01), { t: lt, ...mid }];
  }
  c.out = srcT;
  S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
  S.sel = b.id;
  compute();
  refreshAll();
};
function dupClip(c) {
  const n = cloneClip(c);
  n.id = nid();
  n.src = null; n.gain = null;
  if (c.type === 'video') {
    const el = document.createElement('video');
    el.playsInline = true; el.preload = 'auto'; el.src = c.el.src;
    n.el = el;
    wire(n);
  }
  return n;
}
$('bDup').onclick = () => {
  const c = selClip(); if (!c) return;
  touch('dup' + nid());
  const n = dupClip(c);
  n.tr = { type: 'none', dur: 0.5 };
  S.clips.splice(S.clips.indexOf(c) + 1, 0, n);
  S.sel = n.id;
  compute(); refreshAll();
};
$('bDel').onclick = () => {
  const c = selClip(); if (!c) return;
  touch('del' + nid());
  const i = S.clips.indexOf(c);
  if (c.type === 'video') c.el.pause();
  S.clips.splice(i, 1);
  S.sel = S.clips.length ? S.clips[Math.min(i, S.clips.length - 1)].id : -1;
  compute();
  S.t = clamp(S.t, 0, S.total);
  refreshAll();
};
function moveClip(dir) {
  const c = selClip(); if (!c) return;
  const i = S.clips.indexOf(c), j = i + dir;
  if (j < 0 || j >= S.clips.length) return;
  touch('move' + nid());
  S.clips.splice(i, 1);
  S.clips.splice(j, 0, c);
  compute();
  refreshAll();
}
$('bLeft').onclick = () => moveClip(-1);
$('bRight').onclick = () => moveClip(1);

/* ---------- Adjust tab ---------- */
function refreshAdjust() {
  const c = selClip();
  $('n-adjust').classList.toggle('off', !c);
  if (!c) return;
  $('fPreset').value = c.f.preset;
  setR('fb', c.f.b); setR('fc', c.f.c); setR('fs', c.f.s); setR('fh', c.f.h); setR('fbl', c.f.bl);
  $('fFit').value = c.fit;
}
$('fPreset').onchange = e => { const c = selClip(); if (!c) return; touch('fp' + nid()); c.f.preset = e.target.value; };
[['fb', 'b'], ['fc', 'c'], ['fs', 's'], ['fh', 'h'], ['fbl', 'bl']].forEach(([id, k]) => {
  $(id).oninput = e => { const c = selClip(); if (!c) return; touch('f' + id); c.f[k] = +e.target.value; };
});
$('fFit').onchange = e => { const c = selClip(); if (!c) return; touch('fit' + nid()); c.fit = e.target.value; };
$('fAll').onclick = () => {
  const c = selClip(); if (!c) return;
  touch('fall' + nid());
  S.clips.forEach(k => { k.f = { ...c.f }; k.fit = c.fit; });
  toast('Look applied to all clips');
};
$('fReset').onclick = () => {
  const c = selClip(); if (!c) return;
  touch('freset' + nid());
  c.f = defFilter();
  refreshAdjust();
};

/* ---------- Animate tab ---------- */
function refreshAnim() {
  const c = selClip();
  $('n-animate').classList.toggle('off', !c);
  if (!c) { $('kList').innerHTML = ''; return; }
  if (S.playing) return;
  const p = evalProps(c, clamp(S.t - c.start, 0, len(c)));
  PK.forEach(k => setR(k, Math.round(p[k])));
  const box = $('kList');
  box.innerHTML = '';
  if (!c.kf.length) { box.textContent = 'No keyframes yet.'; return; }
  c.kf.forEach(k => {
    const b = document.createElement('button');
    b.textContent = '◆ ' + k.t.toFixed(1) + 's';
    b.onclick = () => seek(c.start + k.t);
    box.appendChild(b);
  });
}
PK.forEach(k => {
  $(k).oninput = e => {
    const c = selClip(); if (!c) return;
    touch('p' + k);
    applyProps(c, { [k]: +e.target.value });
  };
});
$('kAdd').onclick = () => {
  const c = selClip(); if (!c) return;
  touch('kadd' + nid());
  const lt = clamp(S.t - c.start, 0, len(c));
  upsertKf(c, lt, evalProps(c, lt));
  refreshAnim(); drawTimeline();
};
$('kDel').onclick = () => {
  const c = selClip(); if (!c) return;
  const lt = S.t - c.start;
  const i = c.kf.findIndex(k => Math.abs(k.t - lt) < 0.15);
  if (i < 0) return toast('No keyframe at the playhead');
  touch('kdel' + nid());
  const rest = c.kf.filter((_, j) => j !== i);
  if (!rest.length) Object.assign(c, pickP(c.kf[i]));
  c.kf = rest;
  refreshAnim(); drawTimeline();
};
function kenBurns(zoomIn) {
  const c = selClip(); if (!c) return;
  touch('kb' + nid());
  const L = len(c);
  c.kf = [
    { t: 0, sc: zoomIn ? 100 : 125, px: zoomIn ? 0 : 3, py: 0, rot: 0, op: 100 },
    { t: L, sc: zoomIn ? 125 : 100, px: zoomIn ? 3 : 0, py: 0, rot: 0, op: 100 }
  ];
  refreshAnim(); drawTimeline();
}
$('kIn').onclick = () => kenBurns(true);
$('kOut').onclick = () => kenBurns(false);
$('kClear').onclick = () => {
  const c = selClip(); if (!c || !c.kf.length) return;
  touch('kclr' + nid());
  Object.assign(c, pickP(evalProps(c, clamp(S.t - c.start, 0, len(c)))));
  c.kf = [];
  refreshAnim(); drawTimeline();
};
$('kReset').onclick = () => {
  const c = selClip(); if (!c) return;
  touch('kres' + nid());
  c.kf = [];
  Object.assign(c, { sc: 100, px: 0, py: 0, rot: 0, op: 100 });
  refreshAnim(); drawTimeline();
};

/* ---------- Text tab ---------- */
const TEMPLATES = {
  title: { text: 'YOUR TITLE', size: 120, x: 0.5, y: 0.45, color: '#ffffff', bgOn: false, bg: '#000000', anim: 'pop', bold: true, len: 3 },
  lower: { text: 'Name · Role', size: 46, x: 0.36, y: 0.82, color: '#ffffff', bgOn: true, bg: '#7a5cff', anim: 'left', bold: true, len: 4 },
  cta: { text: 'SUBSCRIBE', size: 64, x: 0.5, y: 0.86, color: '#ffffff', bgOn: true, bg: '#e53935', anim: 'pop', bold: true, len: 3 },
  type: { text: 'Type your message here...', size: 50, x: 0.5, y: 0.8, color: '#ffffff', bgOn: true, bg: '#111111', anim: 'type', bold: false, len: 4 },
  caption: { text: 'Caption text', size: 52, x: 0.5, y: 0.86, color: '#ffffff', bgOn: false, bg: '#000000', anim: 'fade', bold: true, len: 3 }
};
function newText(o) {
  const from = +S.t.toFixed(1);
  return { id: nid(), text: 'New text', x: 0.5, y: 0.5, size: 64, color: '#ffffff', bgOn: false, bg: '#7a5cff', anim: 'none', bold: true, from, to: +(from + (o.len || 3)).toFixed(1), ...o, len: undefined };
}
function refreshText() {
  const sel = $('tSel');
  sel.innerHTML = '';
  S.texts.forEach((L, i) => {
    const o = document.createElement('option');
    o.value = L.id;
    o.textContent = (i + 1) + '. ' + L.text.slice(0, 24);
    sel.appendChild(o);
  });
  const L = selText();
  $('n-text').classList.toggle('off', !L);
  sel.style.display = S.texts.length ? '' : 'none';
  if (!L) return;
  sel.value = L.id;
  $('tText').value = L.text;
  setR('tSize', L.size);
  $('tColor').value = L.color; $('tBg').value = L.bg;
  $('tBgOn').checked = L.bgOn; $('tBold').checked = L.bold;
  $('tAnim').value = L.anim;
  $('tFrom').value = L.from; $('tTo').value = L.to;
}
document.querySelectorAll('[data-tpl]').forEach(b => {
  b.onclick = () => {
    touch('tpl' + nid());
    const L = newText(TEMPLATES[b.dataset.tpl]);
    S.texts.push(L);
    S.tsel = L.id;
    refreshAll();
  };
});
$('tAdd').onclick = () => {
  touch('tadd' + nid());
  const L = newText({});
  S.texts.push(L); S.tsel = L.id;
  refreshAll();
};
$('tDup').onclick = () => {
  const L = selText(); if (!L) return;
  touch('tdup' + nid());
  const n = { ...L, id: nid(), y: Math.min(0.95, L.y + 0.08), _box: null };
  S.texts.push(n); S.tsel = n.id;
  refreshAll();
};
$('tDel').onclick = () => {
  const L = selText(); if (!L) return;
  touch('tdel' + nid());
  S.texts = S.texts.filter(t => t.id !== L.id);
  S.tsel = S.texts.length ? S.texts[S.texts.length - 1].id : -1;
  refreshAll();
};
$('tSel').onchange = e => { S.tsel = +e.target.value; refreshText(); drawTimeline(); };
function editText(fn, key) {
  const L = selText(); if (!L) return;
  touch(key);
  fn(L);
  drawTimeline();
}
$('tText').oninput = e => {
  editText(L => { L.text = e.target.value; }, 'ttext');
  const L = selText();
  if (L) { const o = $('tSel').options[S.texts.indexOf(L)]; if (o) o.textContent = (S.texts.indexOf(L) + 1) + '. ' + L.text.slice(0, 24); }
};
$('tSize').oninput = e => editText(L => { L.size = +e.target.value; }, 'tsize');
$('tColor').oninput = e => editText(L => { L.color = e.target.value; }, 'tcolor');
$('tBg').oninput = e => editText(L => { L.bg = e.target.value; L.bgOn = true; $('tBgOn').checked = true; }, 'tbg');
$('tBgOn').onchange = e => editText(L => { L.bgOn = e.target.checked; }, 'tbgon' + nid());
$('tBold').onchange = e => editText(L => { L.bold = e.target.checked; }, 'tbold' + nid());
$('tAnim').onchange = e => editText(L => { L.anim = e.target.value; }, 'tanim' + nid());
$('tFrom').oninput = e => editText(L => { L.from = Math.max(0, +e.target.value || 0); if (L.to <= L.from) L.to = L.from + 0.5; }, 'tfrom');
$('tTo').oninput = e => editText(L => { L.to = Math.max(L.from + 0.1, +e.target.value || 0); }, 'tto');
$('tNow').onclick = () => {
  editText(L => { const d = L.to - L.from; L.from = +S.t.toFixed(1); L.to = +(L.from + d).toFixed(1); }, 'tnow' + nid());
  refreshText();
};

/* ---------- Audio tab ---------- */
$('addAudio').onchange = e => { addAudio([...e.target.files]); e.target.value = ''; };
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
  if (!a) return;
  sel.value = a.id;
  setR('aVol', a.vol);
  $('aStart').value = a.start;
}
$('aSel').onchange = e => { S.asel = +e.target.value; refreshAudio(); drawTimeline(); };
$('aVol').oninput = e => { const a = selAudio(); if (!a) return; touch('avol'); a.vol = +e.target.value; };
$('aStart').oninput = e => { const a = selAudio(); if (!a) return; touch('astart'); a.start = Math.max(0, +e.target.value || 0); drawTimeline(); };
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

/* ---------- Export tab ---------- */
const TYPES = window.MediaRecorder ? [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
].filter(t => MediaRecorder.isTypeSupported(t)) : [];
TYPES.forEach(t => {
  const o = document.createElement('option');
  o.value = t;
  o.textContent = t.includes('mp4') ? 'MP4' : 'WebM' + (t.includes('vp9') ? ' (VP9)' : t.includes('vp8') ? ' (VP8)' : '');
  $('xFmt').appendChild(o);
});
$('xRatio').onchange = e => { S.ratio = e.target.value; setSize(S.prev); markDirty(); };
$('xPrev').onchange = e => { S.prev = +e.target.value; setSize(S.prev); };
$('xBg').oninput = e => { S.bg = e.target.value; markDirty(); };
$('xLb').onchange = e => { S.letterbox = e.target.checked; markDirty(); };
$('xVig').onchange = e => { S.vignette = e.target.checked; markDirty(); };

let rec = null, chunks = [], lock = null, cancelled = false;
async function runRealtime() {
  if (S.exporting) return;
  if (!S.clips.length) return toast('Add a clip first');
  if (!TYPES.length) return toast('Export is not supported in this browser. Use Chrome.');
  pause();
  initAudio();
  await AC.resume();
  S.exporting = true;
  cancelled = false;
  $('busy').classList.add('on');
  $('busyProg').value = 0;
  setSize(+$('xRes').value);
  S.t = 0;
  render();
  await sleep(700); // let the first frames load
  const type = $('xFmt').value;
  const stream = cv.captureStream(+$('xFps').value);
  dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
  try {
    rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: +$('xBit').value, audioBitsPerSecond: 128000 });
  } catch (e) {
    S.exporting = false; $('busy').classList.remove('on'); setSize(S.prev);
    return toast('Could not start the recorder: ' + e.message);
  }
  chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => exportDone(type);
  rec.start(500);
  try { lock = await navigator.wakeLock.request('screen'); } catch (e) { }
  S.t = 0;
  await play();
}
function finishExport() {
  pause();
  setTimeout(() => { if (rec && rec.state !== 'inactive') rec.stop(); }, 300);
}
function exportDone(type) {
  S.exporting = false;
  $('busy').classList.remove('on');
  if (lock) { lock.release().catch(() => { }); lock = null; }
  setSize(S.prev);
  S.t = 0;
  pauseAllMedia();
  if (cancelled) return toast('Export cancelled');
  const mime = type.split(';')[0];
  presentExport(new Blob(chunks, { type: mime }), mime);
}
function presentExport(blob, mime) {
  const url = URL.createObjectURL(blob);
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  $('xOut').src = url;
  $('xOut').style.display = 'block';
  $('xDl').href = url;
  $('xDl').download = 'vided-export.' + ext;
  $('xDl').style.display = 'block';
  const file = new File([blob], 'vided-export.' + ext, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    $('xShare').style.display = 'block';
    $('xShare').onclick = () => navigator.share({ files: [file], title: 'Vided export' }).catch(() => { });
  }
  openTab('export');
  toast('Export finished (' + (blob.size / 1048576).toFixed(1) + ' MB)');
  updateTime(); drawTimeline();
}
$('xBtn').onclick = () => doExport();
$('goExport').onclick = () => openTab('export');
$('busyCancel').onclick = () => {
  cancelled = true;
  pause();
  if (rec && rec.state !== 'inactive') rec.stop();
};

/* ---------- tabs ---------- */
function openTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'p-' + name));
  $('panels').scrollTop = 0;
}
document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => openTab(b.dataset.tab); });

/* ---------- direct manipulation on the preview ---------- */
let drag = null;
function cpt(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
}
function pickClip() {
  const t = Math.min(S.t, Math.max(0, S.total - 0.001));
  const act = frameState(t).map(s => s.c);
  const cur = selClip();
  if (cur && act.includes(cur)) return cur;
  return act[act.length - 1] || null;
}
cv.addEventListener('pointerdown', e => {
  if (S.exporting) return;
  const [x, y] = cpt(e);
  for (let i = S.texts.length - 1; i >= 0; i--) {
    const L = S.texts[i], b = L._box;
    if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      touch('tdrag' + nid());
      S.tsel = L.id;
      drag = { kind: 'text', L, ox: x - L.x * cv.width, oy: y - L.y * cv.height, moved: false };
      cv.setPointerCapture(e.pointerId);
      refreshText(); drawTimeline();
      return;
    }
  }
  const c = pickClip();
  if (c) {
    S.sel = c.id;
    drag = { kind: 'clip', c, sx: x, sy: y, p0: evalProps(c, clamp(S.t - c.start, 0, len(c))), moved: false, touched: false };
    cv.setPointerCapture(e.pointerId);
    refreshAll();
  }
});
cv.addEventListener('pointermove', e => {
  if (!drag) return;
  const [x, y] = cpt(e);
  if (drag.kind === 'text') {
    drag.moved = true;
    drag.L.x = clamp((x - drag.ox) / cv.width, 0, 1);
    drag.L.y = clamp((y - drag.oy) / cv.height, 0, 1);
  } else {
    if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) < 6 * cv.width / 360) return;
    if (!drag.touched) { touch('cdrag' + nid()); drag.touched = true; }
    drag.moved = true;
    applyProps(drag.c, { px: drag.p0.px + (x - drag.sx) / cv.width * 100, py: drag.p0.py + (y - drag.sy) / cv.height * 100 });
  }
});
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'text' && !d.moved) openTab('text');
  refreshAnim();
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);

/* ---------- refresh everything ---------- */
function refreshAll() {
  refreshMedia(); refreshAdjust(); refreshAnim(); refreshText(); refreshAudio();
  $('empty').style.display = S.clips.length ? 'none' : 'flex';
  updateTime(); drawTimeline(); updUR();
}

$('undo').onclick = undo;
$('redo').onclick = redo;
window.addEventListener('resize', () => { fitCanvas(); drawTimeline(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S.playing && !S.exporting) pause(); });

/* ---------- start ---------- */
setSize(S.prev);
refreshAll();
requestAnimationFrame(loop);

// Small hook so automated tests can inspect the app. Harmless in normal use.
window.__vided = { S, compute, render, frameState, evalProps, undo, redo, addMedia, makeClip };
