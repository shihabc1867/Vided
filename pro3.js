/* Vided Phase 10: keyframe easing, auto-reframe (follow the action), extra transition support lives in app.js. */
(function () {
  const box = $('n-animate');
  const hint = box.querySelector('.hint');
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="lbl">Keyframe easing (at the playhead; all keyframes if none is here)</label>
    <select id="kfEase">
      <option value="ease">Smooth (default)</option><option value="linear">Linear</option><option value="in">Ease in (accelerate)</option>
      <option value="out">Ease out (decelerate)</option><option value="bounce">Bounce</option><option value="back">Overshoot</option><option value="hold">Hold (jump)</option>
    </select>
    <label class="lbl">Auto-reframe</label>
    <button id="bReframe" class="accent">Auto-reframe: follow the action</button>
    <div class="hint">Fills the frame and pans to follow movement in the clip (good for turning 16:9 videos into 9:16). It tracks motion, not faces. Check the result and adjust the keyframes if needed.</div>`;
  hint.before(wrap);

  $('kfEase').onchange = e => {
    const c = selClip(); if (!c) return;
    if (!c.kf.length) return toast('Add keyframes first (Add keyframe here)');
    touch('kfe' + nid());
    const lt = clamp(S.t - c.start, 0, len(c));
    const k = c.kf.find(k => Math.abs(k.t - lt) < 0.06);
    if (k) { k.ease = e.target.value; toast('Easing set for the keyframe at the playhead'); }
    else { c.kf.forEach(k => { k.ease = e.target.value; }); toast('Easing set for all keyframes'); }
    render(true); markDirty();
  };

  $('bReframe').onclick = async () => {
    const c = selClip();
    if (!c || c.type !== 'video') return toast('Select a video clip first');
    if (isSpecial(c)) return toast('Auto-reframe does not work on reversed, ramped or frozen clips');
    if (S.exporting) return;
    pause();
    $('busy').classList.add('on'); $('busyProg').value = 0; busyMsg('Analysing motion…');
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(c.blob);
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Cannot read this clip')); });
      const sw = v.videoWidth, sh = v.videoHeight, W = cv.width, H = cv.height;
      const s = Math.max(W / sw, H / sh);
      const maxX = Math.max(0, (sw * s - W) / 2), maxY = Math.max(0, (sh * s - H) / 2);
      if (maxX < 2 && maxY < 2) throw new Error('This clip already fills the frame, nothing to pan');
      const gw = 48, gh = Math.max(8, Math.round(48 * sh / sw));
      const g = document.createElement('canvas'); g.width = gw; g.height = gh;
      const gx = g.getContext('2d', { willReadFrequently: true });
      const span = c.out - c.in, n = clamp(Math.round(span * 2.5), 4, 40);
      const pts = [];
      let prev = null, last = [0.5, 0.5];
      for (let i = 0; i <= n; i++) {
        const st = Math.min(c.out - 0.02, c.in + span * i / n);
        await seekEl(v, st);
        gx.drawImage(v, 0, 0, gw, gh);
        const d = gx.getImageData(0, 0, gw, gh).data, gray = new Float32Array(gw * gh);
        for (let p = 0; p < gw * gh; p++) gray[p] = 0.3 * d[p * 4] + 0.59 * d[p * 4 + 1] + 0.11 * d[p * 4 + 2];
        let cx = last[0], cy = last[1];
        if (prev) {
          let tw = 0, sx = 0, sy = 0;
          for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
            const df = Math.abs(gray[y * gw + x] - prev[y * gw + x]);
            if (df > 22) { tw += df; sx += df * x; sy += df * y; }
          }
          if (tw > 400) { cx = sx / tw / (gw - 1); cy = sy / tw / (gh - 1); }
        }
        pts.push({ st, cx, cy });
        last = [cx, cy]; prev = gray;
        $('busyProg').value = i / n;
      }
      if (pts.length > 1) { pts[0].cx = pts[1].cx; pts[0].cy = pts[1].cy; }
      // smooth the path so the camera glides
      let ex = pts[0].cx, ey = pts[0].cy;
      pts.forEach(p => { ex += (p.cx - ex) * 0.45; ey += (p.cy - ey) * 0.45; p.cx = ex; p.cy = ey; });
      touch('reframe' + nid());
      c.fit = 'cover'; c.sc = 100;
      c.kf = pts.map(p => ({
        t: +((p.st - c.in) / c.speed).toFixed(3), sc: 100, rot: c.rot || 0, op: c.op == null ? 100 : c.op, ease: 'ease',
        px: +(clamp((0.5 - p.cx) * sw * s, -maxX, maxX) / W * 100).toFixed(2),
        py: +(clamp((0.5 - p.cy) * sh * s, -maxY, maxY) / H * 100).toFixed(2)
      }));
      c.kf[0].t = 0; c.kf[c.kf.length - 1].t = len(c);
      toast('Auto-reframe done: ' + c.kf.length + ' keyframes');
    } catch (e) { toast(e.message); }
    URL.revokeObjectURL(v.src);
    $('busy').classList.remove('on');
    refreshAll(); markDirty();
  };
})();
