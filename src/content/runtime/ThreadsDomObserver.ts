import type { ReconcileScope } from "./types";

type RequestReconcile = (scope: ReconcileScope) => void;
type MutationObserverConstructor = new (
  callback: MutationCallback,
) => MutationObserver;

export class ThreadsDomObserver {
  private observer: MutationObserver | null = null;

  constructor(
    private readonly observedDocument: Document,
    private readonly requestReconcile: RequestReconcile,
    private readonly Observer: MutationObserverConstructor = MutationObserver,
  ) {}

  start(): void {
    if (this.observer) {
      return;
    }

    const observer = new this.Observer((records) => {
      if (this.observer !== observer) {
        return;
      }

      const roots = records.flatMap((record) => [
        ...record.addedNodes,
        ...record.removedNodes,
      ]);
      if (roots.length > 0) {
        this.requestReconcile({ type: "subtree", roots });
      }
    });

    try {
      observer.observe(this.observedDocument, {
        childList: true,
        subtree: true,
      });
      this.observer = observer;
    } catch (error) {
      this.observer = null;
      observer.disconnect();
      throw error;
    }
  }

  stop(): void {
    const observer = this.observer;
    if (!observer) {
      return;
    }

    this.observer = null;
    observer.disconnect();
  }
}
