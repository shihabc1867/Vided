'use strict';
/* Image editor: crop, eraser (erase / restore / magic), adjust, rotate & flip.
   Also: "Freeze frame" turns the video frame at the playhead into an image clip. */

const IED = (() => {
  const box = $('ied'), cvs = $('iedCv'), g = cvs.getContext('2d'), stageEl = $('iedStage');
  const MAXD = 1920;
  const E = { clip: null, work: null, orig: null, hist: [], tool: 'crop', mode: 'erase', crop: null, ratio: 0, k: 1, ox: 0, oy: 0, dpr: 1, cw: 0, ch: 0, alpha: false, changed: false, cur: null, drag: null };
  const adj = { preset: '', b: 100, c: 100, s: 100, h: 0, bl: 0 };

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const copy = c => { const n = mk(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n; };
  const adjFilter = () => filterOf(adj, Math.min(E.work.width, E.work.height) / 720);

  // checkerboard so transparent areas are visible
  const checker = (() => {
    const c = mk(16, 16), x = c.getContext('2d');
    x.fillStyle = '#cfcfd6'; x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#ececf2'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    return c;
  })();

  function pushHist(geo) {
    E.hist.push({ w: copy(E.work), o: geo ? copy(E.orig) : null });
    if (E.hist.length > 8) E.hist.shift();
    E.changed = true;
  }

  /* ----- layout ----- */
  function layout() {
    const r = stageEl.getBoundingClientRect();
    E.dpr = Math.min(2, window.devicePixelRatio || 1);
    E.cw = r.width; E.ch = r.height;
    cvs.width = Math.round(r.width * E.dpr);
    cvs.height = Math.round(r.height * E.dpr);
    cvs.style.width = r.width + 'px';
    cvs.style.height = r.height + 'px';
    fit();
  }
  function fit() {
    const w = E.work.width, h = E.work.height;
    E.k = Math.min((E.cw - 24) / w, (E.ch - 24) / h);
    E.ox = (E.cw - w * E.k) / 2;
    E.oy = (E.ch - h * E.k) / 2;
  }

  /* ----- drawing ----- */
  function draw() {
    if (!box.classList.contains('on')) return;
    const { k, ox, oy } = E, w = E.work.width, h = E.work.height;
    g.setTransform(E.dpr, 0, 0, E.dpr, 0, 0);
    g.clearRect(0, 0, E.cw, E.ch);
    g.save();
    g.beginPath(); g.rect(ox, oy, w * k, h * k); g.clip();
    g.fillStyle = g.createPattern(checker, 'repeat');
    g.fillRect(ox, oy, w * k, h * k);
    if (E.tool === 'adjust') g.filter = adjFilter();
    g.drawImage(E.work, ox, oy, w * k, h * k);
    g.filter = 'none';
    g.restore();

    if (E.tool === 'crop' && E.crop) {
      const c = E.crop, x = ox + c.x * k, y = oy + c.y * k, cw = c.w * k, ch = c.h * k;
      g.fillStyle = 'rgba(0,0,0,.6)';
      g.fillRect(ox, oy, w * k, y - oy);
      g.fillRect(ox, y + ch, w * k, oy + h * k - y - ch);
      g.fillRect(ox, y, x - ox, ch);
      g.fillRect(x + cw, y, ox + w * k - x - cw, ch);
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x, y, cw, ch);
      g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.45)';
      for (let i = 1; i < 3; i++) {
        g.beginPath(); g.moveTo(x + cw * i / 3, y); g.lineTo(x + cw * i / 3, y + ch); g.stroke();
        g.beginPath(); g.moveTo(x, y + ch * i / 3); g.lineTo(x + cw, y + ch * i / 3); g.stroke();
      }
      g.fillStyle = '#7a5cff';
      [[x, y], [x + cw, y], [x, y + ch], [x + cw, y + ch]].forEach(([hx, hy]) => g.fillRect(hx - 9, hy - 9, 18, 18));
    }
    if (E.tool === 'erase' && E.cur) {
      const r = +$('ieSize').value / 2;
      g.strokeStyle = E.mode === 'erase' ? '#ff4d6d' : E.mode === 'restore' ? '#2fe08a' : '#ffd166';
      g.lineWidth = 2;
      g.beginPath(); g.arc(E.cur.x, E.cur.y, E.mode === 'magic' ? 10 : r, 0, 7); g.stroke();
    }
  }

  /* ----- crop ----- */
  function resetCrop() { E.crop = { x: 0, y: 0, w: E.work.width, h: E.work.height }; }
  function setRatio(r) {
    E.ratio = r;
    if (!r) return;
    const W = E.work.width, H = E.work.height;
    let w, h;
    if (W / H > r) { h = H; w = H * r; } else { w = W; h = W / r; }
    E.crop = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }
  function applyCrop() {
    const c = E.crop;
    const x = Math.round(c.x), y = Math.round(c.y), w = Math.round(c.w), h = Math.round(c.h);
    if (w < 2 || h < 2) return;
    if (w === E.work.width && h === E.work.height) return toast('Drag the corners to choose the crop area');
    pushHist(true);
    const nw = mk(w, h); nw.getContext('2d').drawImage(E.work, x, y, w, h, 0, 0, w, h);
    const no = mk(w, h); no.getContext('2d').drawImage(E.orig, x, y, w, h, 0, 0, w, h);
    E.work = nw; E.orig = no;
    resetCrop(); fit(); draw();
  }
  function cornerAt(x, y) {
    const c = E.crop;
    const pts = [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]];
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(x - (E.ox + pts[i][0] * E.k), y - (E.oy + pts[i][1] * E.k)) < 34) return i;
    }
    return -1;
  }
  function dragCrop(ix, iy) {
    const W = E.work.width, H = E.work.height, d = E.drag;
    if (d.type === 'move') {
      const c = E.crop;
      c.x = clamp(ix - d.dx, 0, W - c.w);
      c.y = clamp(iy - d.dy, 0, H - c.h);
      return;
    }
    const px = clamp(ix, 0, W), py = clamp(iy, 0, H), ax = d.ax, ay = d.ay;
    let w = Math.abs(px - ax), h = Math.abs(py - ay);
    let x, y;
    if (E.ratio) {
      if (w / E.ratio > h) h = w / E.ratio; else w = h * E.ratio;
      const dx = px >= ax ? 1 : -1, dy = py >= ay ? 1 : -1;
      const s = Math.min(1, (dx > 0 ? W - ax : ax) / w, (dy > 0 ? H - ay : ay) / h);
      w *= s; h *= s;
      x = dx > 0 ? ax : ax - w; y = dy > 0 ? ay : ay - h;
    } else { x = Math.min(ax, px); y = Math.min(ay, py); }
    if (w < 24 || h < 24) return;
    E.crop = { x, y, w, h };
  }

  /* ----- eraser ----- */
  function stamp(ix, iy) {
    const r = Math.max(1, (+$('ieSize').value / 2) / E.k);
    const soft = +$('ieSoft').value / 100;
    const hard = Math.min(0.99, Math.max(0, 1 - soft));
    const wc = E.work.getContext('2d');
    const grad = (ctx2, cx, cy) => {
      const gr = ctx2.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(hard, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      return gr;
    };
    if (E.mode === 'erase') {
      wc.save();
      wc.globalCompositeOperation = 'destination-out';
      wc.fillStyle = grad(wc, ix, iy);
      wc.fillRect(ix - r, iy - r, r * 2, r * 2);
      wc.restore();
      E.alpha = true;
    } else {
      const d = Math.ceil(r * 2);
      const t = mk(d, d), tc = t.getContext('2d');
      tc.drawImage(E.orig, ix - r, iy - r, r * 2, r * 2, 0, 0, d, d);
      tc.globalCompositeOperation = 'destination-in';
      tc.fillStyle = grad(tc, d / 2, d / 2);
      tc.fillRect(0, 0, d, d);
      wc.drawImage(t, ix - r, iy - r, r * 2, r * 2);
    }
  }
  function stroke(ix, iy) {
    const l = E.drag.last, r = Math.max(1, (+$('ieSize').value / 2) / E.k);
    const dist = Math.hypot(ix - l.x, iy - l.y), step = Math.max(1, r * 0.25);
    const n = Math.max(1, Math.floor(dist / step));
    for (let i = 1; i <= n; i++) stamp(l.x + (ix - l.x) * i / n, l.y + (iy - l.y) * i / n);
    E.drag.last = { x: ix, y: iy };
  }
  function magic(ix, iy) {
    const w = E.work.width, h = E.work.height;
    const x0 = Math.floor(ix), y0 = Math.floor(iy);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    const wc = E.work.getContext('2d');
    const id = wc.getImageData(0, 0, w, h), d = id.data;
    const si = (y0 * w + x0) * 4;
    if (d[si + 3] === 0) return;
    const sr = d[si], sg = d[si + 1], sb = d[si + 2];
    const maxd = (+$('ieTol').value / 100) * 220, thr = maxd * maxd;
    const match = i => {
      const p = i * 4;
      if (d[p + 3] === 0) return true;
      const dr = d[p] - sr, dg = d[p + 1] - sg, db = d[p + 2] - sb;
      return dr * dr + dg * dg + db * db <= thr;
    };
    pushHist(false);
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
    let sp = 0;
    stack[sp++] = y0 * w + x0; seen[y0 * w + x0] = 1;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j >= 0 && !seen[j] && match(j)) { seen[j] = 1; stack[sp++] = j; }
      }
    }
    // erase the region, then soften its 1px edge
    const edge = [];
    for (let i = 0; i < w * h; i++) {
      if (seen[i]) { d[i * 4 + 3] = 0; continue; }
      const x = i % w, y = (i / w) | 0;
      if ((x > 0 && seen[i - 1]) || (x < w - 1 && seen[i + 1]) || (y > 0 && seen[i - w]) || (y < h - 1 && seen[i + w])) edge.push(i);
    }
    edge.forEach(i => { d[i * 4 + 3] = Math.round(d[i * 4 + 3] * 0.5); });
    wc.putImageData(id, 0, 0);
    E.alpha = true;
  }

  /* ----- adjust / transform ----- */
  function resetAdj() {
    Object.assign(adj, { preset: '', b: 100, c: 100, s: 100, h: 0, bl: 0 });
    $('iePreset').value = '';
    setR('ieB', 100); setR('ieC', 100); setR('ieS', 100); setR('ieH', 0); setR('ieBl', 0);
  }
  function applyAdjust() {
    if (adjFilter() === 'none') return toast('Change a slider or pick a filter first');
    pushHist(false);
    const t = mk(E.work.width, E.work.height), tc = t.getContext('2d');
    tc.filter = adjFilter();
    tc.drawImage(E.work, 0, 0);
    E.work = t;
    resetAdj(); draw();
  }
  function geo(fn) {
    pushHist(true);
    E.work = fn(E.work); E.orig = fn(E.orig);
    resetCrop(); fit(); draw();
  }
  const rotate = cw => src => {
    const n = mk(src.height, src.width), x = n.getContext('2d');
    if (cw) { x.translate(src.height, 0); x.rotate(Math.PI / 2); } else { x.translate(0, src.width); x.rotate(-Math.PI / 2); }
    x.drawImage(src, 0, 0);
    return n;
  };
  const flip = horiz => src => {
    const n = mk(src.width, src.height), x = n.getContext('2d');
    if (horiz) { x.translate(src.width, 0); x.scale(-1, 1); } else { x.translate(0, src.height); x.scale(1, -1); }
    x.drawImage(src, 0, 0);
    return n;
  };

  /* ----- history ----- */
  function undo() {
    const h = E.hist.pop();
    if (!h) return toast('Nothing to undo');
    E.work = h.w;
    if (h.o) E.orig = h.o;
    resetCrop(); fit(); draw();
  }

  /* ----- tools ----- */
  function setTool(t) {
    E.tool = t;
    document.querySelectorAll('#ied .ied-tabs button').forEach(b => b.classList.toggle('active', b.dataset.it === t));
    document.querySelectorAll('#ied .ied-panel').forEach(p => p.classList.toggle('active', p.id === 'it-' + t));
    E.cur = null;
    draw();
  }

  function open(c) {
    if (!c || c.type !== 'image') return toast('Select an image clip to edit');
    pause();
    const img = c.el;
    const w0 = img.naturalWidth, h0 = img.naturalHeight, sc = Math.min(1, MAXD / Math.max(w0, h0));
    E.work = mk(Math.round(w0 * sc), Math.round(h0 * sc));
    E.work.getContext('2d').drawImage(img, 0, 0, E.work.width, E.work.height);
    E.orig = copy(E.work);
    E.hist = []; E.clip = c; E.alpha = (c.blob && c.blob.type === 'image/png'); E.changed = false; E.drag = null;
    E.mode = 'erase'; E.ratio = 0;
    document.querySelectorAll('#ied [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === 'erase'));
    document.querySelectorAll('#ied [data-r]').forEach(b => b.classList.toggle('on', b.dataset.r === '0'));
    resetAdj();
    box.classList.add('on');
    layout();
    resetCrop();
    setTool('crop');
  }
  function close() { box.classList.remove('on'); E.work = E.orig = null; E.hist = []; E.clip = null; }

  async function done() {
    if (!E.changed) return close();
    const c = E.clip;
    const type = E.alpha ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(r => E.work.toBlob(r, type, 0.92));
    if (!blob) return toast('Could not save the image');
    close();
    await replaceClipImage(c, blob);
    toast('Image updated');
  }

  /* ----- pointer ----- */
  const pos = e => { const r = cvs.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cvs.addEventListener('pointerdown', e => {
    if (!E.work) return;
    const [x, y] = pos(e), ix = (x - E.ox) / E.k, iy = (y - E.oy) / E.k;
    cvs.setPointerCapture(e.pointerId);
    if (E.tool === 'crop') {
      const ci = cornerAt(x, y), c = E.crop;
      if (ci >= 0) {
        const opp = [[c.x + c.w, c.y + c.h], [c.x, c.y + c.h], [c.x + c.w, c.y], [c.x, c.y]][ci];
        E.drag = { type: 'corner', ax: opp[0], ay: opp[1] };
      } else if (ix >= c.x && ix <= c.x + c.w && iy >= c.y && iy <= c.y + c.h) {
        E.drag = { type: 'move', dx: ix - c.x, dy: iy - c.y };
      }
    } else if (E.tool === 'erase') {
      E.cur = { x, y };
      if (E.mode === 'magic') { magic(ix, iy); }
      else { pushHist(false); E.drag = { type: 'paint', last: { x: ix, y: iy } }; stamp(ix, iy); }
    }
    draw();
  });
  cvs.addEventListener('pointermove', e => {
    if (!E.work) return;
    const [x, y] = pos(e), ix = (x - E.ox) / E.k, iy = (y - E.oy) / E.k;
    if (E.tool === 'erase') E.cur = { x, y };
    if (E.drag) {
      if (E.drag.type === 'paint') stroke(ix, iy); else dragCrop(ix, iy);
    }
    draw();
  });
  const up = () => { E.drag = null; if (E.tool === 'erase') { E.cur = null; } draw(); };
  cvs.addEventListener('pointerup', up);
  cvs.addEventListener('pointercancel', up);

  /* ----- wiring ----- */
  document.querySelectorAll('#ied .ied-tabs button').forEach(b => { b.onclick = () => setTool(b.dataset.it); });
  document.querySelectorAll('#ied [data-r]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#ied [data-r]').forEach(x => x.classList.toggle('on', x === b));
      setRatio(+b.dataset.r); draw();
    };
  });
  document.querySelectorAll('#ied [data-mode]').forEach(b => {
    b.onclick = () => {
      E.mode = b.dataset.mode;
      document.querySelectorAll('#ied [data-mode]').forEach(x => x.classList.toggle('on', x === b));
      $('ieMagicBox').style.display = E.mode === 'magic' ? '' : 'none';
      $('ieBrushBox').style.display = E.mode === 'magic' ? 'none' : '';
    };
  });
  $('iePreset').onchange = e => { adj.preset = e.target.value; draw(); };
  [['ieB', 'b'], ['ieC', 'c'], ['ieS', 's'], ['ieH', 'h'], ['ieBl', 'bl']].forEach(([id, k]) => {
    $(id).oninput = e => { adj[k] = +e.target.value; draw(); };
  });
  $('ieCrop').onclick = applyCrop;
  $('ieAdj').onclick = applyAdjust;
  $('ieAdjReset').onclick = () => { resetAdj(); draw(); };
  $('ieRotL').onclick = () => geo(rotate(false));
  $('ieRotR').onclick = () => geo(rotate(true));
  $('ieFlipH').onclick = () => geo(flip(true));
  $('ieFlipV').onclick = () => geo(flip(false));
  $('iedUndo').onclick = undo;
  $('iedRevert').onclick = () => { if (E.clip) open(E.clip); };
  $('iedCancel').onclick = close;
  $('iedApply').onclick = done;
  window.addEventListener('resize', () => { if (E.work) { layout(); draw(); } });

  return { open, E, adj, magic, stamp, applyCrop, setRatio, done, close, geo, rotate, flip };
})();

