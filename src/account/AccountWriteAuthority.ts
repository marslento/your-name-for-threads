import type { CurrentAccountResolver } from "./CurrentAccountResolver";

/** Cancels queued writes when the proof that authorized them changes. */
export class AccountWriteAuthority {
  private controller = new AbortController();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly resolver: CurrentAccountResolver) {}

  start(): void {
    if (this.unsubscribe) return;
    this.controller = new AbortController();
    let previous = this.resolver.getState();
    this.unsubscribe = this.resolver.subscribe(() => {
      const next = this.resolver.getState();
      if (
        previous.state !== "confirmed" || next.state !== "confirmed" ||
        previous.ownerThreadsUserId !== next.ownerThreadsUserId
      ) {
        this.controller.abort();
        // Reconfirmation authorizes NEW operations, never revives old ones.
        this.controller = new AbortController();
      }
      previous = next;
    });
  }

  stop(): void {
    this.controller.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  capture(ownerThreadsUserId: string): AbortSignal {
    const state = this.resolver.getState();
    if (!this.unsubscribe || state.state !== "confirmed" || state.ownerThreadsUserId !== ownerThreadsUserId) {
      throw new DOMException("Account no longer authorizes this write", "AbortError");
    }
    return this.controller.signal;
  }
}
