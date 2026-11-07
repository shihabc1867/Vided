'use strict';
/* MP4 (H.264) demuxer + sequential decoder built on WebCodecs.
   Used by the fast exporter: frames are decoded once, in order, with no seeking.
   Anything it cannot handle (WebM, HEVC, broken files) returns null and the
   exporter falls back to seeking a normal <video> element. */
(function (root) {
  const four = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

  function* boxes(dv, start, end) {
    let p = start;
    while (p + 8 <= end) {
      let sz = dv.getUint32(p), hdr = 8;
      const type = four(dv, p + 4);
      if (sz === 1) { sz = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); hdr = 16; }
      else if (sz === 0) sz = end - p;
      if (sz < hdr || p + sz > end) return;
      yield { type, start: p + hdr, end: p + sz };
      p += sz;
    }
  }
  const kid = (dv, b, type) => { for (const k of boxes(dv, b.start, b.end)) if (k.type === type) return k; return null; };

  async function findMoov(blob) {
    let pos = 0;
    const size = blob.size;
    while (pos + 8 <= size) {
      const h = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
      let sz = h.getUint32(0), hdr = 8;
      const type = four(h, 4);
      if (sz === 1) { sz = h.getUint32(8) * 4294967296 + h.getUint32(12); hdr = 16; }
      else if (sz === 0) sz = size - pos;
      if (sz < 8) return null;
      if (type === 'moov') return blob.slice(pos + hdr, pos + sz).arrayBuffer();
      pos += sz;
    }
    return null;
  }

  async function parse(blob) {
    const buf = await findMoov(blob);
    if (!buf) return null;
    const dv = new DataView(buf);
    const root = { start: 0, end: buf.byteLength };
    let trak = null;
    for (const t of boxes(dv, 0, buf.byteLength)) {
      if (t.type !== 'trak') continue;
      const mdia = kid(dv, t, 'mdia');
      const hdlr = mdia && kid(dv, mdia, 'hdlr');
      if (hdlr && four(dv, hdlr.start + 8) === 'vide') { trak = t; break; }
    }
    if (!trak) return null;
    const mdia = kid(dv, trak, 'mdia');

    // rotation from the track header matrix
    const tkhd = kid(dv, trak, 'tkhd');
    let rot = 0;
    if (tkhd) {
      const mo = tkhd.start + (dv.getUint8(tkhd.start) === 1 ? 52 : 40);
      const a = dv.getInt32(mo), b = dv.getInt32(mo + 4);
      rot = ((Math.round(Math.atan2(b, a) * 180 / Math.PI) % 360) + 360) % 360;
    }

    const mdhd = kid(dv, mdia, 'mdhd');
    const timescale = dv.getUint32(mdhd.start + (dv.getUint8(mdhd.start) === 1 ? 20 : 12));
    const minf = kid(dv, mdia, 'minf');
    const stbl = kid(dv, minf, 'stbl');

    // codec configuration
    const stsd = kid(dv, stbl, 'stsd');
    const entry = [...boxes(dv, stsd.start + 8, stsd.end)][0];
    if (!entry) return null;
    const etype = four(dv, entry.start - 4);
    if (etype !== 'avc1' && etype !== 'avc3') return null;
    const width = dv.getUint16(entry.start + 24), height = dv.getUint16(entry.start + 26);
    const avcC = kid(dv, { start: entry.start + 78, end: entry.end }, 'avcC');
    if (!avcC) return null;
    const desc = new Uint8Array(buf, avcC.start, avcC.end - avcC.start).slice();
    const hex = n => n.toString(16).padStart(2, '0');
    const codec = 'avc1.' + hex(desc[1]) + hex(desc[2]) + hex(desc[3]);

    // sample tables
    const sz = kid(dv, stbl, 'stsz');
    const fixed = dv.getUint32(sz.start + 4), n = dv.getUint32(sz.start + 8);
    const sizes = new Uint32Array(n);
    for (let i = 0; i < n; i++) sizes[i] = fixed || dv.getUint32(sz.start + 12 + i * 4);

    const stc = kid(dv, stbl, 'stsc');
    const sc = [];
    for (let i = 0, c = dv.getUint32(stc.start + 4); i < c; i++) {
      const p = stc.start + 8 + i * 12;
      sc.push([dv.getUint32(p), dv.getUint32(p + 4)]);
    }
    let co = kid(dv, stbl, 'stco'), wide = false;
    if (!co) { co = kid(dv, stbl, 'co64'); wide = true; }
    const nco = dv.getUint32(co.start + 4);
    const offs = new Float64Array(n);
    {
      let s = 0, run = 0;
      for (let ci = 0; ci < nco && s < n; ci++) {
        while (run + 1 < sc.length && sc[run + 1][0] <= ci + 1) run++;
        let off = wide ? dv.getUint32(co.start + 8 + ci * 8) * 4294967296 + dv.getUint32(co.start + 12 + ci * 8)
          : dv.getUint32(co.start + 8 + ci * 4);
        for (let j = 0; j < sc[run][1] && s < n; j++) { offs[s] = off; off += sizes[s]; s++; }
      }
    }

    const dts = new Float64Array(n), dur = new Float64Array(n);
    {
      const st = kid(dv, stbl, 'stts');
      let s = 0, t = 0;
      for (let i = 0, c = dv.getUint32(st.start + 4); i < c; i++) {
        const cnt = dv.getUint32(st.start + 8 + i * 8), d = dv.getUint32(st.start + 12 + i * 8);
        for (let k = 0; k < cnt && s < n; k++) { dts[s] = t; dur[s] = d; t += d; s++; }
      }
    }
    const cts = new Float64Array(n);
    const ct = kid(dv, stbl, 'ctts');
    if (ct) {
      let s = 0;
      for (let i = 0, c = dv.getUint32(ct.start + 4); i < c; i++) {
        const cnt = dv.getUint32(ct.start + 8 + i * 8), o = dv.getInt32(ct.start + 12 + i * 8);
        for (let k = 0; k < cnt && s < n; k++) cts[s++] = o;
      }
    }
    const key = new Uint8Array(n);
    const ss = kid(dv, stbl, 'stss');
    if (ss) for (let i = 0, c = dv.getUint32(ss.start + 4); i < c; i++) { const k = dv.getUint32(ss.start + 8 + i * 4) - 1; if (k >= 0 && k < n) key[k] = 1; }
    else key.fill(1);

    // edit list: first non-empty edit gives the start offset
    let mediaTime = 0;
    const edts = kid(dv, trak, 'edts'), elst = edts && kid(dv, edts, 'elst');
    if (elst) {
      const v1 = dv.getUint8(elst.start) === 1, cnt = dv.getUint32(elst.start + 4);
      for (let i = 0, p = elst.start + 8; i < cnt; i++, p += v1 ? 20 : 12) {
        const mt = v1 ? dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12) : dv.getInt32(p + 4);
        if (mt >= 0) { mediaTime = mt; break; }
      }
    }
    const pts = new Float64Array(n);
    for (let i = 0; i < n; i++) pts[i] = Math.round((dts[i] + cts[i] - mediaTime) * 1e6 / timescale);
    const durUs = new Float64Array(n);
    for (let i = 0; i < n; i++) durUs[i] = Math.round(dur[i] * 1e6 / timescale);
    return { codec, desc, width, height, rot, n, sizes, offs, pts, durUs, key };
  }

  class FrameSource {
    static async open(blob) {
      if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return null;
      let info;
      try { info = await parse(blob); } catch (e) { return null; }
      if (!info || !info.n) return null;
      let sup;
      try { sup = await VideoDecoder.isConfigSupported({ codec: info.codec, description: info.desc }); } catch (e) { return null; }
      if (!sup || !sup.supported) return null;
      return new FrameSource(blob, info);
    }

    constructor(blob, info) {
      this.blob = blob; this.info = info;
      this.rot = info.rot; this.width = info.width; this.height = info.height;
      this.q = []; this.cur = null;
      this.fed = 0; this.flushed = false; this.last = null;
      this.err = null; this.failed = false;
      this.win = null; this.winStart = 0; this.winEnd = 0;
      this._w = null;
      this._make();
    }
    _make() {
      this.dec = new VideoDecoder({
        output: f => { this.q.push(f); this._wake(); },
        error: e => { this.err = e; this.failed = true; this._wake(); }
      });
      this.dec.configure({ codec: this.info.codec, description: this.info.desc });
    }
    _wake() { if (this._w) { const r = this._w; this._w = null; r(); } }
    _wait(ms) { return new Promise(r => { const t = setTimeout(() => { this._w = null; r(); }, ms); this._w = () => { clearTimeout(t); r(); }; }); }

    async _sample(i) {
      const { offs, sizes } = this.info;
      const o = offs[i], s = sizes[i];
      if (!this.win || o < this.winStart || o + s > this.winEnd) {
        const len = Math.max(s, 4 * 1024 * 1024);
        const end = Math.min(this.blob.size, o + len);
        this.win = new Uint8Array(await this.blob.slice(o, end).arrayBuffer());
        this.winStart = o; this.winEnd = end;
      }
      return this.win.subarray(o - this.winStart, o - this.winStart + s);
    }

    _clear() {
      this.q.forEach(f => f.close());
      this.q = [];
      if (this.cur) { this.cur.close(); this.cur = null; }
    }

    async _restart(target) {
      const { pts, key, n } = this.info;
      let k = 0;
      for (let i = 0; i < n; i++) { if (key[i]) { if (pts[i] <= target) k = i; else if (pts[i] > target + 1) break; } }
      this._clear();
      if (this.dec.state !== 'closed') { try { this.dec.reset(); } catch (e) { } }
      this.dec.configure({ codec: this.info.codec, description: this.info.desc });
      this.fed = k;
      this.flushed = false;
    }

    // Returns the VideoFrame to show at source time `sec` (latest frame with pts <= sec).
    async frameAt(sec) {
      if (this.failed) throw this.err || new Error('decoder failed');
      const target = sec * 1e6;
      if (this.last === null || target < this.last - 1 || target - this.last > 3e6) await this._restart(target);
      this.last = target;
      const { pts, durUs, key, n } = this.info;
      for (let guard = 0; guard < 4000; guard++) {
        if (this.failed) throw this.err || new Error('decoder failed');
        const ahead = this.q.length && this.q[this.q.length - 1].timestamp > target;
        if (ahead || (this.fed >= n && this.flushed)) break;
        if (this.fed < n) {
          let fedNow = 0;
          while (fedNow < 6 && this.fed < n && this.dec.decodeQueueSize < 10) {
            const i = this.fed++;
            const data = await this._sample(i);
            this.dec.decode(new EncodedVideoChunk({ type: key[i] ? 'key' : 'delta', timestamp: pts[i], duration: durUs[i], data }));
            fedNow++;
          }
        } else {
          await this.dec.flush();
          this.flushed = true;
          continue;
        }
        const before = this.q.length;
        await this._wait(250);
        if (this.q.length === before && this.dec.decodeQueueSize === 0 && this.fed < n) { /* keep feeding */ }
      }
      let pick = null;
      while (this.q.length && this.q[0].timestamp <= target) {
        if (pick) pick.close();
        pick = this.q.shift();
      }
      if (pick) { if (this.cur) this.cur.close(); this.cur = pick; }
      else if (!this.cur && this.q.length) this.cur = this.q.shift();
      return this.cur;
    }

    close() {
      this._clear();
      try { if (this.dec.state !== 'closed') this.dec.close(); } catch (e) { }
    }
  }

  root.FrameSource = FrameSource;
})(typeof window !== 'undefined' ? window : globalThis);
