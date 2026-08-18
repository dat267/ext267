"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadZip() {
  const sandbox = { TextEncoder };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr-zip.js"), "utf8"), ctx, {
    filename: "plugins/archivr-zip.js"
  });
  return ctx.zipBytes;
}

const zipBytes = loadZip();

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function crc32(bytes) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function parseZip(bytes) {
  const u8 = Uint8Array.from(bytes);
  const eocd = u8.length - 22;
  assert.equal(readU32(u8, eocd), 0x06054b50, "EOCD signature");
  const count = readU16(u8, eocd + 10);
  const cdOffset = readU32(u8, eocd + 16);
  assert.equal(readU16(u8, eocd + 8), count, "entry counts match");
  const entries = [];
  let o = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(readU32(u8, o), 0x02014b50, "central dir signature");
    const flags = readU16(u8, o + 8);
    const method = readU16(u8, o + 10);
    const crc = readU32(u8, o + 16);
    const csize = readU32(u8, o + 20);
    const usize = readU32(u8, o + 24);
    const nameLen = readU16(u8, o + 28);
    const localOff = readU32(u8, o + 42);
    let name = "";
    for (let i2 = 0; i2 < nameLen; i2++) name += String.fromCharCode(u8[o + 46 + i2]);
    if (flags & 0x0800) name = Buffer.from(name, "latin1").toString("utf8");
    entries.push({ method, flags, crc, csize, usize, name, localOff });
    o += 46 + nameLen + readU16(u8, o + 30) + readU16(u8, o + 32);
  }
  for (const e of entries) {
    assert.equal(readU32(u8, e.localOff), 0x04034b50, "local header signature");
    const dataStart = e.localOff + 30 + readU16(u8, e.localOff + 26) + readU16(u8, e.localOff + 28);
    assert.equal(readU32(u8, e.localOff + 14), e.crc, `local CRC for ${e.name}`);
    assert.equal(crc32(u8.subarray(dataStart, dataStart + e.usize)), e.crc, `CRC match for ${e.name}`);
  }
  return entries;
}

test("zipBytes produces a valid STORE archive", () => {
  const files = [
    { name: "a.txt", data: "hello" },
    { name: "b.txt", data: new Uint8Array([1, 2, 3]) }
  ];
  const entries = parseZip(zipBytes(files));
  assert.deepEqual(
    entries.map((e) => e.name),
    ["a.txt", "b.txt"]
  );
  assert.ok(
    entries.every((e) => e.method === 0),
    "STORE method"
  );
});

test("zipBytes handles UTF-8 filenames via the language encoding flag", () => {
  const entries = parseZip(zipBytes([{ name: "\u6d4b\u8bd5.txt", data: "x" }]));
  assert.equal(entries[0].name, "\u6d4b\u8bd5.txt");
  assert.ok(entries[0].flags & 0x0800, "UTF-8 flag set");
});

test("zipBytes sorts by name and keeps data byte-exact", () => {
  const data = Uint8Array.from({ length: 256 }, (_, i) => i);
  const entries = parseZip(
    zipBytes([
      { name: "z.bin", data },
      { name: "a.bin", data }
    ])
  );
  assert.deepEqual(
    entries.map((e) => e.name),
    ["a.bin", "z.bin"]
  );
  assert.equal(entries[0].usize, 256);
});

test("zipBytes returns empty archive for empty input", () => {
  assert.equal(zipBytes([]).length, 0);
});
