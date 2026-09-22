import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExtensionErrorBoundary } from "../../src/content/ui/shared/ExtensionErrorBoundary";

const privateMarker = "PRIVATE_CONTACT_DATABASE_alice_photographer";

function ThrowingProfile() {
  throw new Error(privateMarker);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ExtensionErrorBoundary", () => {
  it("fails the extension subtree closed while keeping Threads connected and logs only structural diagnostics in development", () => {
    const logger = vi.fn();

    render(
      <>
        <aside data-testid="threads-content">Threads content</aside>
        <ExtensionErrorBoundary development logger={logger}>
          <ThrowingProfile />
        </ExtensionErrorBoundary>
      </>,
      { onCaughtError: () => {} },
    );

    expect(screen.getByTestId("threads-content").isConnected).toBe(true);
    expect(screen.queryByText(privateMarker)).toBeNull();
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Threads Private Directory UI error",
      expect.objectContaining({
        componentStack: expect.stringContaining("ThrowingProfile"),
      }),
    );
    expect(logger.mock.calls.flat().some((value) => value instanceof Error)).toBe(false);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(privateMarker);
  });

  it("does not log a caught extension error in production", () => {
    const logger = vi.fn();

    render(
      <ExtensionErrorBoundary development={false} logger={logger}>
        <ThrowingProfile />
      </ExtensionErrorBoundary>,
      { onCaughtError: () => {} },
    );

    expect(document.body.textContent).not.toContain(privateMarker);
    expect(logger).not.toHaveBeenCalled();
  });

  it("contains a development logger failure", () => {
    const logger = vi.fn(() => {
      throw new Error("logger unavailable");
    });

    expect(() =>
      render(
        <ExtensionErrorBoundary development logger={logger}>
          <ThrowingProfile />
        </ExtensionErrorBoundary>,
        { onCaughtError: () => {} },
      ),
    ).not.toThrow();
    expect(screen.queryByText(privateMarker)).toBeNull();
  });

  describe("onError (diagnostics hook, Phase 4 Task 8)", () => {
    it("runs in production, where nothing is logged, and is handed nothing to pass on", () => {
      const onError = vi.fn();

      render(
        <ExtensionErrorBoundary development={false} onError={onError}>
          <ThrowingProfile />
        </ExtensionErrorBoundary>,
        { onCaughtError: () => {} },
      );

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith();
    });

    it("does not run for a subtree that renders fine", () => {
      const onError = vi.fn();

      render(
        <ExtensionErrorBoundary onError={onError}>
          <span>fine</span>
        </ExtensionErrorBoundary>,
      );

      expect(onError).not.toHaveBeenCalled();
    });

    it("is contained when it throws, and the development log still happens", () => {
      const onError = vi.fn(() => {
        throw new Error("reporter unavailable");
      });
      const logger = vi.fn();

      expect(() =>
        render(
          <ExtensionErrorBoundary development logger={logger} onError={onError}>
            <ThrowingProfile />
          </ExtensionErrorBoundary>,
          { onCaughtError: () => {} },
        ),
      ).not.toThrow();
      expect(screen.queryByText(privateMarker)).toBeNull();
      expect(logger).toHaveBeenCalledTimes(1);
    });
  });
});
