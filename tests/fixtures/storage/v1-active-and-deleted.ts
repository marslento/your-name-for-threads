import type { ExtensionStorageV1 } from "../../../src/storage/schema";
import type { ExtensionStorageV2 } from "../../../src/storage/schema";

export const v1ActiveAndDeletedFixture: ExtensionStorageV1 = {
  schemaVersion: 1,
  contacts: {
    "contact-numeric": {
      id: "contact-numeric",
      threadsUserId: "1001",
      username: "alice",
      nickname: "Alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    "contact-username-only": {
      id: "contact-username-only",
      username: "bob",
      nickname: "Bob",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      identityUpdatedAt: "2026-01-03T00:00:00.000Z",
    },
    "contact-deleted": {
      id: "contact-deleted",
      threadsUserId: "1003",
      username: "carol",
      nickname: "Carol",
      createdAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
      identityUpdatedAt: "2026-01-04T00:00:00.000Z",
      deletedAt: "2026-01-05T00:00:00.000Z",
    },
  },
  identityIndex: {
    "username:alice": "contact-numeric",
    "threads:1001": "contact-numeric",
    "username:bob": "contact-username-only",
    "username:carol": "contact-deleted",
    "threads:1003": "contact-deleted",
  },
  identityCache: {
    bob: {
      username: "bob",
      threadsUserId: "1002",
      source: "network",
      observedAt: "2026-01-03T00:00:00.000Z",
      expiresAt: "2026-02-03T00:00:00.000Z",
    },
  },
  identityConflicts: {
    "conflict-pending": {
      id: "conflict-pending",
      threadsUserId: "2002",
      contactIds: ["contact-numeric", "contact-username-only"],
      detectedAt: "2026-01-06T00:00:00.000Z",
      status: "pending",
    },
    "conflict-resolved": {
      id: "conflict-resolved",
      threadsUserId: "3003",
      contactIds: ["contact-a", "contact-b"],
      detectedAt: "2026-01-01T00:00:00.000Z",
      status: "resolved",
    },
  },
  settings: {
    nicknameDisplay: { profile: false, feed: true, replies: true, quotes: false },
  },
};

export const v1ActiveAndDeletedExpectedV2: ExtensionStorageV2 = {
  schemaVersion: 2,
  contacts: {
    "contact-numeric": {
      id: "contact-numeric",
      threadsUserId: "1001",
      username: "alice",
      nickname: "Alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      identityUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
    "contact-username-only": {
      id: "contact-username-only",
      username: "bob",
      nickname: "Bob",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      identityUpdatedAt: "2026-01-03T00:00:00.000Z",
    },
  },
  tombstones: {
    "contact-deleted": {
      contactId: "contact-deleted",
      threadsUserId: "1003",
      username: "carol",
      createdAt: "2026-01-04T00:00:00.000Z",
      deletedAt: "2026-01-05T00:00:00.000Z",
      reason: "user_deleted",
    },
  },
  identityIndex: {
    "username:alice": "contact-numeric",
    "threads:1001": "contact-numeric",
    "username:bob": "contact-username-only",
  },
  identityCache: {
    bob: {
      username: "bob",
      threadsUserId: "1002",
      source: "network",
      observedAt: "2026-01-03T00:00:00.000Z",
      expiresAt: "2026-02-03T00:00:00.000Z",
    },
  },
  identityConflicts: {
    "conflict-pending": {
      id: "conflict-pending",
      threadsUserId: "2002",
      contactIds: ["contact-numeric", "contact-username-only"],
      detectedAt: "2026-01-06T00:00:00.000Z",
    },
  },
  settings: {
    enabled: true,
    nicknameDisplay: { profile: false, feed: true, replies: true, quotes: false },
  },
};
