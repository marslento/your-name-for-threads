import type { IdentityObservation } from "../../domain/identity";
import {
  normalizeThreadsUserId,
  normalizeUsername,
} from "../../domain/validation";
import type { ContactsRepository } from "../../storage/ContactsRepository";

export class IdentityCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: Pick<ContactsRepository, "cacheIdentityObservation">,
    private readonly requestRuntimeReconciliation: () => void | Promise<void>,
  ) {}

  observe(observation: IdentityObservation): Promise<void> {
    const receivedObservation: IdentityObservation = {
      username: observation.username,
      threadsUserId: observation.threadsUserId,
      source: observation.source,
      observedAt: observation.observedAt,
    };
    const completion = this.queue.then(() => this.process(receivedObservation));
    this.queue = completion.then(
      () => undefined,
      () => undefined,
    );
    return completion;
  }

  private async process(observation: IdentityObservation): Promise<void> {
    const username = normalizeUsername(observation.username);
    const threadsUserId =
      observation.threadsUserId === undefined
        ? undefined
        : normalizeThreadsUserId(observation.threadsUserId);
    if (!Number.isFinite(Date.parse(observation.observedAt))) {
      throw new Error("Identity observation timestamp must be a valid date");
    }

    if (threadsUserId !== undefined) {
      // Page observations are untrusted hints, never authority to mutate private contacts.
      await this.repository.cacheIdentityObservation({
        username,
        threadsUserId,
        source: observation.source,
        observedAt: observation.observedAt,
      });
    }
    await this.requestRuntimeReconciliation();
  }
}
