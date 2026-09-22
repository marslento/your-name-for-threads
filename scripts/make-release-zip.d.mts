export function crc32(buffer: Uint8Array): number;
export function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer;
export function collectFiles(dir: string): Array<{ name: string; data: Buffer }>;
export function readZipEntry(zip: Buffer, name: string): Buffer | undefined;
export function zipDirectory(dir: string, outFile: string): { files: number; bytes: number; sha256: string };
export function run(argv: string[], options?: { cwd?: string; log?: (line: string) => void }): number;
