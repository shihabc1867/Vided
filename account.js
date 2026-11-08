'use strict';
/* Accounts, plans and cloud backup.
   - Talks to Supabase directly over its REST API (no SDK, no extra download).
   - Sign-in uses an emailed one-time code (no passwords).
   - Plan lives in the `profiles` table; users can read it but cannot change it (see supabase-setup.sql).
   - Free plan: export capped at CFG.freeMaxRes and a small watermark. Pro: no limits, plus cloud backup.
   - If supabaseUrl is empty, accounts are off and everything is unlocked. */

const CFG = Object.assign({ supabaseUrl: '', supabaseKey: '', upgradeUrl: '', freeMaxRes: 720, watermark: 'Made with Vided', proPerks: [] }, window.VIDED_CONFIG || {});
const ACC = { on: !!(CFG.supabaseUrl && CFG.supabaseKey), session: null, plan: 'free', until: null, email: '', pendingEmail: '' };
const SB = CFG.supabaseUrl.replace(/\/+$/, '');
const SKEY = 'vided.session';

function isPro() {
  if (!ACC.on) return true;
  if (ACC.plan !== 'pro') return false;
  return !ACC.until || new Date(ACC.until).getTime() > Date.now();
}

/* ---------- HTTP helpers ---------- */
async function sbFetch(path, opt = {}, authed = true) {
  const headers = Object.assign({ apikey: CFG.supabaseKey }, opt.headers || {});
  if (authed) {
    await ensureFresh();
    headers.Authorization = 'Bearer ' + (ACC.session ? ACC.session.access_token : CFG.supabaseKey);
  } else headers.Authorization = 'Bearer ' + CFG.supabaseKey;
  let res;
  try { res = await fetch(SB + path, Object.assign({}, opt, { headers })); }
  catch (e) { throw new Error('No internet connection'); }
  return res;
}
async function sbJson(path, opt, authed) {
  const res = await sbFetch(path, opt, authed);
  let j = null;
  try { j = await res.json(); } catch (e) { }
  if (!res.ok) {
    const m = j && (j.message || j.msg || j.error_description || j.error);
    throw new Error(m || ('Server error ' + res.status));
  }
  return j;
}
const jsonOpt = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ---------- session ---------- */
function saveSession(j) {
  ACC.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)), user: j.user };
  ACC.email = (j.user && j.user.email) || ACC.email;
  try { localStorage.setItem(SKEY, JSON.stringify(ACC.session)); } catch (e) { }
}
function clearSession() {
  ACC.session = null; ACC.plan = 'free'; ACC.until = null; ACC.email = '';
  try { localStorage.removeItem(SKEY); } catch (e) { }
}
let refreshing = null;
async function ensureFresh() {
  const s = ACC.session;
  if (!s || s.expires_at - 60 > Date.now() / 1000) return;
  if (!refreshing) {
    refreshing = (async () => {
      const res = await fetch(SB + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: CFG.supabaseKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token })
      });
      if (!res.ok) { clearSession(); throw new Error('Your session expired. Please sign in again.'); }
      saveSession(await res.json());
    })().finally(() => { refreshing = null; });
  }
  await refreshing;
}

async function loadPlan() {
  if (!ACC.on || !ACC.session) return;
  try {
    const uid = ACC.session.user.id;
    const rows = await sbJson('/rest/v1/profiles?select=plan,plan_until&id=eq.' + encodeURIComponent(uid));
    const p = rows && rows[0];
    ACC.plan = p ? p.plan : 'free';
    ACC.until = p ? p.plan_until : null;
  } catch (e) { /* offline: keep what we have */ }
  try { localStorage.setItem('vided.plan', JSON.stringify({ plan: ACC.plan, until: ACC.until, uid: ACC.session.user.id })); } catch (e) { }
}

