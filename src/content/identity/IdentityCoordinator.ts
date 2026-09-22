import type { IdentityObservation } from "../../domain/identity";
import {
  normalizeThreadsUserId,
  normalizeUsername,
} from "../../domain/validation";
import type {
  AttachStableIdentityResult,
  ContactsRepository,
} from "../../storage/ContactsRepository";

export class IdentityCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: ContactsRepository,
    private readonly requestRuntimeReconciliation: () => void | Promise<void>,
    /** No confirmed owner means no private Directory access - `attachStableIdentity` is skipped entirely when this returns `null`. */
    private readonly getOwnerThreadsUserId: () => string | null,
  ) {}

  observe(
    observation: IdentityObservation,
  ): Promise<AttachStableIdentityResult | null> {
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

  private async process(
    observation: IdentityObservation,
  ): Promise<AttachStableIdentityResult | null> {
    const username = normalizeUsername(observation.username);
    const threadsUserId =
      observation.threadsUserId === undefined
        ? undefined
        : normalizeThreadsUserId(observation.threadsUserId);
    if (!Number.isFinite(Date.parse(observation.observedAt))) {
      throw new Error("Identity observation timestamp must be a valid date");
    }

    if (threadsUserId === undefined) {
      await this.requestRuntimeReconciliation();
      return null;
    }

    const normalizedObservation: IdentityObservation = {
      username,
      threadsUserId,
      source: observation.source,
      observedAt: observation.observedAt,
    };
    await this.repository.cacheIdentityObservation(normalizedObservation);
    const ownerThreadsUserId = this.getOwnerThreadsUserId();
    let result: AttachStableIdentityResult | null = null;
    try {
      if (ownerThreadsUserId) {
        result = await this.repository.attachStableIdentity(ownerThreadsUserId, {
          username,
          threadsUserId,
          observedAt: observation.observedAt,
        });
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) throw error;
      // Revoked private writes do not invalidate the public observation
      // already cached above. Continue reconciliation and bridge consumers,
      // just as when there was no confirmed owner at the start.
    }
    await this.requestRuntimeReconciliation();
    return result;
  }
}
