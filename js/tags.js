/* Minimal, dependency-free audio tag reader: ID3v2 (mp3), MP4/M4A, FLAC, Ogg Vorbis/Opus.
   readTags(ArrayBuffer) -> { title, artist, album, cover: { data: ArrayBuffer, type } | null } */
const AuralTags = (() => {
  const ascii = (u8, p, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8[p + i]);
    return s;
  };
  const synchsafe = (u8, p) => ((u8[p] & 0x7f) << 21) | ((u8[p + 1] & 0x7f) << 14) | ((u8[p + 2] & 0x7f) << 7) | (u8[p + 3] & 0x7f);

  function decode(bytes, enc) {
    let label = 'utf-8';
    if (enc === 0) label = 'windows-1252';
    else if (enc === 1) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) { label = 'utf-16le'; bytes = bytes.subarray(2); }
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) { label = 'utf-16be'; bytes = bytes.subarray(2); }
      else label = 'utf-16le';
    } else if (enc === 2) label = 'utf-16be';
    let s = '';
    try { s = new TextDecoder(label).decode(bytes); } catch (e) { s = ''; }
    return s.replace(/\u0000+$/g, '').split('\u0000')[0].trim();
  }

  function sniffImage(u8) {
    if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) return 'image/webp';
    return null;
  }

  function makeCover(u8) {
    const type = sniffImage(u8);
    if (!type || u8.length < 100) return null;
    return { data: u8.slice().buffer, type };
  }

  /* ---------- ID3v2 ---------- */
  function parseID3(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 10 || ascii(u8, 0, 3) !== 'ID3') return null;
    const v = new DataView(buf);
    const ver = u8[3];
    const flags = u8[5];
    const end = Math.min(10 + synchsafe(u8, 6), u8.length);
    let pos = 10;
    if (ver >= 3 && (flags & 0x40)) {
      const ext = ver === 4 ? synchsafe(u8, pos) : v.getUint32(pos) + 4;
      pos += ext;
    }
    const out = {};
    let coverBest = null, coverRank = -1;
    const hdrLen = ver === 2 ? 6 : 10;
    while (pos + hdrLen <= end) {
      let id, len;
      if (ver === 2) {
        id = ascii(u8, pos, 3);
        len = (u8[pos + 3] << 16) | (u8[pos + 4] << 8) | u8[pos + 5];
      } else {
        id = ascii(u8, pos, 4);
        len = ver === 4 ? synchsafe(u8, pos + 4) : v.getUint32(pos + 4);
      }
      if (!/^[A-Z0-9]+$/.test(id) || len <= 0) break;
      const body = u8.subarray(pos + hdrLen, pos + hdrLen + len);
      pos += hdrLen + len;
      if (!body.length) continue;

      const textKey = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TPE2: 'albumArtist', TP2: 'albumArtist' }[id];
      if (textKey) {
        const t = decode(body.subarray(1), body[0]);
        if (t && !out[textKey]) out[textKey] = t;
      } else if (id === 'APIC' || id === 'PIC') {
        try {
          const enc = body[0];
          let i = 1;
          if (id === 'PIC') i += 3;
          else { while (i < body.length && body[i] !== 0) i++; i++; }
          const picType = body[i]; i++;
          if (enc === 1 || enc === 2) {
            while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
            i += 2;
          } else {
            while (i < body.length && body[i] !== 0) i++;
            i++;
          }
          const cover = makeCover(body.subarray(i));
          const rank = picType === 3 ? 2 : picType === 0 ? 1 : 0;
          if (cover && rank > coverRank) { coverBest = cover; coverRank = rank; }
        } catch (e) { /* ignore broken frame */ }
      }
    }
    if (coverBest) out.cover = coverBest;
    return out;
  }

  /* ---------- MP4 / M4A ---------- */
  function parseMP4(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 16 || ascii(u8, 4, 4) !== 'ftyp') return null;
    const v = new DataView(buf);
    const out = {};

    function walk(start, end, cb) {
      let p = start;
      while (p + 8 <= end) {
        let size = v.getUint32(p);
        const type = ascii(u8, p + 4, 4);
        let hdr = 8;
        if (size === 1) { size = Number(v.getBigUint64(p + 8)); hdr = 16; }
        else if (size === 0) size = end - p;
        if (size < hdr) break;
        const boxEnd = Math.min(p + size, end);
        cb(type, p + hdr, boxEnd);
        p += size;
      }
    }

    function findIlst(start, end) {
      walk(start, end, (type, s, e) => {
        if (type === 'moov' || type === 'udta') findIlst(s, e);
        else if (type === 'meta') findIlst(s + 4, e);
        else if (type === 'ilst') readItems(s, e);
      });
    }

    function readItems(start, end) {
      walk(start, end, (type, s, e) => {
        const key = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumArtist', covr: 'cover' }[type];
        if (!key) return;
        walk(s, e, (t2, ds, de) => {
          if (t2 !== 'data' || de - ds <= 8) return;
          const payload = u8.subarray(ds + 8, de);
          if (key === 'cover') {
            if (!out.cover) { const c = makeCover(payload); if (c) out.cover = c; }
          } else if (!out[key]) {
            const t = decode(payload, 3);
            if (t) out[key] = t;
          }
        });
      });
    }

    findIlst(0, u8.length);
    return out;
  }

  /* ---------- FLAC ---------- */
  function parseVorbisComments(u8, p, out) {
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const vendorLen = v.getUint32(p, true); p += 4 + vendorLen;
    const count = v.getUint32(p, true); p += 4;
    for (let i = 0; i < count && p + 4 <= u8.length; i++) {
      const len = v.getUint32(p, true); p += 4;
      if (len > u8.length - p) break;
      const s = new TextDecoder('utf-8').decode(u8.subarray(p, p + len));
      p += len;
      const eq = s.indexOf('=');
      if (eq < 1) continue;
      const k = s.slice(0, eq).toUpperCase();
      const val = s.slice(eq + 1).trim();
      const key = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist' }[k];
      if (key && val && !out[key]) out[key] = val;
      if (k === 'METADATA_BLOCK_PICTURE' && !out.cover) {
        try {
          const bin = atob(val);
          const pic = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) pic[j] = bin.charCodeAt(j);
          const c = readFlacPicture(pic);
          if (c) out.cover = c;
        } catch (e) { /* ignore */ }
      }
    }
  }

  function readFlacPicture(u8) {
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 4;
    const mimeLen = v.getUint32(p); p += 4 + mimeLen;
    const descLen = v.getUint32(p); p += 4 + descLen;
    p += 16;
    const dataLen = v.getUint32(p); p += 4;
    return makeCover(u8.subarray(p, p + dataLen));
  }

  function parseFLAC(buf) {
    const u8 = new Uint8Array(buf);
    if (u8.length < 8 || ascii(u8, 0, 4) !== 'fLaC') return null;
    const out = {};
    let p = 4;
    while (p + 4 <= u8.length) {
      const last = u8[p] & 0x80;
      const type = u8[p] & 0x7f;
      const len = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
      p += 4;
      const body = u8.subarray(p, p + len);
      try {
        if (type === 4) parseVorbisComments(body, 0, out);
        else if (type === 6 && !out.cover) { const c = readFlacPicture(body); if (c) out.cover = c; }
      } catch (e) { /* ignore */ }
      p += len;
      if (last) break;
    }
    return out;
  }

  /* ---------- Ogg (Vorbis / Opus) — text tags only, when the comment header fits in the first pages ---------- */
  function parseOgg(buf) {
    const u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 262144));
    if (u8.length < 4 || ascii(u8, 0, 4) !== 'OggS') return null;
    const out = {};
    const head = ascii(u8, 0, u8.length);
    let i = head.indexOf('OpusTags');
    let start = -1;
    if (i >= 0) start = i + 8;
    else {
      i = head.indexOf('\u0003vorbis');
      if (i >= 0) start = i + 7;
    }
    if (start > 0) { try { parseVorbisComments(u8, start, out); } catch (e) { /* ignore */ } }
    return out;
  }

  function readTags(buf) {
    let r = null;
    try {
      r = parseID3(buf) || parseMP4(buf) || parseFLAC(buf) || parseOgg(buf);
    } catch (e) { r = null; }
    r = r || {};
    if (!r.artist && r.albumArtist) r.artist = r.albumArtist;
    return { title: r.title || '', artist: r.artist || '', album: r.album || '', cover: r.cover || null };
  }

  return { readTags };
})();