/* ---------- gating ---------- */
function drawWatermark() {
  if (isPro()) return;
  const W = cv.width, H = cv.height, px = Math.max(12, Math.round(Math.min(W, H) * 0.034));
  ctx.save();
  ctx.font = `700 ${px}px ${FONT}`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.globalAlpha = 0.75;
  ctx.lineJoin = 'round'; ctx.lineWidth = px / 5; ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.strokeText(CFG.watermark, W - px, H - px);
  ctx.fillStyle = '#fff';
  ctx.fillText(CFG.watermark, W - px, H - px);
  ctx.restore();
}
function gateExport() {
  if (isPro()) return;
  if (+$('xRes').value > CFG.freeMaxRes) {
    $('xRes').value = String(CFG.freeMaxRes);
    toast('Free plan exports up to ' + CFG.freeMaxRes + 'p. Upgrade for Full HD.');
  }
}
function applyPlanUI() {
  const pro = isPro();
  $('proBadge').hidden = !(ACC.on && pro);
  const opt = $('xRes').querySelector('option[value="1080"]');
  if (opt) opt.textContent = pro ? '1080p Full HD' : '1080p Full HD (Pro)';
  const note = $('xPlanNote');
  note.style.display = ACC.on && !pro ? '' : 'none';
  note.textContent = ACC.on && !pro ? `Free plan: exports up to ${CFG.freeMaxRes}p with a small “${CFG.watermark}” watermark. See the Account tab to upgrade.` : '';
  refreshAccount();
}

/* ---------- account panel ---------- */
const show = (id, on) => { $(id).style.display = on ? '' : 'none'; };
function refreshAccount() {
  show('acOff', !ACC.on);
  show('acOut', ACC.on && !ACC.session);
  show('acIn', ACC.on && !!ACC.session);
  if (!ACC.on || !ACC.session) return;
  const pro = isPro();
  $('acWho').textContent = ACC.email;
  $('acPlan').textContent = pro
    ? 'Pro plan' + (ACC.until ? ' · active until ' + new Date(ACC.until).toLocaleDateString() : '')
    : (ACC.plan === 'pro' ? 'Your Pro plan has expired.' : 'Free plan');
  show('acUpgrade', !pro);
  $('acPerks').textContent = CFG.proPerks.length ? 'Pro includes: ' + CFG.proPerks.join(' · ') : '';
  $('acBackup').disabled = !pro;
  if (pro) refreshBackups(); else $('acList').innerHTML = '<div class="hint">Cloud backup is a Pro feature.</div>';
}
$('acSend').onclick = async () => {
  const email = $('acEmail').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Enter a valid email address');
  $('acSend').disabled = true;
  try {
    await sbJson('/auth/v1/otp', jsonOpt('POST', { email, create_user: true }), false);
    ACC.pendingEmail = email;
    $('acSent').textContent = 'We sent a code to ' + email + '. Check your inbox (and spam).';
    show('acStep1', false); show('acStep2', true);
    $('acCode').focus();
  } catch (e) { toast(e.message); }
  $('acSend').disabled = false;
};
$('acBack').onclick = () => { show('acStep1', true); show('acStep2', false); };
$('acVerify').onclick = async () => {
  const token = $('acCode').value.replace(/\s+/g, '');
  if (!token) return toast('Enter the code from the email');
  $('acVerify').disabled = true;
  try {
    saveSession(await sbJson('/auth/v1/verify', jsonOpt('POST', { type: 'email', email: ACC.pendingEmail, token }), false));
    $('acCode').value = '';
    await loadPlan();
    applyPlanUI();
    toast('Signed in');
  } catch (e) { toast(e.message); }
  $('acVerify').disabled = false;
};
$('acOutBtn').onclick = async () => {
  try { await sbFetch('/auth/v1/logout', { method: 'POST' }); } catch (e) { }
  clearSession();
  show('acStep1', true); show('acStep2', false);
  applyPlanUI();
  toast('Signed out');
};
$('acUpgrade').onclick = () => {
  if (!CFG.upgradeUrl) return toast('Ask the app owner for a Pro code, then enter it below');
  const u = CFG.upgradeUrl + (CFG.upgradeUrl.includes('?') ? '&' : '?') + 'email=' + encodeURIComponent(ACC.email);
  window.open(u, '_blank', 'noopener');
};
$('acRedeem').onclick = async () => {
  const code = $('acRedeemCode').value.trim();
  if (!code) return toast('Enter your code');
  $('acRedeem').disabled = true;
  try {
    await sbJson('/rest/v1/rpc/redeem_code', jsonOpt('POST', { p_code: code }));
    $('acRedeemCode').value = '';
    await loadPlan();
    applyPlanUI();
    toast('Pro unlocked. Thank you!');
  } catch (e) { toast(e.message); }
  $('acRedeem').disabled = false;
};

