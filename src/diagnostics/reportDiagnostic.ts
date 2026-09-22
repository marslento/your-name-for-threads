import { PHASE_ONE_VERSION } from "../shared/constants";
import { DIAGNOSTICS_STORAGE_KEY, diagnosticStore } from "./DiagnosticStore";
import type { DiagnosticComponent, DiagnosticRuntimeState, ProductDiagnosticCode } from "./diagnosticTypes";

/**
 * How long one context stays quiet about a failure it has already reported.
 * Timestamps, not a timer: the runtime contract forbids polling, and this
 * only has to answer "was it recent?" at the moment a failure repeats.
 */
const THROTTLE_MS = 5 * 60_000;

/** One attempt to report a failure. The identity tells an older attempt apart from the one that owns the entry now. */
interface Attempt {
  at: number;
}

const attempts = new Map<string, Attempt>();
let watchingForClear = false;

/**
 * Clearing the buffer lifts every context's throttle, so "clear, reproduce,
 * copy" works without waiting out five minutes. `chrome.storage.onChanged`
 * reaches every context, content-script tabs included, and only fires when
 * something changes - no polling. Only a removal lifts it (the key loses its
 * value): recording an event, or any other key changing, must not.
 *
 * This is the lift for reports that WERE recorded. A report the coordinator did
 * not take never made a key to remove - clearing an empty buffer changes nothing
 * and fires nothing - so those release their own throttle (see `release`).
 */
function liftThrottleWhenCleared(): void {
  if (watchingForClear) return;
  watchingForClear = true;
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (
        areaName === "local" &&
        Object.hasOwn(changes, DIAGNOSTICS_STORAGE_KEY) &&
        changes[DIAGNOSTICS_STORAGE_KEY].newValue === undefined
      ) {
        attempts.clear();
      }
    });
  } catch {
    // No storage events here (or no chrome API): the throttle simply runs its course.
  }
}

/** Gives the failure back to the next occurrence - but only if this attempt still owns the entry, so an old failure cannot release a newer attempt's throttle. */
function release(key: string, attempt: Attempt): void {
  if (attempts.get(key) === attempt) attempts.delete(key);
}

/**
 * The one way product code records a persistent diagnostic (Phase 4 §5-6).
 *
 * The signature is the privacy boundary: a stable code, the component, and an
 * optional closed runtime state. There is no parameter that can carry an
 * error, a message, a URL or a name, so a call site cannot leak one by
 * accident - and the store rebuilds every event from the allowlist regardless.
 * Fire-and-forget; it never throws and never rejects, because diagnostics must
 * not be able to break the thing they describe.
 *
 * Repeats are bounded: the same failure is reported at most once per
 * `THROTTLE_MS` per context (until the buffer is cleared), and the coordinator
 * skips it when it is already the newest stored event. So a failure that keeps
 * happening is listed once, stamped with its first occurrence, until something
 * else is recorded after it - "when did this start", not "when did it last
 * happen".
 *
 * The throttle covers a failure only once the coordinator took it (Phase 4
 * follow-up review, P2). While an attempt is unfinished it stands in for that, so
 * a burst of the same failure is one attempt; if the coordinator did not take it
 * (unreachable, a refused write), the failure is released and the next
 * occurrence tries again, instead of an unrecorded failure being silenced for
 * five minutes.
 * ponytail: after failures it is attempts, not writes, that are unbounded - one
 * message per occurrence while the coordinator stays unreachable (an orphaned
 * content script after an extension update, say). Add a short failure backoff if
 * that ever shows up as noise; it would have to yield to a clear, which is why
 * there is none yet.
 */
export function reportDiagnostic(
  code: ProductDiagnosticCode,
  component: DiagnosticComponent,
  runtimeState?: DiagnosticRuntimeState,
): void {
  try {
    liftThrottleWhenCleared();
    const key = `${code}|${component}|${runtimeState ?? ""}`;
    const now = Date.now();
    const last = attempts.get(key);
    if (last !== undefined && now - last.at < THROTTLE_MS) return;
    const attempt: Attempt = { at: now };
    attempts.set(key, attempt);

    void diagnosticStore
      .recordUnlessRepeat({
        code,
        component,
        occurredAt: new Date(now).toISOString(),
        extensionVersion: PHASE_ONE_VERSION,
        ...(runtimeState === undefined ? {} : { runtimeState }),
      })
      .then(
        (taken) => {
          if (!taken) release(key, attempt);
        },
        () => release(key, attempt),
      );
  } catch {
    // see above
  }
}

/** Test-only: the throttle is module state, which lives as long as the context (by design) or the test file (not by design). */
export function __resetDiagnosticReportsForTests(): void {
  attempts.clear();
  watchingForClear = false;
}
