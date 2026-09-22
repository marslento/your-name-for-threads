import { IdentityCoordinator } from "./identity/IdentityCoordinator";
import { NetworkIdentityBridge } from "./identity/NetworkIdentityBridge";
import { MountRegistry } from "./runtime/MountRegistry";
import { SurfaceRegistry } from "./runtime/SurfaceRegistry";
import { reportSurfaceHealth } from "./runtime/reportSurfaceHealth";
import { ThreadsRuntime } from "./runtime/ThreadsRuntime";
import { PostAuthorSurfaceAdapter } from "./surfaces/post-author/PostAuthorSurfaceAdapter";
import { ProfileSurfaceAdapter } from "./surfaces/profile/ProfileSurfaceAdapter";
import { detectThreadsTheme } from "./theme/detectThreadsTheme";
import { ThreadsThemeObserver } from "./theme/ThreadsThemeObserver";
import type { CurrentAccountResolver } from "../account/CurrentAccountResolver";
import { ownerThreadsUserIdFromState } from "../account/CurrentAccountResolver";
import { installSourceDocumentLifecycle } from "../account/sourceDocumentLifecycle";
import { ThreadsAccountResolver } from "../account/ThreadsAccountResolver";
import { RecoveryAwareAccountResolver } from "../recovery/RecoveryAwareAccountResolver";
import { surfaceHealth } from "../shared/surfaceHealth";
import { AccountWriteAuthority } from "../account/AccountWriteAuthority";
import type { ExtensionSettings } from "../domain/settings";
import { DEFAULT_EXTENSION_SETTINGS } from "../domain/settings";
import { BrowserStorageContactsRepository } from "../storage/BrowserStorageContactsRepository";
import { ContactStore } from "../storage/ContactStore";
import { loadAndMigrateStorage } from "../storage/migrations";