/* ---------- cloud backup ---------- */
const CHUNK = 40 * 1048576;          // Supabase free storage allows 50 MB per file, so large backups are split
const bpath = (pid, name) => `/storage/v1/object/backups/${ACC.session.user.id}/${pid}/${name}`;

async function packProject(id) {
  const rec = await Store.getProject(id);
  if (!rec) throw new Error('Project not found');
  const keys = [...rec.data.clips, ...rec.data.audio].map(x => x.mkey);
  const media = [], blobs = [];
  for (const k of keys) {
    const m = await Store.getMedia(id, k);
    if (m && m.blob) { media.push({ key: k, name: m.name || '', type: m.blob.type || '', size: m.blob.size }); blobs.push(m.blob); }
  }
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, project: rec, media }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, head.length);
  return new Blob([len, head, ...blobs], { type: 'application/octet-stream' });
}
async function unpackProject(blob) {
  const n = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0);
  const h = JSON.parse(new TextDecoder().decode(await blob.slice(4, 4 + n).arrayBuffer()));
  let pos = 4 + n;
  const media = h.media.map(m => { const b = blob.slice(pos, pos + m.size, m.type || undefined); pos += m.size; return { ...m, blob: b }; });
  return { rec: h.project, media };
}
async function listFolder(prefix) {
  return sbJson('/storage/v1/object/list/backups', jsonOpt('POST', { prefix, limit: 200, offset: 0, sortBy: { column: 'name', order: 'asc' } }));
}
async function removePaths(paths) {
  if (!paths.length) return;
  const res = await sbFetch('/storage/v1/object/backups', jsonOpt('DELETE', { prefixes: paths }));
  if (!res.ok) throw new Error('Could not delete the old backup');
}
async function clearBackup(pid) {
  const uid = ACC.session.user.id;
  const files = await listFolder(`${uid}/${pid}`);
  await removePaths((files || []).filter(f => f.name).map(f => `${uid}/${pid}/${f.name}`));
}

