#!/usr/bin/env node
/**
 * The release ZIP (Phase 4 Task 37; review checklist 39 and 40): the audited `dist` directory as one deterministic
 * archive, which is the only thing either store and the GitHub release are ever given.
 *
 *   node scripts/make-release-zip.mjs <dir> <out.zip>
 *
 * Deterministic means the same files always give the same bytes, whatever machine, clock or directory order made them:
 * entries are sorted by name, every timestamp is the ZIP epoch (1980-01-01 00:00), nothing about the owner, the
 * permissions or the platform is recorded, and compression is fixed. That makes the ZIP's SHA-256 a name for exactly
 * what was audited, so a store job can check it is uploading that and nothing else, and two builds can be compared
 * byte for byte. Only regular files go in: a symlink, or anything else, stops the build.
 *
 * Node built-ins only, so it runs anywhere Node does with nothing installed. It writes the plain ZIP format both stores
 * accept (no ZIP64, no encryption, no data descriptors), with the file names as UTF-8.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const DOS_TIME = 0;
/** 1980-01-01: ((year - 1980) << 9) | (month << 5) | day. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

const TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

/** CRC-32 as ZIP uses it. Written out so it does not depend on the Node version. */
export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** A name a ZIP may hold: forward slashes, no empty or dot segments (which also rules out an absolute name), no control characters. */
function checkName(name) {
  const bad = name === "" || name.includes("\\") || [...name].some((char) => char.charCodeAt(0) < 32) || name.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  if (bad) throw new Error(`release zip: "${name}" is not a name a package may have`);
  if (Buffer.byteLength(name, "utf8") > 0xffff) throw new Error(`release zip: "${name}" is too long`);
}

/**
 * The archive for these files. `entries` is `{ name, data }` with `data` a Buffer. The order given does not matter:
 * they are sorted by the bytes of their names.
 */
export function buildZip(entries) {
  if (entries.length === 0) throw new Error("release zip: there is nothing to put in it");
  if (entries.length > MAX_ENTRIES) throw new Error("release zip: too many files for a plain ZIP");
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
  const seen = new Set();
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    checkName(name);
    if (seen.has(name)) throw new Error(`release zip: "${name}" is in it twice`);
    seen.add(name);
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const method = stored ? 0 : 8;
    if (data.length > MAX_BYTES || offset > MAX_BYTES) throw new Error("release zip: too large for a plain ZIP");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(UTF8_NAMES, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** Every regular file under `dir`, as `{ name, data }` with a forward-slash name relative to it. */
export function collectFiles(dir) {
  const files = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error(`release zip: ${name} is a symbolic link, which a package may not hold`);
      if (info.isDirectory()) visit(full, name);
      else if (info.isFile()) files.push({ name, data: readFileSync(full) });
      else throw new Error(`release zip: ${name} is not a regular file`);
    }
  };
  visit(dir, "");
  return files;
}

/** Writes the ZIP for `dir` to `outFile`. Returns what a person needs to check it: the file count, the bytes and the SHA-256. */
export function zipDirectory(dir, outFile) {
  const files = collectFiles(dir);
  const zip = buildZip(files);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, zip);
  return { files: files.length, bytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") };
}

/**
 * One file out of a ZIP, or `undefined` when it is not there. Used by the store jobs to read the manifest they are about to
 * upload, so it reads what any ZIP tool writes (stored or deflated, with or without a comment or a data descriptor) and
 * refuses what a release ZIP never is: ZIP64, encryption, another compression method, or bytes that do not match their CRC-32.
 */
export function readZipEntry(zip, name) {
  const fail = (why) => {
    throw new Error(`release zip: ${why}`);
  };
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) fail("this is not a ZIP: no end-of-directory record");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) fail("ZIP64 is not supported");
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) fail("the central directory is damaged");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const packedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const entryName = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (entryName !== name) continue;

    if (flags & 1) fail(`${name} is encrypted`);
    if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== 0x04034b50) fail(`${name} has a damaged local header`);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    if (start + packedSize > zip.length) fail(`${name} runs past the end of the file`);
    const packed = zip.subarray(start, start + packedSize);
    if (method !== 0 && method !== 8) fail(`${name} uses compression method ${method}, which is not supported`);
    const data = method === 0 ? Buffer.from(packed) : inflateRawSync(packed);
    if (data.length !== size || crc32(data) !== crc) fail(`${name} does not match its checksum`);
    return data;
  }
  return undefined;
}

/** The command line. Returns the exit code, and says what it made through `log`. */
export function run(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const [dir, outFile, ...rest] = argv;
  if (!dir || !outFile || rest.length > 0) {
    log("usage: node scripts/make-release-zip.mjs <dir> <out.zip>");
    return 2;
  }
  try {
    const { files, bytes, sha256 } = zipDirectory(resolve(cwd, dir), resolve(cwd, outFile));
    log(`${sha256}  ${outFile}  (${files} files, ${bytes} bytes)`);
    return 0;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run(process.argv.slice(2));
