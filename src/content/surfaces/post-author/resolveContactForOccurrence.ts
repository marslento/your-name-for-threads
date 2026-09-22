import type { ThreadContact } from "../../../domain/contact";
import type { ContactStore } from "../../../storage/ContactStore";
import type { AuthorOccurrence } from "./types";

/**
 * Resolves the saved contact for a Feed author occurrence using Phase 1's
 * own lookup priority (numeric Threads ID first, normalized username
 * fallback) and canonical conflict resolution, reusing ContactStore
 * directly rather than adding Feed-specific identity semantics. The numeric
 * ID may come from the current observation, the bounded identity cache, or
 * an already-upgraded contact; Feed DOM observations are never written into
 * the identity system.
 */
export function resolveContactForOccurrence(
  occurrence: Pick<AuthorOccurrence, "username">,
  contactStore: ContactStore,
  observedThreadsUserId?: string,
): ThreadContact | null {
  const byUsername = contactStore.getByUsername(occurrence.username);
  const threadsUserId =
    observedThreadsUserId ??
    contactStore.getThreadsUserIdByUsername(occurrence.username) ??
    byUsername?.threadsUserId;
  if (threadsUserId) {
    return contactStore.resolve({
      username: occurrence.username,
      threadsUserId,
    });
  }
  return byUsername;
}
