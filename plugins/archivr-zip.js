"use strict";

// Minimal STORE-only ZIP writer (local headers + central directory + EOCD).
// Uncompressed text archives only; CRC-32 per entry; UTF-8 filename flag set.

(function (global) {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function toBytes(data) {
    if (typeof data === "string") return new TextEncoder().encode(data);
    return Uint8Array.from(data);
  }

  function pushU16(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff);
  }
  function pushU32(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  function makeLocalHeader(nameBytes, nameLen, crc, size) {
    const out = [];
    pushU32(out, 0x04034b50);
    pushU16(out, 20);
    pushU16(out, 0x0800); // UTF-8 filenames
    pushU16(out, 0); // STORE
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, crc);
    pushU32(out, size);
    pushU32(out, size);
    pushU16(out, nameLen);
    pushU16(out, 0);
    for (const b of nameBytes) out.push(b);
    return out;
  }

  function makeCentralHeader(nameBytes, nameLen, crc, size, localOffset) {
    const out = [];
    pushU32(out, 0x02014b50);
    pushU16(out, 20);
    pushU16(out, 20);
    pushU16(out, 0x0800);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, crc);
    pushU32(out, size);
    pushU32(out, size);
    pushU16(out, nameLen);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, 0);
    pushU32(out, localOffset);
    for (const b of nameBytes) out.push(b);
    return out;
  }

  global.zipBytes = function zipBytes(files) {
    if (!files || files.length === 0) return new Uint8Array(0);

    const encoder = new TextEncoder();
    const localParts = [];
    const centralDirs = [];
    let offset = 0;

    const ordered = files
      .map((f) => ({ name: String(f.name), data: toBytes(f.data) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const f of ordered) {
      const nameBytes = encoder.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = makeLocalHeader(nameBytes, nameBytes.length, crc, size);
      localParts.push(Uint8Array.from(local), f.data);
      centralDirs.push(makeCentralHeader(nameBytes, nameBytes.length, crc, size, offset));
      offset += local.length + size;
    }

    const centralBytes = [];
    for (const dir of centralDirs) centralBytes.push(Uint8Array.from(dir));
    const cdLength = centralBytes.reduce((n, b) => n + b.length, 0);

    const eocd = [];
    pushU32(eocd, 0x06054b50);
    pushU16(eocd, 0);
    pushU16(eocd, 0);
    pushU16(eocd, ordered.length);
    pushU16(eocd, ordered.length);
    pushU32(eocd, cdLength);
    pushU32(eocd, offset);
    pushU16(eocd, 0);

    const eocdBytes = Uint8Array.from(eocd);
    const total = offset + cdLength + eocdBytes.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of localParts) {
      out.set(part, p);
      p += part.length;
    }
    for (const part of centralBytes) {
      out.set(part, p);
      p += part.length;
    }
    out.set(eocdBytes, p);
    return out;
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
