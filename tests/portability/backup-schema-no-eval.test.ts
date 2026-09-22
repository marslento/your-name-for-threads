import { afterEach, describe, expect, it, vi } from "vitest";

import { filesMatching } from "../fixtures/repoFiles";

/**
 * The extension's pages run under a content security policy that forbids `eval` and `new Function`, and a browser reports
 * every attempt as a violation, even one the code catches (Phase 4 Task 46: the packaged Dashboard reported two, from zod's
 * own probe, `Function("")`, which it makes each time a schema is built). So the backup schema has to be built, and a backup
 * parsed, without the engine being asked to compile a string. The `Function` constructor is trapped here, and only calls
 * that come from zod's own files are counted, because the test runner compiles its own modules.
 */
const RealFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = RealFunction;
  vi.resetModules();
});

function trapFunctionConstructor(compiled: unknown[][]): void {
  const fromZod = () => /[\\/]node_modules[\\/]zod[\\/]/.test(new Error().stack ?? "");
  globalThis.Function = new Proxy(RealFunction, {
    construct(target, args, newTarget) {
      if (fromZod()) compiled.push(args);
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) {
      if (fromZod()) compiled.push(args);
      return Reflect.apply(target, thisArg, args);
    },
  });
}

const backup = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: "threads-private-directory-backup",
    backupVersion: 2,
    exportedBy: { threadsUserId: "900", username: "alice" },
    directoryId: "dir-1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    contacts: [{ id: "c1", username: "bob", threadsUserId: "901", nickname: "Bob", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", identityUpdatedAt: "2026-01-01T00:00:00.000Z" }],
    tombstones: [],
    ...extra,
  });

describe("the backup schema under a policy that forbids eval", () => {
  it("(control) is seen asking, when the probe is not switched off", async () => {
    const compiled: unknown[][] = [];
    trapFunctionConstructor(compiled);
    vi.resetModules();
    const { z } = await import("zod");
    z.config({ jitless: false });

    z.object({ a: z.string() }).parse({ a: "x" });

    // It probes with Function(""), and then, where the probe says yes, compiles a parser from a string too: both are refused by the policy.
    expect(compiled[0], "zod probes with Function(\"\") when it is allowed to").toEqual([""]);
    expect(compiled.length).toBeGreaterThanOrEqual(1);
  });

  it("is built, and parses a valid backup and an invalid one, without compiling a string", async () => {
    const compiled: unknown[][] = [];
    trapFunctionConstructor(compiled);
    vi.resetModules();

    const { parseBackupText } = await import("../../src/portability/parseBackup");
    const valid = parseBackupText(backup());
    const invalid = parseBackupText(backup({ contacts: [{ id: "c1" }] }));

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    expect(compiled).toEqual([]);
  });

  it("is the only place the product uses zod, so that setting it there sets it for all", () => {
    expect(filesMatching(/from ["']zod["']/)).toEqual(["src/portability/backupSchema.ts"]);
  });
});
