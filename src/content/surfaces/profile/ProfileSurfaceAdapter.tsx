import * as React from "react";

import { reportSurfaceFailure } from "../../../diagnostics/surfaceDiagnostics";
import { surfaceHealth } from "../../../shared/surfaceHealth";
import type { ThreadContact } from "../../../domain/contact";
import type { IdentityCacheEntry, ThreadsIdentity } from "../../../domain/identity";
import { isIdentityCacheEntryExpired } from "../../../domain/identityCache";
import type { ContactsRepository } from "../../../storage/ContactsRepository";
import type { ContactStore } from "../../../storage/ContactStore";
import type { MountRegistry } from "../../runtime/MountRegistry";
import type {
  PageContext,
  SurfaceCleanupContext,
  SurfaceReconcileContext,
} from "../../runtime/types";
import type { ThreadsSurfaceAdapter } from "../ThreadsSurfaceAdapter";
import type { ThreadsTheme } from "../../theme/detectThreadsTheme";
import { ExtensionErrorBoundary } from "../../ui/shared/ExtensionErrorBoundary";
import { DeleteNicknameDialog } from "../../ui/profile/DeleteNicknameDialog";
import { NicknameDialog } from "../../ui/profile/NicknameDialog";
import { ProfileNicknameApp } from "../../ui/profile/ProfileNicknameApp";
import {
  createProfileShadow,
  type ProfileShadowSurface,
} from "../../ui/profile/profileShadow";
import { ProfileToaster, showProfileToast } from "../../ui/profile/profileToasts";
import {
  detectProfile,
  findProfileIdentityRow,
  profilePageRouteUsername,
} from "./profileDetector";
import { resolveProfileIdentity } from "./profileIdentity";
import { resolveProfileMountPoint } from "./profileMountPoint";

const UNSAFE_ADJACENT_SELECTOR = 'article, [role="feed"], [role="article"], a[href*="/post/"]';

function isSafeAdjacentSection(candidate: Element): boolean {
  return (
    !candidate.matches(UNSAFE_ADJACENT_SELECTOR) &&
    candidate.querySelector(UNSAFE_ADJACENT_SELECTOR) === null
  );
}

type NicknameSession =
  | {
      readonly mode: "create";
      readonly identity: ThreadsIdentity;
      readonly displayUsername: string;
    }
  | {
      readonly mode: "edit";
      readonly identity: ThreadsIdentity;
      readonly displayUsername: string;
      readonly contact: ThreadContact;
    };

interface ProfileSurfaceViewProps {
  readonly contactStore: ContactStore;
  readonly repository: ContactsRepository;
  readonly requireOwner: () => string;
  readonly identity: ThreadsIdentity;
  readonly hasPendingConflict: boolean;
  readonly portalContainer: Element | DocumentFragment;
  readonly theme: ThreadsTheme;
  readonly clock: () => string;
}

function ProfileSurfaceView({
  contactStore,
  repository,
  requireOwner,
  identity,
  hasPendingConflict,
  portalContainer,
  theme,
  clock,
}: ProfileSurfaceViewProps) {
  const [nicknameSession, setNicknameSession] =
    React.useState<NicknameSession | null>(null);
  const [deleteContact, setDeleteContact] = React.useState<ThreadContact | null>(null);

  return (
    <>
      <ProfileNicknameApp
        resolver={contactStore}
        identity={identity}
        hasPendingConflict={hasPendingConflict}
        onCreate={(currentIdentity) => {
          setDeleteContact(null);
          setNicknameSession({
            mode: "create",
            identity: currentIdentity,
            displayUsername: currentIdentity.username,
          });
        }}
        onEdit={(contact) => {
          setDeleteContact(null);
          setNicknameSession({
            mode: "edit",
            identity: {
              username: contact.username,
              ...(contact.threadsUserId === undefined
                ? {}
                : { threadsUserId: contact.threadsUserId }),
            },
            displayUsername: identity.username,
            contact,
          });
        }}
      />
      {nicknameSession ? (
        <NicknameDialog
          open
          mode={nicknameSession.mode}
          username={nicknameSession.displayUsername}
          initialNickname={
            nicknameSession.mode === "edit" ? nicknameSession.contact.nickname : ""
          }
          portalContainer={portalContainer}
          onOpenChange={(open) => {
            if (!open) setNicknameSession(null);
          }}
          onSave={(nickname) =>
            repository.upsertNickname(requireOwner(), {
              identity: nicknameSession.identity,
              nickname,
              now: clock(),
            })
          }
          onSaveSuccess={() =>
            showProfileToast(
              nicknameSession.mode === "create" ? "created" : "updated",
            )
          }
          onSaveError={() => showProfileToast("save-error")}
          {...(nicknameSession.mode === "edit"
            ? {
                onRequestDelete: () => {
                  setDeleteContact(nicknameSession.contact);
                  setNicknameSession(null);
                },
              }
            : {})}
        />
      ) : null}
      {deleteContact ? (
        <DeleteNicknameDialog
          open
          sessionKey={deleteContact.id}
          portalContainer={portalContainer}
          onOpenChange={(open) => {
            if (!open) setDeleteContact(null);
          }}
          onDelete={() => repository.deleteContact(requireOwner(), { id: deleteContact.id, now: clock() })}
          onDeleteSuccess={() => showProfileToast("deleted")}
          onDeleteError={() => showProfileToast("delete-error")}
        />
      ) : null}
      <ProfileToaster theme={theme} />
    </>
  );
}

