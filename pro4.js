/* Vided Phase 11: auto-cut silences, auto-enhance, more template packs. */
(function () {
  /* ---------- more template packs ---------- */
  Object.assign(PACKS, {
    subscribe: base => [
      { text: 'SUBSCRIBE', size: 64, y: 0.82, bgOn: true, bg: '#e53935', anim: 'pop', from: base, to: base + 4 },
      { text: '🔔 Like  ·  Share  ·  Follow', size: 38, y: 0.90, anim: 'fade', bold: false, from: base + 0.4, to: base + 4 }
    ],
    quote: base => [
      { text: '“', size: 260, y: 0.30, color: '#ffd400', anim: 'fade', from: base, to: base + 5 },
      { text: 'Your quote goes here', size: 70, y: 0.48, anim: 'zoom', from: base + 0.2, to: base + 5 },
      { text: '— Author name', size: 40, y: 0.62, color: '#cccccc', bold: false, anim: 'fade', from: base + 0.8, to: base + 5 }
    ],
    news: base => [
      { text: 'BREAKING NEWS', size: 46, x: 0.28, y: 0.86, bgOn: true, bg: '#c62828', anim: 'left', from: base, to: base + 6 },
      { text: 'Your headline text runs here', size: 36, x: 0.6, y: 0.93, bgOn: true, bg: '#111111', bold: false, anim: 'right', from: base + 0.2, to: base + 6 }
    ],
    chapter: base => [
      { text: '01', size: 200, y: 0.40, color: '#7a5cff', anim: 'bounce', from: base, to: base + 3 },
      { text: 'CHAPTER TITLE', size: 64, y: 0.55, anim: 'slide', from: base + 0.3, to: base + 3 }
    ],
    social: base => [
      { text: '@yourhandle', size: 42, x: 0.5, y: 0.94, anim: 'fade', bold: false, from: base, to: Math.max(base + 3, S.total) }
    ],
    title2: base => [
      { text: 'BIG IMPACT TITLE', size: 110, y: 0.42, bgOn: true, bg: '#111111', anim: 'zoom', from: base, to: base + 3 },
      { text: 'SUBTITLE LINE', size: 44, y: 0.55, color: '#ffd400', anim: 'type', bold: false, from: base + 0.5, to: base + 3 }
    ]
  });
  const row = document.querySelector('[data-pack="count"]').parentElement;
  [['subscribe', 'Subscribe + like'], ['quote', 'Quote card'], ['news', 'Breaking news bar'], ['chapter', 'Chapter title'], ['social', '@handle (whole video)'], ['title2', 'Impact title']].forEach(([k, l]) => {
    const b = document.createElement('button'); b.dataset.pack = k; b.textContent = l; row.appendChild(b);
    b.onclick = () => {
      const base = +(k === 'social' ? 0 : S.t).toFixed(1);
      touch('pack' + nid());
      const made = PACKS[k](base).map(o => ({ id: nid(), text: '', x: 0.5, y: 0.5, size: 64, color: '#ffffff', bgOn: false, bg: '#7a5cff', anim: 'none', bold: true, ...o, from: +o.from.toFixed(2), to: +o.to.toFixed(2) }));
      S.texts.push(...made); S.tsel = made[0].id;
      refreshAll(); seek(Math.min(S.total, base + 0.5));
      toast('Added ' + made.length + ' text layer' + (made.length > 1 ? 's' : '') + '. Edit them in the list below.');
    };
  });

  /* ---------- auto-enhance + auto-cut silences (Media/Adjust panels) ---------- */
  const mBox = $('bHold').parentElement.parentElement;
  const w = document.createElement('div');
  w.innerHTML = `
    <label class="lbl">Auto-cut silences (jump cuts)</label>
    <div class="field"><label><span>Cut pauses longer than</span><b id="v-silGap"></b></label><input type="range" id="silGap" min="0.2" max="2" step="0.1" value="0.5"></div>
    <button id="bSilence" class="accent">Remove silences from this clip</button>
    <div class="hint">Finds the parts where someone is speaking and cuts the quiet gaps out. Works best on talking videos.</div>`;
  $('bDetach').after(w);
  $('silGap').dataset.unit = ' s'; $('silGap').addEventListener('input', () => showVal($('silGap'))); showVal($('silGap'));

  const aw = document.createElement('div');
  aw.innerHTML = '<label class="lbl">One-tap fix</label><button id="bEnhance" class="accent">Auto enhance (brightness, contrast, colour)</button>';
  $('fBlend').previousElementSibling.before(aw);

  $('bEnhance').onclick = () => {
    const c = selClip(); if (!c) return toast('Select a clip first');
    const el = c.el, g = document.createElement('canvas'); g.width = 64; g.height = 64;
    const x = g.getContext('2d', { willReadFrequently: true });
    try { x.drawImage(el, 0, 0, 64, 64); } catch (e) { return toast('Cannot read this clip yet'); }
    const d = x.getImageData(0, 0, 64, 64).data, h = new Uint32Array(256);
    let sum = 0, sat = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2], l = Math.round(0.2126 * r + 0.7152 * gg + 0.0722 * b);
      h[l]++; sum += l; n++;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b); sat += mx ? (mx - mn) / mx : 0;
    }
    const pct = q => { let a = 0; for (let i = 0; i < 256; i++) { a += h[i]; if (a >= n * q) return i; } return 255; };
    const lo = pct(0.02), hi = pct(0.98), mean = sum / n, s = sat / n;
    const b = clamp(100 * Math.pow(120 / Math.max(30, mean), 0.7), 70, 160);
    const range = Math.max(60, (hi - lo) * b / 100);
    const ct = clamp(100 * Math.pow(210 / range, 0.8), 90, 165);
    const sa = s < 0.22 ? 130 : s < 0.38 ? 115 : 100;
    touch('enh' + nid());
    c.f = { ...c.f, b: Math.round(b), c: Math.round(ct), s: sa };
    refreshAll(); render(true);
    toast(`Enhanced: brightness ${Math.round(b)}%, contrast ${Math.round(ct)}%, saturation ${sa}%`);
  };

  $('bSilence').onclick = async () => {
    const c = selClip();
    if (!c || c.type !== 'video') return toast('Select a video clip first');
    if (c.layer === 1 || isSpecial(c)) return toast('Use this on a normal main-track clip');
    const gap = +$('silGap').value;
    $('busy').classList.add('on'); $('busyProg').value = 0.3; busyMsg('Listening for speech…');
    let r = null;
    try { r = speechOf(c); if (r && r.p) await r.p; } catch (e) { }
    $('busy').classList.remove('on');
    const iv = r && r.iv ? r.iv : [];
    // speech intervals inside the clip, padded a little and merged when the pause is short
    let segs = [];
    iv.forEach(([a, b]) => { a = Math.max(c.in, a - 0.12); b = Math.min(c.out, b + 0.18); if (b - a > 0.05) segs.push([a, b]); });
    segs.sort((p, q) => p[0] - q[0]);
    const merged = [];
    segs.forEach(s => { const l = merged[merged.length - 1]; if (l && s[0] - l[1] < gap) l[1] = Math.max(l[1], s[1]); else merged.push([...s]); });
    if (!merged.length) return toast('No speech found in this clip');
    const kept = merged.reduce((a, s) => a + (s[1] - s[0]), 0);
    if (merged.length === 1 && merged[0][0] <= c.in + 0.05 && merged[0][1] >= c.out - 0.05) return toast('No pauses longer than ' + gap + ' s found');
    touch('sil' + nid());
    const idx = S.clips.indexOf(c);
    const parts = merged.map((s, i) => {
      const p = cloneClip(c);
      p.id = nid(); p.in = s[0]; p.out = s[1]; p.kf = []; p.fi = 0; p.fo = 0;
      p.tr = i === 0 ? { ...c.tr } : { type: 'none', dur: 0.5 };
      return p;
    });
    S.clips.splice(idx, 1, ...parts);
    parts.forEach(p => { if (typeof wire === 'function') wire(p); });
    S.sel = parts[0].id;
    compute(); S.t = clamp(S.t, 0, S.total); refreshAll();
    toast(`Cut into ${parts.length} parts. Removed ${(c.out - c.in - kept).toFixed(1)} s of silence.`);
  };
})();
