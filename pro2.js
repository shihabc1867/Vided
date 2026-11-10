/* Vided Phase 9b: audio EQ + voice effects, text exit animation/rotation, stickers,
   timeline markers, snapping, drag-to-move, detach audio. */
(function () {
  /* ================= audio effects engine (live + offline) ================= */
  const VFX = [['none', 'No effect'], ['telephone', 'Telephone'], ['megaphone', 'Megaphone'], ['robot', 'Robot'], ['echo', 'Echo'], ['hall', 'Big hall'], ['underwater', 'Underwater']];

  function impulse(x, secs, decay) {
    const sr = x.sampleRate, n = Math.floor(sr * secs), b = x.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  }
  function curve(k) { const n = 256, c = new Float32Array(n); for (let i = 0; i < n; i++) { const v = i * 2 / n - 1; c[i] = (1 + k) * v / (1 + k * Math.abs(v)); } return c; }

  window.buildAudioFx = function (x, eq, vfx) {
    eq = eq || {}; vfx = vfx || 'none';
    const parts = [];
    const biq = (type, f, g, q) => { const n = x.createBiquadFilter(); n.type = type; n.frequency.value = f; if (g != null) n.gain.value = g; if (q) n.Q.value = q; return n; };
    if (eq.bass) parts.push({ in: biq('lowshelf', 120, eq.bass * 0.12) });
    if (eq.mid) parts.push({ in: biq('peaking', 1200, eq.mid * 0.12, 0.9) });
    if (eq.treble) parts.push({ in: biq('highshelf', 5000, eq.treble * 0.12) });
    if (vfx === 'telephone') parts.push({ in: biq('highpass', 400), out: null }, { in: biq('lowpass', 3200) });
    else if (vfx === 'megaphone') { const ws = x.createWaveShaper(); ws.curve = curve(8); parts.push({ in: biq('highpass', 500) }, { in: biq('lowpass', 4000) }, { in: ws }); }
    else if (vfx === 'underwater') parts.push({ in: biq('lowpass', 520, null, 1.2) });
    else if (vfx === 'robot') {
      const g = x.createGain(); g.gain.value = 0;
      const o = x.createOscillator(); o.type = 'sine'; o.frequency.value = 55; o.connect(g.gain); o.start(0);
      parts.push({ in: g });
    } else if (vfx === 'echo' || vfx === 'hall') {
      const input = x.createGain(), out = x.createGain(), wet = x.createGain();
      input.connect(out);                                  // dry
      if (vfx === 'echo') {
        const d = x.createDelay(1); d.delayTime.value = 0.28; const fb = x.createGain(); fb.gain.value = 0.42;
        input.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.gain.value = 0.6;
      } else {
        const cv = x.createConvolver(); cv.buffer = impulse(x, 2.2, 2.6);
        input.connect(cv); cv.connect(wet); wet.gain.value = 0.7;
      }
      wet.connect(out);
      parts.push({ in: input, out });
    }
    if (!parts.length) return null;
    for (let i = 0; i < parts.length - 1; i++) (parts[i].out || parts[i].in).connect(parts[i + 1].in);
    const last = parts[parts.length - 1];
    return { input: parts[0].in, output: last.out || last.in };
  };

  window.applyAudioFx = function (it) {
    if (!AC || !it.src || !it.gain) return;
    try { it.src.disconnect(); } catch (e) { }
    if (it._fxo) { try { it._fxo.disconnect(); } catch (e) { } it._fxo = null; }
    const ch = buildAudioFx(AC, it.eq, it.vfx);
    if (ch) { it.src.connect(ch.input); ch.output.connect(it.gain); it._fxo = ch.output; }
    else it.src.connect(it.gain);
  };

  /* sliders/select builder for an audio item */
  function soundUI(parent, getItem, pre) {
    const mk = (k, label) => {
      const w = document.createElement('div'); w.className = 'field';
      const id = pre + k;
      w.innerHTML = `<label><span>${label}</span><b id="v-${id}"></b></label><input type="range" id="${id}" min="-100" max="100" step="1" value="0">`;
      parent.appendChild(w);
      const inp = w.querySelector('input'); inp.dataset.unit = '';
      inp.addEventListener('input', () => {
        showVal(inp);
        const it = getItem(); if (!it) return;
        touch(pre + k);
        it.eq = { ...(it.eq || {}), [k]: +inp.value };
        applyAudioFx(it); markDirty();
      });
      showVal(inp);
    };
    mk('bass', 'Bass'); mk('mid', 'Mids'); mk('treble', 'Treble');
    const lb = document.createElement('label'); lb.className = 'lbl'; lb.textContent = 'Voice / sound effect'; parent.appendChild(lb);
    const sel = document.createElement('select'); sel.id = pre + 'vfx';
    sel.innerHTML = VFX.map(v => `<option value="${v[0]}">${v[1]}</option>`).join('');
    parent.appendChild(sel);
    sel.onchange = () => { const it = getItem(); if (!it) return; touch(pre + 'vfx' + nid()); it.vfx = sel.value; applyAudioFx(it); markDirty(); };
    const note = document.createElement('div'); note.className = 'hint'; note.textContent = 'Effects are heard in the preview and in the exported video.'; parent.appendChild(note);
    return () => {
      const it = getItem();
      ['bass', 'mid', 'treble'].forEach(k => { const e = $(pre + k); e.value = (it && it.eq && it.eq[k]) || 0; showVal(e); });
      sel.value = (it && it.vfx) || 'none';
    };
  }
  const aBox = $('n-audio');
  const lA = document.createElement('label'); lA.className = 'lbl'; lA.textContent = 'Equaliser & effects'; aBox.appendChild(lA);
  const refA = soundUI(aBox, selAudio, 'ae');
  const fxBox = $('n-fx');
  const lC = document.createElement('label'); lC.className = 'lbl'; lC.textContent = 'Sound of this clip'; fxBox.appendChild(lC);
  const refC = soundUI(fxBox, selClip, 'ce');

  /* ================= text: exit animation, rotation, stickers ================= */
  const anim = $('tAnim');
  const l1 = document.createElement('label'); l1.className = 'lbl'; l1.textContent = 'Exit animation';
  const outSel = document.createElement('select'); outSel.id = 'tAnimOut';
  outSel.innerHTML = '<option value="none">None</option><option value="fade">Fade out</option><option value="down">Slide down</option><option value="up">Slide up</option><option value="left">Slide to left</option><option value="right">Slide to right</option><option value="zoom">Shrink</option>';
  anim.after(l1); l1.after(outSel);
  outSel.onchange = () => editText(L => { L.aout = outSel.value; }, 'taout' + nid());
  const rw = document.createElement('div'); rw.className = 'field';
  rw.innerHTML = '<label><span>Rotate</span><b id="v-tRot"></b></label><input type="range" id="tRot" min="-180" max="180" step="1" value="0">';
  outSel.after(rw);
  const rin = $('tRot'); rin.dataset.unit = '°';
  rin.addEventListener('input', () => { showVal(rin); editText(L => { L.rot = +rin.value; }, 'trot'); });
  showVal(rin);

  const stk = document.createElement('div');
  stk.innerHTML = '<label class="lbl">Stickers &amp; shapes (tap to add)</label><div id="stkGrid" class="stkgrid"></div>';
  $('p-text').appendChild(stk);
  const EMO = ['😀', '😂', '😍', '🔥', '❤️', '👍', '🎉', '⭐', '✨', '💯', '👑', '😎', '🥳', '😱', '🙏', '💥', '🎵', '📸', '✅', '❌', '⚡', '🌈', '☀️', '🌙', '🍕', '🚀', '💎', '🎬', '▶️', '⭕', '⬛', '➡️', '⬆️', '🔔', '📍', '💬'];
  const grid = $('stkGrid');
  EMO.forEach(e => {
    const b = document.createElement('button'); b.textContent = e; b.className = 'stk';
    b.onclick = () => {
      touch('stk' + nid());
      const L = newText({ text: e, size: 150, sticker: true, anim: 'pop', len: 3 });
      S.texts.push(L); S.tsel = L.id; refreshAll(); openTab('text');
    };
    grid.appendChild(b);
  });
  const prevRT = window.refreshText;
  window.refreshPro2 = function () {
    const L = selText();
    outSel.value = (L && L.aout) || 'none';
    rin.value = (L && L.rot) || 0; showVal(rin);
    refA(); refC();
  };

  /* ================= detach audio ================= */
  const dbtn = document.createElement('button'); dbtn.id = 'bDetach'; dbtn.textContent = 'Detach audio to a track';
  $('bHold').parentElement.after(dbtn);
  dbtn.onclick = async () => {
    const c = selClip();
    if (!c || c.type !== 'video') return toast('Select a video clip first');
    if (c.vol <= 0) return toast('This clip has no sound on (volume is 0)');
    const f = new File([c.blob], c.name.replace(/\.[^.]+$/, '') + ' (audio).mp4', { type: c.blob.type || 'video/mp4' });
    const n0 = S.audio.length;
    await addAudio([f]);
    const a = S.audio[S.audio.length - 1];
    if (S.audio.length === n0 + 1 && a) {
      a.start = c.start; a.in = c.in; a.out = Math.min(a.dur, c.out); a.vol = c.vol;
      c.vol = 0;
      refreshAll(); toast('Audio detached. You can now edit it in the Audio tab.');
    }
  };

  /* ================= markers + snapping + drag ================= */
  S.marks = S.marks || [];
  const near = 0.12;
  const bar = $('zoom').parentElement;
  const mb = document.createElement('div'); mb.className = 'markbar';
  mb.innerHTML = '<button id="mkPrev" title="Previous marker">&#9664;&#9873;</button><button id="mkAdd" title="Add or remove a marker here">&#9873; Marker</button><button id="mkNext" title="Next marker">&#9873;&#9654;</button><button id="mvMode" title="Drag overlays, text and audio on the timeline">&#10021; Move</button>';
  $('scrub').before(mb);
  $('mkAdd').onclick = () => {
    touch('mk' + nid());
    const i = S.marks.findIndex(m => Math.abs(m - S.t) < near);
    if (i >= 0) S.marks.splice(i, 1); else S.marks.push(+S.t.toFixed(2));
    S.marks.sort((a, b) => a - b); drawTimeline(); markDirty();
  };
  $('mkPrev').onclick = () => { const m = [...S.marks].reverse().find(v => v < S.t - 0.05); if (m != null) seek(m); else toast('No earlier marker'); };
  $('mkNext').onclick = () => { const m = S.marks.find(v => v > S.t + 0.05); if (m != null) seek(m); else toast('No later marker'); };

  let snapLine = null;
  window.drawMarks = function (g, H) {
    g.save();
    S.marks.forEach(m => {
      const x = Math.round(PAD + m * pps) + 0.5;
      g.strokeStyle = 'rgba(255,196,0,.55)'; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#ffc400'; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 9); g.closePath(); g.fill();
    });
    if (snapLine != null) { const x = Math.round(PAD + snapLine * pps) + 0.5; g.strokeStyle = '#00e0c0'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    g.restore();
  };

  let move = false;
  $('mvMode').onclick = () => {
    move = !move; $('mvMode').classList.toggle('on', move);
    tl.style.touchAction = move ? 'none' : '';
    toast(move ? 'Move mode: drag overlays, text and audio on the timeline' : 'Move mode off: drag to scroll');
  };

  function targets(skipId) {
    const T = [0, S.total, S.t, ...S.marks];
    S.clips.forEach(c => { if (c.id !== skipId) T.push(c.start, c.end); });
    S.texts.forEach(L => { if (L.id !== skipId) T.push(L.from, L.to); });
    S.audio.forEach(a => { if (a.id !== skipId) T.push(a.start, a.start + alen(a)); });
    return T;
  }
  function snapStart(start, dur, skipId) {
    const th = 8 / pps, T = targets(skipId);
    let best = null, bd = th;
    for (const t of T) {
      for (const e of [start, start + dur]) { const d = Math.abs(e - t); if (d < bd) { bd = d; best = { shift: t - e, at: t }; } }
    }
    return best;
  }
  window.snapStart = snapStart;

  let dr = null;
  const hitAt = (x, y) => { for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h; } return null; };
  tl.addEventListener('pointerdown', e => {
    if (!move) return;
    const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, h = hitAt(x, y);
    if (!h) return;
    let it = null, kind = h.kind;
    if (kind === 'clip') { it = S.clips.find(c => c.id === h.id); if (!it || it.layer !== 1) { toast('Main-track clips are reordered with the ◀ ▶ buttons'); return; } }
    else if (kind === 'text') it = S.texts.find(L => L.id === h.id);
    else if (kind === 'audio') it = S.audio.find(a => a.id === h.id);
    else return;
    if (!it) return;
    const orig = kind === 'clip' ? it.at || 0 : kind === 'text' ? it.from : it.start;
    const dur = kind === 'clip' ? len(it) : kind === 'text' ? it.to - it.from : alen(it);
    touch('drag' + nid());
    dr = { kind, it, x0: e.clientX, orig, dur, id: it.id };
    tl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  tl.addEventListener('pointermove', e => {
    if (!dr) return;
    let ns = Math.max(0, dr.orig + (e.clientX - dr.x0) / pps);
    const sn = snapStart(ns, dr.dur, dr.id);
    snapLine = null;
    if (sn) { ns = Math.max(0, ns + sn.shift); snapLine = sn.at; }
    ns = +ns.toFixed(3);
    const it = dr.it;
    if (dr.kind === 'clip') { it.at = ns; compute(); }
    else if (dr.kind === 'text') { it.from = ns; it.to = +(ns + dr.dur).toFixed(3); }
    else it.start = ns;
    if (dr.kind !== 'clip') compute();
    drawTimeline(); if (!S.playing) render(true);
    dr.moved = true;
  });
  const endDrag = e => {
    if (!dr) return;
    const moved = dr.moved, k = dr.kind, id = dr.id;
    dr = null; snapLine = null;
    tl._swallow = moved;
    if (moved) {
      if (k === 'clip') S.sel = id; else if (k === 'text') S.tsel = id; else S.asel = id;
      refreshAll(); markDirty();
    } else drawTimeline();
    setTimeout(() => { tl._swallow = false; }, 50);
  };
  tl.addEventListener('pointerup', endDrag);
  tl.addEventListener('pointercancel', endDrag);
  tl.addEventListener('click', e => { if (tl._swallow) e.stopImmediatePropagation(); }, true);

  /* hook refresh */
  const prev = window.refreshFx;
  window.refreshFx = function () { if (prev) prev(); if (window.refreshPro2) refreshPro2(); };
})();
