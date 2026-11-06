'use strict';
const $ = id => document.getElementById(id);
const cv = $('cv'), cx = cv.getContext('2d');
const SIZES = { '9:16': [720, 1280], '16:9': [1280, 720], '1:1': [720, 720] };

const vid = document.createElement('video');
vid.playsInline = true;
vid.preload = 'auto';
const mus = new Audio();
mus.loop = true;

const S = { kind: null, img: null, texts: [], sel: -1, playing: false, t0: 0, exporting: false, fit: 'contain' };
let AC, dest, vGain, mGain, rec, chunks = [], lock = null, drag = null;

/* ---------- অডিও গ্রাফ ---------- */
function initAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  dest = AC.createMediaStreamDestination();
  vGain = AC.createGain();
  mGain = AC.createGain();
  AC.createMediaElementSource(vid).connect(vGain);
  AC.createMediaElementSource(mus).connect(mGain);
  [vGain, mGain].forEach(g => { g.connect(dest); g.connect(AC.destination); });
  applyVol();
}
function applyVol() {
  if (!AC) return;
  vGain.gain.value = $('vv').value / 100;
  mGain.gain.value = $('mv').value / 100;
}

/* ---------- সময় ও ট্রিম ---------- */
const dur = () => Math.max(0.1, +$('te').value - +$('ts').value);
function curT() {
  if (S.kind === 'video') return vid.currentTime - +$('ts').value;
  return S.playing ? (performance.now() - S.t0) / 1000 : 0;
}
const seek = t => new Promise(res => {
  if (Math.abs(vid.currentTime - t) < 0.02) return res();
  vid.onseeked = () => { vid.onseeked = null; res(); };
  vid.currentTime = t;
});
function labels() {
  $('tsl').textContent = (+$('ts').value).toFixed(1);
  $('tel').textContent = (+$('te').value).toFixed(1);
}
function setTrim(max, end, isImg) {
  $('ts').max = max; $('te').max = max;
  $('ts').value = 0; $('te').value = end;
  $('ts').disabled = isImg;
  labels();
}
$('ts').oninput = () => {
  if (+$('ts').value > +$('te').value - 0.1) $('ts').value = +$('te').value - 0.1;
  labels();
  if (S.kind === 'video' && !S.playing) vid.currentTime = +$('ts').value;
};
$('te').oninput = () => {
  if (+$('te').value < +$('ts').value + 0.1) $('te').value = +$('ts').value + 0.1;
  labels();
  if (S.kind === 'video' && !S.playing) vid.currentTime = Math.max(+$('ts').value, +$('te').value - 0.1);
};

/* ---------- ফাইল লোড ---------- */
function info() {
  $('info').textContent = S.kind === 'video' ? 'ভিডিও লোড হয়েছে' : S.kind === 'image' ? 'ছবি লোড হয়েছে' : '';
}
$('file').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  stop();
  const url = URL.createObjectURL(f);
  if (f.type.startsWith('image/')) {
    const im = new Image();
    im.onload = () => { S.img = im; S.kind = 'image'; setTrim(60, 5, true); info(); };
    im.src = url;
  } else {
    vid.onloadedmetadata = () => {
      S.kind = 'video';
      setTrim(vid.duration, vid.duration, false);
      vid.currentTime = 0;
      info();
    };
    vid.src = url;
  }
};
$('mfile').onchange = e => {
  const f = e.target.files[0];
  if (f) { mus.src = URL.createObjectURL(f); mus.load(); }
};
$('vv').oninput = applyVol;
$('mv').oninput = applyVol;

/* ---------- রেশিও ও ফিল্টার ---------- */
$('ratio').onchange = () => { [cv.width, cv.height] = SIZES[$('ratio').value]; };
$('fit').onchange = () => { S.fit = $('fit').value; };
function filterStr() {
  return `brightness(${$('fb').value}%) contrast(${$('fc').value}%) saturate(${$('fs').value}%) ${$('preset').value}`;
}

/* ---------- টেক্সট ---------- */
function refreshTexts() {
  const l = $('tl');
  l.innerHTML = '';
  S.texts.forEach((o, i) => {
    const op = document.createElement('option');
    op.value = i;
    op.textContent = (i + 1) + '. ' + o.t.slice(0, 20);
    l.appendChild(op);
  });
  if (S.sel >= 0 && S.texts[S.sel]) {
    const o = S.texts[S.sel];
    l.value = S.sel;
    $('txt').value = o.t; $('tsize').value = o.s; $('tcol').value = o.c;
    $('tfrom').value = o.from; $('tto').value = o.to;
  } else {
    $('txt').value = '';
  }
}
$('addT').onclick = () => {
  S.texts.push({ t: 'নতুন টেক্সট', x: 0.5, y: 0.5, s: 64, c: '#ffffff', from: 0, to: +dur().toFixed(1) });
  S.sel = S.texts.length - 1;
  refreshTexts();
};
$('delT').onclick = () => {
  if (S.sel < 0) return;
  S.texts.splice(S.sel, 1);
  S.sel = S.texts.length - 1;
  refreshTexts();
};
$('tl').onchange = () => { S.sel = +$('tl').value; refreshTexts(); };
function editText() {
  const o = S.texts[S.sel];
  if (!o) return;
  o.t = $('txt').value; o.s = +$('tsize').value; o.c = $('tcol').value;
  o.from = +$('tfrom').value; o.to = +$('tto').value;
  const opt = $('tl').options[S.sel];
  if (opt) opt.textContent = (S.sel + 1) + '. ' + o.t.slice(0, 20);
}
['txt', 'tsize', 'tcol', 'tfrom', 'tto'].forEach(id => { $(id).oninput = editText; });

