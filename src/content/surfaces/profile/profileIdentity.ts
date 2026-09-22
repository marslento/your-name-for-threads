import type { ThreadsIdentity } from "../../../domain/identity";
import { isValidThreadsUserId, normalizeUsername } from "../../../domain/validation";

import type { DetectedProfile } from "./profileDetector";

export function resolveProfileIdentity(
  profile: DetectedProfile,
  cachedIdentity: Readonly<ThreadsIdentity> | null = null,
): ThreadsIdentity {
  const username = normalizeUsername(profile.username);
  let cachedUsername: string | null = null;
  let threadsUserId: string | undefined;
  try {
    if (cachedIdentity && typeof cachedIdentity.username === "string") {
      cachedUsername = normalizeUsername(cachedIdentity.username);
      threadsUserId = cachedIdentity.threadsUserId;
    }
  } catch {
    cachedUsername = null;
    threadsUserId = undefined;
  }

  if (cachedUsername === username && typeof threadsUserId === "string" && isValidThreadsUserId(threadsUserId)) {
    return Object.freeze({ username, threadsUserId });
  }

  return Object.freeze({ username });
}
