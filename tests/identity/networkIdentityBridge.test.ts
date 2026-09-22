import { describe, expect, it } from "vitest";

import { NetworkIdentityBridge } from "../../src/content/identity/NetworkIdentityBridge";
import { validateIdentityMessage } from "../../src/content/identity/validateIdentityMessage";

const observedAt = "2026-09-11T01:02:03.000Z";

describe("validateIdentityMessage", () => {
  it("accepts own string fields and returns a normalized network observation", () => {
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "  @Alice  ",
          threadsUserId: "00123",
        },
        observedAt,
      ),
    ).toEqual({
      username: "alice",
      threadsUserId: "00123",
      source: "network",
      observedAt,
    });
  });

  it.each(["", "123 ", "+123", "12.3", "１２３"])(
    "rejects non-ASCII-digit stable ID %j",
    (threadsUserId) => {
      expect(
        validateIdentityMessage(
          {
            type: "TPD_IDENTITY_DISCOVERED",
            username: "alice",
            threadsUserId,
          },
          observedAt,
        ),
      ).toBeNull();
    },
  );

  it("rejects a username that is empty after shared normalization", () => {
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "  @  ",
          threadsUserId: "123",
        },
        observedAt,
      ),
    ).toBeNull();
  });

  it("requires the exact message type", () => {
    expect(
      validateIdentityMessage(
        {
          type: "tpd_identity_discovered",
          username: "alice",
          threadsUserId: "123",
        },
        observedAt,
      ),
    ).toBeNull();
  });

  it("rejects fields over their pre-normalization caps", () => {
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: ` ${"a".repeat(127)}`,
          threadsUserId: "123",
        },
        observedAt,
      ),
    ).toEqual({
      username: "a".repeat(127),
      threadsUserId: "123",
      source: "network",
      observedAt,
    });
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: ` ${"a".repeat(128)}`,
          threadsUserId: "123",
        },
        observedAt,
      ),
    ).toBeNull();
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "😀".repeat(64),
          threadsUserId: "123",
        },
        observedAt,
      ),
    ).toEqual({
      username: "😀".repeat(64),
      threadsUserId: "123",
      source: "network",
      observedAt,
    });
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: `${"😀".repeat(64)}a`,
          threadsUserId: "123",
        },
        observedAt,
      ),
    ).toBeNull();
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "alice",
          threadsUserId: "1".repeat(32),
        },
        observedAt,
      ),
    ).toEqual({
      username: "alice",
      threadsUserId: "1".repeat(32),
      source: "network",
      observedAt,
    });
    expect(
      validateIdentityMessage(
        {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "alice",
          threadsUserId: "1".repeat(33),
        },
        observedAt,
      ),
    ).toBeNull();
  });

  it("rejects inherited and non-primitive required fields", () => {
    const inherited = Object.create({
      type: "TPD_IDENTITY_DISCOVERED",
      username: "alice",
      threadsUserId: "123",
    });

    expect(validateIdentityMessage(inherited, observedAt)).toBeNull();
    expect(
      validateIdentityMessage(
        {
          type: new String("TPD_IDENTITY_DISCOVERED"),
          username: "alice",
          threadsUserId: "123",
        },
        observedAt,
      ),
    ).toBeNull();
  });

  it("ignores unrelated throwing properties without invoking them", () => {
    const data = {
      type: "TPD_IDENTITY_DISCOVERED",
      username: "Alice",
      threadsUserId: "123",
    };
    Object.defineProperty(data, "credentials", {
      enumerable: true,
      get(): never {
        throw new Error("must not inspect unrelated data");
      },
    });

    expect(() => validateIdentityMessage(data, observedAt)).not.toThrow();
    expect(validateIdentityMessage(data, observedAt)).toEqual({
      username: "alice",
      threadsUserId: "123",
      source: "network",
      observedAt,
    });
  });

  it("returns null instead of throwing for hostile required fields and proxies", () => {
    const throwingUsername = {
      type: "TPD_IDENTITY_DISCOVERED",
      threadsUserId: "123",
      get username(): never {
        throw new Error("hostile accessor");
      },
    };
    const throwingProxy = new Proxy({}, {
      getOwnPropertyDescriptor(): never {
        throw new Error("hostile proxy");
      },
    });

    expect(() => validateIdentityMessage(throwingUsername, observedAt)).not.toThrow();
    expect(validateIdentityMessage(throwingUsername, observedAt)).toBeNull();
    expect(() => validateIdentityMessage(throwingProxy, observedAt)).not.toThrow();
    expect(validateIdentityMessage(throwingProxy, observedAt)).toBeNull();
  });
});

function createTarget(origin = "https://www.threads.com"): Window {
  const target = new EventTarget() as EventTarget & {
    location: { origin: string };
  };
  target.location = { origin };
  return target as unknown as Window;
}