interface MountedProfile {
  readonly key: string;
  readonly username: string;
  readonly host: HTMLElement;
  readonly shadow: ProfileShadowSurface;
  identity: ThreadsIdentity;
  hasPendingConflict: boolean;
}

interface ProfileDomSnapshot {
  readonly identityRow: HTMLElement;
  readonly metadata: Element | null;
  readonly nodes: ReadonlySet<Node>;
}

export interface ProfileSurfaceAdapterOptions {
  readonly contactStore: ContactStore;
  readonly repository: ContactsRepository;
  readonly mountRegistry: MountRegistry;
  readonly clock: () => string;
  readonly initialTheme: ThreadsTheme;
  readonly getCurrentGeneration: () => number;
  /** No confirmed owner means no private Directory access - callers must check for `null` before writing. */
  readonly getOwnerThreadsUserId: () => string | null;
  readonly createShadow?: (host: HTMLElement) => ProfileShadowSurface | null;
}

export class ProfileSurfaceAdapter implements ThreadsSurfaceAdapter {
  readonly id = "profile";

  private readonly identityCache = new Map<string, IdentityCacheEntry | null>();
  private readonly createShadow: (host: HTMLElement) => ProfileShadowSurface | null;
  private mounted: MountedProfile | null = null;
  private profileDom: ProfileDomSnapshot | null = null;
  private theme: ThreadsTheme;
  private revision = 0;
  private enabled = true;

  constructor(private readonly options: ProfileSurfaceAdapterOptions) {
    this.theme = options.initialTheme;
    this.createShadow = options.createShadow ?? createProfileShadow;
  }

  isApplicable(context: PageContext): boolean {
    if (!this.enabled) return false;
    try {
      return profilePageRouteUsername(context.url) !== null;
    } catch {
      return false;
    }
  }

