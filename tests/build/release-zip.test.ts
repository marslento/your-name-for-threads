import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 as platformCrc32, deflateRawSync, inflateRawSync } from "node:zlib";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auditPackage } from "../../scripts/release-audit.mjs";
import { buildZip, crc32, readZipEntry, run, zipDirectory } from "../../scripts/make-release-zip.mjs";
import { buildPackage, filesUnder, removeBuilt, scratchDirectory } from "../fixtures/buildPackage";
import { ROOT } from "../fixtures/repoFiles";

/**
 * The release ZIP (Phase 4 Task 37; review checklist 39 and 40). It is what both stores and the GitHub release receive,
 * so what is held here is that it is exactly the audited files, that it is deterministic (the same files give the same
 * bytes, in any order, at any time), and that it is a real ZIP: it is read back here by a reader written apart from the
 * writer, with a CRC from the platform, and by the platform's own unzip when there is one, and a real production build is
 * zipped, extracted and put through the package audit.
 */
const put = (dir: string, name: string, data: Buffer | string) => {
  const path = join(dir, ...name.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
};

interface Entry {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  flags: number;
  time: number;
  date: number;
  versionNeeded: number;
  versionMade: number;
  externalAttributes: number;
  extraLength: number;
  data: Buffer;
}

/** A reader that shares nothing with the writer: it finds the end record, walks the central directory, and checks every local header against it. */
function readZip(zip: Buffer): Entry[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end), "the end-of-directory signature is in its place, with no comment after it").toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  expect(zip.readUInt16LE(end + 8)).toBe(count);
  expect(zip.readUInt16LE(end + 20), "no archive comment").toBe(0);
  let at = zip.readUInt32LE(end + 16);
  expect(at + zip.readUInt32LE(end + 12), "the directory ends where the end record starts").toBe(end);
  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const offset = zip.readUInt32LE(at + 42);
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);

    expect(zip.readUInt32LE(offset), `${name}: local header`).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(offset + 26);
    expect(zip.subarray(offset + 30, offset + 30 + localNameLength).toString("utf8"), `${name}: the local name`).toBe(name);
    expect(zip.readUInt16LE(offset + 8), `${name}: the local method`).toBe(method);
    expect(zip.readUInt32LE(offset + 14), `${name}: the local CRC`).toBe(zip.readUInt32LE(at + 16));
    expect(zip.readUInt16LE(offset + 4), `${name}: the local version needed`).toBe(zip.readUInt16LE(at + 6));
    expect(zip.readUInt16LE(offset + 6), `${name}: the local flags`).toBe(zip.readUInt16LE(at + 8));
    expect(zip.readUInt16LE(offset + 10), `${name}: the local time`).toBe(zip.readUInt16LE(at + 12));
    expect(zip.readUInt16LE(offset + 12), `${name}: the local date`).toBe(zip.readUInt16LE(at + 14));
    expect(zip.readUInt32LE(offset + 18), `${name}: the local compressed size`).toBe(compressed);
    expect(zip.readUInt32LE(offset + 22), `${name}: the local size`).toBe(zip.readUInt32LE(at + 24));
    const dataStart = offset + 30 + localNameLength + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressed);
    entries.push({
      name,
      method,
      crc: zip.readUInt32LE(at + 16),
      compressed,
      size: zip.readUInt32LE(at + 24),
      flags: zip.readUInt16LE(at + 8),
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      versionNeeded: zip.readUInt16LE(at + 6),
      versionMade: zip.readUInt16LE(at + 4),
      externalAttributes: zip.readUInt32LE(at + 38),
      extraLength: zip.readUInt16LE(at + 30),
      data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

const unzipHere = spawnSync("unzip", ["-v"], { encoding: "utf8" }).status === 0;
const tarHere = spawnSync("tar", ["--version"], { encoding: "utf8" }).status === 0;

afterEach(removeBuilt);

describe("what the ZIP holds", () => {
  it("is every file in the directory, read back byte for byte by a reader that is not the writer's, with a CRC from the platform", () => {
    const dir = scratchDirectory();
    const files: Record<string, Buffer> = {
      "manifest.json": Buffer.from('{"name":"x","version":"1.0.0"}\n'.repeat(40)),
      "assets/app.js": Buffer.from("export const a = 1;\n".repeat(500)),
      "assets/random.bin": randomBytes(4096),
      "empty.txt": Buffer.alloc(0),
      "_locales/zh_TW/messages.json": Buffer.from('{"名稱":"你的名字"}\n'.repeat(30)),
      "src/popup/ü.html": Buffer.from("<p>ü</p>".repeat(100)),
    };
    for (const [name, data] of Object.entries(files)) put(dir, name, data);
    const out = join(scratchDirectory(), "x.zip");

    zipDirectory(dir, out);

    const entries = readZip(readFileSync(out));
    expect(entries.map((entry) => entry.name)).toEqual(Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    for (const entry of entries) {
      expect(entry.data.equals(files[entry.name]), entry.name).toBe(true);
      expect(entry.size, entry.name).toBe(files[entry.name].length);
      expect(entry.crc, `${entry.name}: the platform's own CRC-32`).toBe(platformCrc32(files[entry.name]));
    }
  });

  it("compresses what compresses and stores what does not, and never makes a file larger", () => {
    const zip = buildZip([
      { name: "text.txt", data: Buffer.from("hello ".repeat(1000)) },
      { name: "random.bin", data: randomBytes(2048) },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ]);
    const byName = Object.fromEntries(readZip(zip).map((entry) => [entry.name, entry]));

    expect(byName["text.txt"].method).toBe(8);
    expect(byName["text.txt"].compressed).toBeLessThan(byName["text.txt"].size);
    expect(byName["random.bin"].method).toBe(0);
    expect(byName["random.bin"].compressed).toBe(2048);
    expect(byName["empty.txt"].method).toBe(0);
    expect(byName["empty.txt"].compressed).toBe(0);
  });

  it("compresses at the highest level, so the size is the smallest and the same everywhere", () => {
    const text = Buffer.from("the same words again and again, ".repeat(400));
    const [entry] = readZip(buildZip([{ name: "a.txt", data: text }]));

    expect(entry.method).toBe(8);
    expect(entry.compressed).toBe(deflateRawSync(text, { level: 9 }).length);
    expect(entry.compressed).toBeLessThan(deflateRawSync(text, { level: 1 }).length);
  });

  it("creates the directory it writes into", () => {
    const dir = scratchDirectory();
    put(dir, "a.js", "x");
    const out = join(scratchDirectory(), "not", "there", "yet", "x.zip");

    zipDirectory(dir, out);

    expect(readZip(readFileSync(out)).map((entry) => entry.name)).toEqual(["a.js"]);
  });

  it("agrees with the platform's CRC-32 on any bytes", () => {
    for (const data of [Buffer.alloc(0), Buffer.from("a"), Buffer.from("123456789"), randomBytes(10_000)]) expect(crc32(data)).toBe(platformCrc32(data));
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("determinism", () => {
  const sample = (dir: string, order: string[]) => {
    for (const name of order) put(dir, name, Buffer.from(`contents of ${name}\n`.repeat(20)));
  };
  const NAMES = ["b/two.js", "a/one.js", "manifest.json", "a/z.json", "_locales/en/messages.json"];

  it("gives the same bytes for the same files however they were created, and however often it is run", () => {
    const first = scratchDirectory();
    const second = scratchDirectory();
    sample(first, NAMES);
    sample(second, [...NAMES].reverse());
    const a = join(scratchDirectory(), "a.zip");
    const b = join(scratchDirectory(), "b.zip");
    const c = join(scratchDirectory(), "c.zip");

    zipDirectory(first, a);
    zipDirectory(second, b);
    zipDirectory(first, c);

    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    expect(readFileSync(a).equals(readFileSync(c))).toBe(true);
  });

  it("does not record when the files were made, so changing their timestamps changes nothing", () => {
    const dir = scratchDirectory();
    sample(dir, NAMES);
    const before = join(scratchDirectory(), "before.zip");
    const after = join(scratchDirectory(), "after.zip");
    zipDirectory(dir, before);

    const later = new Date(Date.now() + 86_400_000 * 400);
    for (const file of filesUnder(dir)) utimesSync(file, later, later);
    zipDirectory(dir, after);

    expect(readFileSync(before).equals(readFileSync(after))).toBe(true);
  });

  it("sorts by name, dates everything 1980-01-01 00:00, and records no owner, permissions, extra field or comment", () => {
    const zip = buildZip(NAMES.map((name) => ({ name, data: Buffer.from(`x${name}`) })));
    const entries = readZip(zip);

    expect(entries.map((entry) => entry.name)).toEqual([...NAMES].sort());
    for (const entry of entries) {
      expect(entry.date, entry.name).toBe(0x0021);
      expect(entry.time, entry.name).toBe(0);
      expect(entry.externalAttributes, entry.name).toBe(0);
      expect(entry.extraLength, entry.name).toBe(0);
      expect(entry.versionNeeded).toBe(20);
      expect(entry.versionMade).toBe(20);
      expect(entry.flags, "names are UTF-8").toBe(0x0800);
    }
  });

  it("changes when a file changes, or a name does", () => {
    const base = [{ name: "a.js", data: Buffer.from("one") }];

    expect(buildZip(base).equals(buildZip([{ name: "a.js", data: Buffer.from("two") }]))).toBe(false);
    expect(buildZip(base).equals(buildZip([{ name: "b.js", data: Buffer.from("one") }]))).toBe(false);
  });

  it("hashes to the SHA-256 the command prints", () => {
    const dir = scratchDirectory();
    sample(dir, NAMES);
    const out = join(scratchDirectory(), "x.zip");
    const said: string[] = [];

    expect(run([dir, out], { log: (line) => said.push(line) })).toBe(0);

    expect(said[0]).toContain(createHash("sha256").update(readFileSync(out)).digest("hex"));
    expect(said[0]).toContain(`(${NAMES.length} files`);
  });
});

describe("what it refuses", () => {
  it("refuses a directory with nothing in it", () => {
    const said: string[] = [];

    expect(run([scratchDirectory(), join(scratchDirectory(), "x.zip")], { log: (line) => said.push(line) })).toBe(1);
    expect(said[0]).toMatch(/nothing to put in it/);
  });

  it.each([
    ["a name that climbs out", "../x.js"],
    ["an absolute name", "/x.js"],
    ["a name with a backslash", "a\\b.js"],
    ["an empty segment", "a//b.js"],
    ["a dot segment", "a/./b.js"],
    ["an empty name", ""],
    ["a control character", `a${String.fromCharCode(1)}b.js`],
  ])("refuses %s", (_what, name) => {
    expect(() => buildZip([{ name, data: Buffer.from("x") }])).toThrow(/not a name a package may have/);
  });

  it("refuses the same name twice", () => {
    expect(() => buildZip([{ name: "a.js", data: Buffer.from("1") }, { name: "a.js", data: Buffer.from("2") }])).toThrow(/twice/);
  });

  it("refuses a symbolic link, which a package may not hold", () => {
    const dir = scratchDirectory();
    put(dir, "real.js", "x");
    put(dir, "sub/inside.js", "y");
    const linked = (() => {
      try {
        symlinkSync(join(dir, "real.js"), join(dir, "link.js"));
        return true;
      } catch {
        try {
          symlinkSync(join(dir, "sub"), join(dir, "link"), "junction"); // Windows without the privilege for a file link can still make a junction, which Node reports as a link
          return true;
        } catch {
          return false;
        }
      }
    })();
    if (!linked) return; // nothing that counts as a link can be made here

    expect(() => zipDirectory(dir, join(scratchDirectory(), "x.zip"))).toThrow(/symbolic link/);
  });

  it("says how to use it, and fails, when it is given too little", () => {
    const said: string[] = [];

    expect(run([], { log: (line) => said.push(line) })).toBe(2);
    expect(run(["only-a-dir"], { log: (line) => said.push(line) })).toBe(2);
    expect(said.every((line) => line.startsWith("usage:"))).toBe(true);
  });
});

/** A ZIP made by another tool (Python's zipfile): a deflated manifest, a stored binary and a name with an accent, so the reader is not only ever shown the writer's own output. */
const FOREIGN = Buffer.from("UEsDBBQAAAAIAMBTsVDG0MZGOAAAACIBAAANAAAAbWFuaWZlc3QuanNvbqtWyk3My0xLLS6JL0stKs7Mz1OyMtZRykvMTVWyUnLLrCgpLUpV0lGCSyoZ6RnrmSjVclWPEJ0AUEsDBBQAAAAAAMBTsVCAYQjtyAAAAMgAAAALAAAAaWNvbnMvYS5iaW4AAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx1BLAwQUAAAICADAU7FQTPxaZgsAAAB4AAAADQAAAGRpci9jYWbDqS50eHTLSM3JyefKoDsJAFBLAQIUABQAAAAIAMBTsVDG0MZGOAAAACIBAAANAAAAAAAAAAAAAACAAQAAAABtYW5pZmVzdC5qc29uUEsBAhQAFAAAAAAAwFOxUIBhCO3IAAAAyAAAAAsAAAAAAAAAAAAAAIABYwAAAGljb25zL2EuYmluUEsBAhQAFAAACAgAwFOxUEz8WmYLAAAAeAAAAA0AAAAAAAAAAAAAAIABVAEAAGRpci9jYWbDqS50eHRQSwUGAAAAAAMAAwCvAAAAigEAAAAA", "base64");

describe("reading a file out of a ZIP", () => {
  const seen = (data: Buffer) => data.toString("utf8");

  it("reads what another tool wrote: a deflated file, a stored one and a name with an accent, and finds nothing where there is nothing", () => {
    expect(seen(readZipEntry(FOREIGN, "manifest.json")!)).toContain('"version":"2.3.4"');
    expect(readZipEntry(FOREIGN, "icons/a.bin")!.equals(Buffer.from(Array.from({ length: 200 }, (_, index) => index)))).toBe(true);
    expect(seen(readZipEntry(FOREIGN, "dir/café.txt")!)).toBe("hello\n".repeat(20));
    expect(readZipEntry(FOREIGN, "nothing/here.json")).toBeUndefined();
  });

  it("reads back what the writer wrote, empty files and incompressible ones included", () => {
    const random = randomBytes(3000);
    const zip = buildZip([
      { name: "a/manifest.json", data: Buffer.from('{"version":"1.0.0"}\n'.repeat(30)) },
      { name: "empty.txt", data: Buffer.alloc(0) },
      { name: "random.bin", data: random },
    ]);

    expect(seen(readZipEntry(zip, "a/manifest.json")!)).toContain('"version":"1.0.0"');
    expect(readZipEntry(zip, "empty.txt")!.length).toBe(0);
    expect(readZipEntry(zip, "random.bin")!.equals(random)).toBe(true);
  });

  it("does not match a name that only starts the same, or only ends the same", () => {
    const zip = buildZip([{ name: "assets/manifest.json", data: Buffer.from("x") }, { name: "manifest.json.bak", data: Buffer.from("y") }]);

    expect(readZipEntry(zip, "manifest.json")).toBeUndefined();
  });

  describe("refuses", () => {
    const stored = randomBytes(64);
    const make = () => buildZip([{ name: "a.bin", data: stored }, { name: "z.txt", data: Buffer.from("later") }]);
    const directoryAt = (zip: Buffer) => zip.readUInt32LE(zip.length - 22 + 16);

    it("something that is not a ZIP", () => {
      expect(() => readZipEntry(randomBytes(500), "a.bin")).toThrow(/not a ZIP/);
      expect(() => readZipEntry(Buffer.alloc(0), "a.bin")).toThrow(/not a ZIP/);
    });

    it("bytes that have been changed, so that they no longer match their checksum", () => {
      const zip = make();
      zip[zip.indexOf(stored) + 5] ^= 0xff;

      expect(() => readZipEntry(zip, "a.bin")).toThrow(/does not match its checksum/);
    });

    it("an encrypted file", () => {
      const zip = make();
      zip.writeUInt16LE(zip.readUInt16LE(directoryAt(zip) + 8) | 1, directoryAt(zip) + 8);

      expect(() => readZipEntry(zip, "a.bin")).toThrow(/is encrypted/);
    });

    it("a compression method it does not know", () => {
      const zip = make();
      zip.writeUInt16LE(12, directoryAt(zip) + 10);

      expect(() => readZipEntry(zip, "a.bin")).toThrow(/compression method 12/);
    });

    it("ZIP64, which a release ZIP never needs", () => {
      const zip = make();
      zip.writeUInt16LE(0xffff, zip.length - 22 + 10);

      expect(() => readZipEntry(zip, "a.bin")).toThrow(/ZIP64/);
    });

    it("a damaged central directory, and a damaged local header", () => {
      const damagedDirectory = make();
      damagedDirectory.writeUInt32LE(0, directoryAt(damagedDirectory));
      const damagedLocal = make();
      damagedLocal.writeUInt32LE(0, 0);

      expect(() => readZipEntry(damagedDirectory, "a.bin")).toThrow(/central directory is damaged/);
      expect(() => readZipEntry(damagedLocal, "a.bin")).toThrow(/damaged local header/);
    });

    it("a file that runs past the end of the archive", () => {
      const zip = make();
      zip.writeUInt32LE(0x7fffffff, directoryAt(zip) + 20);

      expect(() => readZipEntry(zip, "a.bin")).toThrow(/runs past the end/);
    });
  });
});

describe("the platform's own tools", () => {
  const files: Record<string, Buffer> = { "manifest.json": Buffer.from('{"a":1}\n'.repeat(50)), "assets/x.js": Buffer.from("let x;\n".repeat(300)), "b/random.bin": randomBytes(1500), "empty.txt": Buffer.alloc(0) };

  it.skipIf(!unzipHere)("unzip tests the archive as sound, and extracts every file exactly", () => {
    const dir = scratchDirectory();
    for (const [name, data] of Object.entries(files)) put(dir, name, data);
    const zip = join(scratchDirectory(), "x.zip");
    zipDirectory(dir, zip);

    const tested = spawnSync("unzip", ["-t", zip], { encoding: "utf8" });
    const extracted = scratchDirectory();
    const result = spawnSync("unzip", ["-q", zip, "-d", extracted], { encoding: "utf8" });

    expect(tested.status, tested.stdout + tested.stderr).toBe(0);
    expect(tested.stdout).toMatch(/No errors detected/);
    expect(result.status, result.stderr).toBe(0);
    for (const [name, data] of Object.entries(files)) expect(readFileSync(join(extracted, ...name.split("/"))).equals(data), name).toBe(true);
  });

  it.skipIf(unzipHere || !tarHere)("tar (bsdtar) lists the archive, when there is no unzip", () => {
    const dir = scratchDirectory();
    for (const [name, data] of Object.entries(files)) put(dir, name, data);
    const zip = join(scratchDirectory(), "x.zip");
    zipDirectory(dir, zip);

    const listed = spawnSync("tar", ["-tf", zip], { encoding: "utf8" });

    expect(listed.status, listed.stderr).toBe(0);
    for (const name of Object.keys(files)) expect(listed.stdout).toContain(name);
  });
});

describe("a real production build", () => {
  let built: string;

  // A real build takes about three seconds alone and much longer while the whole suite is running, so it is given the same generous timeout as the other tests that build.
  beforeAll(() => {
    built = buildPackage();
  }, 120_000);
  afterAll(removeBuilt);

  it("zips to exactly its files, twice the same, and the extracted ZIP passes the package audit as the build did", () => {
    const zip = join(scratchDirectory(), "release.zip");
    const again = join(scratchDirectory(), "again.zip");
    zipDirectory(built, zip);
    zipDirectory(built, again);
    const entries = readZip(readFileSync(zip));

    expect(readFileSync(zip).equals(readFileSync(again))).toBe(true);
    expect(entries.map((entry) => entry.name).sort()).toEqual(filesUnder(built).map((file) => file.slice(built.length + 1).split("\\").join("/")).sort());
    expect(entries.map((entry) => entry.name)).toContain("manifest.json");

    const extracted = scratchDirectory();
    for (const entry of entries) put(extracted, entry.name, entry.data);
    const audit = auditPackage(extracted, { packageJson: join(ROOT, "package.json") });

    expect(audit.findings).toEqual([]);
    expect(audit.files).toBe(entries.length);
  });
});
