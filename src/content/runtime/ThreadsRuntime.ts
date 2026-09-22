import type { CurrentAccountResolver } from "../../account/CurrentAccountResolver";
import { ownerThreadsUserIdFromState } from "../../account/CurrentAccountResolver";
import type { ContactStore } from "../../storage/ContactStore";
import { ThreadsDomObserver } from "./ThreadsDomObserver";
import { NavigationObserver } from "./NavigationObserver";
import { ReconcileScheduler } from "./ReconcileScheduler";
import { SurfaceRegistry } from "./SurfaceRegistry";
import type { PageContext, ReconcileScope } from "./types";

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;
type MutationObserverConstructor = new (
  callback: MutationCallback,
) => MutationObserver;

export interface ThreadsRuntimeOptions {
  readonly contactStore: ContactStore;
  /**
   * No confirmed owner means no private Directory access (Phase 3.5 Task
   * 16): the runtime subscribes to this resolver for its whole lifetime, so
   * an owner appearing, disappearing, or changing mid-session is handled
   * live, not just read once at `start()`. See `handleOwnerTransition`.
   */
  readonly accountResolver: CurrentAccountResolver;
  readonly surfaceRegistry?: SurfaceRegistry;
  readonly observedWindow?: Window;
  readonly observedDocument?: Document;
  readonly requestFrame?: RequestFrame;
  readonly cancelFrame?: CancelFrame;
  readonly MutationObserver?: MutationObserverConstructor;
}

export class ThreadsRuntime {
  private readonly surfaceRegistry: SurfaceRegistry;
  private readonly observedWindow: Window;
  private readonly observedDocument: Document;
  private readonly requestFrame: RequestFrame | undefined;
  private readonly cancelFrame: CancelFrame | undefined;
  private readonly Observer: MutationObserverConstructor | undefined;
  private readonly navigation: NavigationObserver;
  private readonly dom: ThreadsDomObserver;
  private scheduler: ReconcileScheduler | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeResolver: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private active = false;
  private started = false;
  private enabled = true;
  private lifecycle = 0;
  /** The owner ContactStore/surfaces are currently loaded for, or null when no owner is confirmed. */
  private currentOwnerThreadsUserId: string | null = null;

  constructor(private readonly options: ThreadsRuntimeOptions) {
    this.surfaceRegistry = options.surfaceRegistry ?? new SurfaceRegistry();
    this.observedWindow = options.observedWindow ?? window;
    this.observedDocument = options.observedDocument ?? document;
    this.requestFrame = options.requestFrame;
    this.cancelFrame = options.cancelFrame;
    this.Observer = options.MutationObserver;
    this.navigation = new NavigationObserver(this.observedWindow, (scope) => {
      this.request(scope);
    });
    this.dom = new ThreadsDomObserver(
      this.observedDocument,
      (scope) => this.request(scope),
      this.Observer,
    );
  }

  start(): Promise<void> {
    if (this.started) {
      return Promise.resolve();
    }
    if (this.starting) {
      return this.starting;
    }

    const lifecycle = ++this.lifecycle;
    this.active = true;
    const starting = this.activate(lifecycle);
    this.starting = starting;
    void starting.then(
      () => this.finishStart(starting),
      () => this.finishStart(starting),
    );
    return starting;
  }

