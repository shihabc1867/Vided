'use strict';
/* Quick start tools: format presets, safe-zone guide, motion-graphics template packs, first-run tour. */

/* ---------- format presets ---------- */
const FORMATS = { reels: '9:16', youtube: '16:9', square: '1:1', post: '4:5' };
function refreshFormat() {
  document.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('on', FORMATS[b.dataset.fmt] === S.ratio));
  const sf = $('safeOn');
  if (sf) sf.checked = !!S.safe;
}
document.querySelectorAll('[data-fmt]').forEach(b => {
  b.onclick = () => {
    S.ratio = FORMATS[b.dataset.fmt];
    $('xRatio').value = S.ratio;
    setSize(S.prev);
    markDirty(); refreshFormat(); render(true); drawTimeline();
  };
});
$('xRatio').addEventListener('change', refreshFormat);

/* ---------- safe zones (preview only, never exported) ---------- */
function drawSafe() {
  const W = cv.width, H = cv.height;
  let top, bottom, left, right, label;
  if (S.ratio === '9:16') { top = 0.12; bottom = 0.22; left = 0.05; right = 0.14; label = 'Reels / TikTok / Shorts buttons and captions cover these areas'; }
  else if (S.ratio === '16:9') { top = bottom = 0.05; left = right = 0.05; label = 'Title safe area'; }
  else { top = bottom = left = right = 0.06; label = 'Keep text inside the frame'; }
  ctx.save();
  ctx.fillStyle = 'rgba(255,60,80,.22)';
  ctx.fillRect(0, 0, W, H * top);
  ctx.fillRect(0, H * (1 - bottom), W, H * bottom);
  ctx.fillRect(0, H * top, W * left, H * (1 - top - bottom));
  ctx.fillRect(W * (1 - right), H * top, W * right, H * (1 - top - bottom));
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = Math.max(1, W / 360);
  ctx.setLineDash([W / 60, W / 80]);
  ctx.strokeRect(W * left, H * top, W * (1 - left - right), H * (1 - top - bottom));
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.max(10, W / 38)}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(label, W / 2, H * top + W / 60);
  ctx.restore();
}
$('safeOn').onchange = e => { S.safe = e.target.checked; render(true); };

/* ---------- template packs ---------- */
const PACKS = {
  intro: base => [
    { text: 'YOUR TITLE', size: 120, y: 0.45, anim: 'pop', from: base, to: base + 3 },
    { text: 'Your subtitle here', size: 48, y: 0.56, anim: 'fade', bold: false, from: base + 0.3, to: base + 3 }
  ],
  lower: base => [
    { text: 'Your Name', size: 52, x: 0.34, y: 0.80, bgOn: true, bg: '#7a5cff', anim: 'left', from: base, to: base + 4 },
    { text: 'Your role · your channel', size: 32, x: 0.34, y: 0.87, bgOn: true, bg: '#111111', bold: false, anim: 'left', from: base + 0.15, to: base + 4 }
  ],
  outro: base => [
    { text: 'THANKS FOR WATCHING', size: 74, y: 0.40, anim: 'pop', from: base, to: base + 3.5 },
    { text: 'Follow for more', size: 46, y: 0.52, anim: 'fade', bold: false, from: base + 0.4, to: base + 3.5 },
    { text: 'SUBSCRIBE', size: 60, y: 0.66, bgOn: true, bg: '#e53935', anim: 'pop', from: base + 0.8, to: base + 3.5 }
  ],
  hook: base => [
    { text: 'WAIT FOR IT...', size: 90, y: 0.24, color: '#ffd400', anim: 'pop', from: base, to: base + 2.5 }
  ],
  count: base => ['3', '2', '1'].map((n, i) => ({ text: n, size: 260, y: 0.45, anim: 'pop', from: base + i, to: base + i + 1 }))
};
document.querySelectorAll('[data-pack]').forEach(b => {
  b.onclick = () => {
    const k = b.dataset.pack;
    const base = +(k === 'outro' ? Math.max(0, S.total - 3.5) : k === 'intro' ? 0 : S.t).toFixed(1);
    touch('pack' + nid());
    const made = PACKS[k](base).map(o => ({ id: nid(), text: '', x: 0.5, y: 0.5, size: 64, color: '#ffffff', bgOn: false, bg: '#7a5cff', anim: 'none', bold: true, ...o, from: +o.from.toFixed(2), to: +o.to.toFixed(2) }));
    S.texts.push(...made);
    S.tsel = made[0].id;
    refreshAll();
    seek(Math.min(S.total, base + 0.5));
    toast('Added ' + made.length + ' text layer' + (made.length > 1 ? 's' : '') + '. Edit them in the list below.');
  };
});

/* ---------- first-run tour ---------- */
const TOUR = [
  { tab: null, title: 'Welcome to Vided', text: 'A free video editor that runs right here in your browser. Your projects stay on your phone and save automatically.' },
  { tab: 'media', title: '1. Add your clips', text: 'Open the Media tab and tap “Add video / image”. Tap a clip on the timeline to select it, then split, trim, speed it up or add transitions.' },
  { tab: 'text', title: '2. Text and captions', text: 'The Text tab has ready-made titles, lower thirds and outros. The Captions tab writes subtitles for you in Bengali or English.' },
  { tab: 'audio', title: '3. Sound', text: 'Record a voice-over, remove background noise, make music dip while you speak, and cut your video to the beat.' },
  { tab: 'export', title: '4. Export', text: 'Pick a format (Reels, YouTube, Square), then Export. Free exports go up to 720p. Pro unlocks Full HD and removes the watermark.' }
];
let tourI = 0;
function showTour(i) {
  tourI = i;
  const st = TOUR[i];
  $('tour').classList.add('on');
  $('tourTitle').textContent = st.title;
  $('tourText').textContent = st.text;
  $('tourDots').textContent = TOUR.map((_, k) => (k === i ? '●' : '○')).join(' ');
  $('tourBack').style.visibility = i ? 'visible' : 'hidden';
  $('tourNext').textContent = i === TOUR.length - 1 ? 'Start editing' : 'Next';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('tourhl', !!st.tab && b.dataset.tab === st.tab));
  if (st.tab) openTab(st.tab);
}
function endTour() {
  $('tour').classList.remove('on');
  document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('tourhl'));
  openTab('media');
  try { localStorage.setItem('vided.tour', '1'); } catch (e) { }
}
$('tourNext').onclick = () => (tourI >= TOUR.length - 1 ? endTour() : showTour(tourI + 1));
$('tourBack').onclick = () => showTour(Math.max(0, tourI - 1));
$('tourSkip').onclick = endTour;
$('pTour').onclick = () => showTour(0);
(function () {
  let seen = false;
  try { seen = !!localStorage.getItem('vided.tour'); } catch (e) { seen = true; }
  if (!seen) setTimeout(() => { if (!hasContent()) showTour(0); else { try { localStorage.setItem('vided.tour', '1'); } catch (e) { } } }, 900);
})();
refreshFormat();
