'use strict';
/* Fast MP4 export (WebCodecs).
   - Frames are rendered one by one (no waiting for real-time playback)
   - MP4/H.264 sources are decoded in order with VideoDecoder (no slow seeking)
   - Audio is mixed offline, then encoded (AAC when the device supports it, Opus otherwise)
   - Everything is written into a standard MP4 (H.264 + AAC) by mux.js
   If anything is unsupported or fails, doExport() falls back to real-time recording. */

const FAST = {
  ok: !!(window.VideoEncoder && window.VideoFrame && window.AudioEncoder && window.AudioData &&
    window.OfflineAudioContext && window.EncodedVideoChunk && window.Mp4Muxer)
};

(function initEngineSelect() {
  const sel = $('xEngine');
  if (!sel) return;
  if (!FAST.ok) {
    sel.querySelector('option[value="fast"]').remove();
    sel.value = 'realtime';
  }
  const sync = () => {
    $('xFmtWrap').style.display = sel.value === 'fast' ? 'none' : '';
    $('xEngineNote').textContent = sel.value === 'fast'
      ? 'Renders frame by frame, much faster than playing the video. Produces a standard MP4 (H.264).'
      : 'Records playback in real time (a 1-minute video takes 1 minute). Works on every browser.';
  };
  sel.onchange = sync;
  sync();
})();

const busyMsg = m => { $('busyMsg').textContent = m; };

async function doExport() {
  if (S.exporting) return;
  if (!S.clips.length) return toast('Add a clip first');
  pause();
  if (window.gateExport) gateExport();
  try { if (window.prepareDucking) await prepareDucking(); } catch (e) { }
  try { if (window.prepareCutouts) { busyMsg('Loading AI cutout…'); $('busy').classList.add('on'); await prepareCutouts(); $('busy').classList.remove('on'); } }
  catch (e) { $('busy').classList.remove('on'); return toast(e.message); }
  if ($('xEngine').value === 'fast' && FAST.ok) {
    const r = await runFast();
    if (r !== 'fallback') return;
    toast((runFast.lastError || 'Fast export is not available here') + ' — using real-time mode');
  }
  await runRealtime();
}

async function runFast() {
  S.exporting = true; S.fast = true; cancelled = false;
  $('busy').classList.add('on');
  busyMsg('Preparing…');
  $('busyProg').value = 0;
  runFast.lastError = '';
  let blob = null, err = null;
  try { blob = await fastCore(); } catch (e) { err = e; console.warn('Fast export failed:', e); }
  S.clips.forEach(c => {
    if (c.fs) { try { c.fs.close(); } catch (e) { } c.fs = null; }
    c.exFrame = null;
  });
  S.exporting = false; S.fast = false;
  $('busy').classList.remove('on');
  if (lock) { lock.release().catch(() => { }); lock = null; }
  setSize(S.prev);
  S.t = 0;
  pauseAllMedia();
  updateTime(); drawTimeline();
  if (cancelled) { toast('Export cancelled'); return 'cancelled'; }
  if (err || !blob) { runFast.lastError = err && err.message ? err.message : 'Fast export failed'; return 'fallback'; }
  presentExport(blob, 'video/mp4');
  return 'done';
}

async function pickVideoCodec(w, h, fps, bitrate) {
  for (const codec of ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a', 'avc1.640028', 'avc1.42001f']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' } });
      if (r.supported) return codec;
    } catch (e) { }
  }
  return null;
}
async function pickAudioCodec() {
  for (const codec of ['mp4a.40.2', 'opus']) {
    try {
      const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      if (r.supported) return codec;
    } catch (e) { }
  }
  return null;
}

/* ---------- offline audio mix ---------- */
function clipAudioFactor(c, t) {
  const e = frameState(t).find(x => x.c === c);
  return e ? e.fx.au : 0;
}
async function mixAudio(total, sr = 48000) {
  const dctx = new OfflineAudioContext(2, sr, sr);
  const cache = new Map();
  const decode = async (blob, key) => {
    if (cache.has(key)) return cache.get(key);
    let buf = null;
    try { buf = await dctx.decodeAudioData(await blob.arrayBuffer()); } catch (e) { buf = null; }
    cache.set(key, buf);
    return buf;
  };
  const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sr)), sr);
  let nodes = 0;

  for (const c of S.clips) {
    if (c.type !== 'video' || !c.blob || c.vol <= 0) continue;
    const buf = await decode(c.blob, c.mkey);
    if (!buf) continue;
    const L = len(c);
    const steps = Math.max(2, Math.ceil(L * 100) + 1);
    const curve = new Float32Array(steps);
    for (let k = 0; k < steps; k++) {
      const tt = Math.min(c.end - 0.001, c.start + (k / (steps - 1)) * L);
      curve[k] = clipAudioFactor(c, tt) * c.vol / 100;
    }
    const node = off.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = c.speed;
    const g = off.createGain();
    g.gain.setValueCurveAtTime(curve, c.start, L);
    node.connect(g); g.connect(off.destination);
    node.start(c.start, c.in, c.out - c.in);
    node.stop(c.start + L);
    nodes++;
    if (cancelled) return null;
  }
  for (const a of S.audio) {
    if (!a.blob || a.start >= total) continue;
    const buf = await decode(a.blob, a.mkey);
    if (!buf) continue;
    const aL = Math.min(alen(a), Math.max(0.01, buf.duration - a.in));
    const steps = Math.max(2, Math.ceil(aL * 100) + 1);
    const curve = new Float32Array(steps);
    for (let k = 0; k < steps; k++) curve[k] = (a.vol / 100) * fadeF(a.fi || 0, a.fo || 0, (k / (steps - 1)) * aL, aL) * (a.duck && window.duckF ? duckF(a.start + (k / (steps - 1)) * aL) : 1);
    const node = off.createBufferSource();
    node.buffer = buf;
    const g = off.createGain();
    g.gain.setValueCurveAtTime(curve, a.start, aL);
    node.connect(g); g.connect(off.destination);
    node.start(a.start, a.in, aL);
    node.stop(Math.min(total, a.start + aL));
    nodes++;
    if (cancelled) return null;
  }
  if (!nodes) return null;
  return off.startRendering();
}

