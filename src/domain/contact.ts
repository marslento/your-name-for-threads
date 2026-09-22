export interface ThreadContact {
  id: string;

  threadsUserId?: string;
  username: string;

  nickname: string;
  note?: string;

  createdAt: string;

  // User-owned data clock.
  updatedAt: string;

  // Threads identity metadata clock.
  identityUpdatedAt: string;
}
