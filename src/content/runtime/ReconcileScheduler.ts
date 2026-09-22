import type { ReconcileScope } from "./types";

type Reconcile = (scope: ReconcileScope) => void | Promise<void>;
type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

const requestDefaultFrame: RequestFrame = (callback) =>
  globalThis.requestAnimationFrame(callback);
const cancelDefaultFrame: CancelFrame = (handle) =>
  globalThis.cancelAnimationFrame(handle);

export class ReconcileScheduler {
  private frameHandle: number | null = null;
  private pending: ReconcileScope | null = null;
  private reconciling = false;
  private stopped = false;

  constructor(
    private readonly reconcile: Reconcile,
    private readonly requestFrame: RequestFrame = requestDefaultFrame,
    private readonly cancelFrame: CancelFrame = cancelDefaultFrame,
  ) {}

  request(scope: ReconcileScope): void {
    if (this.stopped) {
      return;
    }

    if (scope.type === "full") {
      this.pending = scope;
    } else if (this.pending?.type !== "full") {
      const roots =
        this.pending?.type === "subtree" ? [...this.pending.roots] : [];

      for (const root of [...scope.roots]) {
        if (roots.some((existing) => existing.contains(root))) {
          continue;
        }

        for (let index = roots.length - 1; index >= 0; index -= 1) {
          if (root.contains(roots[index])) {
            roots.splice(index, 1);
          }
        }
        roots.push(root);
      }

      this.pending = { type: "subtree", roots };
    }

    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.pending = null;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }

  private schedule(): void {
    if (this.stopped || this.frameHandle !== null || this.reconciling) {
      return;
    }

    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = null;
      if (this.stopped) {
        return;
      }
      const pending = this.pending;
      this.pending = null;
      if (!pending) {
        return;
      }

      this.reconciling = true;
      void Promise.resolve()
        .then(() => {
          if (!this.stopped) {
            return this.reconcile(pending);
          }
        })
        .catch(() => {})
        .finally(() => {
          this.reconciling = false;
          if (this.pending) {
            this.schedule();
          }
        });
    });
  }
}
