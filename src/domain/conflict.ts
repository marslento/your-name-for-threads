export interface IdentityConflict {
  id: string;

  threadsUserId: string;
  contactIds: string[];

  detectedAt: string;
}
