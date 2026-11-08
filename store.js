'use strict';
/* Project storage: IndexedDB keeps the project data AND the original media files,
   so a project can be re-opened later on the same phone with everything in place. */

const Store = (() => {
  let dbp = null;
  const rp = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('Storage is not available in this browser'));
      const r = indexedDB.open('vided', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('media', { keyPath: 'k' }).createIndex('pid', 'pid');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Storage is blocked'));
    });
    return dbp;
  }
  async function write(name, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(name, 'readwrite');
      fn(t);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage write failed'));
    });
  }
  const read = async (name, fn) => { const db = await open(); return rp(fn(db.transaction(name, 'readonly').objectStore(name))); };
  return {
    putProject: rec => write('projects', t => t.objectStore('projects').put(rec)),
    getProject: id => read('projects', s => s.get(id)),
    listProjects: () => read('projects', s => s.getAll()),
    putMedia: (pid, key, blob, name) => write('media', t => t.objectStore('media').put({ k: pid + ':' + key, pid, key, blob, name })),
    getMedia: (pid, key) => read('media', s => s.get(pid + ':' + key)),
    delMedia: (pid, key) => write('media', t => t.objectStore('media').delete(pid + ':' + key)),
    async delProject(id) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(['projects', 'media'], 'readwrite');
        t.objectStore('projects').delete(id);
        const cur = t.objectStore('media').index('pid').openKeyCursor(IDBKeyRange.only(id));
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { t.objectStore('media').delete(c.primaryKey); c.continue(); }
        };
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
  };
})();

const PROJ = { id: null, name: 'Untitled project', stored: new Set(), timer: null, chain: Promise.resolve(), persisted: false };
const hasContent = () => S.clips.length || S.audio.length || S.texts.length || S.caps.length;

function setStatus(msg) { const el = $('pStatus'); if (el) el.textContent = msg; }

function serialize() {
  const pick = (o, keys) => { const r = {}; keys.forEach(k => { r[k] = o[k]; }); return r; };
  return {
    v: 3, uid, ratio: S.ratio, bg: S.bg, letterbox: S.letterbox, vignette: S.vignette, sel: S.sel, t: S.t,
    clips: S.clips.map(c => ({
      ...pick(c, ['id', 'name', 'type', 'mkey', 'dur', 'in', 'out', 'speed', 'vol', 'fi', 'fo', 'fit', 'sc', 'px', 'py', 'rot', 'op']),
      tr: { ...c.tr }, f: { ...c.f }, bg: { ...c.bg }, kf: c.kf.map(k => ({ ...k }))
    })),
    texts: S.texts.map(t => { const { _box, ...r } = t; return r; }),
    audio: S.audio.map(a => pick(a, ['id', 'name', 'mkey', 'dur', 'in', 'out', 'fi', 'fo', 'start', 'vol'])),
    caps: S.caps.map(c => ({ ...c })), capStyle: { ...S.capStyle }
  };
}

function storeDirty() {
  if (!hasContent()) return;
  clearTimeout(PROJ.timer);
  PROJ.timer = setTimeout(saveProject, 1200);
  setStatus('Saving…');
}
function flushSave() { clearTimeout(PROJ.timer); return saveProject(); }

function saveProject() {
  if (!hasContent()) return Promise.resolve();
  if (!PROJ.id) PROJ.id = 'p' + Date.now().toString(36);
  PROJ.chain = PROJ.chain.then(async () => {
    const id = PROJ.id;
    const items = [...S.clips, ...S.audio].filter(x => x.blob);
    const used = new Set(items.map(x => x.mkey));
    for (const it of items) {
      if (!PROJ.stored.has(it.mkey)) { await Store.putMedia(id, it.mkey, it.blob, it.name); PROJ.stored.add(it.mkey); }
    }
    for (const k of [...PROJ.stored]) {
      if (!used.has(k)) { await Store.delMedia(id, k); PROJ.stored.delete(k); }
    }
    const first = S.clips[0];
    let thumb = '';
    try { if (first && first.thumb) thumb = first.thumb.toDataURL('image/jpeg', 0.6); } catch (e) { }
    await Store.putProject({ id, name: PROJ.name, updated: Date.now(), thumb, data: serialize() });
    try { localStorage.setItem('vided.last', id); } catch (e) { }
    const d = new Date();
    setStatus('Saved on this device at ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'));
    if (!PROJ.persisted && navigator.storage && navigator.storage.persist) {
      PROJ.persisted = true;
      navigator.storage.persist().catch(() => { });
    }
    refreshProjectList();
  }).catch(e => {
    const quota = e && /quota/i.test(e.name + ' ' + e.message);
    setStatus(quota ? 'Not enough storage space to save this project' : 'Could not save: ' + (e && e.message));
    toast(quota ? 'Not enough storage space to save' : 'Could not save the project');
  });
  return PROJ.chain;
}

async function resetProject(name) {
  pause(); pauseAllMedia();
  S.clips = []; S.texts = []; S.audio = []; S.caps = []; S.capStyle = defCapStyle(); S.capSel = -1;
  S.sel = -1; S.tsel = -1; S.asel = -1; S.t = 0;
  compute();
  U.length = 0; R.length = 0; lastKey = '';
  PROJ.id = null; PROJ.name = name || 'Untitled project'; PROJ.stored = new Set();
  $('pName').value = PROJ.name;
  refreshAll();
}

