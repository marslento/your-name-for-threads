/**
 * The persistent diagnostic taxonomy (Phase 4 §5-6). Everything a diagnostic
 * event may say is one of these closed sets or a machine-generated timestamp
 * or version - there is deliberately no free-text field, because a free
 * string is exactly how a username, a note or an exception message would get
 * into a buffer that users copy into public GitHub issues.
 *
 * TypeScript alone cannot promise that at runtime (a `record()` caller can be
 * cast, and storage is untrusted input), so `sanitizeDiagnosticEvent` rebuilds
 * every event from this allowlist; the store runs it on the way in and on the
 * way out.
 */
export const PRODUCT_DIAGNOSTIC_CODES = [
  "ACCOUNT_RESOLVER_UNRESOLVED",
  "PROFILE_SURFACE_MOUNT_FAILED",
  "POST_AUTHOR_SURFACE_FAILED",
  "STORAGE_VALIDATION_FAILED",
  "STORAGE_MIGRATION_FAILED",
  "BACKUP_EXPORT_FAILED",
  "BACKUP_IMPORT_INVALID",
  "IMPORT_COMMIT_FAILED",
  "DASHBOARD_SESSION_INVALID",
] as const;

export const DIAGNOSTIC_COMPONENTS = [
  "account-resolver",
  "profile-surface",
  "post-author-surface",
  "storage",
  "backup",
  "import",
  "dashboard",
] as const;

/**
 * The state of the thing that failed, from the states the product already
 * has: the Current Account Resolver's (`AccountResolutionState`) and a
 * surface's health (`ready` / `degraded`, Task 21). Recovery scopes join this
 * set when Recovery Mode lands (Tasks 17-18) - a closed union is cheap to
 * widen, and one that is never widened by accident is the point.
 */
export const DIAGNOSTIC_RUNTIME_STATES = ["confirmed", "revalidating", "unresolved", "ready", "degraded"] as const;

export type ProductDiagnosticCode = (typeof PRODUCT_DIAGNOSTIC_CODES)[number];
export type DiagnosticComponent = (typeof DIAGNOSTIC_COMPONENTS)[number];
export type DiagnosticRuntimeState = (typeof DIAGNOSTIC_RUNTIME_STATES)[number];

export interface DiagnosticEvent {
  code: ProductDiagnosticCode;
  component: DiagnosticComponent;
  /** `Date#toISOString()` output. */
  occurredAt: string;
  /** `major.minor.patch` of the build that recorded it. */
  extensionVersion: string;
  runtimeState?: DiagnosticRuntimeState;
}

// Machine formats only: what `Date#toISOString()` and a manifest version can
// produce, so neither can carry a sentence.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

function isMember<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const time = Date.parse(value);
  // Round-trip catches shapes the regex admits but no real instant has (2026-02-31).
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

/** Own data properties only: no inherited values, and no getter ever runs. */
function readOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Rebuilds an event from the allowlist, or returns null. Fields outside the
 * allowlist are dropped without being looked at; a field inside it that is
 * present but not valid rejects the whole event rather than being patched -
 * an event the code did not build itself is not worth keeping. Never throws.
 */
export function sanitizeDiagnosticEvent(raw: unknown): DiagnosticEvent | null {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

    const code = readOwn(raw, "code");
    const component = readOwn(raw, "component");
    const occurredAt = readOwn(raw, "occurredAt");
    const extensionVersion = readOwn(raw, "extensionVersion");
    const runtimeState = readOwn(raw, "runtimeState");

    if (
      !isMember(PRODUCT_DIAGNOSTIC_CODES, code) ||
      !isMember(DIAGNOSTIC_COMPONENTS, component) ||
      !isCanonicalTimestamp(occurredAt) ||
      typeof extensionVersion !== "string" ||
      !VERSION.test(extensionVersion)
    ) {
      return null;
    }
    if (runtimeState !== undefined && !isMember(DIAGNOSTIC_RUNTIME_STATES, runtimeState)) return null;

    return {
      code,
      component,
      occurredAt,
      extensionVersion,
      ...(runtimeState === undefined ? {} : { runtimeState }),
    };
  } catch {
    return null;
  }
}
