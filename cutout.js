'use strict';
/* Background removal for video and image clips.
   Mode 1 - Color key: removes a chosen color (green screen or any plain backdrop), with softness, spill cleanup and edge control.
   Mode 2 - AI person cutout: MediaPipe selfie segmentation (runs on the phone, model is downloaded once).
   The removed area can stay transparent (shows the layer below / project background) or be filled with a color, a blurred copy of the video, or a picture. */

const CUT = { cache: new Map(), masks: new Map(), seg: null, segP: null, state: 'idle', err: '', imgs: new Map() };
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const hex2rgb = h => { const n = parseInt(String(h).replace('#', ''), 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgb2hex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const cbcr = (r, g, b) => [-0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];
const sstep = (a, b, x) => { if (b <= a) return x >= a ? 1 : 0; const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ---------- color key ---------- */
function applyChroma(d, bg) {
  const [kr, kg, kb] = hex2rgb(bg.key);
  const [kcb, kcr] = cbcr(kr, kg, kb);
  const kY = 0.299 * kr + 0.587 * kg + 0.114 * kb;
  const useY = Math.hypot(kcb, kcr) < 25;             // gray-ish key (white/black/gray wall): compare brightness too
  const thr = bg.sim * 1.2, soft = Math.max(1, bg.soft * 1.5);
  const spill = bg.spill / 100, shift = bg.shift / 100, inv = !!bg.invert;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const [cb, cr] = cbcr(r, g, b);
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    let dist = Math.hypot(cb - kcb, cr - kcr);
    if (useY) dist += Math.abs(y - kY) * 0.8;
    let a = clamp(sstep(thr, thr + soft, dist) + shift, 0, 1);
    if (a > 0 && spill > 0) {
      const s = spill * (1 - sstep(thr, thr + soft * 4 + 40, dist));
      if (s > 0) { d[i] = r + (y - r) * s; d[i + 1] = g + (y - g) * s; d[i + 2] = b + (y - b) * s; }
    }
    if (inv) a = 1 - a;
    d[i + 3] = d[i + 3] * a;
  }
}

/* ---------- AI mask ---------- */
function loadSegmenter() {
  if (CUT.seg) return Promise.resolve(CUT.seg);
  if (CUT.segP) return CUT.segP;
  CUT.state = 'loading'; CUT.err = '';
  uiCutStatus();
  CUT.segP = (async () => {
    try {
      const mod = await import(MP_BASE + '/vision_bundle.mjs');
      const files = await mod.FilesetResolver.forVisionTasks(MP_BASE + '/wasm');
      let seg = null;
      for (const delegate of ['GPU', 'CPU']) {
        try {
          seg = await mod.ImageSegmenter.createFromOptions(files, {
            baseOptions: { modelAssetPath: MP_MODEL, delegate },
            runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true
          });
          break;
        } catch (e) { seg = null; CUT.err = String(e && e.message || e); }
      }
      if (!seg) throw new Error(CUT.err || 'model failed to load');
      CUT.seg = seg; CUT.state = 'ready'; CUT.err = '';
      return seg;
    } catch (e) {
      CUT.state = 'error'; CUT.err = String(e && e.message || e); CUT.segP = null;
      throw new Error('AI cutout could not load (' + CUT.err + '). It needs an internet connection the first time.');
    } finally {
      uiCutStatus();
      if (window.render && !S.exporting) render(true);
    }
  })();
  CUT.segP.catch(() => { });
  return CUT.segP;
}
async function prepareCutouts() {
  if (S.clips.some(c => c.bg && c.bg.on && c.bg.type === 'ai') && !window.segmentHook) await loadSegmenter();
}

function runSegmenter(canvas) {
  if (window.segmentHook) return window.segmentHook(canvas);   // test hook
  if (!CUT.seg) return null;
  let out = null;
  const grab = res => {
    if (!res || !res.confidenceMasks || !res.confidenceMasks.length) return;
    const mk = res.confidenceMasks[res.confidenceMasks.length - 1];
    out = { w: mk.width, h: mk.height, data: Float32Array.from(mk.getAsFloat32Array()) };
    if (res.close) res.close();
  };
  try { const r = CUT.seg.segment(canvas, grab); if (!out && r) grab(r); } catch (e) { return null; }
  if (!out) return null;
  // Some model builds output "background" instead of "person" – if the border is clearly more "on" than the center, flip it
  const { w, h, data } = out;
  let bs = 0, bn = 0, cs = 0, cn = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const v = data[y * w + x], edge = x < w * 0.12 || x > w * 0.88 || y < h * 0.12 || y > h * 0.88;
    const mid = x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7;
    if (edge) { bs += v; bn++; } else if (mid) { cs += v; cn++; }
  }
  if (bn && cn && bs / bn > cs / cn + 0.25) for (let i = 0; i < data.length; i++) data[i] = 1 - data[i];
  return out;
}
function applyMask(d, w, h, m, bg) {
  const center = 0.5 - bg.shift / 200, width = Math.max(0.02, bg.soft / 100 * 0.5), inv = !!bg.invert;
  const mw = m.w, mh = m.h, md = m.data;
  for (let y = 0; y < h; y++) {
    const fy = clamp((y + 0.5) / h * mh - 0.5, 0, mh - 1), y0 = Math.floor(fy), y1 = Math.min(mh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x + 0.5) / w * mw - 0.5, 0, mw - 1), x0 = Math.floor(fx), x1 = Math.min(mw - 1, x0 + 1), tx = fx - x0;
      const v = (md[y0 * mw + x0] * (1 - tx) + md[y0 * mw + x1] * tx) * (1 - ty) + (md[y1 * mw + x0] * (1 - tx) + md[y1 * mw + x1] * tx) * ty;
      let a = sstep(center - width, center + width, v);
      if (inv) a = 1 - a;
      d[(y * w + x) * 4 + 3] *= a;
    }
  }
}