  stop(): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.started = false;
    this.lifecycle += 1;
    this.starting = null;
    this.unsubscribeResolver?.();
    this.unsubscribeResolver = null;
    this.pauseHotPaths();
    this.options.contactStore.stop();
    this.surfaceRegistry.cleanup({ page: this.createPage() });
    this.currentOwnerThreadsUserId = null;
  }

  identityDiscovered(): void {
    this.request({ type: "full" });
  }

  getGeneration(): number {
    return this.navigation.getGeneration();
  }

  /**
   * Pauses/resumes the hot paths (mutation observer, navigation observer,
   * ContactStore subscription, reconcile scheduler) without tearing down
   * the runtime the way stop() does. Resuming never forces a full
   * reconcile: per the enabled-ON contract, OFF -> ON must not trigger a
   * giant immediate Feed rescan - new/changed content is picked up by the
   * mutation observer as it happens, and a reload is the accepted way to
   * fully resync already-rendered content.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (!this.started || !this.active || !this.currentOwnerThreadsUserId) {
      return;
    }

    if (enabled) {
      this.resumeHotPaths();
    } else {
      this.pauseHotPaths();
      this.surfaceRegistry.cleanup({ page: this.createPage() });
    }
  }

  private async activate(lifecycle: number): Promise<void> {
    try {
      this.unsubscribeResolver = this.options.accountResolver.subscribe(() => {
        void this.handleOwnerTransition(lifecycle).catch(() => {
          // The new owner's data could not be loaded (storage unreadable). Fail closed and stay alive: the
          // previous owner's UI and store are already gone, nothing private is mounted, and the next change
          // of account tries again. Left unhandled this was an unhandled rejection in the page.
          if (this.isActive(lifecycle)) {
            this.options.contactStore.stop();
            this.currentOwnerThreadsUserId = null;
          }
        });
      });
      await this.handleOwnerTransition(lifecycle);
      if (!this.isActive(lifecycle)) {
        return;
      }

      this.started = true;
    } catch (error) {
      if (this.isActive(lifecycle)) {
        this.rollback();
      }
      throw error;
    }
  }

  /**
   * The one place an owner appearing, disappearing, or changing is handled
   * (Phase 3.5 Task 16-17). Three distinct cases:
   *
   * - `revalidating` (an owner is confirmed but the Recovery check for their
   *   data has not answered yet, `RecoveryAwareAccountResolver`): freeze in
   *   place - pause hot paths so no new mutation happens while it is
   *   uncertain, but leave the currently mounted private UI and loaded
   *   ContactStore exactly as they are. This is not invalidation. (A reload
   *   used to reach here too, through a 10 second window; since the
   *   2026-09-21 Dashboard source lifecycle design a reload replaces the
   *   document and there is no such window.)
   * - the confirmed owner is unchanged (including once the Recovery check
   *   has answered after `revalidating`): resume hot paths if they were
   *   paused; nothing else changes.
   * - true invalidation or a genuine owner switch (confirmed -> a
   *   *different* owner, or -> unresolved): stops private processing,
   *   removes every TPD-owned private UI node, and unloads the old owner's
   *   ContactStore *before* a new one is ever loaded - two owners' stores
   *   can never coexist, and a new owner can never briefly render through
   *   the previous one's still-mounted nickname nodes. Loading a new owner
   *   always does exactly one controlled full reconcile, then resumes the
   *   incremental observers for everything after that.
   */
  private async handleOwnerTransition(lifecycle: number): Promise<void> {
    const state = this.options.accountResolver.getState();

    if (state.state === "revalidating") {
      if (this.currentOwnerThreadsUserId !== null) {
        this.pauseHotPaths();
      }
      return;
    }

    const nextOwner = ownerThreadsUserIdFromState(state);
    if (nextOwner === this.currentOwnerThreadsUserId) {
      if (nextOwner !== null && this.enabled) {
        this.resumeHotPaths();
      }
      return;
    }

    if (this.currentOwnerThreadsUserId !== null) {
      this.pauseHotPaths();
      this.surfaceRegistry.cleanup({ page: this.createPage() });
      this.options.contactStore.stop();
      this.currentOwnerThreadsUserId = null;
    }

    if (!this.isActive(lifecycle) || nextOwner === null) {
      return;
    }

    await this.options.contactStore.start(nextOwner);
    if (!this.isActive(lifecycle)) {
      return;
    }
    this.currentOwnerThreadsUserId = nextOwner;

    if (this.enabled) {
      this.resumeHotPaths();
      if (!this.isActive(lifecycle)) {
        return;
      }
      this.request({ type: "full" });
    }
  }

  private resumeHotPaths(): void {
    if (this.unsubscribeStore) {
      return;
    }
    const lifecycle = this.lifecycle;
    this.unsubscribeStore = this.options.contactStore.subscribe(() => {
      this.request({ type: "full" });
    });
    this.scheduler = new ReconcileScheduler(
      (scope) => this.reconcile(lifecycle, scope),
      this.requestFrame,
      this.cancelFrame,
    );
    this.navigation.start();
    this.dom.start();
  }

  private pauseHotPaths(): void {
    this.scheduler?.stop();
    this.scheduler = null;
    this.dom.stop();
    this.navigation.stop();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  private request(scope: ReconcileScope): void {
    if (!this.active) {
      return;
    }
    this.scheduler?.request(scope);
  }

  private async reconcile(
    lifecycle: number,
    scope: ReconcileScope,
  ): Promise<void> {
    if (!this.isActive(lifecycle)) {
      return;
    }
    await this.surfaceRegistry.reconcile({ page: this.createPage(), scope });
  }

  private rollback(): void {
    this.active = false;
    this.started = false;
    this.lifecycle += 1;
    this.unsubscribeResolver?.();
    this.unsubscribeResolver = null;
    this.pauseHotPaths();
    this.options.contactStore.stop();
    this.currentOwnerThreadsUserId = null;
  }

  private isActive(lifecycle: number): boolean {
    return this.active && this.lifecycle === lifecycle;
  }

  private finishStart(starting: Promise<void>): void {
    if (this.starting === starting) {
      this.starting = null;
    }
  }

  private createPage(): PageContext {
    return Object.freeze({
      document: this.observedDocument,
      url: this.observedWindow.location.href,
      generation: this.navigation.getGeneration(),
    });
  }
}