export function startThreadsPrivateDirectory(
  targetWindow: Window = window,
  targetDocument: Document = document,
  injectedAccountResolver?: CurrentAccountResolver,
): () => void {
  const clock = () => new Date().toISOString();
  const repository = new BrowserStorageContactsRepository((owner) => writeAuthority.capture(owner));
  // Phase 3.5 Tasks 11-13/16: real Threads viewer evidence drives account
  // resolution in production. A DOM-anchor username only ever confirms an
  // owner through an unexpired identityCache entry - `getCachedIdentity`
  // returns null for an expired one, which keeps this unresolved.
  const accountResolver: CurrentAccountResolver =
    injectedAccountResolver ??
    new ThreadsAccountResolver(targetDocument, {
      resolveCachedUsername: async (username, now) =>
        (await repository.getCachedIdentity(username, now))?.threadsUserId ?? null,
      clock,
    });
  const ownedAccountResolver =
    accountResolver instanceof ThreadsAccountResolver ? accountResolver : null;
  // Phase 4 Task 18: an account whose data needs recovery reads as unresolved from here on, so it gets
  // exactly what an unconfirmed account gets - no private UI, no loaded contacts, no writes - and the
  // runtime, the write authority and the identity coordinator each obey the gate without knowing why.
  const gatedResolver = new RecoveryAwareAccountResolver(accountResolver);
  const writeAuthority = new AccountWriteAuthority(gatedResolver);
  const getOwnerThreadsUserId = () => ownerThreadsUserIdFromState(gatedResolver.getState());
  const contactStore = new ContactStore();
  const mountRegistry = new MountRegistry();
  const surfaceRegistry = new SurfaceRegistry();
  // The popup and About say when part of the integration is unavailable (Phase 4 Tasks 22-23). The tracker only
  // speaks when a surface's health changes, so a surface that keeps failing is one message, not one per failure.
  const stopReportingHealth = surfaceHealth.subscribe(() => reportSurfaceHealth(surfaceHealth.snapshot()));
  const runtime = new ThreadsRuntime({
    contactStore,
    accountResolver: gatedResolver,
    surfaceRegistry,
    observedWindow: targetWindow,
    observedDocument: targetDocument,
  });
  const profile = new ProfileSurfaceAdapter({
    contactStore,
    repository,
    getOwnerThreadsUserId,
    mountRegistry,
    clock,
    initialTheme: detectThreadsTheme(targetDocument),
    getCurrentGeneration: () => runtime.getGeneration(),
  });
  profile.setEnabled(false);
  surfaceRegistry.register(profile);
  // Fail closed like Profile above: runtime.start() races contactStore's
  // own independent loadAndMigrateStorage() read against this settings
  // read below, so a persisted-OFF page must not be able to end up with
  // the mutation/navigation observers, the ContactStore subscription, or
  // the scheduler running before the real setting is confirmed.
  runtime.setEnabled(false);

  let postAuthor: PostAuthorSurfaceAdapter | null = null;
  const observedIdentities = new Map<string, string>();
  const coordinator = new IdentityCoordinator(
    repository,
    () => {
      profile.invalidateIdentity();
      runtime.identityDiscovered();
    },
    getOwnerThreadsUserId,
  );
  const bridge = new NetworkIdentityBridge(
    targetWindow,
    async (observation) => {
      await coordinator.observe(observation);
      if (observation.threadsUserId) {
        observedIdentities.set(observation.username, observation.threadsUserId);
        postAuthor?.identityDiscovered(observation.username, observation.threadsUserId);
      }
    },
    clock,
  );
  const themeObserver = new ThreadsThemeObserver(
    targetDocument,
    (theme) => profile.setTheme(theme),
  );

  // The MAIN-world identity observer cannot read chrome.storage itself, so
  // its enable state is mirrored over postMessage rather than restoring
  // fetch/XHR - the wrapper install stays permanent either way.
  const notifyMainWorldEnabled = (enabled: boolean) => {
    try {
      targetWindow.postMessage(
        { type: "TPD_ENABLED_CHANGED", enabled },
        targetWindow.location.origin,
      );
    } catch {
      // Best effort; the observer just keeps its last-known state.
    }
  };

  // Settings changes need their own listener: ContactStore's onChanged
  // subscription only watches contacts/identityIndex/identityCache, and the
  // global enable toggle must take effect on an already-open tab immediately
  // rather than waiting for the next contact change or a reload.
  const onSettingsChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== "local" || !Object.hasOwn(changes, "settings")) return;
    const settings = (changes.settings.newValue as ExtensionSettings | undefined) ??
      DEFAULT_EXTENSION_SETTINGS;
    profile.setEnabled(settings.enabled && settings.nicknameDisplay.profile);
    postAuthor?.setSettings(settings, targetDocument);
    runtime.setEnabled(settings.enabled);
    notifyMainWorldEnabled(settings.enabled);
  };

  let active = true;
  let uninstallSourceLifecycle: () => void = () => undefined;
  const stop = () => {
    if (!active) return;
    active = false;
    writeAuthority.stop();
    uninstallSourceLifecycle();
    try {
      targetWindow.removeEventListener("pagehide", stop);
    } catch {
      // Page teardown is best effort.
    }
    try {
      chrome.storage.onChanged.removeListener(onSettingsChanged);
    } catch {
      // Page teardown is best effort.
    }
    try {
      ownedAccountResolver?.stop();
    } catch {
      // Page teardown is best effort.
    }
    try {
      gatedResolver.stop();
    } catch {
      // Page teardown is best effort.
    }
    try {
      stopReportingHealth();
      surfaceHealth.reset();
    } catch {
      // Page teardown is best effort.
    }
    try {
      themeObserver.stop();
    } catch {
      // Page teardown is best effort.
    }
    try {
      bridge.stop();
    } catch {
      // Page teardown is best effort.
    }
    try {
      runtime.stop();
    } catch {
      // Page teardown is best effort.
    }
    observedIdentities.clear();
  };

  try {
    targetWindow.addEventListener("pagehide", stop, { once: true });
    // Tells background when this document is being navigated away from, and answers "are you still there?" for
    // it, so a Dashboard opened from this page ends with the page (Dashboard source lifecycle design 2026-09-21).
    uninstallSourceLifecycle = installSourceDocumentLifecycle(targetWindow);
    writeAuthority.start();
    gatedResolver.start();
    ownedAccountResolver?.start();
    bridge.start();
    profile.setTheme(themeObserver.start());
    void runtime.start().catch(stop);
    void loadAndMigrateStorage()
      .then(({ settings }) => {
        if (!active) return;
        profile.setEnabled(settings.enabled && settings.nicknameDisplay.profile);
        runtime.setEnabled(settings.enabled);
        postAuthor = new PostAuthorSurfaceAdapter({
          contactStore,
          settings,
          getCurrentGeneration: () => runtime.getGeneration(),
        });
        for (const [username, threadsUserId] of observedIdentities) {
          postAuthor.identityDiscovered(username, threadsUserId);
        }
        surfaceRegistry.register(postAuthor);
        chrome.storage.onChanged.addListener(onSettingsChanged);
        notifyMainWorldEnabled(settings.enabled);
        runtime.identityDiscovered();
      })
      .catch(() => {
        if (!active) return;
        // Fallback must be consistent across every enabled-gated piece -
        // Profile, the runtime, and the MAIN-world observer all fall back
        // to the same enabled state rather than three different ones.
        profile.setEnabled(true);
        runtime.setEnabled(true);
        notifyMainWorldEnabled(true);
        runtime.identityDiscovered();
        // Feed nickname display is best-effort; Profile falls back to its
        // pre-settings behavior if the surface settings could not be loaded.
      });
  } catch {
    stop();
  }

  return stop;
}

if (
  typeof window !== "undefined" &&
  window.location.hostname === "www.threads.com"
) {
  try {
    startThreadsPrivateDirectory(window, document);
  } catch {
    // Content startup must never affect Threads page startup.
  }
}
