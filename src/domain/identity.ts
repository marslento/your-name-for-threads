export type IdentitySource =
  | "network"
  | "profile-route"
  | "profile-dom"
  | "feed-dom"
  | "reply-dom";

export interface ThreadsIdentity {
  username: string;
  threadsUserId?: string;
}

export interface IdentityObservation {
  username: string;
  threadsUserId?: string;
  source: IdentitySource;
  observedAt: string;
}

export interface IdentityCacheEntry {
  username: string;
  threadsUserId: string;

  source: IdentitySource;

  observedAt: string;
  expiresAt: string;
}
