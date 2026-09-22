import { CURRENT_BACKUP_VERSION } from "../portability/backupTypes";
import { PHASE_ONE_VERSION } from "../shared/constants";
import { splitDamagedDirectories } from "../recovery/quarantine";
import { SURFACES, SURFACE_HEALTH_VALUES, type SurfaceHealth, type SurfaceName } from "../shared/surfaceHealth";
import { recoveryStateFor } from "../recovery/RecoveryCoordinator";
import { findInvalidDirectoryIds, migrateStorage } from "../storage/migrations";
import type { ExtensionStorageV4 } from "../storage/schema";
import { DIAGNOSTICS_STORAGE_KEY, parseStoredDiagnostics } from "./DiagnosticStore";

const ACCOUNT_STATES = ["confirmed", "revalidating", "unresolved"] as const;

type AccountState = (typeof ACCOUNT_STATES)[number];

export interface DiagnosticSummaryOptions {
  /** The Current Account Resolver's state in the calling context, if it has one. */
  accountState?: AccountState;
  /** Whose Directory to count. Used to look it up and never printed. */
  ownerThreadsUserId?: string;
  /** Surface health as the caller knows it (Tasks 21-23). */
  surfaces?: Partial<Record<SurfaceName, SurfaceHealth>>;
  /** Injectable for tests; default to `navigator`. Only a family and a major version ever leave them. */
  userAgent?: string;
  platform?: string;
}

type Snapshot = Record<string, unknown>;

type DirectoryFacts =
  | { kind: "not-available" }
  | { kind: "unavailable" }
  | { kind: "none" }
  | { kind: "present"; contacts: number; tombstones: number; pendingConflicts: number };

function isMember<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

// The user agent and platform strings are reduced to a closed family plus, for
// the browser, digits. The raw strings carry far more than support needs.
function browserFamily(userAgent: string): string {
  const edge = /Edg\/(\d+)/.exec(userAgent);
  if (edge) return `Edge ${edge[1]}`;
  if (/OPR\/|Vivaldi\/|YaBrowser\//.test(userAgent)) return "Other Chromium";
  const chrome = /Chrome\/(\d+)/.exec(userAgent);
  return chrome ? `Chrome ${chrome[1]}` : "Other";
}

function platformFamily(platform: string, userAgent: string): string {
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/^Win/i.test(platform) || /Windows/.test(userAgent)) return "Windows";
  if (/^Mac/i.test(platform) || /Macintosh/.test(userAgent)) return "macOS";
  if (/Linux|X11/i.test(`${platform} ${userAgent}`)) return "Linux";
  return "Other";
}

async function readSnapshot(): Promise<Snapshot | undefined> {
  try {
    const stored: unknown = await chrome.storage.local.get();
    return typeof stored === "object" && stored !== null ? (stored as Snapshot) : undefined;
  } catch {
    return undefined;
  }
}

function storageSchema(snapshot: Snapshot | undefined): string {
  if (!snapshot) return "unavailable";
  const version = snapshot.schemaVersion;
  if (version === undefined) return "none";
  return typeof version === "number" && Number.isInteger(version) && version >= 0 && version < 1000 ? String(version) : "unavailable";
}

/**
 * Counts come only from current-version storage, through the pure V4 read
 * (`migrateStorage` on a V4 snapshot allocates and writes nothing). An older,
 * unsupported or invalid snapshot is reported as unavailable: it is never
 * migrated to get a count, because that migration rewrites (and for V3
 * discards) the very data the report is about.
 */
/**
 * A Directory that is damaged on its own is set aside, so another account's counts can still be reported
 * while the damaged account's are unavailable. Damage anywhere else throws, and is reported as unavailable.
 * Reads only, like everything here.
 */
function readStorageForFacts(snapshot: Snapshot, owner: string): { storage: ExtensionStorageV4; inRecovery: boolean } {
  try {
    return { storage: migrateStorage(snapshot), inRecovery: false };
  } catch (error) {
    const damaged = findInvalidDirectoryIds(snapshot);
    if (damaged.length === 0) throw error;
    const { usable, quarantine } = splitDamagedDirectories(snapshot, damaged);
    return { storage: migrateStorage(usable), inRecovery: Object.hasOwn(quarantine.accountBindings, owner) };
  }
}

/** A closed-set state and code, or "unavailable": nothing stored can reach it. */
function recoveryLine(snapshot: Snapshot | undefined, owner: string | undefined): string {
  if (!snapshot) return "unavailable";
  const state = recoveryStateFor(snapshot, owner ?? null);
  return state.kind === "none" ? "none" : `${state.kind} (${state.code})`;
}

