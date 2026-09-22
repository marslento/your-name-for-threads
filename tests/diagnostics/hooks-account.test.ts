import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardSessionAccountResolver } from "../../src/account/DashboardSessionAccountResolver";
import { createSession } from "../../src/account/DashboardSessionRegistry";
import { ThreadsAccountResolver } from "../../src/account/ThreadsAccountResolver";
import { reportDiagnostic } from "../../src/diagnostics/reportDiagnostic";
import { endSession } from "../fixtures/storage/endSession";

vi.mock("../../src/diagnostics/reportDiagnostic", () => ({ reportDiagnostic: vi.fn() }));

/** A page whose viewer define never arrived: the state the hydration retries (and giving up) answer. */
const hydrating = "<div>still hydrating</div>";
const signedOut = `<script type="application/json" data-sjs>${JSON.stringify({
  require: [["ScheduledServerJS", "handle", null, [{ __bbox: { define: [["BarcelonaSharedData", [], { viewer: null }, 1]] } }]]],
})}</script>`;
const signedIn = `<script type="application/json" data-sjs>${JSON.stringify({
  require: [
    ["ScheduledServerJS", "handle", null, [{ __bbox: { define: [["BarcelonaSharedData", [], { viewer: { id: "73681567207", fbid: "1", username: "alice" } }, 1]] } }]],
  ],
})}</script>`;

function resolverOn(html: string, overrides: Partial<ConstructorParameters<typeof ThreadsAccountResolver>[1]> = {}) {
  document.body.innerHTML = html;
  return new ThreadsAccountResolver(document, {
    resolveCachedUsername: async () => null,
    report: () => undefined,
    hydrationRetries: 0,
    ...overrides,
  });
}

beforeEach(() => {
  vi.mocked(reportDiagnostic).mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("account resolver -> ACCOUNT_RESOLVER_UNRESOLVED", () => {
  it("is reported when the resolver gives up after its hydration retries, and not before", async () => {
    vi.useFakeTimers();
    const resolver = resolverOn(hydrating, { hydrationRetries: 2, hydrationRetryDelayMs: 1_000 });

    // Two retries = three attempts: at 0 ms, 1 s and 2 s. Only the last one gives up.
    resolver.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reportDiagnostic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reportDiagnostic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reportDiagnostic).toHaveBeenCalledTimes(1);
    expect(reportDiagnostic).toHaveBeenCalledWith("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    resolver.stop();
  });

  it("is reported at once when there are no retries to wait for", async () => {
    const resolver = resolverOn(hydrating);

    resolver.start();
    await vi.waitFor(() => expect(resolver.getState().state).toBe("unresolved"));

    expect(reportDiagnostic).toHaveBeenCalledWith("ACCOUNT_RESOLVER_UNRESOLVED", "account-resolver", "unresolved");
    resolver.stop();
  });

  it("is not reported for a logout: the page itself says there is no viewer", async () => {
    const resolver = resolverOn(signedOut);

    resolver.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resolver.getState().state).toBe("unresolved");
    expect(reportDiagnostic).not.toHaveBeenCalled();
    resolver.stop();
  });

  it("is not reported when the viewer is confirmed", async () => {
    const resolver = resolverOn(signedIn);

    resolver.start();
    await vi.waitFor(() => expect(resolver.getState().state).toBe("confirmed"));

    expect(reportDiagnostic).not.toHaveBeenCalled();
    resolver.stop();
  });
});

describe("Dashboard session -> DASHBOARD_SESSION_INVALID", () => {
  type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

  function installSessionStorage() {
    const state: Record<string, unknown> = {};
    const listeners = new Set<Listener>();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          session: {
            async get(key: string) {
              return Object.hasOwn(state, key) ? { [key]: state[key] } : {};
            },
            async set(values: Record<string, unknown>) {
              const changes: Record<string, chrome.storage.StorageChange> = {};
              for (const [key, newValue] of Object.entries(values)) changes[key] = { oldValue: state[key], newValue };
              Object.assign(state, values);
              for (const listener of [...listeners]) listener(changes, "session");
            },
          },
          onChanged: { addListener: (l: Listener) => listeners.add(l), removeListener: (l: Listener) => listeners.delete(l) },
        },
      },
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("is reported when the URL names a session that does not exist", async () => {
    installSessionStorage();
    const resolver = new DashboardSessionAccountResolver({ search: "?session=fabricated" });

    resolver.subscribe(() => undefined);
    await settle();

    expect(reportDiagnostic).toHaveBeenCalledWith("DASHBOARD_SESSION_INVALID", "dashboard", "unresolved");
  });

  it("is reported when the session was invalidated while the Dashboard is open", async () => {
    installSessionStorage();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver({ search: `?session=${session.sessionId}` });
    resolver.subscribe(() => undefined);
    await settle();
    expect(reportDiagnostic).not.toHaveBeenCalled();

    await endSession(session.sessionId);
    await settle();

    expect(reportDiagnostic).toHaveBeenCalledWith("DASHBOARD_SESSION_INVALID", "dashboard", "unresolved");
  });

  it("is not reported when the Dashboard is simply opened without a session (e.g. from the extension's Options link)", async () => {
    installSessionStorage();
    const resolver = new DashboardSessionAccountResolver({ search: "" });

    resolver.subscribe(() => undefined);
    await settle();

    expect(resolver.getState()).toEqual({ state: "unresolved" });
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });

  it("is not reported for a valid active session", async () => {
    installSessionStorage();
    const session = await createSession({ ownerThreadsUserId: "123", ownerUsername: "alice", sourceTabId: 1 });
    const resolver = new DashboardSessionAccountResolver({ search: `?session=${session.sessionId}` });

    resolver.subscribe(() => undefined);
    await settle();

    expect(resolver.getState().state).toBe("confirmed");
    expect(reportDiagnostic).not.toHaveBeenCalled();
  });
});