function createMessageEvent(input: {
  data: unknown;
  source: Window;
  origin: string;
}): MessageEvent<unknown> {
  const event = new Event("message");
  Object.defineProperties(event, {
    data: { value: input.data },
    source: { value: input.source },
    origin: { value: input.origin },
  });
  return event as MessageEvent<unknown>;
}

function dispatchMessage(
  target: Window,
  overrides: Partial<{
    data: unknown;
    source: Window;
    origin: string;
  }> = {},
): boolean {
  return target.dispatchEvent(
    createMessageEvent({
      data: {
        type: "TPD_IDENTITY_DISCOVERED",
        username: "  @Alice  ",
        threadsUserId: "00123",
      },
      source: target,
      origin: target.location.origin,
      ...overrides,
    }),
  );
}

describe("NetworkIdentityBridge", () => {
  it("emits exactly one normalized observation for a valid same-window message", () => {
    const target = createTarget();
    const observations: unknown[] = [];
    const bridge = new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => observedAt,
    );
    bridge.start();

    dispatchMessage(target);

    expect(observations).toEqual([
      {
        username: "alice",
        threadsUserId: "00123",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("ignores a message from another window", () => {
    const target = createTarget();
    const observations: unknown[] = [];
    const bridge = new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => observedAt,
    );
    bridge.start();

    dispatchMessage(target, { source: createTarget() });

    expect(observations).toEqual([]);
  });

  it("ignores a message with another origin", () => {
    const target = createTarget();
    const observations: unknown[] = [];
    const bridge = new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => observedAt,
    );
    bridge.start();

    dispatchMessage(target, { origin: "https://attacker.example" });

    expect(observations).toEqual([]);
  });

  it("ignores a same-window message with the wrong payload type", () => {
    const target = createTarget();
    const observations: unknown[] = [];
    const bridge = new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => observedAt,
    );
    bridge.start();

    dispatchMessage(target, {
      data: {
        type: "UNRELATED_MESSAGE",
        username: "alice",
        threadsUserId: "123",
      },
    });

    expect(observations).toEqual([]);
  });

  it("keeps start and stop idempotent while preserving listener identity", () => {
    const target = createTarget();
    const observations: unknown[] = [];
    const bridge = new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => observedAt,
    );

    bridge.start();
    bridge.start();
    dispatchMessage(target);
    bridge.stop();
    bridge.stop();
    dispatchMessage(target);
    bridge.start();
    dispatchMessage(target);

    expect(observations).toHaveLength(2);
  });

  it("does not handle messages before start", () => {
    const target = createTarget();
    const observations: unknown[] = [];
    new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => observedAt,
    );

    dispatchMessage(target);

    expect(observations).toEqual([]);
  });

  it("isolates callback failures from the window event handler", () => {
    const target = createTarget();
    let callbackCalls = 0;
    const bridge = new NetworkIdentityBridge(
      target,
      () => {
        callbackCalls += 1;
        throw new Error("consumer failed");
      },
      () => observedAt,
    );
    bridge.start();

    expect(() => dispatchMessage(target)).not.toThrow();
    expect(() => dispatchMessage(target)).not.toThrow();
    expect(callbackCalls).toBe(2);
  });

  it("consumes an asynchronous callback rejection without blocking the handler", () => {
    const target = createTarget();
    let rejectionSinkAttached = false;
    const rejectedCompletion = {
      then(_onFulfilled, onRejected) {
        rejectionSinkAttached = typeof onRejected === "function";
        onRejected?.(new Error("async consumer failed"));
        return Promise.resolve();
      },
    } as PromiseLike<void>;
    const bridge = new NetworkIdentityBridge(
      target,
      () => rejectedCompletion,
      () => observedAt,
    );
    bridge.start();

    expect(() => dispatchMessage(target)).not.toThrow();
    expect(rejectionSinkAttached).toBe(true);
  });

  it("isolates clock and hostile payload failures from the window event handler", () => {
    const target = createTarget();
    const observations: unknown[] = [];
    const throwingClock = new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => {
        throw new Error("clock failed");
      },
    );
    throwingClock.start();

    expect(() => dispatchMessage(target)).not.toThrow();
    throwingClock.stop();

    const hostilePayload = new Proxy({}, {
      getOwnPropertyDescriptor(): never {
        throw new Error("hostile payload");
      },
    });
    const defensiveBridge = new NetworkIdentityBridge(
      target,
      (observation) => {
        observations.push(observation);
      },
      () => observedAt,
    );
    defensiveBridge.start();

    expect(() => dispatchMessage(target, { data: hostilePayload })).not.toThrow();
    expect(observations).toEqual([]);
  });
});