function directoryFacts(snapshot: Snapshot | undefined, ownerThreadsUserId: string | undefined): DirectoryFacts {
  if (ownerThreadsUserId === undefined) return { kind: "not-available" };
  if (!snapshot || snapshot.schemaVersion !== 4) return { kind: "unavailable" };
  try {
    const { storage, inRecovery } = readStorageForFacts(snapshot, ownerThreadsUserId);
    if (inRecovery) return { kind: "unavailable" };
    const directoryId = storage.accountBindings[ownerThreadsUserId];
    const directory = directoryId === undefined ? undefined : storage.directories[directoryId];
    if (!directory) return { kind: "none" };
    return {
      kind: "present",
      contacts: Object.keys(directory.contacts).length,
      tombstones: Object.keys(directory.tombstones).length,
      pendingConflicts: Object.keys(directory.identityConflicts).length,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function surfaceLine(surfaces: DiagnosticSummaryOptions["surfaces"]): string {
  if (!surfaces) return "not reported";
  return SURFACES.map((name) => `${name}=${isMember(SURFACE_HEALTH_VALUES, surfaces[name]) ? surfaces[name] : "unknown"}`).join(", ");
}

function directoryLines(facts: DirectoryFacts): string[] {
  switch (facts.kind) {
    case "not-available":
      return ["Directory exists: not available in this context", "Contact count: n/a", "Tombstone count: n/a", "Pending conflict count: n/a"];
    case "unavailable":
      return ["Directory exists: unavailable", "Contact count: unavailable", "Tombstone count: unavailable", "Pending conflict count: unavailable"];
    case "none":
      return ["Directory exists: no", "Contact count: n/a", "Tombstone count: n/a", "Pending conflict count: n/a"];
    case "present":
      return [
        "Directory exists: yes",
        `Contact count: ${facts.contacts}`,
        `Tombstone count: ${facts.tombstones}`,
        `Pending conflict count: ${facts.pendingConflicts}`,
      ];
  }
}

/**
 * The text behind "Copy diagnostics" (Phase 4 §7-8), written to be pasted into
 * a public GitHub issue. Every value in it is a closed-set label, a number, a
 * boolean, a timestamp or a version: no username, ID, nickname, note, URL or
 * Directory identifier can reach it, because none of them is ever read into a
 * variable that gets printed. Counts are counts. Always English, whatever the
 * UI language, so reports read the same to whoever triages them.
 *
 * A pure read: one snapshot of storage, and nothing written, migrated or
 * recorded - the schema, the counts and the events describe the same moment,
 * and summarising storage cannot change the storage being summarised. That
 * matters most where the summary is needed most, on data that is old or
 * broken (Recovery).
 *
 * Never throws: a part that cannot be read prints "unavailable", which is
 * itself useful in a report.
 */
export async function collectDiagnosticSummary(options: DiagnosticSummaryOptions = {}): Promise<string> {
  const env = typeof navigator === "undefined" ? undefined : navigator;
  const userAgent = options.userAgent ?? env?.userAgent ?? "";
  const platform =
    options.platform ?? (env as (Navigator & { userAgentData?: { platform?: string } }) | undefined)?.userAgentData?.platform ?? env?.platform ?? "";

  const snapshot = await readSnapshot();
  const events = parseStoredDiagnostics(snapshot?.[DIAGNOSTICS_STORAGE_KEY]);

  return [
    "Your Name for Threads Diagnostics",
    "",
    `Version: ${PHASE_ONE_VERSION}`,
    `Browser: ${browserFamily(userAgent)}`,
    `Platform: ${platformFamily(platform, userAgent)}`,
    `Storage schema: ${storageSchema(snapshot)}`,
    `Backup version: ${CURRENT_BACKUP_VERSION}`,
    `Account resolver state: ${isMember(ACCOUNT_STATES, options.accountState) ? options.accountState : "not available in this context"}`,
    `Recovery state: ${recoveryLine(snapshot, options.ownerThreadsUserId)}`,
    ...directoryLines(directoryFacts(snapshot, options.ownerThreadsUserId)),
    `Runtime surface status: ${surfaceLine(options.surfaces)}`,
    events.length === 0 ? "Recent diagnostic error codes: none" : "Recent diagnostic error codes:",
    ...events.map((e) => `- ${e.occurredAt} ${e.code} (${e.component}${e.runtimeState ? `, ${e.runtimeState}` : ""})`),
  ].join("\n");
}
