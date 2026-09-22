import { useEffect, useState } from "react";

import { readRecoveryState } from "./RecoveryCoordinator";
import type { RecoveryState } from "./recoveryTypes";

/**
 * `checking`: nobody has asked storage about this account yet, so nothing private may be shown or read.
 * `unknown`: storage could not be read. That is a transient fault and not a Recovery state, so callers carry
 * on as they did before Recovery existed; the storage layer still refuses every read and write of damaged data.
 */
export type RecoveryCheck = { status: "checking" } | { status: "ready"; state: RecoveryState } | { status: "unknown" };

/** The keys whose change can turn a Directory, or the root, from damaged to sound or back. */
const RELEVANT_KEYS = ["directories", "accountBindings", "schemaVersion"];

type Answer = { owner: string; check: Exclude<RecoveryCheck, { status: "checking" }> };

const sameCheck = (a: Answer["check"], b: Answer["check"]): boolean => {
  if (a.status !== b.status) return false;
  if (a.status !== "ready" || b.status !== "ready") return true;
  return a.state.kind === b.state.kind && (a.state.kind === "none" || (b.state.kind !== "none" && a.state.code === b.state.code));
};

/**
 * The Recovery state of `ownerThreadsUserId`, checked when it changes and whenever the stored Directories or
 * bindings change, so the Dashboard leaves the Recovery page by itself once the data has been cleared, and
 * moves to it if the data becomes damaged while it is open. Only the latest answer is used. It writes nothing.
 *
 * An answer belongs to the owner it was asked for. The moment the owner changes, and before anything has
 * been asked about the new one, this reports `checking`: the previous account's clean answer is never read
 * as the new account's, not even for the one render between the change and the effect that asks again.
 * With no owner there is nothing to check and the result stays `checking`.
 */
export function useRecoveryState(ownerThreadsUserId: string | null): RecoveryCheck {
  const [answer, setAnswer] = useState<Answer | null>(null);
  // An unchanged answer keeps its identity, so a re-check that finds nothing new renders nothing: every write to
  // the Directories, an import commit for one, asks again, and the Dashboard should not redraw for each.
  const settle = (owner: string, check: Answer["check"]) =>
    setAnswer((previous) => (previous !== null && previous.owner === owner && sameCheck(previous.check, check) ? previous : { owner, check }));

  useEffect(() => {
    if (ownerThreadsUserId === null) return;
    const owner = ownerThreadsUserId;

    let live = true;
    let latest = 0;
    const run = () => {
      const mine = ++latest;
      readRecoveryState(owner).then(
        (state) => live && mine === latest && settle(owner, { status: "ready", state }),
        () => live && mine === latest && settle(owner, { status: "unknown" }),
      );
    };
    run();

    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === "local" && RELEVANT_KEYS.some((key) => Object.hasOwn(changes, key))) run();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [ownerThreadsUserId]);

  return answer !== null && answer.owner === ownerThreadsUserId ? answer.check : { status: "checking" };
}
