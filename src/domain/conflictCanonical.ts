import type { ThreadContact } from "./contact";
import type { IdentityConflict } from "./conflict";

/**
 * The canonical contact in an identity conflict is the one whose
 * threadsUserId exactly matches the conflict's threadsUserId - not "any
 * source that happens to have a numeric ID". Two sources can carry
 * different numeric IDs; picking the first one found instead of the exact
 * match can select the wrong contact as canonical and tombstone the real
 * one. Anything other than exactly one match is abnormal data - fail safe
 * (null) rather than crash or arbitrarily pick.
 */
export function selectCanonicalContact(
  conflict: IdentityConflict,
  sources: ThreadContact[],
): ThreadContact | null {
  const matches = sources.filter((source) => source.threadsUserId === conflict.threadsUserId);
  return matches.length === 1 ? matches[0] : null;
}
