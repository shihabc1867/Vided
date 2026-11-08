'use strict';
/* Android app (Capacitor) support. Does nothing in a normal browser.
   Inside the app, files cannot be saved with a download link, so exports and SRT files go through the share sheet. */
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

const blobToB64 = b => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

async function nativeShare(blob, name) {
  const { Filesystem, Share } = window.Capacitor.Plugins;
  if (!Filesystem || !Share) throw new Error('Saving is not available in this build');
  const path = 'vided/' + name, CH = 3 * 1024 * 1024;   // multiple of 3 so each chunk is clean base64
  try { await Filesystem.deleteFile({ path, directory: 'CACHE' }); } catch (e) { }
  for (let off = 0; off < Math.max(1, blob.size); off += CH) {
    const data = await blobToB64(blob.slice(off, off + CH));
    if (off === 0) await Filesystem.writeFile({ path, data, directory: 'CACHE', recursive: true });
    else await Filesystem.appendFile({ path, data, directory: 'CACHE' });
  }
  const { uri } = await Filesystem.getUri({ path, directory: 'CACHE' });
  await Share.share({ title: name, url: uri, dialogTitle: 'Save or share' });
}

function downloadBlob(blob, name) {
  if (IS_NATIVE) { nativeShare(blob, name).catch(e => { if (!/cancel/i.test(e && e.message)) toast('Could not save: ' + (e && e.message || e)); }); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

if (IS_NATIVE) {
  const basePresent = presentExport;
  presentExport = function (blob, mime) {
    basePresent(blob, mime);
    const name = 'vided-export.' + (mime.includes('mp4') ? 'mp4' : 'webm');
    $('xDl').textContent = 'Save / share video';
    $('xDl').onclick = e => { e.preventDefault(); downloadBlob(blob, name); };
    $('xShare').style.display = 'none';
  };
}
