import type { ReconcileScope } from "./types";

type RequestReconcile = (
  scope: ReconcileScope,
) => void | PromiseLike<void>;

interface NavigationLifecycle {
  url: string;
  readonly originalPushState: History["pushState"];
  readonly originalReplaceState: History["replaceState"];
  readonly pushState: History["pushState"];
  readonly replaceState: History["replaceState"];
  readonly popstateListener: EventListener;
}

export class NavigationObserver {
  private generation = 0;
  private lifecycle: NavigationLifecycle | null = null;

  constructor(
    private readonly observedWindow: Window,
    private readonly requestReconcile: RequestReconcile,
  ) {}

  start(): void {
    if (this.lifecycle) {
      return;
    }

    const observer = this;
    const history = this.observedWindow.history;
    let lifecycle!: NavigationLifecycle;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const pushState: History["pushState"] = function (
      this: History,
      ...args
    ) {
      const result = originalPushState.apply(this, args);
      observer.handleRouteChange(lifecycle);
      return result;
    };
    const replaceState: History["replaceState"] = function (
      this: History,
      ...args
    ) {
      const result = originalReplaceState.apply(this, args);
      observer.handleRouteChange(lifecycle);
      return result;
    };
    const popstateListener = () => observer.handleRouteChange(lifecycle);
    lifecycle = {
      url: this.observedWindow.location.href,
      originalPushState,
      originalReplaceState,
      pushState,
      replaceState,
      popstateListener,
    };

    try {
      history.pushState = lifecycle.pushState;
      history.replaceState = lifecycle.replaceState;
      this.observedWindow.addEventListener(
        "popstate",
        lifecycle.popstateListener,
      );
      this.lifecycle = lifecycle;
    } catch (error) {
      this.uninstall(lifecycle);
      throw error;
    }
  }

  stop(): void {
    const lifecycle = this.lifecycle;
    if (!lifecycle) {
      return;
    }

    this.lifecycle = null;
    this.uninstall(lifecycle);
  }

  getGeneration(): number {
    return this.generation;
  }

  private handleRouteChange(lifecycle: NavigationLifecycle): void {
    if (this.lifecycle !== lifecycle) {
      return;
    }

    const nextUrl = this.observedWindow.location.href;
    if (nextUrl === lifecycle.url) {
      return;
    }

    lifecycle.url = nextUrl;
    this.generation += 1;
    try {
      void Promise.resolve(this.requestReconcile({ type: "full" })).catch(
        () => {},
      );
    } catch {
      // Navigation must remain successful if reconciliation cannot be requested.
    }
  }

  private uninstall(lifecycle: NavigationLifecycle): void {
    try {
      this.observedWindow.removeEventListener(
        "popstate",
        lifecycle.popstateListener,
      );
    } catch {
      // Continue restoring owned history methods.
    }

    try {
      if (this.observedWindow.history.pushState === lifecycle.pushState) {
        this.observedWindow.history.pushState = lifecycle.originalPushState;
      }
    } catch {
      // Continue restoring the other owned history method.
    }

    try {
      if (
        this.observedWindow.history.replaceState === lifecycle.replaceState
      ) {
        this.observedWindow.history.replaceState =
          lifecycle.originalReplaceState;
      }
    } catch {
      // Cleanup is best effort after lifecycle invalidation.
    }
  }
}
