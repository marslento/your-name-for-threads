import { reportSurfaceFailure } from "../../diagnostics/surfaceDiagnostics";
import { surfaceHealth } from "../../shared/surfaceHealth";
import type { ThreadsSurfaceAdapter } from "../surfaces/ThreadsSurfaceAdapter";
import type {
  SurfaceCleanupContext,
  SurfaceReconcileContext,
} from "./types";

export class SurfaceRegistry {
  private readonly adapters = new Map<string, ThreadsSurfaceAdapter>();
  /**
   * Surfaces whose last `reconcile` threw. Only those are restored by a later reconcile that does not: a
   * surface that reported its own failure and then returned normally (the Profile adapter catches its own
   * mount failure, and its error boundary reports a crashed UI after the fact) is not "healthy" because
   * `reconcile` came back, so it is restored by its own successful mount or by its UI being torn down.
   */
  private readonly threw = new Set<string>();

  register(adapter: ThreadsSurfaceAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Surface adapter "${adapter.id}" is already registered`);
    }

    this.adapters.set(adapter.id, adapter);
  }

  unregister(id: string): ThreadsSurfaceAdapter | undefined {
    const adapter = this.adapters.get(id);
    this.adapters.delete(id);
    return adapter;
  }

  list(): readonly ThreadsSurfaceAdapter[] {
    return [...this.adapters.values()];
  }

  async reconcile(context: SurfaceReconcileContext): Promise<void> {
    const cleanupContext: SurfaceCleanupContext = { page: context.page };

    for (const adapter of this.list()) {
      try {
        if (adapter.isApplicable(context.page)) {
          await adapter.reconcile(context);
          if (this.threw.delete(adapter.id)) surfaceHealth.report(adapter.id, "ready");
        } else {
          adapter.cleanup(cleanupContext);
          this.uiGone(adapter.id);
        }
      } catch {
        // A surface cannot prevent other registered surfaces from reconciling, and one that failed is
        // degraded on its own: nothing here touches the others' health.
        // Recorded as a code only: what was thrown can carry page or private data.
        this.threw.add(adapter.id);
        reportSurfaceFailure(adapter.id);
      }
    }
  }

  cleanup(context: SurfaceCleanupContext): void {
    for (const adapter of this.list()) {
      try {
        adapter.cleanup(context);
        this.uiGone(adapter.id);
      } catch {
        // A surface cannot prevent other registered surfaces from cleaning up.
      }
    }
  }

  /** A surface whose UI has been taken down has nothing left to be broken. */
  private uiGone(id: string): void {
    this.threw.delete(id);
    surfaceHealth.report(id, "ready");
  }
}
