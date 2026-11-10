/* Vided Phase 13: Premiere-style tools. Adjustment layers, scopes, slip / roll trim, insert edit,
   save-frame PNG, loudness normalise. */
(function () {
  const sec = $('p-fx'), box = $('n-fx');

  /* ================= adjustment layers ================= */
  const adjTop = document.createElement('div');
  adjTop.innerHTML = `
    <label class="lbl">Adjustment layer (look over every clip below it)</label>
    <button id="adjAdd" class="accent">+ Add adjustment layer at playhead (5 s)</button>
    <div id="adjInfo" class="hint">Tap the yellow bar on the timeline to edit it. Effects, colour grading and LUTs below then apply to everything underneath it.</div>
    <div id="adjCtl" style="display:none"></div>`;
  sec.insertBefore(adjTop, sec.firstChild);
  const adjCtl = $('adjCtl');
  const curAdj = () => (S.fxAdj && (S.adj || []).find(a => a.id === S.adjSel)) || null;

  $('adjAdd').onclick = () => {
    if (!S.clips.length) return toast('Add a clip first');
    touch('adjadd' + nid());
    const from = +S.t.toFixed(1), a = { id: nid(), from, to: +Math.min(Math.max(from + 5, from + 0.5), Math.max(S.total, from + 1)).toFixed(1), fx: {}, gr: {}, f: defFilter(), lutTxt: '', lutName: '', amt: 100 };
    if (a.to <= a.from + 0.2) a.to = +(a.from + 3).toFixed(1);
    S.adj = S.adj || []; S.adj.push(a);
    S.adjSel = a.id; S.fxAdj = true;
    refreshAll(); openTab('fx');
    toast('Adjustment layer added. Add effects below.');
  };

  function mk(label, id, min, max, def, onset) {
    const w = document.createElement('div'); w.className = 'field';
    w.innerHTML = `<label><span>${label}</span><b id="v-${id}"></b></label><input type="range" id="${id}" min="${min}" max="${max}" step="1" value="${def}">`;
    adjCtl.appendChild(w);
    const inp = w.querySelector('input'); inp.dataset.unit = '';
    inp.addEventListener('input', () => { showVal(inp); const a = curAdj(); if (!a) return; touch(id); onset(a, +inp.value); render(true); drawTimeline(); markDirty(); });
    showVal(inp);
    return inp;
  }
  const sAmt = mk('Layer strength', 'adjAmt', 0, 100, 100, (a, v) => { a.amt = v; });
  const sB = mk('Brightness', 'adjB', 0, 200, 100, (a, v) => { a.f = { ...a.f, b: v }; });
  const sC = mk('Contrast', 'adjC', 0, 200, 100, (a, v) => { a.f = { ...a.f, c: v }; });
  const sS = mk('Saturation', 'adjS', 0, 300, 100, (a, v) => { a.f = { ...a.f, s: v }; });
  const sFrom = mk('Starts at (s)', 'adjFrom', 0, 600, 0, (a, v) => { const d = a.to - a.from; a.from = v; a.to = v + d; });
  const sLen = mk('Length (s)', 'adjLen', 1, 120, 5, (a, v) => { a.to = a.from + v; });
  const bd = document.createElement('div'); bd.className = 'grid2';
  bd.innerHTML = '<button id="adjDel" class="danger">Delete adjustment layer</button><button id="adjClip">Edit clip instead</button>';
  adjCtl.appendChild(bd);
  $('adjDel').onclick = () => { const a = curAdj(); if (!a) return; touch('adjdel' + nid()); S.adj = S.adj.filter(x => x.id !== a.id); S.fxAdj = false; refreshAll(); };
  $('adjClip').onclick = () => { S.fxAdj = false; refreshAll(); };

  function refreshAdj() {
    const a = curAdj();
    adjCtl.style.display = a ? '' : 'none';
    if (!a) return;
    $('adjInfo').textContent = `Editing adjustment layer ${(S.adj.indexOf(a) + 1)}: ${a.from.toFixed(1)}–${a.to.toFixed(1)} s. Everything in the effect, grading and LUT sections below applies to this layer.`;
    sAmt.value = a.amt == null ? 100 : a.amt; sB.value = (a.f && a.f.b) || 100; sC.value = (a.f && a.f.c) || 100; sS.value = (a.f && a.f.s) || 100;
    sFrom.max = Math.max(60, Math.ceil(S.total + 10)); sFrom.value = Math.round(a.from); sLen.value = Math.round(a.to - a.from);
    [sAmt, sB, sC, sS, sFrom, sLen].forEach(showVal);
  }

  /* ================= scopes ================= */
  const sc = document.createElement('div');
  sc.innerHTML = `
    <label class="lbl">Scopes (read the picture like Premiere)</label>
    <select id="scopeMode">
      <option value="off">Scopes off</option><option value="wave">Waveform (brightness)</option><option value="hist">Histogram</option>
      <option value="parade">RGB parade</option><option value="vec">Vectorscope (colour)</option>
    </select>
    <canvas id="scope" width="256" height="128" style="display:none;width:100%;max-width:400px;background:#0a0a10;border-radius:8px;margin-top:6px"></canvas>`;
  box.insertBefore(sc, box.firstChild);
  const scv = $('scope'), sx = scv.getContext('2d');
  const probe = document.createElement('canvas'); probe.width = 160;
  const px = probe.getContext('2d', { willReadFrequently: true });
  function drawScope() {
    const mode = $('scopeMode').value;
    if (mode === 'off' || !$('p-fx').classList.contains('active') || S.exporting || !cv.width) return;
    probe.height = Math.max(8, Math.round(160 * cv.height / cv.width));
    px.drawImage(cv, 0, 0, probe.width, probe.height);
    const d = px.getImageData(0, 0, probe.width, probe.height).data, w = probe.width, h = probe.height, SW = 256, SH = 128;
    sx.fillStyle = '#0a0a10'; sx.fillRect(0, 0, SW, SH);
    sx.strokeStyle = 'rgba(255,255,255,.12)'; sx.lineWidth = 1;
    if (mode === 'wave' || mode === 'parade') {
      for (let i = 0; i <= 4; i++) { const y = Math.round(SH - i * SH / 4) + 0.5; sx.beginPath(); sx.moveTo(0, y); sx.lineTo(SW, y); sx.stroke(); }
      const chans = mode === 'wave' ? [[0.2126, 0.7152, 0.0722, '#6cff8a']] : [[1, 0, 0, '#ff5a5a'], [0, 1, 0, '#5aff7a'], [0, 0, 1, '#5a8bff']];
      const cw = SW / chans.length;
      chans.forEach(([kr, kg, kb, col], ci) => {
        sx.fillStyle = col; sx.globalAlpha = 0.18;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4, v = kr * d[i] + kg * d[i + 1] + kb * d[i + 2];
          sx.fillRect(ci * cw + x / w * cw, SH - 1 - v / 255 * (SH - 1), 1.6, 1.6);
        }
      });
      sx.globalAlpha = 1;
    } else if (mode === 'hist') {
      const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      for (let i = 0; i < d.length; i += 4) { bins[0][d[i]]++; bins[1][d[i + 1]]++; bins[2][d[i + 2]]++; }
      const mx = Math.max(1, ...bins.map(b => Math.max(...b)));
      ['#ff5a5a', '#5aff7a', '#5a8bff'].forEach((col, c) => {
        sx.strokeStyle = col; sx.globalAlpha = 0.9; sx.beginPath();
        for (let i = 0; i < 256; i++) { const y = SH - Math.sqrt(bins[c][i] / mx) * (SH - 4); i ? sx.lineTo(i, y) : sx.moveTo(i, y); }
        sx.stroke();
      });
      sx.globalAlpha = 1;
    } else {
      const cx = SW / 2, cy = SH / 2, R = SH / 2 - 4;
      sx.beginPath(); sx.arc(cx, cy, R, 0, Math.PI * 2); sx.stroke();
      sx.beginPath(); sx.moveTo(cx - R, cy); sx.lineTo(cx + R, cy); sx.moveTo(cx, cy - R); sx.lineTo(cx, cy + R); sx.stroke();
      sx.fillStyle = 'rgba(120,255,200,.35)';
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const cb = (-0.1687 * r - 0.3313 * g + 0.5 * b) / 128, cr = (0.5 * r - 0.4187 * g - 0.0813 * b) / 128;
        sx.fillRect(cx + cb * R * 1.6, cy - cr * R * 1.6, 2, 2);
      }
    }
  }
  $('scopeMode').onchange = () => { scv.style.display = $('scopeMode').value === 'off' ? 'none' : 'block'; drawScope(); };
  setInterval(() => { if (!S.exporting) drawScope(); }, 160);
  window.drawScope = drawScope;

  /* ================= slip / roll trim + insert edit ================= */
  const mw = document.createElement('div');
  mw.innerHTML = `
    <label class="lbl">Precision trim (Slip &amp; Roll)</label>
    <div class="grid2">
      <button data-slip="-1">Slip −1 s</button><button data-slip="1">Slip +1 s</button>
      <button data-slip="-0.1">Slip −0.1 s</button><button data-slip="0.1">Slip +0.1 s</button>
    </div>
    <div class="hint">Slip changes which part of the source plays, without moving the clip. Roll moves the cut between this clip and the next one.</div>
    <div class="grid2">
      <button data-roll="-0.1">Roll cut −0.1 s</button><button data-roll="0.1">Roll cut +0.1 s</button>
      <button data-roll="-0.5">Roll cut −0.5 s</button><button data-roll="0.5">Roll cut +0.5 s</button>
    </div>
    <label class="lbl">Insert edit</label>
    <label class="filebtn">Insert clip at playhead (ripple)
      <input type="file" id="insMedia" accept="video/*,image/*" hidden>
    </label>
    <div class="hint">Splits the clip under the playhead and puts the new clip in the gap, pushing everything after it later.</div>`;
  $('bDetach').after(mw);

  mw.querySelectorAll('[data-slip]').forEach(b => b.onclick = () => {
    const c = selClip(); if (!c || c.type !== 'video') return toast('Select a video clip first');
    if (isSpecial(c)) return toast('Not available on reversed, ramped or frozen clips');
    const d = +b.dataset.slip, span = c.out - c.in;
    const ni = clamp(c.in + d, 0, c.dur - span);
    if (Math.abs(ni - c.in) < 0.001) return toast('Already at the edge of the source video');
    touch('slip' + nid());
    c.out = ni + span; c.in = ni;
    compute(); refreshAll(); render(true);
  });
  mw.querySelectorAll('[data-roll]').forEach(b => b.onclick = () => {
    const c = selClip(); if (!c || c.layer === 1) return toast('Select a main-track clip');
    const mc = mainClips(), n = mc[mc.indexOf(c) + 1];
    if (!n) return toast('This is the last clip, there is no cut after it');
    if (c.type !== 'video' || n.type !== 'video') return toast('Roll needs two video clips');
    if (isSpecial(c) || isSpecial(n)) return toast('Not available on reversed, ramped or frozen clips');
    const d = +b.dataset.roll;                         // seconds of timeline; source moves by speed
    const nOut = c.out + d * c.speed, nIn = n.in + d * n.speed;
    if (nOut > c.dur + 0.001 || nOut < c.in + 0.1 || nIn < 0 || nIn > n.out - 0.1) return toast('Cannot roll that far (not enough footage)');
    touch('roll' + nid());
    c.out = nOut; n.in = nIn;
    compute(); refreshAll(); render(true);
  });

  $('insMedia').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const mc = mainClips();
      if (!mc.length) return toast('Add a main clip first, then use Insert');
      touch('ins' + nid());
      const nc = await makeClip(f);
      let at = mc.find(c => S.t > c.start + 0.1 && S.t < c.end - 0.1);
      let idx;
      if (at) {
        S.sel = at.id;
        const n0 = S.clips.length;
        const un = U.length;
        $('bSplit').onclick();
        if (S.clips.length === n0) throw new Error('Cannot split here');
        while (U.length > un + 1) U.pop();            // keep one undo step for split + insert
        idx = S.clips.indexOf(selClip());
        U.splice(un, 1);                               // drop split's own snapshot, ours (taken above) stays
      } else {
        const after = mc.filter(c => c.start >= S.t - 0.05)[0];
        idx = after ? S.clips.indexOf(after) : S.clips.length;
      }
      nc.layer = 0;
      S.clips.splice(idx, 0, nc); wire(nc);
      S.sel = nc.id;
      compute(); refreshAll(); toast('Inserted. Later clips moved to make room.');
    } catch (er) { toast(er.message); }
  };

  /* ================= save frame as PNG ================= */
  const fb = document.createElement('button'); fb.id = 'bFramePng'; fb.className = 'big'; fb.textContent = 'Save current frame (PNG)';
  $('wavBtn').before(fb);
  fb.onclick = async () => {
    if (S.exporting) return;
    if (!S.clips.length) return toast('Add a clip first');
    pause();
    const keep = S.t;
    S.exporting = true;
    try {
      setSize(Math.min(1080, +$('xRes').value || 720));
      render(true);
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      downloadBlob(blob, 'vided-frame.png');
    } catch (e) { toast('Could not save the frame'); }
    S.exporting = false; setSize(S.prev); S.t = keep; render(true);
  };

  /* ================= loudness normalise ================= */
  async function normalise(it, label) {
    if (!it || !it.blob) return toast('Select a ' + label + ' first');
    $('busy').classList.add('on'); $('busyProg').value = 0.4; busyMsg('Measuring loudness…');
    try {
      const buf = await decodeBlob(it.blob, 16000);
      const ch = buf.getChannelData(0), a0 = Math.floor((it.in || 0) * 16000), a1 = Math.min(ch.length, Math.floor((it.out == null ? buf.duration : it.out) * 16000));
      const win = 800; let sum = 0, n = 0;
      for (let s = a0; s + win < a1; s += win) {
        let e = 0; for (let i = s; i < s + win; i++) e += ch[i] * ch[i];
        const r = Math.sqrt(e / win);
        if (r > 0.003) { sum += e / win; n++; }          // ignore near-silence
      }
      if (!n) { toast('No sound found'); }
      else {
        const rms = Math.sqrt(sum / n), target = 0.14;
        const nv = clamp(Math.round((it.vol || 100) * target / rms), 5, 200);
        touch('norm' + nid()); it.vol = nv; refreshAll();
        toast(`Loudness matched: volume set to ${nv}%` + (nv >= 200 ? ' (maximum, the recording is very quiet)' : ''));
      }
    } catch (e) { toast('Could not measure this file'); }
    $('busy').classList.remove('on');
  }
  const nA = document.createElement('button'); nA.textContent = 'Normalise loudness (this track)'; nA.id = 'bNormA';
  $('aebass').closest('.field').parentElement.appendChild(nA);
  nA.onclick = () => normalise(selAudio(), 'audio track');
  const nC = document.createElement('button'); nC.textContent = 'Normalise loudness (this clip)'; nC.id = 'bNormC';
  $('cebass').closest('.field').parentElement.appendChild(nC);
  nC.onclick = () => { const c = selClip(); if (c && c.type !== 'video') return toast('Select a video clip first'); normalise(c, 'video clip'); };

  const prev = window.refreshFx;
  window.refreshFx = function () { if (prev) prev(); refreshAdj(); };
})();
