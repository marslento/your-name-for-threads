import type { ThreadContact } from "../domain/contact";
import type { ContactTombstone } from "../domain/tombstone";
import type { IdentityConflict } from "../domain/conflict";
import type { IdentityCacheEntry, IdentityObservation, ThreadsIdentity } from "../domain/identity";
import type { ResolveConflictInput, ResolveConflictResult } from "../domain/resolveIdentityConflict";

export type AttachStableIdentityResult =
  | { type: "attached"; contact: ThreadContact }
  | { type: "already-linked"; contact: ThreadContact }
  | {
      type: "conflict";
      canonicalContact: ThreadContact;
      conflict: IdentityConflict;
    }
  | { type: "cached-only" };

/**
 * Thrown by upsertNickname when the requested identity's numeric Threads ID
 * is already linked to a different contact than the one resolved by
 * username. Saving would either silently overwrite the wrong contact or
 * silently do nothing, so the request is rejected instead of resolving with
 * an unrelated contact.
 */
export class NicknameIdentityConflictError extends Error {
  constructor(readonly canonicalContact: ThreadContact) {
    super(
      "Cannot save nickname: this identity's numeric Threads ID is already linked to a different contact.",
    );
    this.name = "NicknameIdentityConflictError";
  }
}

/**
 * Every method below operates on one owner's Directory (Phase 3.5 Task 8):
 * `ownerThreadsUserId` is required, explicit, and never inferred or
 * defaulted - a caller with no confirmed owner must not call these at all
 * ("no confirmed owner means no private Directory access"). The identity
 * cache methods are the one exception: `identityCache` stays browser-global
 * across every owner (Phase 3.5 Global Constraints), so they take no owner.
 */
export interface ContactsRepository {
  getByIdentity(ownerThreadsUserId: string, identity: ThreadsIdentity): Promise<ThreadContact | null>;

  getById(ownerThreadsUserId: string, id: string): Promise<ThreadContact | null>;

  hasPendingConflict(ownerThreadsUserId: string, identity: ThreadsIdentity): Promise<boolean>;

  listActive(ownerThreadsUserId: string): Promise<ThreadContact[]>;

  upsertNickname(
    ownerThreadsUserId: string,
    input: {
      identity: ThreadsIdentity;
      nickname: string;
      now: string;
    },
  ): Promise<ThreadContact>;

  /** Dashboard-only mutation: writes nickname/note without touching identity. */
  updateContactDetails(
    ownerThreadsUserId: string,
    input: {
      id: string;
      nickname: string;
      note: string;
      now: string;
    },
  ): Promise<ThreadContact>;

  deleteContact(ownerThreadsUserId: string, input: { id: string; now: string }): Promise<ContactTombstone>;

  attachStableIdentity(
    ownerThreadsUserId: string,
    input: {
      username: string;
      threadsUserId: string;
      observedAt: string;
    },
  ): Promise<AttachStableIdentityResult>;

  resolveConflict(ownerThreadsUserId: string, input: ResolveConflictInput): Promise<ResolveConflictResult>;

  /** Browser-global: not scoped to any owner/Directory. */
  cacheIdentityObservation(input: IdentityObservation): Promise<IdentityCacheEntry>;

  /** Browser-global: not scoped to any owner/Directory. */
  getCachedIdentity(username: string, now: string): Promise<IdentityCacheEntry | null>;

  /** Browser-global: not scoped to any owner/Directory. */
  pruneIdentityCache(now: string): Promise<number>;
}