/* ক্যানভাসে আঙুল দিয়ে টেক্সট সরানো */
function pt(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
}
function fontOf(o) { return `bold ${o.s}px "Noto Sans Bengali",sans-serif`; }
cv.onpointerdown = e => {
  const [px, py] = pt(e);
  for (let i = S.texts.length - 1; i >= 0; i--) {
    const o = S.texts[i];
    cx.font = fontOf(o);
    const w = cx.measureText(o.t).width;
    if (Math.abs(px - o.x * cv.width) < w / 2 + 20 && Math.abs(py - o.y * cv.height) < o.s / 2 + 20) {
      S.sel = i; drag = i; refreshTexts(); cv.setPointerCapture(e.pointerId);
      return;
    }
  }
};
cv.onpointermove = e => {
  if (drag === null) return;
  const [px, py] = pt(e);
  S.texts[drag].x = Math.min(1, Math.max(0, px / cv.width));
  S.texts[drag].y = Math.min(1, Math.max(0, py / cv.height));
};
cv.onpointerup = () => { drag = null; };

/* ---------- ড্র লুপ ---------- */
function draw() {
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, cv.width, cv.height);

  if (S.kind) {
    const src = S.kind === 'video' ? vid : S.img;
    const sw = S.kind === 'video' ? vid.videoWidth : S.img.naturalWidth;
    const sh = S.kind === 'video' ? vid.videoHeight : S.img.naturalHeight;
    if (sw && sh) {
      const r = S.fit === 'fill' ? Math.max(cv.width / sw, cv.height / sh) : Math.min(cv.width / sw, cv.height / sh);
      const w = sw * r, h = sh * r;
      cx.filter = filterStr();
      cx.drawImage(src, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
      cx.filter = 'none';
    }
  }

  const t = curT();
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.lineJoin = 'round';
  S.texts.forEach((o, i) => {
    const editing = !S.playing && !S.exporting && i === S.sel;
    if (!editing && (t < o.from || t > o.to)) return;
    cx.font = fontOf(o);
    const X = o.x * cv.width, Y = o.y * cv.height;
    cx.lineWidth = o.s / 8;
    cx.strokeStyle = '#000';
    cx.strokeText(o.t, X, Y);
    cx.fillStyle = o.c;
    cx.fillText(o.t, X, Y);
    if (editing) {
      const w = cx.measureText(o.t).width;
      cx.lineWidth = 2;
      cx.strokeStyle = '#6d4cff';
      cx.strokeRect(X - w / 2 - 10, Y - o.s / 2 - 8, w + 20, o.s + 16);
    }
  });

  if (S.playing && S.kind) {
    $('prog').value = Math.min(1, t / dur());
    if (t >= dur()) onEnd();
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
vid.onended = () => { if (S.playing) onEnd(); };

/* ---------- প্লে / স্টপ ---------- */
async function play() {
  if (!S.kind) return;
  initAudio();
  await AC.resume();
  if (S.kind === 'video') {
    const t = vid.currentTime;
    if (t < +$('ts').value || t >= +$('te').value - 0.05) await seek(+$('ts').value);
    await vid.play();
  } else {
    S.t0 = performance.now();
  }
  if (mus.src) { mus.currentTime = 0; mus.play().catch(() => {}); }
  S.playing = true;
}
function stop() {
  S.playing = false;
  vid.pause();
  mus.pause();
}
function onEnd() {
  if (S.exporting) return finishExport();
  stop();
  if (S.kind === 'video') vid.currentTime = +$('ts').value;
}
$('play').onclick = play;
$('stopb').onclick = stop;

/* ---------- এক্সপোর্ট ---------- */
const TYPES = [
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'
].filter(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
TYPES.forEach(t => {
  const o = document.createElement('option');
  o.value = t;
  o.textContent = t.includes('mp4') ? 'MP4' : 'WebM' + (t.includes('vp9') ? ' (VP9)' : t.includes('vp8') ? ' (VP8)' : '');
  $('fmt').appendChild(o);
});

async function doExport() {
  if (!S.kind) return alert('আগে ভিডিও বা ছবি দাও');
  if (!TYPES.length) return alert('এই ব্রাউজারে এক্সপোর্ট সাপোর্ট নেই, Chrome ব্যবহার করো');
  initAudio();
  await AC.resume();
  stop();
  if (S.kind === 'video') await seek(+$('ts').value);

  const stream = cv.captureStream(30);
  dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const type = $('fmt').value;
  rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: +$('q').value });
  chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    const url = URL.createObjectURL(blob);
    $('out').src = url; $('out').style.display = 'block';
    $('dl').href = url;
    $('dl').download = 'output.' + (type.includes('mp4') ? 'mp4' : 'webm');
    $('dl').style.display = 'block';
    $('exp').disabled = false;
    $('exp').textContent = 'এক্সপোর্ট শুরু করো';
    if (lock) { lock.release().catch(() => {}); lock = null; }
  };
  S.exporting = true;
  $('exp').disabled = true;
  $('exp').textContent = 'এক্সপোর্ট হচ্ছে...';
  $('dl').style.display = 'none';
  try { lock = await navigator.wakeLock.request('screen'); } catch (e) {}
  rec.start(500);
  await play();
}
function finishExport() {
  S.exporting = false;
  stop();
  if (rec && rec.state !== 'inactive') rec.stop();
}
$('exp').onclick = doExport;
