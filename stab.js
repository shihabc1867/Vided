/* Vided Phase 14: video stabilizer. Estimates camera shake (movement + tilt) from the footage,
   smooths the camera path, and counter-moves each frame (with a small zoom to hide the edges). */
(function () {
  const GW = 96;

  window.stabAt = function (c, lt) {
    const d = c.stab; if (!d || !d.x || !d.x.length) return null;
    const st = srcAt(c, lt);
    let f = (st - d.t0) * d.fps;
    f = f < 0 ? 0 : f > d.x.length - 1 ? d.x.length - 1 : f;
    const i = Math.floor(f), j = Math.min(d.x.length - 1, i + 1), u = f - i;
    const L = a => a[i] + (a[j] - a[i]) * u;
    return { x: L(d.x), y: L(d.y), r: L(d.r), z: d.z };
  };

  /* best (u,v) minimising sum |cur(x,y) - prev(x+u, y+v)| over a region */
  function match(prev, cur, gw, gh, x0, x1, R) {
    const N = 2 * R + 1, sad = new Float64Array(N * N);
    let best = 1e18, bu = 0, bv = 0, cnt = (x1 - x0) * (gh - 2 * R);
    for (let v = -R; v <= R; v++) for (let u = -R; u <= R; u++) {
      let s = 0;
      for (let y = R; y < gh - R; y++) {
        const ro = y * gw, po = (y + v) * gw + u;
        for (let x = x0; x < x1; x++) s += Math.abs(cur[ro + x] - prev[po + x]);
      }
      sad[(v + R) * N + u + R] = s;
      if (s < best) { best = s; bu = u; bv = v; }
    }
    const sub = (a, b, c) => { const dn = a - 2 * b + c; return dn > 1e-9 ? 0.5 * (a - c) / dn : 0; };
    let su = 0, sv = 0;
    if (bu > -R && bu < R) su = sub(sad[(bv + R) * N + bu - 1 + R], best, sad[(bv + R) * N + bu + 1 + R]);
    if (bv > -R && bv < R) sv = sub(sad[(bv - 1 + R) * N + bu + R], best, sad[(bv + 1 + R) * N + bu + R]);
    return { u: bu + clamp(su, -1, 1), v: bv + clamp(sv, -1, 1), cost: best / Math.max(1, cnt) };
  }

  function smooth(arr, sig) {
    const n = arr.length, out = new Float64Array(n), rad = Math.max(1, Math.ceil(sig * 2.5));
    for (let i = 0; i < n; i++) {
      let s = 0, w = 0;
      for (let k = -rad; k <= rad; k++) {
        const j = i + k; if (j < 0 || j >= n) continue;
        const g = Math.exp(-(k * k) / (2 * sig * sig)); s += arr[j] * g; w += g;
      }
      out[i] = s / w;
    }
    return out;
  }

  window.analyseStab = async function (c, strength, fixTilt, onProg) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(c.blob);
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Cannot read this clip')); });
      const gh = Math.max(24, Math.round(GW * v.videoHeight / v.videoWidth)), R = 10;
      const span = c.out - c.in;
      const fps = Math.min(30, Math.max(6, 900 / span));
      const n = Math.max(3, Math.floor(span * fps) + 1);
      const g = document.createElement('canvas'); g.width = GW; g.height = gh;
      const gx = g.getContext('2d', { willReadFrequently: true });
      let prev = null;
      const mx = new Float64Array(n), my = new Float64Array(n), mr = new Float64Array(n);
      let ax = 0, ay = 0, ar = 0;
      for (let i = 0; i < n; i++) {
        await seekEl(v, Math.min(c.out - 0.02, c.in + i / fps));
        gx.drawImage(v, 0, 0, GW, gh);
        const d = gx.getImageData(0, 0, GW, gh).data, gray = new Float32Array(GW * gh);
        for (let p = 0; p < GW * gh; p++) gray[p] = 0.3 * d[p * 4] + 0.59 * d[p * 4 + 1] + 0.11 * d[p * 4 + 2];
        if (prev) {
          const L = match(prev, gray, GW, gh, R, GW / 2 | 0, R), Rr = match(prev, gray, GW, gh, GW / 2 | 0, GW - R, R);
          // content moved by minus (u,v)
          let dx = -(L.u + Rr.u) / 2, dy = -(L.v + Rr.v) / 2, dr = fixTilt ? (-Rr.v + L.v) / (GW / 2) : 0;
          if (L.cost > 40 && Rr.cost > 40) { dx = dy = dr = 0; }      // scene cut / unreliable: do not follow
          ax += dx; ay += dy; ar += dr;
        }
        mx[i] = ax; my[i] = ay; mr[i] = ar;
        prev = gray;
        if (onProg) onProg(i / n);
      }
      const sig = strength * fps;
      const sx = smooth(mx, sig), sy = smooth(my, sig), sr = smooth(mr, sig);
      const MAXT = 0.12, MAXR = 0.12;
      const X = [], Y = [], Rt = [];
      let mt = 0, mrot = 0;
      for (let i = 0; i < n; i++) {
        const qx = clamp((sx[i] - mx[i]) / GW, -MAXT, MAXT), qy = clamp((sy[i] - my[i]) / gh, -MAXT, MAXT), qr = fixTilt ? clamp(sr[i] - mr[i], -MAXR, MAXR) : 0;
        X.push(+qx.toFixed(5)); Y.push(+qy.toFixed(5)); Rt.push(+qr.toFixed(5));
        mt = Math.max(mt, Math.abs(qx), Math.abs(qy)); mrot = Math.max(mrot, Math.abs(qr));
      }
      const z = clamp(1 + 2 * mt + mrot * 0.9 + 0.01, 1.01, 1.35);
      return { fps, t0: c.in, x: X, y: Y, r: Rt, z: +z.toFixed(3), strength, dbg: window.__stabDbg ? { mx: Array.from(mx), my: Array.from(my), mr: Array.from(mr), gh } : undefined };
    } finally { URL.revokeObjectURL(v.src); }
  };

  /* ---------- UI (Media tab) ---------- */
  const w = document.createElement('div');
  w.innerHTML = `
    <label class="lbl">Stabilizer</label>
    <select id="stabStr">
      <option value="0.25">Light (keeps natural movement)</option>
      <option value="0.5" selected>Normal</option>
      <option value="1">Strong (tripod-like)</option>
    </select>
    <label class="check"><input type="checkbox" id="stabTilt" checked> Also fix tilt (rotation)</label>
    <div class="grid2"><button id="bStab" class="accent">Stabilize this clip</button><button id="bStabOff">Remove</button></div>
    <div class="hint" id="stabInfo">Removes camera shake. The picture is zoomed in a little so the edges never show.</div>`;
  const anchor = $('bSilence').nextElementSibling;
  anchor.after(w);

  function info() {
    const c = selClip();
    $('stabInfo').textContent = c && c.stab ? `Stabilized (zoom ${Math.round((c.stab.z - 1) * 100)}%). Re-run to change the strength.` : 'Removes camera shake. The picture is zoomed in a little so the edges never show.';
  }
  $('bStab').onclick = async () => {
    const c = selClip();
    if (!c || c.type !== 'video') return toast('Select a video clip first');
    if (S.exporting) return;
    if (c.out - c.in > 120) return toast('Stabilizer works on clips up to 2 minutes. Split the clip first.');
    pause();
    $('busy').classList.add('on'); $('busyProg').value = 0; busyMsg('Analysing camera movement…');
    try {
      const d = await analyseStab(c, +$('stabStr').value, $('stabTilt').checked, p => { $('busyProg').value = p; });
      touch('stab' + nid());
      c.stab = d;
      toast(`Stabilized. The picture is zoomed in ${Math.round((d.z - 1) * 100)}% to hide the edges.`);
    } catch (e) { toast(e.message || 'Stabilizer failed'); }
    $('busy').classList.remove('on');
    refreshAll(); render(true); markDirty();
  };
  $('bStabOff').onclick = () => { const c = selClip(); if (!c || !c.stab) return toast('This clip is not stabilized'); touch('stabx' + nid()); c.stab = null; refreshAll(); render(true); };

  const prev = window.refreshFx;
  window.refreshFx = function () { if (prev) prev(); info(); };
})();
