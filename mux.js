'use strict';
/* Minimal MP4 muxer for WebCodecs output.
   Video: H.264 (avc1)   Audio: AAC (mp4a) or Opus.
   Samples are kept in memory, then written as: ftyp + moov + mdat ("fast start"). */
(function (root) {
  const TE = new TextEncoder();
  const cat = arrs => {
    let n = 0;
    for (const a of arrs) n += a.length;
    const o = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { o.set(a, p); p += a.length; }
    return o;
  };
  const b32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const b16 = n => new Uint8Array([(n >>> 8) & 255, n & 255]);
  const b8 = (...a) => Uint8Array.from(a);
  const z = n => new Uint8Array(n);
  const s4 = s => TE.encode(s);
  const list32 = arr => {
    const o = new Uint8Array(arr.length * 4);
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      o[i * 4] = (n >>> 24) & 255; o[i * 4 + 1] = (n >>> 16) & 255; o[i * 4 + 2] = (n >>> 8) & 255; o[i * 4 + 3] = n & 255;
    }
    return o;
  };
  const box = (type, ...p) => { const body = cat(p); return cat([b32(8 + body.length), s4(type), body]); };
  const fbox = (type, ver, flags, ...p) => box(type, b8(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...p);
  const toU8 = d => (d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
  const MATRIX = cat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(b32));

  function descr(tag, body) { return cat([b8(tag, 0x80, 0x80, 0x80, body.length), body]); }

  function runs(values) {
    const out = [];
    for (const v of values) {
      const l = out[out.length - 1];
      if (l && l.v === v) l.n++; else out.push({ v, n: 1 });
    }
    return out;
  }

  class Mp4Muxer {
    constructor(o) {
      this.o = o || {};
      this.v = []; this.a = [];
      this.vDesc = null; this.aDesc = null;
      this.lastVTs = -1;
      this.unordered = false;
    }
    _copy(chunk) { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); return d; }
    addVideo(chunk, meta) {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.vDesc) {
        this.vDesc = toU8(meta.decoderConfig.description).slice();
      }
      if (chunk.timestamp <= this.lastVTs) this.unordered = true;
      this.lastVTs = chunk.timestamp;
      this.v.push({ d: this._copy(chunk), ts: chunk.timestamp, key: chunk.type === 'key' });
    }
    addAudio(chunk, meta) {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.aDesc) {
        this.aDesc = toU8(meta.decoderConfig.description).slice();
      }
      this.a.push({ d: this._copy(chunk), ts: chunk.timestamp, dur: chunk.duration || 0 });
    }

    _videoTrack() {
      const V = 90000, o = this.o.video;
      const ts = this.v.map(s => Math.round((s.ts - this.v[0].ts) * V / 1e6));
      const fallback = Math.round(V / (o.fps || 30));
      const samples = this.v.map((s, i) => ({
        d: s.d, key: s.key,
        delta: i < this.v.length - 1 ? Math.max(1, ts[i + 1] - ts[i]) : (i > 0 ? Math.max(1, ts[i] - ts[i - 1]) : fallback)
      }));
      const per = Math.max(1, Math.round(o.fps || 30));
      const entry = box('avc1', z(6), b16(1), z(16), b16(o.width), b16(o.height),
        b32(0x00480000), b32(0x00480000), z(4), b16(1), z(32), b16(0x18), b16(0xFFFF),
        box('avcC', this.vDesc));
      return { kind: 'vide', timescale: V, samples, per, entry, width: o.width, height: o.height };
    }
    _audioTrack() {
      const o = this.o.audio, sr = o.sampleRate, ch = o.channels || 2;
      const samples = this.a.map(s => ({ d: s.d, key: true, delta: Math.max(1, Math.round((s.dur || (o.codec === 'opus' ? 20000 : 21333)) * sr / 1e6)) }));
      let entry;
      if (o.codec === 'opus') {
        const h = this.aDesc ? toU8(this.aDesc) : null;
        let pre = 312, rate = sr;
        if (h && h.length >= 19) { pre = h[10] | (h[11] << 8); rate = (h[12] | (h[13] << 8) | (h[14] << 16) | (h[15] << 24)) >>> 0; }
        const dops = box('dOps', b8(0, ch), b16(pre), b32(rate), b16(0), b8(0));
        entry = box('Opus', z(6), b16(1), z(8), b16(ch), b16(16), b16(0), b16(0), b32((sr * 65536) >>> 0), dops);
      } else {
        const asc = this.aDesc || b8(0x11, 0x90);
        const dcd = cat([b8(0x40, 0x15, 0, 0, 0), b32(0), b32(o.bitrate || 128000), descr(0x05, asc)]);
        const es = cat([b16(0), b8(0), descr(0x04, dcd), descr(0x06, b8(2))]);
        const esds = fbox('esds', 0, 0, descr(0x03, es));
        entry = box('mp4a', z(6), b16(1), z(8), b16(ch), b16(16), b16(0), b16(0), b32((sr * 65536) >>> 0), esds);
      }
      const per = Math.max(1, Math.round(sr / (samples[0] ? samples[0].delta : 1024)));
      return { kind: 'soun', timescale: sr, samples, per, entry, channels: ch };
    }

    _plan(t) {
      let ticks = 0;
      const starts = [];
      t.samples.forEach(s => { starts.push(ticks); ticks += s.delta; });
      t.duration = ticks;
      t.chunks = [];
      for (let i = 0; i < t.samples.length; i += t.per) {
        const n = Math.min(t.per, t.samples.length - i);
        let bytes = 0;
        for (let k = i; k < i + n; k++) bytes += t.samples[k].d.length;
        t.chunks.push({ start: i, count: n, bytes, time: starts[i] / t.timescale });
      }
    }

    _stbl(t, offsets) {
      const s = t.samples;
      const sttsRuns = runs(s.map(x => x.delta));
      const stts = fbox('stts', 0, 0, b32(sttsRuns.length), list32(sttsRuns.flatMap(r => [r.n, r.v])));
      const keys = [];
      s.forEach((x, i) => { if (x.key) keys.push(i + 1); });
      const stss = (t.kind === 'vide' && keys.length < s.length) ? fbox('stss', 0, 0, b32(keys.length), list32(keys)) : null;
      const stsz = fbox('stsz', 0, 0, b32(0), b32(s.length), list32(s.map(x => x.d.length)));
      const sc = [];
      t.chunks.forEach((c, i) => {
        const l = sc[sc.length - 1];
        if (!l || l.n !== c.count) sc.push({ first: i + 1, n: c.count });
      });
      const stsc = fbox('stsc', 0, 0, b32(sc.length), list32(sc.flatMap(r => [r.first, r.n, 1])));
      const stco = fbox('stco', 0, 0, b32(offsets.length), list32(offsets));
      const stsd = fbox('stsd', 0, 0, b32(1), t.entry);
      return box('stbl', stsd, stts, ...(stss ? [stss] : []), stsc, stsz, stco);
    }

    _trak(t, id, offsets, movieDur) {
      const isV = t.kind === 'vide';
      const durMovie = Math.round(t.duration * 1000 / t.timescale);
      const tkhd = fbox('tkhd', 0, 3, b32(0), b32(0), b32(id), b32(0), b32(durMovie), z(8), b16(0), b16(0),
        b16(isV ? 0 : 0x0100), b16(0), MATRIX, b32(isV ? t.width * 65536 : 0), b32(isV ? t.height * 65536 : 0));
      const mdhd = fbox('mdhd', 0, 0, b32(0), b32(0), b32(t.timescale), b32(t.duration), b16(0x55c4), b16(0));
      const hdlr = fbox('hdlr', 0, 0, b32(0), s4(t.kind), z(12), s4(isV ? 'VideoHandler\0' : 'SoundHandler\0'));
      const xmhd = isV ? fbox('vmhd', 0, 1, z(8)) : fbox('smhd', 0, 0, z(4));
      const dinf = box('dinf', fbox('dref', 0, 0, b32(1), fbox('url ', 0, 1)));
      const minf = box('minf', xmhd, dinf, this._stbl(t, offsets));
      return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    }

    finish() {
      if (!this.v.length && !this.a.length) throw new Error('Nothing to write');
      if (this.v.length && !this.vDesc) throw new Error('Missing H.264 configuration');
      const tracks = [];
      if (this.v.length) tracks.push(this._videoTrack());
      if (this.a.length) tracks.push(this._audioTrack());
      tracks.forEach(t => this._plan(t));

      const order = [];
      tracks.forEach((t, ti) => t.chunks.forEach(c => order.push({ ti, c })));
      order.sort((x, y) => x.c.time - y.c.time || x.ti - y.ti);

      const build = base => {
        let off = base;
        const offs = tracks.map(() => []);
        for (const e of order) { offs[e.ti].push(off); off += e.c.bytes; }
        const movieDur = Math.max(...tracks.map(t => Math.round(t.duration * 1000 / t.timescale)));
        const mvhd = fbox('mvhd', 0, 0, b32(0), b32(0), b32(1000), b32(movieDur), b32(0x10000), b16(0x0100), b16(0),
          z(8), MATRIX, z(24), b32(tracks.length + 1));
        return box('moov', mvhd, ...tracks.map((t, i) => this._trak(t, i + 1, offs[i], movieDur)));
      };

      const ftyp = box('ftyp', s4('isom'), b32(0x200), s4('isom'), s4('iso2'), s4('avc1'), s4('mp41'));
      const moov0 = build(0);
      const dataSize = order.reduce((n, e) => n + e.c.bytes, 0);
      if (dataSize + 8 >= 4294967296) throw new Error('Video is too large for MP4 export');
      const moov = build(ftyp.length + moov0.length + 8);
      const parts = [ftyp, moov, cat([b32(8 + dataSize), s4('mdat')])];
      for (const e of order) {
        const t = tracks[e.ti];
        for (let k = e.c.start; k < e.c.start + e.c.count; k++) parts.push(t.samples[k].d);
      }
      return new Blob(parts, { type: 'video/mp4' });
    }
  }

  root.Mp4Muxer = Mp4Muxer;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Mp4Muxer };
})(typeof window !== 'undefined' ? window : globalThis);
