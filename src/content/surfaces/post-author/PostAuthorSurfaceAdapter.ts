import type { ExtensionSettings } from "../../../domain/settings";
import {
  normalizeThreadsUserId,
  normalizeUsername,
} from "../../../domain/validation";
import type { ContactStore } from "../../../storage/ContactStore";
import { UnresolvedOccurrenceRegistry } from "../../runtime/unresolved/UnresolvedOccurrenceRegistry";
import type {
  PageContext,
  SurfaceCleanupContext,
  SurfaceReconcileContext,
} from "../../runtime/types";
import type { ThreadsSurfaceAdapter } from "../ThreadsSurfaceAdapter";
import { renderNicknameLabel } from "../../ui/display/NicknameLabelRenderer";
import { deriveAuthorOccurrence } from "./deriveAuthorOccurrence";
import { resolveContactForOccurrence } from "./resolveContactForOccurrence";
import { resolveSeparatorPlan } from "./separatorStrategy";
import { retryOccurrenceDerivation } from "./retryOccurrenceDerivation";
import { scanAuthorCandidatesInBatches } from "./scanAuthorCandidatesInBatches";
import type { AuthorOccurrence, AuthorOccurrenceType } from "./types";
import { NICKNAME_ATTRIBUTE } from "../../ui/display/NicknameLabelRenderer";

// Threads' Activity/notifications tab is excluded entirely rather than
// relying on a per-row structural signal, since a notification actor row
// has no reliable distinguishing shape of its own to fail closed against.
const EXCLUDED_ROUTE_PATTERN = /^\/activity(\/|$)/i;

export interface PostAuthorSurfaceAdapterOptions {
  readonly contactStore: ContactStore;
  readonly settings: ExtensionSettings;
  readonly getCurrentGeneration: () => number;
}

function isScannableRoot(node: Node): node is ParentNode {
  if (!node.isConnected) return false;
  return node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
}

export class PostAuthorSurfaceAdapter implements ThreadsSurfaceAdapter {
  readonly id = "post-author";

  private readonly unresolved = new UnresolvedOccurrenceRegistry();
  private readonly observedThreadsUserIds = new Map<string, string>();
  private activeGeneration: number | null = null;
  private didFullScan = false;
  private settings: ExtensionSettings;
  // Bumped only when the global enable/disable flag changes, so a
  // batch/retry already scheduled under a prior epoch (e.g. queued before
  // a global OFF) is abandoned rather than resuming - including after a
  // later OFF->ON, which must not revive it. Per-location display flags
  // (feed/replies/quotes) do NOT bump this: they are gated live by
  // isSurfaceEnabled() as each occurrence is processed, so toggling one
  // location must not abort in-flight work for the others.
  private settingsRevision = 0;

  constructor(private readonly options: PostAuthorSurfaceAdapterOptions) {
    this.settings = options.settings;
  }

  isApplicable(context: PageContext): boolean {
    if (!this.settings.enabled) return false;
    try {
      return !EXCLUDED_ROUTE_PATTERN.test(new URL(context.url).pathname);
    } catch {
      return false;
    }
  }

  /**
   * Live settings update from the Dashboard/popup. Disabling sweeps every
   * already-rendered label immediately (ON->OFF must be immediate); enabling
   * only updates the flag - the next natural reconcile picks new work up,
   * matching the requirement not to force a full Feed rescan.
   */
  setSettings(next: ExtensionSettings, document: Document): void {
    const wasEnabled = this.settings.enabled;
    this.settings = next;
    if (wasEnabled !== next.enabled) this.settingsRevision += 1;
    if (!wasEnabled || next.enabled) return;

    this.unresolved.clear();
    this.observedThreadsUserIds.clear();
    this.activeGeneration = null;
    this.didFullScan = false;
    for (const label of document.querySelectorAll(`[${NICKNAME_ATTRIBUTE}]`)) {
      label.remove();
    }
  }

  async reconcile(context: SurfaceReconcileContext): Promise<void> {
    if (!this.isApplicable(context.page)) return;

    const generation = context.page.generation;
    if (this.options.getCurrentGeneration() !== generation) return;
    if (this.activeGeneration !== generation) {
      this.unresolved.clear();
      if (this.activeGeneration !== null) this.observedThreadsUserIds.clear();
      this.activeGeneration = generation;
      this.didFullScan = false;
    }
    if (context.scope.type === "full") {
      if (this.didFullScan) return;
      this.didFullScan = true;
    }

    const roots: ParentNode[] =
      context.scope.type === "full"
        ? [context.page.document]
        : context.scope.roots.filter(isScannableRoot);
    if (roots.length === 0) return;

    const revision = this.settingsRevision;
    const isCurrent = () =>
      this.options.getCurrentGeneration() === generation && this.settingsRevision === revision;

    scanAuthorCandidatesInBatches(
      roots,
      (authorLink, root) => this.processCandidate(authorLink, root, isCurrent),
      { isCurrent },
    );
  }

  cleanup(_context: SurfaceCleanupContext): void {
    this.unresolved.clear();
    this.observedThreadsUserIds.clear();
    this.activeGeneration = null;
    this.didFullScan = false;
  }

  identityDiscovered(username: string, threadsUserId: string): void {
    let normalizedUsername: string;
    let normalizedThreadsUserId: string;
    try {
      normalizedUsername = normalizeUsername(username);
      normalizedThreadsUserId = normalizeThreadsUserId(threadsUserId);
    } catch {
      return;
    }

    this.observedThreadsUserIds.set(normalizedUsername, normalizedThreadsUserId);
    this.unresolved.pruneDetached();
    for (const occurrence of this.unresolved.take(normalizedUsername)) {
      this.handleOccurrence(occurrence, normalizedThreadsUserId);
    }
  }

  private processCandidate(
    authorLink: HTMLAnchorElement,
    root: ParentNode,
    isCurrent: () => boolean,
  ): void {
    const occurrence = deriveAuthorOccurrence(authorLink, root);
    if (occurrence) {
      this.handleOccurrence(occurrence);
      return;
    }

    retryOccurrenceDerivation(authorLink, root, (resolved) => this.handleOccurrence(resolved), isCurrent);
  }

  private handleOccurrence(occurrence: AuthorOccurrence, threadsUserId?: string): void {
    if (!this.isSurfaceEnabled(occurrence.type)) return;

    const contact = resolveContactForOccurrence(
      occurrence,
      this.options.contactStore,
      threadsUserId ?? this.observedThreadsUserIds.get(normalizeUsername(occurrence.username)),
    );
    if (!contact || !contact.nickname?.trim()) {
      this.unresolved.add(occurrence.username, occurrence);
      return;
    }

    renderNicknameLabel({
      occurrence,
      contact,
      separator: resolveSeparatorPlan(occurrence.metadataRow),
    });
  }

  private isSurfaceEnabled(type: AuthorOccurrenceType): boolean {
    if (!this.settings.enabled) return false;
    switch (type) {
      case "feed":
        return this.settings.nicknameDisplay.feed;
      case "reply":
        return this.settings.nicknameDisplay.replies;
      case "quote":
        return this.settings.nicknameDisplay.quotes;
    }
  }
}