async function encodeAudio(buf, codec, mux) {
  const sr = buf.sampleRate;
  let aerr = null;
  const ae = new AudioEncoder({ output: (c, m) => mux.addAudio(c, m), error: e => { aerr = e; } });
  ae.configure({ codec, sampleRate: sr, numberOfChannels: 2, bitrate: 128000 });
  const Lc = buf.getChannelData(0), Rc = buf.numberOfChannels > 1 ? buf.getChannelData(1) : Lc;
  const blk = 4096;
  for (let pos = 0; pos < Lc.length; pos += blk) {
    if (aerr) throw aerr;
    const n = Math.min(blk, Lc.length - pos);
    const data = new Float32Array(n * 2);
    data.set(Lc.subarray(pos, pos + n), 0);
    data.set(Rc.subarray(pos, pos + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(pos / sr * 1e6), data });
    ae.encode(ad);
    ad.close();
    if (ae.encodeQueueSize > 24) await sleep(0);
  }
  await ae.flush();
  ae.close();
  if (aerr) throw aerr;
}

/* ---------- the exporter ---------- */
async function fastCore() {
  const fps = +$('xFps').value, bitrate = +$('xBit').value, short = +$('xRes').value;
  if ([...S.clips, ...S.audio].some(x => x.blob && x.blob.size > 300 * 1024 * 1024)) {
    throw new Error('A file is very large');
  }
  setSize(short);
  const W = cv.width, H = cv.height, total = S.total;
  const N = Math.max(1, Math.round(total * fps));
  const vcodec = await pickVideoCodec(W, H, fps, bitrate);
  if (!vcodec) throw new Error('This device cannot encode H.264');
  try { lock = await navigator.wakeLock.request('screen'); } catch (e) { }

  const mux = new Mp4Muxer({ video: { width: W, height: H, fps } });

  busyMsg('Mixing audio…');
  await sleep(30);
  const mix = await mixAudio(total);
  if (cancelled) return null;
  if (mix) {
    const acodec = await pickAudioCodec();
    if (!acodec) throw new Error('This device cannot encode audio');
    mux.o.audio = { codec: acodec === 'opus' ? 'opus' : 'aac', sampleRate: mix.sampleRate, channels: 2, bitrate: 128000 };
    busyMsg('Encoding audio…');
    await encodeAudio(mix, acodec, mux);
  }
  $('busyProg').value = 0.08;

  busyMsg('Opening video…');
  for (const c of S.clips) {
    c.fs = null; c.exFrame = null;
    if (c.type === 'video' && c.blob) { try { c.fs = await FrameSource.open(c.blob); } catch (e) { c.fs = null; } }
  }

  let verr = null;
  const venc = new VideoEncoder({ output: (ch, m) => mux.addVideo(ch, m), error: e => { verr = e; } });
  venc.configure({ codec: vcodec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } });

  const wall0 = performance.now();
  for (let i = 0; i < N; i++) {
    if (cancelled) { try { venc.close(); } catch (e) { } return null; }
    if (verr) throw verr;
    const t = Math.min(i / fps, Math.max(0, total - 0.0005));
    S.t = t;
    for (const c of S.clips) c.exFrame = null;
    for (const { c } of frameState(t)) {
      if (c.type !== 'video') continue;
      const target = clamp(c.in + (t - c.start) * c.speed, 0, Math.max(0, c.dur - 0.001));
      if (c.fs && !c.fs.failed) {
        try { c.exFrame = await c.fs.frameAt(target); } catch (e) { c.fs.failed = true; c.exFrame = null; }
      }
      if (!c.exFrame) await seekEl(c.el, target);
    }
    render(true);
    const vf = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    if (venc.encodeQueueSize > 8) { while (venc.encodeQueueSize > 3) await sleep(1); }
    if (i % 3 === 0 || i === N - 1) {
      const el = (performance.now() - wall0) / 1000;
      $('busyProg').value = 0.08 + 0.92 * ((i + 1) / N);
      busyMsg(`Exporting… ${Math.round((i + 1) / N * 100)}%` + (el > 1 ? ` · ${((t || 0.001) / el).toFixed(1)}× speed` : ''));
      await sleep(0);
    }
  }
  busyMsg('Finishing…');
  await venc.flush();
  venc.close();
  if (verr) throw verr;
  if (mux.unordered) throw new Error('Encoder returned frames out of order');
  fastCore.stats = { seconds: (performance.now() - wall0) / 1000, total, vcodec, audio: mux.o.audio ? mux.o.audio.codec : 'none' };
  return mux.finish();
}