async function backupProject() {
  if (!isPro()) return toast('Cloud backup is a Pro feature');
  if (!hasContent()) return toast('Add something to the project first');
  await flushSave();
  if (!PROJ.id) return toast('Nothing to back up yet');
  cancelled = false;
  try {
    setBusy('Preparing backup…', 0.02);
    const blob = await packProject(PROJ.id);
    const parts = Math.max(1, Math.ceil(blob.size / CHUNK));
    await clearBackup(PROJ.id).catch(() => { });
    for (let i = 0; i < parts; i++) {
      if (cancelled) { clearBusy(); return toast('Backup cancelled'); }
      setBusy(`Uploading… part ${i + 1} of ${parts} (${(blob.size / 1048576).toFixed(0)} MB total)`, 0.05 + 0.9 * i / parts);
      const res = await sbFetch(bpath(PROJ.id, 'p' + i), { method: 'POST', headers: { 'x-upsert': 'true', 'Content-Type': 'application/octet-stream' }, body: blob.slice(i * CHUNK, (i + 1) * CHUNK) });
      if (!res.ok) {
        let m = ''; try { m = (await res.json()).message; } catch (e) { }
        throw new Error(/exceeded|quota|too large|size/i.test(m || '') ? 'Your cloud storage is full' : (m || 'Upload failed (' + res.status + ')'));
      }
    }
    const rec = await Store.getProject(PROJ.id);
    const meta = { name: PROJ.name, updated: Date.now(), size: blob.size, parts, clips: rec.data.clips.length };
    const mr = await sbFetch(bpath(PROJ.id, 'meta.json'), { method: 'POST', headers: { 'x-upsert': 'true', 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
    if (!mr.ok) throw new Error('Could not finish the backup');
    toast('Backed up “' + PROJ.name + '”');
  } catch (e) { toast(e.message || 'Backup failed'); }
  clearBusy();
  refreshBackups();
}
async function restoreBackup(pid, meta) {
  if (!isPro()) return toast('Cloud backup is a Pro feature');
  try {
    const local = await Store.getProject(pid);
    if (local && !confirm('This project already exists on this phone. Replace it with the cloud copy?')) return;
    cancelled = false;
    const parts = [];
    for (let i = 0; i < meta.parts; i++) {
      if (cancelled) { clearBusy(); return toast('Restore cancelled'); }
      setBusy(`Downloading… part ${i + 1} of ${meta.parts}`, 0.05 + 0.8 * i / meta.parts);
      const res = await sbFetch(`/storage/v1/object/authenticated/backups/${ACC.session.user.id}/${pid}/p${i}`);
      if (!res.ok) throw new Error('Download failed (' + res.status + ')');
      parts.push(await res.blob());
    }
    setBusy('Restoring…', 0.9);
    const { rec, media } = await unpackProject(new Blob(parts));
    for (const m of media) await Store.putMedia(rec.id, m.key, m.blob, m.name);
    await Store.putProject(rec);
    clearBusy();
    await openProject(rec.id);
    openTab('media');
    toast('Restored “' + rec.name + '”');
  } catch (e) { clearBusy(); toast(e.message || 'Restore failed'); }
}
async function refreshBackups() {
  const box = $('acList');
  if (!ACC.session || !isPro()) return;
  box.innerHTML = '<div class="hint">Loading backups…</div>';
  let items = [];
  try {
    const uid = ACC.session.user.id;
    const folders = (await listFolder(uid + '/')) || [];
    for (const f of folders) {
      if (!f.name) continue;
      try {
        const res = await sbFetch(`/storage/v1/object/authenticated/backups/${uid}/${f.name}/meta.json`);
        if (res.ok) items.push({ pid: f.name, meta: await res.json() });
      } catch (e) { }
    }
  } catch (e) { box.innerHTML = '<div class="hint"></div>'; box.firstChild.textContent = 'Could not load backups: ' + e.message; return; }
  items.sort((a, b) => b.meta.updated - a.meta.updated);
  box.innerHTML = '';
  if (!items.length) box.innerHTML = '<div class="hint">No cloud backups yet.</div>';
  items.forEach(({ pid, meta }) => {
    const row = document.createElement('div');
    row.className = 'brow';
    const info = document.createElement('div');
    info.className = 'pinfo';
    info.innerHTML = '<b></b><span></span>';
    info.firstChild.textContent = meta.name;
    info.lastChild.textContent = new Date(meta.updated).toLocaleDateString() + ' · ' + (meta.size / 1048576).toFixed(1) + ' MB';
    const r = document.createElement('button'); r.textContent = 'Restore'; r.onclick = () => restoreBackup(pid, meta);
    const d = document.createElement('button'); d.textContent = 'Delete'; d.className = 'danger';
    d.onclick = async () => {
      if (!confirm('Delete this cloud backup?')) return;
      try { await clearBackup(pid); } catch (e) { toast(e.message); }
      refreshBackups();
    };
    row.append(info, r, d);
    box.appendChild(row);
  });
}
$('acBackup').onclick = backupProject;

/* ---------- start ---------- */
(async function initAccount() {
  if (ACC.on) {
    try {
      const raw = localStorage.getItem(SKEY);
      if (raw) {
        ACC.session = JSON.parse(raw);
        ACC.email = (ACC.session.user && ACC.session.user.email) || '';
        const cached = JSON.parse(localStorage.getItem('vided.plan') || 'null');
        if (cached && cached.uid === ACC.session.user.id) { ACC.plan = cached.plan; ACC.until = cached.until; }
      }
    } catch (e) { ACC.session = null; }
  }
  applyPlanUI();
  if (ACC.on && ACC.session) { await loadPlan(); applyPlanUI(); }
})();
document.querySelector('#tabs [data-tab=account]').addEventListener('click', () => { if (ACC.on && ACC.session) loadPlan().then(applyPlanUI); });
