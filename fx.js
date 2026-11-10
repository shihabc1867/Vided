/* Vided Phase 8: time effects (reverse, speed ramp, freeze & hold), overlay track (picture-in-picture),
   blend modes, shape masks and borders. Uses globals from app.js. */
(function () {
  const isOv = c => c && c.layer === 1;

  window.refreshFx = function () {
    const c = selClip();
    const img = c && c.type === 'image';
    $('n-ovat').style.display = isOv(c) ? '' : 'none';
    if (!c) return;
    if (isOv(c)) setR('ovAt', Math.round((c.at || 0) * 10) / 10, 0, Math.max(10, Math.ceil(S.total + 5)));
    $('revOn').checked = !!c.rev;
    $('revOn').disabled = img;
    $('rampSel').value = c.ramp || '';
    $('rampSel').disabled = img;
    $('bHold').disabled = img || isOv(c);
    $('fBlend').value = c.blend || 'source-over';
    $('fMask').value = c.mask || 'none';
    setR('fBw', c.bw || 0);
    $('fBc').value = c.bc || '#ffffff';
  };

  function timingChanged() { compute(); S.t = clamp(S.t, 0, S.total); refreshAll(); }

  $('revOn').onchange = e => {
    const c = selClip(); if (!c || c.type !== 'video') return;
    touch('rev' + nid());
    c.rev = e.target.checked;
    if (c.rev && c.vol > 0) toast('Reverse: sound is silent in preview; exports play the clip backwards');
    timingChanged();
  };
  $('rampSel').onchange = e => {
    const c = selClip(); if (!c || c.type !== 'video') return;
    touch('ramp' + nid());
    c.ramp = e.target.value || '';
    if (c.ramp) toast('Speed ramp: this clip plays without sound');
    timingChanged();
  };

  $('bHold').onclick = () => {
    const c = selClip();
    if (!c || c.type !== 'video') return toast('Select a video clip first');
    if (isOv(c)) return toast('Freeze & hold works on the main track');
    const n0 = S.clips.length;
    $('bSplit').onclick();
    if (S.clips.length === n0 + 1) {
      const b = selClip();                         // right-hand part, selected by split
      const h = dupClip(c);
      h.fz = +$('fzLen').value;
      h.in = c.out; h.out = Math.min(c.dur, c.out + 0.04);
      h.speed = 1; h.vol = 0; h.kf = []; h.fi = 0; h.fo = 0; h.rev = false; h.ramp = '';
      h.tr = { type: 'none', dur: 0.5 };
      S.clips.splice(S.clips.indexOf(b), 0, h);
      S.sel = h.id;
      compute(); refreshAll();
      toast('Frozen for ' + h.fz + ' s');
    }
  };

  /* overlay track */
  const PIP = { sc: 38 };
  function pipPlace(c, corner) {
    const W = cv.width, H = cv.height;
    const el = c.el;
    let sw = c.type === 'video' ? el.videoWidth : el.naturalWidth, sh = c.type === 'video' ? el.videoHeight : el.naturalHeight;
    if (c.fs && c.fs.rot % 180) [sw, sh] = [sh, sw];
    if (!sw || !sh) return;
    const base = c.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
    const bw = sw * base * c.sc / 100, bh = sh * base * c.sc / 100, m = 0.04 * Math.min(W, H);
    const x = (W / 2 - bw / 2 - m) / W * 100, y = (H / 2 - bh / 2 - m) / H * 100;
    c.px = corner[1] === 'l' ? -x : x;
    c.py = corner[0] === 't' ? -y : y;
    c.kf = [];
  }
  $('addOverlay').onchange = async e => {
    const files = [...e.target.files]; e.target.value = '';
    if (!S.clips.some(k => k.layer !== 1)) return toast('Add a main video or image first');
    for (const f of files) {
      try {
        touch('addO' + nid());
        const c = await makeClip(f);
        c.layer = 1; c.at = Math.max(0, S.t); c.fit = 'contain';
        c.sc = PIP.sc; c.mask = 'rounded'; c.bw = 3; c.bc = '#ffffff';
        S.clips.push(c); wire(c);
        pipPlace(c, 'br');
        compute();
        S.sel = c.id;
        refreshAll();
      } catch (er) { toast(er.message); U.pop(); }
    }
    toast('Overlay added. Use Adjust → Picture-in-picture to move it.');
  };
  document.querySelectorAll('[data-pip]').forEach(b => {
    b.onclick = () => {
      const c = selClip(); if (!c) return toast('Select a clip first');
      touch('pip' + nid());
      if (!isOv(c) && c.sc >= 100) c.sc = PIP.sc;
      pipPlace(c, b.dataset.pip);
      refreshAll();
    };
  });
  $('ovAt').oninput = e => {
    const c = selClip(); if (!c || !isOv(c)) return;
    touch('ovat');
    c.at = +e.target.value;
    compute(); updateTime(); drawTimeline();
  };

  /* blend / mask / border */
  $('fBlend').onchange = e => { const c = selClip(); if (!c) return; touch('blend' + nid()); c.blend = e.target.value; };
  $('fMask').onchange = e => { const c = selClip(); if (!c) return; touch('mask' + nid()); c.mask = e.target.value; };
  $('fBw').oninput = e => { const c = selClip(); if (!c) return; touch('fBw'); c.bw = +e.target.value; };
  $('fBc').oninput = e => { const c = selClip(); if (!c) return; touch('fBc'); c.bc = e.target.value; };
})();
