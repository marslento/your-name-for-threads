import { normalizeUsername } from "../../../domain/validation";
import type { AuthorOccurrence } from "../../surfaces/post-author/types";

/**
 * Tracks Feed author occurrences whose username could not resolve to a
 * saved contact, so a later numeric-ID discovery for that username can
 * resolve just those occurrences without rescanning the whole Feed.
 * Transient and page-session-only: never persisted to chrome.storage, and
 * never used to live-update an already-rendered nickname.
 */
export class UnresolvedOccurrenceRegistry {
  private readonly byUsername = new Map<string, AuthorOccurrence[]>();

  add(username: string, occurrence: AuthorOccurrence): void {
    const key = normalizeUsername(username);
    const existing = this.byUsername.get(key);
    if (existing) {
      existing.push(occurrence);
    } else {
      this.byUsername.set(key, [occurrence]);
    }
  }

  take(username: string): AuthorOccurrence[] {
    const key = normalizeUsername(username);
    const occurrences = this.byUsername.get(key) ?? [];
    this.byUsername.delete(key);
    return occurrences.filter((occurrence) => occurrence.authorLink.isConnected);
  }

  pruneDetached(): void {
    for (const [key, occurrences] of this.byUsername) {
      const attached = occurrences.filter((occurrence) => occurrence.authorLink.isConnected);
      if (attached.length > 0) {
        this.byUsername.set(key, attached);
      } else {
        this.byUsername.delete(key);
      }
    }
  }

  clear(): void {
    this.byUsername.clear();
  }

  keys(): IterableIterator<string> {
    return this.byUsername.keys();
  }
}