  async reconcile(context: SurfaceReconcileContext): Promise<void> {
    if (!this.isRelevant(context)) return;
    if (!this.isGenerationCurrent(context)) return;

    const revision = ++this.revision;
    const previousProfileDom = this.profileDom;
    if (
      previousProfileDom &&
      (!previousProfileDom.identityRow.isConnected ||
        (previousProfileDom.metadata !== null &&
          !previousProfileDom.metadata.isConnected))
    ) {
      this.removeMount();
    }
    const profile = detectProfile(context.page.document, context.page.url);
    if (!profile) {
      this.profileDom = null;
      this.removeMount();
      return;
    }
    const nextProfileDom = this.captureProfileDom(context.page.document, profile.username);
    if (!nextProfileDom) {
      this.profileDom = null;
      this.removeMount();
      return;
    }
    if (
      this.mounted &&
      previousProfileDom &&
      (previousProfileDom.identityRow !== nextProfileDom.identityRow ||
        previousProfileDom.metadata !== nextProfileDom.metadata)
    ) {
      this.removeMount();
    }
    this.profileDom = nextProfileDom;

    if (
      this.mounted &&
      (this.mounted.username !== profile.username || !this.mounted.host.isConnected)
    ) {
      this.removeMount();
    }

    if (
      context.scope.type === "subtree" &&
      this.mounted?.username === profile.username &&
      this.mounted.host.isConnected
    ) {
      this.renderMounted();
      return;
    }

    if (!resolveProfileMountPoint(context.page.document, profile.username)) {
      this.removeMount();
      return;
    }

    const identity = await this.resolveIdentity(profile.username, context, revision);
    if (!identity || !this.isCurrent(context, profile.username, revision)) return;

    let hasPendingConflict = false;
    const ownerThreadsUserId = this.options.getOwnerThreadsUserId();
    if (ownerThreadsUserId) {
      try {
        hasPendingConflict = await this.options.repository.hasPendingConflict(ownerThreadsUserId, identity);
      } catch {
        // Conflict feedback is advisory; storage failure must not break Profile UI.
      }
    }
    if (!this.isCurrent(context, profile.username, revision)) return;

    const key = `profile:${identity.threadsUserId ?? identity.username}`;
    if (this.mounted?.key === key && this.mounted.host.isConnected) {
      this.mounted.identity = identity;
      this.mounted.hasPendingConflict = hasPendingConflict;
      this.renderMounted();
      return;
    }

    this.removeMount();
    const mountPoint = resolveProfileMountPoint(context.page.document, profile.username);
    if (!mountPoint || !this.isCurrent(context, profile.username, revision)) return;

    const host = context.page.document.createElement("div");
    host.dataset.tpdProfileHost = "";
    const setup: { shadow?: ProfileShadowSurface } = {};

    try {
      mountPoint.parent.insertBefore(host, mountPoint.before);
      const mount = this.options.mountRegistry.getOrCreate({
        key,
        surface: this.id,
        host,
        create: () => {
          const ownedShadow = this.createShadow(host);
          if (!ownedShadow) throw new Error("Profile Shadow setup failed");
          setup.shadow = ownedShadow;
          return () => {
            try {
              ownedShadow.unmount();
            } finally {
              host.remove();
            }
          };
        },
      });
      const shadow = setup.shadow;
      if (mount.host !== host || !shadow) {
        host.remove();
        return;
      }

      this.mounted = {
        key,
        username: profile.username,
        host,
        shadow,
        identity,
        hasPendingConflict,
      };
      shadow.setTheme(this.theme);
      this.renderMounted();
      // A fresh mount is the Profile UI coming back after a crash or an earlier failed mount. If its
      // error boundary trips after this, that reports the failure again.
      surfaceHealth.report(this.id, "ready");
    } catch {
      this.options.mountRegistry.cleanupKey(key);
      host.remove();
      if (this.mounted?.host === host) this.mounted = null;
      reportSurfaceFailure(this.id);
    }
  }

  cleanup(_context: SurfaceCleanupContext): void {
    this.revision += 1;
    this.identityCache.clear();
    this.profileDom = null;
    this.removeMount();
  }

