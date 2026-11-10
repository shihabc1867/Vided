/* Vided Phase 8: GIF export + audio-only WAV export. Uses globals from app.js / export.js / audio.js. */
(function () {
  /* ---------- GIF encoder ---------- */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function buildPalette(samples) {                         // samples: array of Uint8ClampedArray RGBA
    const hist = new Uint32Array(32768);
    for (const d of samples) {
      for (let i = 0; i < d.length; i += 4 * 3) hist[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
    }
    const bins = [];
    for (let k = 0; k < 32768; k++) if (hist[k]) bins.push(k);
    const comp = (k, ch) => ch === 0 ? k >> 10 : ch === 1 ? (k >> 5) & 31 : k & 31;
    let boxes = [bins];
    const NCOL = 255;
    while (boxes.length < NCOL) {
      let bi = -1, bs = 0, bch = 0;
      boxes.forEach((b, i) => {
        if (b.length < 2) return;
        for (let ch = 0; ch < 3; ch++) {
          let lo = 31, hi = 0;
          for (const k of b) { const v = comp(k, ch); if (v < lo) lo = v; if (v > hi) hi = v; }
          const sc = (hi - lo) * (ch === 1 ? 1.2 : ch === 0 ? 1 : 0.8) * Math.sqrt(b.length);
          if (sc > bs) { bs = sc; bi = i; bch = ch; }
        }
      });
      if (bi < 0) break;
      const b = boxes[bi];
      b.sort((x, y) => comp(x, bch) - comp(y, bch));
      let tot = 0; for (const k of b) tot += hist[k];
      let acc = 0, cut = 1;
      for (let i = 0; i < b.length; i++) { acc += hist[b[i]]; if (acc >= tot / 2) { cut = Math.min(Math.max(i + 1, 1), b.length - 1); break; } }
      boxes.splice(bi, 1, b.slice(0, cut), b.slice(cut));
    }
    const pal = new Uint8Array(256 * 3);
    boxes.forEach((b, i) => {
      let r = 0, g = 0, bl = 0, n = 0;
      for (const k of b) { const w = hist[k]; r += (k >> 10) * w; g += ((k >> 5) & 31) * w; bl += (k & 31) * w; n += w; }
      pal[i * 3] = Math.round(r / n * 8 + 4); pal[i * 3 + 1] = Math.round(g / n * 8 + 4); pal[i * 3 + 2] = Math.round(bl / n * 8 + 4);
    });
    return { pal, n: boxes.length };
  }

  function lzw(px, minCode) {
    const clear = 1 << minCode, eoi = clear + 1;
    let next = eoi + 1, size = minCode + 1, dict = new Map();
    const out = []; let cur = 0, bits = 0;
    const put = code => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
    put(clear);
    let prefix = px[0];
    for (let i = 1; i < px.length; i++) {
      const k = px[i], key = prefix * 256 + k, v = dict.get(key);
      if (v !== undefined) { prefix = v; continue; }
      put(prefix);
      if (next < 4096) {
        dict.set(key, next);
        if (next === (1 << size) && size < 12) size++;
        next++;
      } else { put(clear); dict = new Map(); next = eoi + 1; size = minCode + 1; }
      prefix = k;
    }
    put(prefix); put(eoi);
    if (bits > 0) out.push(cur & 255);
    return out;
  }

  function encodeGif(frames, W, H, fps, onProg) {
    const { pal, n } = buildPalette(frames.filter((_, i) => i % Math.max(1, Math.floor(frames.length / 8)) === 0));
    const lut = new Int16Array(32768).fill(-1);
    const near = key => {
      let v = lut[key]; if (v >= 0) return v;
      const r = ((key >> 10) << 3) + 4, g = (((key >> 5) & 31) << 3) + 4, b = ((key & 31) << 3) + 4;
      let best = 0, bd = 1e9;
      for (let i = 0; i < n; i++) {
        const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b, d = dr * dr * 2 + dg * dg * 3 + db * db;
        if (d < bd) { bd = d; best = i; }
      }
      return (lut[key] = best);
    };
    const out = [];
    const w16 = v => out.push(v & 255, (v >> 8) & 255);
    out.push(...[71, 73, 70, 56, 57, 97]);
    w16(W); w16(H); out.push(0xF7, 0, 0);
    for (let i = 0; i < 768; i++) out.push(pal[i]);
    out.push(0x21, 0xFF, 11, ...[...'NETSCAPE2.0'].map(c => c.charCodeAt(0)), 3, 1, 0, 0, 0);
    const delay = Math.max(2, Math.round(100 / fps));
    let prev = null;
    const idx = new Uint8Array(W * H);
    frames.forEach((d, f) => {
      const cur = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x, o = p * 4, bias = (BAYER[(y & 3) * 4 + (x & 3)] - 7.5) * 0.7;
          const r = Math.min(255, Math.max(0, d[o] + bias)), g = Math.min(255, Math.max(0, d[o + 1] + bias)), b = Math.min(255, Math.max(0, d[o + 2] + bias));
          cur[p] = near(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        }
      }
      let useT = false;
      if (prev) {
        for (let p = 0; p < idx.length; p++) { if (cur[p] === prev[p]) idx[p] = 255; else idx[p] = cur[p]; }
        useT = true;
      } else idx.set(cur);
      out.push(0x21, 0xF9, 4, (1 << 2) | (useT ? 1 : 0), delay & 255, delay >> 8, 255, 0);
      out.push(0x2C); w16(0); w16(0); w16(W); w16(H); out.push(0);
      out.push(8);
      const data = lzw(idx, 8);
      for (let i = 0; i < data.length; i += 255) { const part = data.slice(i, i + 255); out.push(part.length, ...part); }
      out.push(0);
      prev = cur;
      if (onProg) onProg((f + 1) / frames.length);
    });
    out.push(0x3B);
    return new Blob([new Uint8Array(out)], { type: 'image/gif' });
  }
  window.encodeGif = encodeGif;

  /* ---------- GIF export (frame by frame) ---------- */
  let gifUrl = null;
  async function runGif() {
    if (S.exporting) return;
    if (!S.clips.length) return toast('Add a clip first');
    pause();
    const fps = +$('gFps').value, short = +$('gRes').value;
    const MAXS = 30;
    const secs = Math.min(S.total, MAXS);
    if (S.total > MAXS) toast('GIFs are limited to ' + MAXS + ' s. Exporting the first ' + MAXS + ' s.');
    const N = Math.max(1, Math.round(secs * fps));
    S.exporting = true; S.fast = true; cancelled = false;
    $('busy').classList.add('on'); $('busyProg').value = 0; busyMsg('Preparing GIF…');
    let blob = null, err = null;
    try {
      if (window.prepareCutouts) { try { await prepareCutouts(); } catch (e) { } }
      setSize(short);
      const W = cv.width, H = cv.height;
      for (const c of S.clips) {
        c.fs = null; c.exFrame = null;
        if (c.type === 'video' && c.blob && window.FrameSource) { try { c.fs = await FrameSource.open(c.blob); } catch (e) { c.fs = null; } }
      }
      const frames = [];
      for (let i = 0; i < N; i++) {
        if (cancelled) break;
        const t = Math.min(i / fps, Math.max(0, S.total - 0.0005));
        S.t = t;
        for (const c of S.clips) c.exFrame = null;
        for (const { c } of frameState(t)) {
          if (c.type !== 'video') continue;
          const target = clamp(srcAt(c, t - c.start), 0, Math.max(0, c.dur - 0.001));
          if (c.fs && !c.fs.failed) { try { c.exFrame = await c.fs.frameAt(target); } catch (e) { c.fs.failed = true; c.exFrame = null; } }
          if (!c.exFrame) await seekEl(c.el, target);
        }
        render(true);
        frames.push(ctx.getImageData(0, 0, W, H).data);
        if (i % 2 === 0) { $('busyProg').value = 0.5 * (i + 1) / N; busyMsg(`Capturing frames… ${Math.round((i + 1) / N * 100)}%`); await sleep(0); }
      }
      if (!cancelled) {
        busyMsg('Building GIF…'); await sleep(20);
        blob = encodeGif(frames, W, H, fps, p => { $('busyProg').value = 0.5 + 0.5 * p; });
      }
    } catch (e) { err = e; console.warn(e); }
    S.clips.forEach(c => { if (c.fs) { try { c.fs.close(); } catch (e) { } c.fs = null; } c.exFrame = null; });
    S.exporting = false; S.fast = false;
    $('busy').classList.remove('on');
    setSize(S.prev); S.t = 0; pauseAllMedia(); updateTime(); drawTimeline();
    if (cancelled) return toast('Export cancelled');
    if (err || !blob) return toast('GIF export failed' + (err ? ': ' + err.message : ''));
    if (gifUrl) URL.revokeObjectURL(gifUrl);
    gifUrl = URL.createObjectURL(blob);
    $('gOut').src = gifUrl; $('gOut').style.display = 'block';
    $('gDl').style.display = '';
    $('gDl').textContent = 'Save GIF (' + (blob.size / 1048576).toFixed(1) + ' MB)';
    $('gDl').onclick = () => downloadBlob(blob, 'vided.gif');
    window.__lastGif = blob;
  }
  $('gBtn').onclick = runGif;

  /* ---------- audio-only WAV ---------- */
  $('wavBtn').onclick = async () => {
    if (S.exporting) return;
    if (!S.clips.length && !S.audio.length) return toast('Add something first');
    pause();
    S.exporting = true;
    $('busy').classList.add('on'); $('busyProg').value = 0; busyMsg('Mixing audio…');
    try {
      if (window.prepareDucking) { try { await prepareDucking(); } catch (e) { } }
      await sleep(30);
      const mix = await mixAudio(S.total, 44100);
      if (!mix) toast('There is no sound in this project');
      else downloadBlob(wavBlob([mix.getChannelData(0), mix.getChannelData(1)], mix.sampleRate), 'vided-audio.wav');
    } catch (e) { toast('Audio export failed: ' + e.message); }
    S.exporting = false;
    $('busy').classList.remove('on');
  };
})();