async function openProject(id) {
  await flushSave();
  const rec = await Store.getProject(id);
  if (!rec) return toast('Project not found');
  toast('Opening “' + rec.name + '”…');
  pause(); pauseAllMedia();
  const d = rec.data;
  const clips = [], audio = [];
  let missing = 0;
  for (const sc of d.clips) {
    try {
      const m = await Store.getMedia(id, sc.mkey);
      if (!m) { missing++; continue; }
      const media = await mediaFromBlob(m.blob, sc.name);
      clips.push({ ...sc, fi: sc.fi || 0, fo: sc.fo || 0, bg: { ...defBg(), ...(sc.bg || {}) }, peaks: null, type: media.type, el: media.el, thumb: media.thumb, blob: m.blob, start: 0, end: 0, ov: 0, src: null, gain: null });
    } catch (e) { missing++; }
  }
  for (const sa of d.audio) {
    try {
      const m = await Store.getMedia(id, sa.mkey);
      if (!m) { missing++; continue; }
      const el = new Audio();
      el.preload = 'auto';
      el.src = URL.createObjectURL(m.blob);
      await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('audio')); });
      audio.push({ ...sa, in: sa.in || 0, out: sa.out == null ? sa.dur : sa.out, fi: sa.fi || 0, fo: sa.fo || 0, peaks: null, type: 'audio', el, blob: m.blob, src: null, gain: null });
    } catch (e) { missing++; }
  }
  S.clips = clips; S.audio = audio;
  S.texts = d.texts.map(t => ({ ...t }));
  S.caps = (d.caps || []).map(c => ({ ...c })); S.capStyle = { ...defCapStyle(), ...(d.capStyle || {}) }; S.capSel = -1;
  S.ratio = d.ratio || '9:16'; S.bg = d.bg || '#000000'; S.letterbox = !!d.letterbox; S.vignette = !!d.vignette;
  $('xRatio').value = S.ratio; $('xBg').value = S.bg; $('xLb').checked = S.letterbox; $('xVig').checked = S.vignette;
  const maxId = Math.max(0, ...clips.map(c => c.id), ...audio.map(a => a.id), ...S.texts.map(t => t.id), ...S.caps.map(c => c.id));
  uid = Math.max(uid, d.uid || 0, maxId + 1);
  S.sel = clips.some(c => c.id === d.sel) ? d.sel : (clips[0] ? clips[0].id : -1);
  S.tsel = S.texts.length ? S.texts[0].id : -1;
  S.asel = audio.length ? audio[0].id : -1;
  S.clips.forEach(wire); S.audio.forEach(wire);
  PROJ.id = id; PROJ.name = rec.name;
  PROJ.stored = new Set([...clips, ...audio].map(x => x.mkey));
  $('pName').value = rec.name;
  U.length = 0; R.length = 0; lastKey = '';
  setSize(S.prev);
  compute();
  S.t = clamp(d.t || 0, 0, S.total);
  refreshAll();
  try { localStorage.setItem('vided.last', id); } catch (e) { }
  refreshProjectList();
  if (missing) toast(missing + ' media file(s) could not be restored');
}

async function refreshProjectList() {
  const box = $('pList');
  if (!box) return;
  let list = [];
  try { list = await Store.listProjects(); } catch (e) { box.textContent = 'Saved projects are not available in this browser.'; return; }
  list.sort((a, b) => b.updated - a.updated);
  box.innerHTML = '';
  if (!list.length) box.innerHTML = '<div class="hint">No saved projects yet.</div>';
  list.forEach(p => {
    const row = document.createElement('div');
    row.className = 'prow' + (p.id === PROJ.id ? ' cur' : '');
    const img = document.createElement('img');
    img.src = p.thumb || '';
    img.alt = '';
    const info = document.createElement('div');
    info.className = 'pinfo';
    const dt = new Date(p.updated);
    info.innerHTML = '<b></b><span></span>';
    info.firstChild.textContent = p.name;
    info.lastChild.textContent = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      ' · ' + p.data.clips.length + ' clip' + (p.data.clips.length === 1 ? '' : 's');
    const open = document.createElement('button');
    open.textContent = p.id === PROJ.id ? 'Open (current)' : 'Open';
    open.onclick = () => openProject(p.id);
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'danger';
    del.onclick = async () => {
      if (!confirm('Delete “' + p.name + '” and its saved media from this device?')) return;
      await Store.delProject(p.id);
      if (p.id === PROJ.id) await resetProject();
      refreshProjectList();
    };
    row.append(img, info, open, del);
    box.appendChild(row);
  });
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      $('pStorage').textContent = 'Storage used by Vided: ' + (e.usage / 1048576).toFixed(0) + ' MB of about ' + (e.quota / 1048576 / 1024).toFixed(1) + ' GB available.';
    }
  } catch (e) { }
}

$('pName').oninput = e => { PROJ.name = e.target.value.trim() || 'Untitled project'; storeDirty(); };
$('pSave').onclick = async () => {
  if (!hasContent()) return toast('Add something to the project first');
  await flushSave();
  toast('Project saved');
};
$('pNew').onclick = async () => {
  await flushSave();
  await resetProject();
  refreshProjectList();
  openTab('media');
  toast('New project');
};
document.addEventListener('visibilitychange', () => { if (document.hidden && hasContent()) flushSave(); });
window.addEventListener('pagehide', () => { if (hasContent()) flushSave(); });

(async function restoreLast() {
  refreshProjectList();
  let last = null;
  try { last = localStorage.getItem('vided.last'); } catch (e) { }
  if (last) { try { await openProject(last); } catch (e) { console.warn('Could not restore last project', e); } }
})();