  invalidateIdentity(username?: string): void {
    this.revision += 1;
    if (username) this.identityCache.delete(username);
    else this.identityCache.clear();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) return;
    this.revision += 1;
    this.identityCache.clear();
    this.profileDom = null;
    this.removeMount();
  }

  setTheme(theme: ThreadsTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    if (!this.mounted) return;
    this.mounted.shadow.setTheme(theme);
    this.renderMounted();
  }

  private async resolveIdentity(
    username: string,
    context: SurfaceReconcileContext,
    revision: number,
  ): Promise<ThreadsIdentity | null> {
    let stored: ThreadContact | null = null;
    try {
      stored = this.options.contactStore.getByUsername(username);
    } catch {
      // Continue with the bounded cache lookup.
    }
    if (stored?.threadsUserId) {
      return resolveProfileIdentity({ username }, stored);
    }

    let cachedIdentity = this.identityCache.get(username) ?? null;
    let checkedAt: string | undefined;
    if (cachedIdentity) {
      try {
        checkedAt = this.options.clock();
        if (isIdentityCacheEntryExpired(cachedIdentity, checkedAt)) {
          this.identityCache.delete(username);
          cachedIdentity = null;
        }
      } catch {
        this.identityCache.delete(username);
        cachedIdentity = null;
      }
    }
    if (!this.identityCache.has(username)) {
      let cacheReadSucceeded = false;
      try {
        cachedIdentity = await this.options.repository.getCachedIdentity(
          username,
          checkedAt ?? this.options.clock(),
        );
        cacheReadSucceeded = true;
      } catch {
        cachedIdentity = null;
      }
      if (!this.isCurrent(context, username, revision)) return null;
      if (cacheReadSucceeded) this.identityCache.set(username, cachedIdentity);
    }

    return resolveProfileIdentity({ username }, cachedIdentity);
  }

  private renderMounted(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    mounted.shadow.render(
      <ExtensionErrorBoundary onError={() => reportSurfaceFailure(this.id)}>
        <ProfileSurfaceView
          contactStore={this.options.contactStore}
          repository={this.options.repository}
          requireOwner={() => {
            const ownerThreadsUserId = this.options.getOwnerThreadsUserId();
            if (!ownerThreadsUserId) throw new Error("No confirmed Threads account");
            return ownerThreadsUserId;
          }}
          identity={mounted.identity}
          hasPendingConflict={mounted.hasPendingConflict}
          portalContainer={mounted.shadow.portalContainer}
          theme={this.theme}
          clock={this.options.clock}
        />
      </ExtensionErrorBoundary>,
    );
  }

  private removeMount(): void {
    this.mounted = null;
    this.options.mountRegistry.cleanupSurface(this.id);
  }

  private isRelevant(context: SurfaceReconcileContext): boolean {
    if (context.scope.type === "full") return true;

    return context.scope.roots.some((root) => {
      if (
        root === context.page.document ||
        root === context.page.document.documentElement ||
        root === context.page.document.body
      ) {
        return true;
      }
      if (
        this.mounted &&
        (root === this.mounted.host ||
          root.contains(this.mounted.host) ||
          this.mounted.host.contains(root))
      ) {
        return true;
      }
      if (
        this.profileDom &&
        [...this.profileDom.nodes].some(
          (node) => root === node || root.contains(node) || node.contains(root),
        )
      ) {
        return true;
      }

      const element =
        root.nodeType === Node.ELEMENT_NODE
          ? (root as Element)
          : root.parentElement;
      if (!element?.isConnected) return false;
      if (element.matches("[data-tpd-profile-host]")) return true;
      // A newly added *safe* sibling of the identity row (e.g. Bio
      // finishing an async load) is cheap to notice without a page-wide
      // scan - just a parentElement check. An unsafe one (a post/feed
      // landing next to the header) must stay ignored here exactly like an
      // already-tracked unsafe sibling's mutations are ignored above.
      if (
        this.profileDom &&
        element.parentElement === this.profileDom.identityRow.parentElement &&
        isSafeAdjacentSection(element)
      ) {
        return true;
      }
      // Once we have tracked state and neither the fast containment checks
      // nor the sibling check above matched, the root is genuinely
      // irrelevant - falling through to a full-document scan for every such
      // mutation would defeat the incremental-reconcile requirement. The
      // scan below is only worth its cost before any state has ever been
      // captured (e.g. right after startup or cleanup()).
      if (this.mounted || this.profileDom) return false;

      const routeUsername = profilePageRouteUsername(context.page.url);
      if (!routeUsername) return false;
      const identityRow = findProfileIdentityRow(context.page.document, routeUsername);
      if (!identityRow) return false;
      return (
        element === identityRow || element.contains(identityRow) || identityRow.contains(element)
      );
    });
  }

  private captureProfileDom(document: Document, username: string): ProfileDomSnapshot | null {
    const identityRow = findProfileIdentityRow(document, username);
    if (!identityRow || !identityRow.isConnected) return null;

    let metadata = identityRow.nextElementSibling;
    if (metadata === this.mounted?.host) metadata = metadata.nextElementSibling;

    // `metadata` itself always reflects the live next sibling (used to decide
    // whether the mount needs to move) regardless of its content, but only a
    // sibling that isn't a feed/post area is walked into `nodes` for dirty
    // tracking - otherwise every post mutation next to the header would look
    // "relevant" and force a wasted reconcile on every scroll.
    const nodes = new Set<Node>([identityRow, ...identityRow.querySelectorAll("*")]);
    if (metadata && isSafeAdjacentSection(metadata)) {
      nodes.add(metadata);
      for (const descendant of metadata.querySelectorAll("*")) nodes.add(descendant);
    }

    return { identityRow, metadata, nodes };
  }

  private isCurrent(
    context: SurfaceReconcileContext,
    username: string,
    revision: number,
  ): boolean {
    if (this.revision !== revision) return false;
    if (!this.isGenerationCurrent(context)) return false;
    try {
      const liveUrl = context.page.document.defaultView?.location.href ?? context.page.url;
      return detectProfile(context.page.document, liveUrl)?.username === username;
    } catch {
      return false;
    }
  }

  private isGenerationCurrent(context: SurfaceReconcileContext): boolean {
    try {
      return this.options.getCurrentGeneration() === context.page.generation;
    } catch {
      return false;
    }
  }
}
