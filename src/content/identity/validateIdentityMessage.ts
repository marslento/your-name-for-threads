import type { IdentityObservation } from "../../domain/identity";
import {
  isValidThreadsUserId,
  normalizeUsername,
} from "../../domain/validation";

const MESSAGE_TYPE = "TPD_IDENTITY_DISCOVERED";
const MAX_USERNAME_INPUT_LENGTH = 128;
const MAX_THREADS_USER_ID_LENGTH = 32;

function readOwnString(value: object, key: string): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

export function validateIdentityMessage(
  data: unknown,
  observedAt: string,
): IdentityObservation | null {
  try {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }

    const type = readOwnString(data, "type");
    const usernameInput = readOwnString(data, "username");
    const threadsUserId = readOwnString(data, "threadsUserId");

    if (
      type !== MESSAGE_TYPE ||
      usernameInput === null ||
      usernameInput.length > MAX_USERNAME_INPUT_LENGTH ||
      threadsUserId === null ||
      threadsUserId.length > MAX_THREADS_USER_ID_LENGTH ||
      !isValidThreadsUserId(threadsUserId)
    ) {
      return null;
    }

    return {
      username: normalizeUsername(usernameInput),
      threadsUserId,
      source: "network",
      observedAt,
    };
  } catch {
    return null;
  }
}
