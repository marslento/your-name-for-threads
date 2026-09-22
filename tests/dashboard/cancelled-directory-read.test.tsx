import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackupImportPage } from "../../src/dashboard/backup/BackupImportPage";
import { rethrowUnlessAbort } from "../../src/shared/rethrowUnlessAbort";
import type { DirectoryRepository } from "../../src/storage/DirectoryRepository";

/**
 * A Directory read the account's proof has withdrawn is refused with an AbortError (Dashboard source lifecycle design
 * 2026-09-21, DL11), and the Dashboard it belonged to is being locked, so the page that asked has nothing to say about
 * it. Any other failure is still a failure: it must not be swallowed on the way.
 */
function repositoryFailingWith(error: unknown): DirectoryRepository {
  return {
    getDirectoryForOwner: () => Promise.reject(error),
    getDirectoryById: () => Promise.resolve(undefined),
    commitOwnerDirectory: () => Promise.reject(error),
    resetDirectoryForOwner: () => Promise.reject(error),
    clearDirectoryForOwner: () => Promise.reject(error),
  } as unknown as DirectoryRepository;
}

/** Everything the process reports as an unhandled rejection while `run` and one more turn of the event loop go by. */
async function unhandledDuring(run: () => void | Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

const renderPage = (repository: DirectoryRepository) =>
  render(
    <MemoryRouter>
      <BackupImportPage ownerThreadsUserId="900" ownerUsername="owner" directoryRepository={repository} />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
});

describe("rethrowUnlessAbort", () => {
  it("returns for an AbortError, of either kind, and rethrows everything else as it was", () => {
    expect(() => rethrowUnlessAbort(new DOMException("Account no longer authorizes this write", "AbortError"))).not.toThrow();
    expect(() => rethrowUnlessAbort(Object.assign(new Error("aborted"), { name: "AbortError" }))).not.toThrow();
    const failure = new Error("storage is unavailable");
    expect(() => rethrowUnlessAbort(failure)).toThrow(failure);
    expect(() => rethrowUnlessAbort("a string")).toThrow("a string");
    expect(() => rethrowUnlessAbort(undefined)).toThrow();
  });
});

describe("the Backup & Import page when its opening read is refused", () => {
  it("says nothing about a read the account withdrew, and leaves the page as it was", async () => {
    const read = vi.fn(() => Promise.reject(new DOMException("Account no longer authorizes this write", "AbortError")));
    const repository = { ...repositoryFailingWith(new Error("unused")), getDirectoryForOwner: read } as DirectoryRepository;

    const unhandled = await unhandledDuring(async () => {
      renderPage(repository);
      await waitFor(() => expect(read).toHaveBeenCalled());
    });

    expect(unhandled).toEqual([]);
  });

  it("does not swallow a real storage failure", async () => {
    const failure = new Error("storage is unavailable");
    const read = vi.fn(() => Promise.reject(failure));
    const repository = { ...repositoryFailingWith(failure), getDirectoryForOwner: read } as DirectoryRepository;

    const unhandled = await unhandledDuring(async () => {
      renderPage(repository);
      await waitFor(() => expect(read).toHaveBeenCalled());
    });

    expect(unhandled).toEqual([failure]);
  });
});
