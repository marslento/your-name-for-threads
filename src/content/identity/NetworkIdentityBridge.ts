import type { IdentityObservation } from "../../domain/identity";
import { validateIdentityMessage } from "./validateIdentityMessage";

export class NetworkIdentityBridge {
  private started = false;

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    try {
      if (
        event.source !== this.targetWindow ||
        event.origin !== this.targetWindow.location.origin
      ) {
        return;
      }

      const observation = validateIdentityMessage(event.data, this.clock());
      if (observation) {
        const completion = this.onIdentityObservation(observation);
        if (completion) {
          void completion.then(undefined, () => {});
        }
      }
    } catch {
      // MAIN-world input and observation consumers cannot affect page handling.
    }
  };

  constructor(
    private readonly targetWindow: Window,
    private readonly onIdentityObservation: (
      observation: IdentityObservation,
    ) => void | PromiseLike<void>,
    private readonly clock: () => string,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.targetWindow.addEventListener("message", this.onMessage);
    this.started = true;
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.targetWindow.removeEventListener("message", this.onMessage);
    this.started = false;
  }
}