/* ---------- called by the renderer ---------- */
function cutoutFrame(c, el, rw, rh, rot, sw, sh, t) {
  const bg = c.bg;
  if (bg.type === 'ai' && !CUT.seg && !window.segmentHook) { loadSegmenter().catch(() => { }); return null; }
  const cap = clamp(Math.max(cv.width, cv.height), 320, 1280), k = Math.min(1, cap / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * k)), h = Math.max(2, Math.round(sh * k));
  let W = CUT.cache.get(c.id);
  if (!W) {
    const cvs = document.createElement('canvas');
    W = { cv: cvs, cx: cvs.getContext('2d', { willReadFrequently: true }), key: '' };
    CUT.cache.set(c.id, W);
  }
  const key = [bg.type, bg.key, bg.sim, bg.soft, bg.spill, bg.shift, bg.invert, w, h, rot].join('|');
  if (c.type === 'image' && W.key === key) return W.cv;
  if (W.cv.width !== w || W.cv.height !== h) { W.cv.width = w; W.cv.height = h; }
  const x = W.cx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, w, h);
  x.save();
  x.translate(w / 2, h / 2);
  x.rotate(rot * Math.PI / 180);
  try { x.drawImage(el, -rw * k / 2, -rh * k / 2, rw * k, rh * k); } catch (e) { x.restore(); return null; }
  x.restore();
  let img;
  try { img = x.getImageData(0, 0, w, h); } catch (e) { return null; }
  if (bg.type === 'ai') {
    const mk = c.id + '|' + w + 'x' + h;
    let rec = CUT.masks.get(c.id);
    const fresh = rec && rec.k === mk && (c.type === 'image' ? rec.t === 0 : (!S.exporting && Math.abs(t - rec.t) < 1 / 12));
    if (!fresh) {
      const m = runSegmenter(W.cv);
      if (!m) return rec && rec.k === mk ? (applyMask(img.data, w, h, rec.m, bg), x.putImageData(img, 0, 0), W.cv) : null;
      rec = { k: mk, t: c.type === 'image' ? 0 : t, m };
      CUT.masks.set(c.id, rec);
    }
    applyMask(img.data, w, h, rec.m, bg);
  } else applyChroma(img.data, bg);
  x.putImageData(img, 0, 0);
  W.key = key;
  return W.cv;
}