/* Replace an image clip's picture with an edited version. */
async function replaceClipImage(c, blob) {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  touch('imgedit' + nid());
  c.el = img;
  c.blob = blob;
  c.mkey = 'm' + nid();
  c.thumb = thumbOf(img, img.naturalWidth, img.naturalHeight);
  refreshAll();
  markDirty();
}

/* Media-tab buttons */
$('bEditImg').onclick = () => {
  const c = selClip();
  if (!c) return toast('Select a clip first');
  if (c.type !== 'image') return toast('Tip: use “Freeze frame” to turn a video frame into an image, then edit it');
  IED.open(c);
};
$('bFreeze').onclick = async () => {
  const c = selClip();
  if (!c || c.type !== 'video') return toast('Select a video clip first');
  const t = S.t;
  if (!(t >= c.start && t < c.end)) return toast('Move the playhead inside the selected clip');
  pause();
  await seekEl(c.el, clamp(c.in + (t - c.start) * c.speed, 0, c.dur - 0.01));
  const cv2 = document.createElement('canvas');
  cv2.width = c.el.videoWidth; cv2.height = c.el.videoHeight;
  cv2.getContext('2d').drawImage(c.el, 0, 0);
  const blob = await new Promise(r => cv2.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) return toast('Could not capture the frame');
  const file = new File([blob], 'frame-' + fmt(t - c.start).replace(':', 'm') + '.jpg', { type: 'image/jpeg' });
  try {
    touch('freeze' + nid());
    const ic = await makeClip(file);
    S.clips.splice(S.clips.indexOf(c) + 1, 0, ic);
    wire(ic);
    S.sel = ic.id;
    compute();
    refreshAll();
    toast('Frame added after the clip. Tap “Edit image…” to edit it.');
  } catch (e) { U.pop(); toast(e.message); }
};
