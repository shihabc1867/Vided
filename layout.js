/* Vided Phase 12: resizable preview. Drag the grip under the preview; double-tap it to switch sizes;
   tap the active tab again to hide/show the tool panel (the preview then fills the screen). */
(function () {
  const app = $('app'), stg = $('stage');
  const grip = document.createElement('div'); grip.id = 'grip'; grip.title = 'Drag to resize the preview';
  stg.after(grip);
  const MINH = 0.2, MAXH = 0.72;
  const root = document.documentElement;
  const vh = () => window.innerHeight;
  let frac = 0.44;
  try { const v = parseFloat(localStorage.getItem('vided.stageH')); if (v >= MINH && v <= MAXH) frac = v; } catch (e) { }
  function apply(f, save) {
    frac = Math.min(Math.min(MAXH, (vh() - 410) / vh()), Math.max(MINH, f));
    root.style.setProperty('--stageH', Math.round(frac * 1000) / 10 + 'dvh');
    if (save) { try { localStorage.setItem('vided.stageH', String(frac)); } catch (e) { } }
    fitCanvas(); drawTimeline();
  }
  apply(frac, false);

  let drag = null, lastTap = 0;
  grip.addEventListener('pointerdown', e => {
    drag = { y: e.clientY, f: frac, moved: false };
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 3) drag.moved = true;
    apply(drag.f + dy / vh(), false);
  });
  const end = () => {
    if (!drag) return;
    const moved = drag.moved; drag = null;
    if (moved) { apply(frac, true); return; }
    const now = Date.now();
    if (now - lastTap < 350) {                           // double tap: cycle small / medium / large
      const steps = [0.3, 0.44, 0.6], i = steps.findIndex(s => Math.abs(s - frac) < 0.04);
      apply(steps[(i + 1) % steps.length], true);
    }
    lastTap = now;
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);

  let inTab = false;
  const baseOpen = window.openTab;
  window.openTab = function (n) { if (!inTab && app.classList.contains('pcollapsed')) { app.classList.remove('pcollapsed'); setTimeout(fitCanvas, 30); } return baseOpen(n); };

  // tap the active tab again: hide / show the tool panel
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    inTab = true; setTimeout(() => { inTab = false; }, 0);
    if (b.dataset.wasActive === '1') app.classList.toggle('pcollapsed');
    else app.classList.remove('pcollapsed');
    setTimeout(fitCanvas, 30);
  }, true);
  $('tabs').addEventListener('pointerdown', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach(x => { x.dataset.wasActive = x.classList.contains('active') ? '1' : ''; });
  }, true);

  if (window.ResizeObserver) new ResizeObserver(() => { fitCanvas(); }).observe(stg);
  window.addEventListener('orientationchange', () => setTimeout(() => apply(frac, false), 200));
})();