function bgImage(src) {
  if (!src) return null;
  let im = CUT.imgs.get(src);
  if (!im) {
    im = new Image();
    im.onload = () => { if (window.render && !S.exporting) render(true); };
    im.src = src;
    CUT.imgs.set(src, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}
function drawBackdrop(c, fx, W, H, F, el, rw, rh, rot, sw, sh) {
  const bg = c.bg;
  ctx.save();
  if (fx.clip !== null) { ctx.beginPath(); ctx.rect(0, 0, W * fx.clip, H); ctx.clip(); }
  ctx.globalAlpha = clamp(fx.alpha, 0, 1);
  if (bg.fill === 'color') {
    ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H);
  } else if (bg.fill === 'blur') {
    const s = Math.max(W / sw, H / sh) * 1.15;
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.filter = `blur(${(bg.blur * F).toFixed(1)}px)`;
    try { ctx.drawImage(el, -rw * s / 2, -rh * s / 2, rw * s, rh * s); } catch (e) { }
  } else if (bg.fill === 'image') {
    const im = bgImage(bg.img);
    if (im) {
      const s = Math.max(W / im.naturalWidth, H / im.naturalHeight);
      ctx.drawImage(im, (W - im.naturalWidth * s) / 2, (H - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s);
    }
  }
  ctx.restore();
}

/* ---------- eyedropper + auto detect ---------- */
function pickKeyColor(x, y) {
  S.pick = false;
  $('bgPick').classList.remove('on');
  const c = selClip();
  if (!c) return;
  S.noCut = true;
  render(true);
  let px;
  try { px = ctx.getImageData(clamp(Math.round(x) - 2, 0, cv.width - 5), clamp(Math.round(y) - 2, 0, cv.height - 5), 5, 5).data; } catch (e) { px = null; }
  S.noCut = false;
  if (px) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    touch('bgkey' + nid());
    c.bg.key = rgb2hex(r / n, g / n, b / n);
    c.bg.type = 'chroma'; c.bg.on = true;
    markDirty();
  }
  refreshCutout();
  render(true);
}
function autoKey(c) {
  const el = c.el;
  const w = c.type === 'video' ? el.videoWidth : el.naturalWidth, h = c.type === 'video' ? el.videoHeight : el.naturalHeight;
  if (!w || !h) return null;
  const t = document.createElement('canvas'); t.width = 64; t.height = 64;
  const x = t.getContext('2d', { willReadFrequently: true });
  try { x.drawImage(el, 0, 0, 64, 64); } catch (e) { return null; }
  const P = 6, pts = [[0, 0], [64 - P, 0], [0, 64 - P], [64 - P, 64 - P]].map(([px, py]) => {
    const d = x.getImageData(px, py, P, P).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  });
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let best = pts[0], bs = Infinity;
  pts.forEach(p => { const s = pts.reduce((n, q) => n + dist(p, q), 0); if (s < bs) { bs = s; best = p; } });
  const near = pts.filter(p => dist(p, best) < 60);
  const m = [0, 1, 2].map(i => near.reduce((n, p) => n + p[i], 0) / near.length);
  return rgb2hex(m[0], m[1], m[2]);
}

/* ---------- panel ---------- */
function uiCutStatus() {
  const e = $('bgAiStatus');
  if (!e) return;
  e.textContent = CUT.state === 'loading' ? 'Loading the AI model (first time only, about 1 MB)…'
    : CUT.state === 'ready' ? 'AI model ready.'
      : CUT.state === 'error' ? 'Could not load the AI model: ' + CUT.err : 'The AI model downloads the first time you use it.';
}
function refreshCutout() {
  const box = $('n-cutout');
  if (!box) return;
  const c = selClip(), ok = c && (c.type === 'video' || c.type === 'image');
  box.style.display = ok ? '' : 'none';
  $('bgInfo').style.display = ok ? 'none' : '';
  $('bgPick').classList.toggle('on', S.pick);
  if (!ok) return;
  const bg = c.bg;
  $('bgOn').checked = bg.on;
  $('bgType').value = bg.type;
  $('bgChromaOnly').style.display = bg.type === 'chroma' ? '' : 'none';
  $('bgAiBox').style.display = bg.type === 'ai' ? '' : 'none';
  $('bgKey').value = bg.key;
  setR('bgSim', bg.sim); setR('bgSoft', bg.soft); setR('bgSpill', bg.spill); setR('bgShift', bg.shift); setR('bgBlur', bg.blur);
  $('bgInv').checked = !!bg.invert;
  $('bgFill').value = bg.fill;
  $('bgColor').value = bg.color;
  $('bgColorBox').style.display = bg.fill === 'color' ? '' : 'none';
  $('bgBlurBox').style.display = bg.fill === 'blur' ? '' : 'none';
  $('bgImgBox').style.display = bg.fill === 'image' ? '' : 'none';
  uiCutStatus();
}
function editBg(fn, key) {
  const c = selClip();
  if (!c) return;
  touch(key);
  fn(c.bg, c);
  CUT.masks.delete(c.id);
  markDirty();
  if (!S.playing) render(true);
}
const bgSlider = (id, k) => { $(id).oninput = e => editBg(b => { b[k] = +e.target.value; }, id); };
bgSlider('bgSim', 'sim'); bgSlider('bgSoft', 'soft'); bgSlider('bgSpill', 'spill'); bgSlider('bgShift', 'shift'); bgSlider('bgBlur', 'blur');
$('bgOn').onchange = e => {
  editBg(b => { b.on = e.target.checked; }, 'bgon' + nid());
  const c = selClip();
  if (c && c.bg.on && c.bg.type === 'ai') loadSegmenter().catch(err => toast(err.message));
};
$('bgType').onchange = e => {
  editBg(b => { b.type = e.target.value; }, 'bgtype' + nid());
  refreshCutout();
  const c = selClip();
  if (c && c.bg.on && c.bg.type === 'ai') loadSegmenter().catch(err => toast(err.message));
};
$('bgKey').oninput = e => editBg(b => { b.key = e.target.value; }, 'bgkeyc');
$('bgInv').onchange = e => editBg(b => { b.invert = e.target.checked; }, 'bginv' + nid());
$('bgFill').onchange = e => { editBg(b => { b.fill = e.target.value; }, 'bgfill' + nid()); refreshCutout(); };
$('bgColor').oninput = e => editBg(b => { b.color = e.target.value; }, 'bgcolor');
$('bgPick').onclick = () => {
  const c = selClip();
  if (!c) return toast('Select a clip first');
  S.pick = !S.pick;
  $('bgPick').classList.toggle('on', S.pick);
  if (S.pick) toast('Tap the color to remove on the preview');
};
$('bgAuto').onclick = () => {
  const c = selClip();
  if (!c) return;
  const k = autoKey(c);
  if (!k) return toast('Could not read this clip yet. Try again in a moment.');
  editBg(b => { b.key = k; b.type = 'chroma'; b.on = true; }, 'bgauto' + nid());
  refreshCutout();
};
$('bgImg').onchange = e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const url = URL.createObjectURL(f), im = new Image();
  im.onload = () => {
    const k = Math.min(1, 1280 / Math.max(im.naturalWidth, im.naturalHeight));
    const t = document.createElement('canvas');
    t.width = Math.round(im.naturalWidth * k); t.height = Math.round(im.naturalHeight * k);
    t.getContext('2d').drawImage(im, 0, 0, t.width, t.height);
    URL.revokeObjectURL(url);
    editBg(b => { b.img = t.toDataURL('image/jpeg', 0.85); b.fill = 'image'; }, 'bgimg' + nid());
    refreshCutout();
  };
  im.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that image'); };
  im.src = url;
};
refreshCutout();
