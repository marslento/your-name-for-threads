import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT } from "./repoFiles";

/**
 * Builds the extension for real, into a temporary directory and never over `dist`, using Vite's own entry point so no
 * shell is involved. A build is a few seconds, and what the package holds is only worth asserting if it comes from a
 * build and not from reading the config. Call `removeBuilt()` in `afterAll`.
 */
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const made: string[] = [];

export function buildPackage(...flags: string[]): string {
  const outDir = mkdtempSync(join(tmpdir(), "tpd-build-"));
  made.push(outDir);
  // The test runner sets NODE_ENV to "test", which Vite would pass on and React would answer with its development build: not what `pnpm build` ships.
  execFileSync(process.execPath, [VITE, "build", "--outDir", outDir, "--emptyOutDir", ...flags], { cwd: ROOT, stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } });
  return outDir;
}

/** A scratch directory that goes with the builds. */
export function scratchDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "tpd-scratch-"));
  made.push(dir);
  return dir;
}

export function removeBuilt(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Every file under a directory, as absolute paths. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
