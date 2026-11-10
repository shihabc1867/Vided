/* Vided Phase 9a: video effects, pro colour grading, curves, HSL, .cube LUT.
   drawClip() hands a clip here (drawPost) when it has any effect or grade. */
(function () {
  const FXK = ['glitch', 'rgb', 'blur', 'pixel', 'vig', 'grain', 'shake', 'pulse', 'glow', 'sharpen', 'crop'];
  const GRK = ['temp', 'tint', 'hi', 'sh', 'cs', 'cm', 'ch', 'hr', 'hy', 'hg', 'hc', 'hb', 'hm', 'bw', 'lut'];

  window.hasPost = c => {
    const e = c.fx, g = c.gr;
    if (e) { for (const k of FXK) if (e[k]) return true; if (e.mirror) return true; }
    if (g) { for (const k of GRK) if (g[k] && !(k === 'lut' && !c.lutTxt)) return true; }
    return false;
  };

  let off = null, tmp = null, small = null;
  function surf(W, H) {
    if (!off || off.cv.width !== W || off.cv.height !== H) {
      const mk = (w, h) => { const cvs = document.createElement('canvas'); cvs.width = w; cvs.height = h; return { cv: cvs, cx: cvs.getContext('2d', { willReadFrequently: true }) }; };
      off = mk(W, H); tmp = mk(W, H); small = mk(8, 8);
    }
    return off;
  }
  const rnd = seed => { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

  /* ----- .cube LUT ----- */
  const LUTS = new Map();
  function parseCube(txt) {
    const key = txt.length + ':' + txt.slice(0, 80) + txt.slice(-80);
    if (LUTS.has(key)) return LUTS.get(key);
    let size = 0, data = [], lo = [0, 0, 0], hi = [1, 1, 1];
    for (const raw of txt.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l[0] === '#') continue;
      if (l.startsWith('LUT_3D_SIZE')) size = parseInt(l.split(/\s+/)[1], 10);
      else if (l.startsWith('DOMAIN_MIN')) lo = l.split(/\s+/).slice(1).map(Number);
      else if (l.startsWith('DOMAIN_MAX')) hi = l.split(/\s+/).slice(1).map(Number);
      else if (/^[-\d.]/.test(l)) { const p = l.split(/\s+/).map(Number); if (p.length >= 3) data.push(p[0], p[1], p[2]); }
    }
    let res = null;
    if (size >= 2 && data.length >= size * size * size * 3) {
      const f = new Float32Array(size * size * size * 3);
      for (let i = 0; i < f.length; i++) { const ch = i % 3; f[i] = (data[i] - lo[ch]) / ((hi[ch] - lo[ch]) || 1); }
      res = { size, data: f };
    }
    LUTS.set(key, res);
    return res;
  }
  window.parseCube = parseCube;

  function curveLut(g) {
    const pts = [[0, 0], [64, 64 + (g.cs || 0) * 0.5], [128, 128 + (g.cm || 0) * 0.5], [192, 192 + (g.ch || 0) * 0.5], [255, 255]];
    const L = new Uint8ClampedArray(256);
    for (let x = 0; x < 256; x++) {
      let i = 0; while (i < 3 && x > pts[i + 1][0]) i++;
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(4, i + 2)];
      const u = (x - p1[0]) / (p2[0] - p1[0]);
      const m1 = (p2[1] - p0[1]) / (p2[0] - p0[0]) * (p2[0] - p1[0]);
      const m2 = (p3[1] - p1[1]) / (p3[0] - p1[0]) * (p2[0] - p1[0]);
      const u2 = u * u, u3 = u2 * u;
      L[x] = (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2;
    }
    return L;
  }

  function gradePass(d, g, lut, W, H) {
    const temp = (g.temp || 0) * 0.3, tint = (g.tint || 0) * 0.2, hi = (g.hi || 0) * 0.6, sh = (g.sh || 0) * 0.6;
    const bands = [g.hr || 0, g.hy || 0, g.hg || 0, g.hc || 0, g.hb || 0, g.hm || 0];
    const useBands = bands.some(Boolean);
    const useCurve = g.cs || g.cm || g.ch, CL = useCurve ? curveLut(g) : null;
    const lutAmt = lut ? (g.lut || 0) / 100 : 0;
    const n = lut ? lut.size : 0, nm = n - 1, ld = lut ? lut.data : null;
    const simple = !(temp || tint || hi || sh), bwA = (g.bw || 0) / 100;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], gg = d[i + 1], b = d[i + 2];
      if (!simple) {
        const l = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
        const k = hi * l * l + sh * (1 - l) * (1 - l);
        r += temp + k; gg += -tint + k; b += -temp + k;
        r = r < 0 ? 0 : r > 255 ? 255 : r; gg = gg < 0 ? 0 : gg > 255 ? 255 : gg; b = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      if (bwA) { const yy = 0.299 * r + 0.587 * gg + 0.114 * b; r += (yy - r) * bwA; gg += (yy - gg) * bwA; b += (yy - b) * bwA; }
      if (useCurve) { r = CL[r | 0]; gg = CL[gg | 0]; b = CL[b | 0]; }
      if (useBands) {
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), dl = mx - mn;
        if (dl > 2) {
          let h = mx === r ? ((gg - b) / dl) % 6 : mx === gg ? (b - r) / dl + 2 : (r - gg) / dl + 4;
          h *= 60; if (h < 0) h += 360;
          let m = 0;
          for (let j = 0; j < 6; j++) { let dh = Math.abs(h - j * 60); if (dh > 180) dh = 360 - dh; if (dh < 60) m += (1 - dh / 60) * bands[j]; }
          const mul = 1 + m / 100, gray = 0.299 * r + 0.587 * gg + 0.114 * b;
          r = gray + (r - gray) * mul; gg = gray + (gg - gray) * mul; b = gray + (b - gray) * mul;
          r = r < 0 ? 0 : r > 255 ? 255 : r; gg = gg < 0 ? 0 : gg > 255 ? 255 : gg; b = b < 0 ? 0 : b > 255 ? 255 : b;
        }
      }
      if (lutAmt > 0) {
        const fr = r / 255 * nm, fg = gg / 255 * nm, fb = b / 255 * nm;
        const r0 = fr | 0, g0 = fg | 0, b0 = fb | 0, r1 = Math.min(nm, r0 + 1), g1 = Math.min(nm, g0 + 1), b1 = Math.min(nm, b0 + 1);
        const tr = fr - r0, tg = fg - g0, tb = fb - b0;
        const o = [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
          const at = (x, y, z) => ld[((z * n + y) * n + x) * 3 + ch];
          const c00 = at(r0, g0, b0) * (1 - tr) + at(r1, g0, b0) * tr, c10 = at(r0, g1, b0) * (1 - tr) + at(r1, g1, b0) * tr;
          const c01 = at(r0, g0, b1) * (1 - tr) + at(r1, g0, b1) * tr, c11 = at(r0, g1, b1) * (1 - tr) + at(r1, g1, b1) * tr;
          o[ch] = ((c00 * (1 - tg) + c10 * tg) * (1 - tb) + (c01 * (1 - tg) + c11 * tg) * tb) * 255;
        }
        r += (o[0] - r) * lutAmt; gg += (o[1] - gg) * lutAmt; b += (o[2] - b) * lutAmt;
      }
      d[i] = r; d[i + 1] = gg; d[i + 2] = b;
    }
  }

  function runLook(S0, c, t, W, H) {
    const F = Math.min(W, H) / 720, e = c.fx || {}, g = c.gr || {}, o = S0.cx;
    const copyTmp = () => { tmp.cx.setTransform(1, 0, 0, 1, 0, 0); tmp.cx.clearRect(0, 0, W, H); tmp.cx.drawImage(S0.cv, 0, 0); };

    if (e.mirror) {
      copyTmp();
      const m = e.mirror;
      if (m === 1 || m === 3) { o.save(); o.translate(W, 0); o.scale(-1, 1); o.clearRect(0, 0, W / 2, H); o.drawImage(tmp.cv, 0, 0, W / 2, H, 0, 0, W / 2, H); o.restore(); }
      if (m === 2 || m === 3) {
        copyTmp(); if (m === 3) { tmp.cx.save(); tmp.cx.translate(W, 0); tmp.cx.scale(-1, 1); tmp.cx.clearRect(0, 0, W / 2, H); tmp.cx.drawImage(S0.cv, 0, 0, W / 2, H, 0, 0, W / 2, H); tmp.cx.restore(); tmp.cx.drawImage(S0.cv, 0, 0); }
        o.save(); o.translate(0, H); o.scale(1, -1); o.drawImage(tmp.cv, 0, 0, W, H / 2, 0, 0, W, H / 2); o.restore();
      }
    }
    if (e.blur) { copyTmp(); o.clearRect(0, 0, W, H); o.filter = `blur(${(e.blur * 0.25 * F).toFixed(1)}px)`; o.drawImage(tmp.cv, 0, 0); o.filter = 'none'; }
    if (e.pixel) {
      const blk = Math.max(2, Math.round(e.pixel * 0.5 * F)), sw = Math.max(1, Math.ceil(W / blk)), sh = Math.max(1, Math.ceil(H / blk));
      if (small.cv.width !== sw || small.cv.height !== sh) { small.cv.width = sw; small.cv.height = sh; }
      small.cx.clearRect(0, 0, sw, sh); small.cx.drawImage(S0.cv, 0, 0, sw, sh);
      o.clearRect(0, 0, W, H); o.imageSmoothingEnabled = false; o.drawImage(small.cv, 0, 0, sw, sh, 0, 0, sw * blk, sh * blk); o.imageSmoothingEnabled = true;
    }
    if (e.glow) {
      copyTmp();
      o.save(); o.globalCompositeOperation = 'screen'; o.globalAlpha = Math.min(1, e.glow / 100 * 0.9);
      o.filter = `blur(${(6 + e.glow * 0.2) * F}px) brightness(1.5)`; o.drawImage(tmp.cv, 0, 0); o.restore(); o.filter = 'none';
    }
    if (e.glitch) {
      copyTmp();
      const R = rnd(Math.floor(t * 12) + 7), n = 3 + Math.round(e.glitch / 12);
      o.clearRect(0, 0, W, H); o.drawImage(tmp.cv, 0, 0);
      for (let i = 0; i < n; i++) {
        if (R() > 0.35 + e.glitch / 200) continue;
        const y = Math.floor(R() * H), h = Math.max(2, Math.floor(R() * H * 0.07)), sx = (R() - 0.5) * e.glitch * 0.8 * F * 2;
        o.clearRect(0, y, W, h); o.drawImage(tmp.cv, 0, y, W, h, sx, y, W, h);
      }
    }
    const needPix = e.rgb || e.glitch || e.grain || e.sharpen || (g && (g.temp || g.tint || g.hi || g.sh || g.cs || g.cm || g.ch || g.hr || g.hy || g.hg || g.hc || g.hb || g.hm || g.bw || (g.lut && c.lutTxt)));
    if (needPix) {
      const img = o.getImageData(0, 0, W, H), d = img.data;
      if (e.rgb || e.glitch) {
        const sh = Math.max(1, Math.round((e.rgb || 0) * 0.12 * F + (e.glitch || 0) * 0.05 * F)), src = new Uint8ClampedArray(d);
        for (let y = 0; y < H; y++) {
          const row = y * W * 4;
          for (let x = 0; x < W; x++) {
            const i = row + x * 4, xr = Math.min(W - 1, x + sh), xb = Math.max(0, x - sh);
            d[i] = src[row + xr * 4]; d[i + 2] = src[row + xb * 4 + 2];
            d[i + 3] = Math.max(src[i + 3], src[row + xr * 4 + 3], src[row + xb * 4 + 3]);
          }
        }
      }
      if (e.sharpen) {
        const k = e.sharpen / 100 * 0.9, src = new Uint8ClampedArray(d), st = W * 4;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * st + x * 4;
          for (let ch = 0; ch < 3; ch++) d[i + ch] = src[i + ch] + k * (4 * src[i + ch] - src[i - 4 + ch] - src[i + 4 + ch] - src[i - st + ch] - src[i + st + ch]);
        }
      }
      const lut = c.lutTxt ? parseCube(c.lutTxt) : null;
      if (g.temp || g.tint || g.hi || g.sh || g.cs || g.cm || g.ch || g.hr || g.hy || g.hg || g.hc || g.hb || g.hm || g.bw || (g.lut && lut)) gradePass(d, g, lut, W, H);
      if (e.grain) {
        const R = rnd(Math.floor(t * 24) + 3), amp = e.grain * 0.9;
        for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; const nz = (R() - 0.5) * amp; d[i] += nz; d[i + 1] += nz; d[i + 2] += nz; }
      }
      o.putImageData(img, 0, 0);
    }
    if (e.vig) {
      o.save(); o.globalCompositeOperation = 'source-atop';
      const gr = o.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) * 0.55);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${Math.min(1, e.vig / 100 * 1.1)})`);
      o.fillStyle = gr; o.fillRect(0, 0, W, H); o.restore();
    }
  }

  window.drawPost = function (c, t, fx) {
    const W = cv.width, H = cv.height, F = Math.min(W, H) / 720;
    const e = c.fx || {}, g = c.gr || {};
    const main = ctx, S0 = surf(W, H), o = S0.cx;
    o.setTransform(1, 0, 0, 1, 0, 0); o.globalAlpha = 1; o.globalCompositeOperation = 'source-over'; o.filter = 'none';
    o.clearRect(0, 0, W, H);
    ctx = o;
    const nb = c.blend; c.blend = null;
    try { drawClip(c, t, { ...fx, alpha: 1, clip: null, _pp: 1 }); } finally { ctx = main; c.blend = nb; }
    runLook(S0, c, t, W, H);
    main.save();
    main.globalAlpha = clamp(fx.alpha, 0, 1);
    if (c.blend && c.blend !== 'source-over') main.globalCompositeOperation = c.blend;
    if (fx.clip !== null && fx.clip !== undefined) { main.beginPath(); main.rect(0, 0, W * fx.clip, H); main.clip(); }
    if (e.crop) { const m = e.crop / 100; main.beginPath(); main.rect(W * m, H * m, W * (1 - 2 * m), H * (1 - 2 * m)); main.clip(); }
    let ox = 0, oy = 0, sc = 1;
    if (e.shake) { const a = e.shake * 0.35 * F; ox = (Math.sin(t * 53) + Math.sin(t * 29 + 1)) * 0.5 * a; oy = (Math.cos(t * 47) + Math.sin(t * 37 + 2)) * 0.5 * a; sc = 1 + e.shake / 100 * 0.04; }
    if (e.pulse) sc *= 1 + e.pulse / 100 * 0.12 * Math.pow(Math.max(0, Math.sin(t * Math.PI * 4)), 4);
    if (ox || oy || sc !== 1) { main.translate(W / 2 + ox, H / 2 + oy); main.scale(sc, sc); main.translate(-W / 2, -H / 2); }
    main.drawImage(S0.cv, 0, 0);
    main.restore();
  };

  window.drawAdj = function (t) {
    const list = S.adj || [];
    for (const a of list) {
      if (t < a.from || t >= a.to) continue;
      const W = cv.width, H = cv.height, F = Math.min(W, H) / 720;
      const flt = filterOf(a.f || defFilter(), F), has = hasPost(a);
      if (!has && flt === 'none') continue;
      const S0 = surf(W, H), o = S0.cx;
      o.setTransform(1, 0, 0, 1, 0, 0); o.globalAlpha = 1; o.globalCompositeOperation = 'source-over'; o.filter = 'none';
      o.clearRect(0, 0, W, H); o.drawImage(cv, 0, 0);
      if (has) runLook(S0, a, t, W, H);
      ctx.save(); ctx.filter = flt; ctx.globalAlpha = (a.amt == null ? 100 : a.amt) / 100; ctx.drawImage(S0.cv, 0, 0); ctx.restore();
    }
  };
  window.fxTgt = () => (S.fxAdj && (S.adj || []).find(a => a.id === S.adjSel)) || selClip();

  /* ---------- FX tab ---------- */
  const tabs = document.getElementById('tabs');
  const btn = document.createElement('button'); btn.dataset.tab = 'fx'; btn.textContent = 'FX';
  tabs.insertBefore(btn, tabs.querySelector('[data-tab="animate"]'));
  btn.onclick = () => openTab('fx');
  const sec = document.createElement('section'); sec.className = 'panel'; sec.id = 'p-fx';
  document.getElementById('p-adjust').after(sec);

  const SL = [];                       // slider specs for refresh
  function slider(parent, grp, key, label, min, max, def) {
    const wrap = document.createElement('div'); wrap.className = 'field';
    const id = 'fx_' + grp + '_' + key;
    wrap.innerHTML = `<label><span>${label}</span><b id="v-${id}"></b></label><input type="range" id="${id}" min="${min}" max="${max}" step="1" value="${def}">`;
    parent.appendChild(wrap);
    const inp = wrap.querySelector('input'); inp.dataset.unit = '';
    inp.addEventListener('input', () => {
      showVal(inp);
      const c = fxTgt(); if (!c) return;
      touch('fx' + grp + key);
      c[grp] = { ...(c[grp] || {}), [key]: +inp.value };
      if (!S.playing) render(true); markDirty();
    });
    showVal(inp);
    SL.push({ inp, grp, key, def });
  }
  const h = (txt) => { const d = document.createElement('label'); d.className = 'lbl'; d.textContent = txt; sec.appendChild(d); };

  sec.innerHTML = '<div class="hint" id="fxInfo">Select a clip on the timeline, then add effects and colour grading.</div>';
  const box = document.createElement('div'); box.className = 'needsel'; box.id = 'n-fx'; sec.appendChild(box);
  const wrapTo = box;
  const lblt = txt => { const d = document.createElement('label'); d.className = 'lbl'; d.textContent = txt; wrapTo.appendChild(d); };
  lblt('Effects');
  [['glitch', 'Glitch'], ['rgb', 'RGB split'], ['blur', 'Blur'], ['pixel', 'Pixelate'], ['vig', 'Vignette'], ['grain', 'Film grain'], ['shake', 'Camera shake'], ['pulse', 'Beat pulse'], ['glow', 'Glow'], ['sharpen', 'Sharpen'], ['crop', 'Crop (all sides)']].forEach(([k, l]) => slider(wrapTo, 'fx', k, l, 0, 100, 0));
  lblt('Mirror');
  const mir = document.createElement('select'); mir.id = 'fxMirror';
  mir.innerHTML = '<option value="0">Off</option><option value="1">Left to right</option><option value="2">Top to bottom</option><option value="3">Four-way</option>';
  wrapTo.appendChild(mir);
  mir.onchange = () => { const c = fxTgt(); if (!c) return; touch('fxmirror' + nid()); c.fx = { ...(c.fx || {}), mirror: +mir.value }; render(true); };
  lblt('Colour grading');
  [['temp', 'Temperature (cool ↔ warm)'], ['tint', 'Tint (green ↔ magenta)'], ['hi', 'Highlights'], ['sh', 'Shadows']].forEach(([k, l]) => slider(wrapTo, 'gr', k, l, -100, 100, 0));
  slider(wrapTo, 'gr', 'bw', 'Black & white', 0, 100, 0);
  lblt('Curves (brightness)');
  [['cs', 'Dark tones'], ['cm', 'Mid tones'], ['ch', 'Light tones']].forEach(([k, l]) => slider(wrapTo, 'gr', k, l, -100, 100, 0));
  lblt('Colour mixer (saturation by colour)');
  [['hr', 'Reds'], ['hy', 'Yellows'], ['hg', 'Greens'], ['hc', 'Cyans'], ['hb', 'Blues'], ['hm', 'Magentas']].forEach(([k, l]) => slider(wrapTo, 'gr', k, l, -100, 100, 0));
  lblt('LUT (.cube colour look)');
  const lf = document.createElement('label'); lf.className = 'filebtn'; lf.innerHTML = 'Import .cube LUT<input type="file" id="lutFile" accept=".cube,text/plain" hidden>';
  wrapTo.appendChild(lf);
  const lutInfo = document.createElement('div'); lutInfo.className = 'hint'; lutInfo.id = 'lutInfo'; wrapTo.appendChild(lutInfo);
  slider(wrapTo, 'gr', 'lut', 'LUT strength', 0, 100, 100);
  const lb = document.createElement('div'); lb.className = 'grid2';
  lb.innerHTML = '<button id="lutClear">Remove LUT</button><button id="fxReset" class="danger">Reset all FX</button>';
  wrapTo.appendChild(lb);
  const cp = document.createElement('div'); cp.className = 'grid2';
  cp.innerHTML = '<button id="fxCopy">Copy look</button><button id="fxPaste">Paste look</button>';
  wrapTo.appendChild(cp);

  $('lutFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    const c = fxTgt(); if (!f || !c) return;
    const txt = await f.text();
    const l = parseCube(txt);
    if (!l) return toast('That file is not a valid 3D .cube LUT');
    touch('lut' + nid());
    c.lutTxt = txt; c.lutName = f.name;
    c.gr = { ...(c.gr || {}), lut: (c.gr && c.gr.lut) || 100 };
    refreshFxTab(); render(true); markDirty(); toast('LUT loaded: ' + f.name);
  };
  $('lutClear').onclick = () => { const c = fxTgt(); if (!c) return; touch('lutc' + nid()); c.lutTxt = ''; c.lutName = ''; refreshFxTab(); render(true); };
  $('fxReset').onclick = () => { const c = fxTgt(); if (!c) return; touch('fxr' + nid()); c.fx = {}; c.gr = {}; c.lutTxt = ''; c.lutName = ''; refreshFxTab(); render(true); };
  let clip = null;
  $('fxCopy').onclick = () => { const c = fxTgt(); if (!c) return; clip = { fx: { ...(c.fx || {}) }, gr: { ...(c.gr || {}) }, f: { ...c.f }, lutTxt: c.lutTxt, lutName: c.lutName }; toast('Look copied'); };
  $('fxPaste').onclick = () => { const c = fxTgt(); if (!c || !clip) return toast('Copy a look first'); touch('fxp' + nid()); c.fx = { ...clip.fx }; c.gr = { ...clip.gr }; c.f = { ...clip.f }; c.lutTxt = clip.lutTxt; c.lutName = clip.lutName; refreshAll(); render(true); };

  function refreshFxTab() {
    const c = fxTgt();
    box.classList.toggle('off', !c);
    $('fxInfo').style.display = c ? 'none' : '';
    if (!c) return;
    SL.forEach(s => { const v = (c[s.grp] && c[s.grp][s.key] != null) ? c[s.grp][s.key] : s.def; s.inp.value = v; showVal(s.inp); });
    mir.value = String((c.fx && c.fx.mirror) || 0);
    lutInfo.textContent = c.lutTxt ? 'LUT: ' + (c.lutName || 'custom') : 'No LUT loaded. Pick a .cube file (free LUT packs work).';
  }
  window.refreshFxTab = refreshFxTab;
  const prev = window.refreshFx;
  window.refreshFx = function () { if (prev) prev(); refreshFxTab(); };
})();
