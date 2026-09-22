/**
 * Whether each in-page Threads integration is working (Phase 4 Task 21, design summary sections 20-21).
 *
 * The surfaces are tracked separately, and nothing links them: a failure of one says nothing about the
 * other, so the Feed keeps working when the Profile UI has failed and the other way round. A surface is
 * `ready` until something reports a failure; it is `degraded` until whoever owns that surface's UI says it
 * is back (a fresh successful mount) or the UI is torn down (there is then nothing left to be broken).
 *
 * Everything in this model is a closed-set name or a closed-set state. There is no field that can carry a
 * URL, a username, an error or a message, so a snapshot can cross a message, sit in session storage and be
 * copied into a public bug report without a private value being able to ride along.
 */
export const SURFACES = ["profile", "post-author"] as const;
export const SURFACE_HEALTH_VALUES = ["ready", "degraded"] as const;

export type SurfaceName = (typeof SURFACES)[number];
export type SurfaceHealth = (typeof SURFACE_HEALTH_VALUES)[number];
export type SurfaceHealthSnapshot = Readonly<Record<SurfaceName, SurfaceHealth>>;

export const READY_SURFACES: SurfaceHealthSnapshot = Object.freeze({ profile: "ready", "post-author": "ready" });

export const isSurfaceName = (value: unknown): value is SurfaceName => typeof value === "string" && (SURFACES as readonly string[]).includes(value);
export const isSurfaceHealth = (value: unknown): value is SurfaceHealth => typeof value === "string" && (SURFACE_HEALTH_VALUES as readonly string[]).includes(value);

/**
 * Rebuilds a snapshot from whatever arrived (a message from a content script, a value from session
 * storage): every surface, own data properties only, known values only, and nothing else it carried. Not
 * an object, or a surface missing or with a value that is not in the closed set, is `undefined`: a report
 * that cannot be read is dropped whole rather than half believed.
 */
export function parseSurfaceHealth(value: unknown): SurfaceHealthSnapshot | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const rebuilt: Partial<Record<SurfaceName, SurfaceHealth>> = {};
  for (const surface of SURFACES) {
    const descriptor = Object.getOwnPropertyDescriptor(value, surface);
    if (!descriptor || !("value" in descriptor) || !isSurfaceHealth(descriptor.value)) return undefined;
    rebuilt[surface] = descriptor.value;
  }
  return Object.freeze(rebuilt as Record<SurfaceName, SurfaceHealth>);
}

export const anyDegraded = (snapshot: SurfaceHealthSnapshot | undefined): boolean => snapshot !== undefined && SURFACES.some((surface) => snapshot[surface] === "degraded");

/** Degraded wherever any of them is, per surface; `undefined` when there is nothing to combine. */
export function worstOf(snapshots: readonly SurfaceHealthSnapshot[]): SurfaceHealthSnapshot | undefined {
  if (snapshots.length === 0) return undefined;
  return Object.freeze(
    Object.fromEntries(SURFACES.map((surface) => [surface, snapshots.some((snapshot) => snapshot[surface] === "degraded") ? "degraded" : "ready"])) as Record<SurfaceName, SurfaceHealth>,
  );
}

/**
 * One page's surfaces. `report` is the only way a state changes; an unknown surface is ignored, so the set
 * cannot grow by someone reporting a name, and a report that changes nothing tells nobody anything, which
 * is what keeps a surface that fails on every mutation from becoming a stream of messages.
 */
export class SurfaceHealthTracker {
  private current: SurfaceHealthSnapshot = READY_SURFACES;
  private readonly listeners = new Set<() => void>();

  snapshot(): SurfaceHealthSnapshot {
    return this.current;
  }

  report(surface: string, health: SurfaceHealth): void {
    if (!isSurfaceName(surface) || this.current[surface] === health) return;
    this.current = Object.freeze({ ...this.current, [surface]: health });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener must not stop the others hearing about a change.
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Back to all-ready without telling anyone. For tests, and for a page being torn down. */
  reset(): void {
    this.current = READY_SURFACES;
  }
}

/** This content script's surfaces. One per page, since each tab has its own script. */
export const surfaceHealth = new SurfaceHealthTracker();
