import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_COMPONENTS,
  DIAGNOSTIC_RUNTIME_STATES,
  PRODUCT_DIAGNOSTIC_CODES,
  sanitizeDiagnosticEvent,
} from "../../src/diagnostics/diagnosticTypes";

const valid = {
  code: "STORAGE_VALIDATION_FAILED",
  component: "storage",
  occurredAt: "2026-09-19T04:30:12.345Z",
  extensionVersion: "1.0.0",
};

/** Text that must never reach the persistent buffer, in every field it could be smuggled through. */
const PRIVATE = ["alice_handle", "17841400000000000", "Big Alice", "secret note", "https://www.threads.com/@alice", "at Object.<anonymous>"];

describe("diagnostic taxonomy", () => {
  it("pins the product-level codes to the design's list, nothing more", () => {
    expect([...PRODUCT_DIAGNOSTIC_CODES]).toEqual([
      "ACCOUNT_RESOLVER_UNRESOLVED",
      "PROFILE_SURFACE_MOUNT_FAILED",
      "POST_AUTHOR_SURFACE_FAILED",
      "STORAGE_VALIDATION_FAILED",
      "STORAGE_MIGRATION_FAILED",
      "BACKUP_EXPORT_FAILED",
      "BACKUP_IMPORT_INVALID",
      "IMPORT_COMMIT_FAILED",
      "DASHBOARD_SESSION_INVALID",
    ]);
  });

  it("pins the components and the runtime states", () => {
    expect([...DIAGNOSTIC_COMPONENTS]).toEqual([
      "account-resolver",
      "profile-surface",
      "post-author-surface",
      "storage",
      "backup",
      "import",
      "dashboard",
    ]);
    expect([...DIAGNOSTIC_RUNTIME_STATES]).toEqual(["confirmed", "revalidating", "unresolved", "ready", "degraded"]);
  });
});

describe("sanitizeDiagnosticEvent", () => {
  it("accepts a well-formed event, with or without a runtime state", () => {
    expect(sanitizeDiagnosticEvent(valid)).toEqual(valid);
    expect(sanitizeDiagnosticEvent({ ...valid, runtimeState: "degraded" })).toEqual({ ...valid, runtimeState: "degraded" });
  });

  it("rebuilds from the allowlist: any other field is dropped, whatever it holds", () => {
    const smuggled = {
      ...valid,
      username: "alice_handle",
      threadsUserId: "17841400000000000",
      nickname: "Big Alice",
      note: "secret note",
      url: "https://www.threads.com/@alice",
      directoryId: "dir-1",
      contactId: "c-1",
      message: "boom",
      stack: "at Object.<anonymous>",
    };

    const result = sanitizeDiagnosticEvent(smuggled);

    expect(result).toEqual(valid);
    expect(Object.keys(result ?? {}).sort()).toEqual(["code", "component", "extensionVersion", "occurredAt"]);
    for (const text of PRIVATE) expect(JSON.stringify(result)).not.toContain(text);
  });

  it.each([
    ["an unknown code", { ...valid, code: "SOMETHING_ELSE" }],
    ["a code carrying free text", { ...valid, code: "STORAGE_VALIDATION_FAILED: alice_handle" }],
    ["an unknown component", { ...valid, component: "popup" }],
    ["an unknown runtime state", { ...valid, runtimeState: "alice_handle" }],
    ["a non-string runtime state", { ...valid, runtimeState: { kind: "confirmed" } }],
    ["a missing code", { ...valid, code: undefined }],
    ["a missing component", { ...valid, component: undefined }],
    ["a missing timestamp", { ...valid, occurredAt: undefined }],
    ["a missing version", { ...valid, extensionVersion: undefined }],
  ])("rejects %s", (_label, event) => {
    expect(sanitizeDiagnosticEvent(event)).toBeNull();
  });

  it.each([
    ["a date only", "2026-09-19"],
    ["a locale string", "Sat Sep 19 2026 04:30:12 GMT+0000"],
    ["a UTC offset instead of Z", "2026-09-19T12:30:12.345+08:00"],
    ["no milliseconds", "2026-09-19T04:30:12Z"],
    ["text after the timestamp", "2026-09-19T04:30:12.345Z alice_handle"],
    ["an impossible date", "2026-02-31T04:30:12.345Z"],
    ["a number", 1789792212345],
  ])("rejects a timestamp that is %s - only Date#toISOString output is a timestamp", (_label, occurredAt) => {
    expect(sanitizeDiagnosticEvent({ ...valid, occurredAt })).toBeNull();
  });

  it.each([
    ["a leading v", "v1.0.0"],
    ["two parts", "1.0"],
    ["text after it", "1.0.0 alice_handle"],
    ["a pre-release tag", "1.0.0-alice"],
    ["a number", 1],
    ["an oversized part", "1.0.123456789"],
  ])("rejects a version that is %s", (_label, extensionVersion) => {
    expect(sanitizeDiagnosticEvent({ ...valid, extensionVersion })).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "STORAGE_VALIDATION_FAILED"],
    ["an array", [valid]],
    ["undefined", undefined],
    ["a number", 7],
  ])("rejects %s", (_label, value) => {
    expect(sanitizeDiagnosticEvent(value)).toBeNull();
  });

  it("reads own data properties only - inherited values and getters are ignored", () => {
    expect(sanitizeDiagnosticEvent(Object.create(valid))).toBeNull();

    let getterRan = false;
    const withGetter = { ...valid };
    Object.defineProperty(withGetter, "code", {
      enumerable: true,
      get() {
        getterRan = true;
        return "STORAGE_VALIDATION_FAILED";
      },
    });
    expect(sanitizeDiagnosticEvent(withGetter)).toBeNull();
    expect(getterRan).toBe(false);
  });

  it("returns null instead of throwing on a hostile object", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );

    expect(sanitizeDiagnosticEvent(hostile)).toBeNull();
  });
});
