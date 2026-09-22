import { afterEach, describe, expect, it, vi } from "vitest";

import * as identityObserver from "../../src/page/identityObserver";

interface PostedMessage {
  message: unknown;
  targetOrigin: string;
}

class FakeXMLHttpRequest extends EventTarget {
  status = 0;
  responseType = "";
  response: unknown = null;
  responseText = "";
  responseContentType: string | null = null;
  sendResult: unknown;
  readonly sentBodies: unknown[] = [];

  send(body?: unknown): unknown {
    this.sentBodies.push(body);
    return this.sendResult;
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === "content-type"
      ? this.responseContentType
      : null;
  }

  finish(): void {
    this.dispatchEvent(new Event("load"));
    this.dispatchEvent(new Event("loadend"));
  }

  fail(): void {
    this.status = 0;
    this.dispatchEvent(new Event("error"));
    this.dispatchEvent(new Event("loadend"));
  }
}

function createTarget(
  fetchImplementation: typeof fetch,
  XMLHttpRequestImplementation = FakeXMLHttpRequest,
): { target: Window; posted: PostedMessage[]; emitMessage: (data: unknown, origin?: string) => void } {
  const posted: PostedMessage[] = [];
  const messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  const target = {
    fetch: fetchImplementation,
    XMLHttpRequest: XMLHttpRequestImplementation,
    location: { hostname: "www.threads.com", origin: "https://www.threads.com" },
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    },
    addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
      if (type === "message") messageListeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
      if (type === "message") messageListeners.delete(listener);
    },
  } as unknown as Window;

  const emitMessage = (data: unknown, origin = "https://www.threads.com") => {
    const event = { data, origin, source: target } as unknown as MessageEvent<unknown>;
    for (const listener of [...messageListeners]) listener(event);
  };

  return { target, posted, emitMessage };
}

const activeCleanups: Array<() => void> = [];

function install(target: Window): () => void {
  const installIdentityObserver = (
    identityObserver as typeof identityObserver & {
      installIdentityObserver?: (target: Window) => () => void;
    }
  ).installIdentityObserver;

  expect(installIdentityObserver).toBeTypeOf("function");
  const cleanup = installIdentityObserver?.(target);
  expect(cleanup).toBeTypeOf("function");
  activeCleanups.push(cleanup!);
  return cleanup!;
}

async function settleObservers(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  while (activeCleanups.length > 0) {
    activeCleanups.pop()?.();
  }
});

describe("emitIdentityDiscoveries", () => {
  it("posts each normalized identity pair once with exact public fields", () => {
    const posted: Array<{ message: unknown; targetOrigin: string }> = [];
    const target = {
      location: { origin: "https://www.threads.com" },
      postMessage(message: unknown, targetOrigin: string) {
        posted.push({ message, targetOrigin });
      },
    } as unknown as Window;
    const emitIdentityDiscoveries = (
      identityObserver as typeof identityObserver & {
        emitIdentityDiscoveries?: (payload: unknown, target: Window) => void;
      }
    ).emitIdentityDiscoveries;

    expect(emitIdentityDiscoveries).toBeTypeOf("function");

    emitIdentityDiscoveries?.(
      {
        payloads: {
          "/@Alice": { rootView: { props: { user_id: "101" } } },
        },
        duplicate: { id: "101", username: " @ALICE " },
        second: { pk: "202", username: "Bob" },
      },
      target,
    );

    expect(posted).toEqual([
      {
        message: {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "alice",
          threadsUserId: "101",
        },
        targetOrigin: "https://www.threads.com",
      },
      {
        message: {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "bob",
          threadsUserId: "202",
        },
        targetOrigin: "https://www.threads.com",
      },
    ]);
  });

  it("swallows posting failures so page execution continues", () => {
    const target = {
      location: { origin: "https://www.threads.com" },
      postMessage() {
        throw new Error("postMessage failed");
      },
    } as unknown as Window;

    expect(() =>
      identityObserver.emitIdentityDiscoveries(
        { id: "303", username: "Carol" },
        target,
      ),
    ).not.toThrow();
  });
});

describe("installIdentityObserver", () => {
  it("returns the original fetch promise and leaves its response body readable", async () => {
    const payload = { user: { id: "404", username: "FetchUser" } };
    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Content-Type": "Application/Vnd.Threads+JSON; Charset=UTF-8",
      },
    });
    const originalPromise = Promise.resolve(response);
    const receiver = { page: true };
    const input = "https://www.threads.com/api/data";
    const init = { method: "POST", body: "page-owned-body" };
    let receivedThis: unknown;
    let receivedArguments: unknown[] = [];
    const originalFetch = function (this: unknown, ...args: unknown[]) {
      receivedThis = this;
      receivedArguments = args;
      return originalPromise;
    } as typeof fetch;
    const { target, posted, emitMessage } = createTarget(originalFetch);
    install(target);
    emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });

    const returned = Reflect.apply(target.fetch, receiver, [input, init]);

    expect(returned).toBe(originalPromise);
    expect(receivedThis).toBe(receiver);
    expect(receivedArguments).toEqual([input, init]);
    const pageResponse = await returned;
    expect(pageResponse).toBe(response);
    expect(await pageResponse.json()).toEqual(payload);
    await expect.poll(() => posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      message: {
        type: "TPD_IDENTITY_DISCOVERED",
        username: "fetchuser",
        threadsUserId: "404",
      },
      targetOrigin: "https://www.threads.com",
    });
  });

  it("returns the original rejected fetch promise unchanged", async () => {
    const failure = new Error("network failed");
    let rejectOriginal!: (reason: unknown) => void;
    const originalPromise = new Promise<Response>((_resolve, reject) => {
      rejectOriginal = reject;
    });
    const originalFetch = (() => originalPromise) as typeof fetch;
    const { target, posted } = createTarget(originalFetch);
    install(target);

    const returned = target.fetch("https://www.threads.com/api/data");

    expect(returned).toBe(originalPromise);
    rejectOriginal(failure);
    await expect(returned).rejects.toBe(failure);
    await settleObservers();
    expect(posted).toEqual([]);
  });

  it("ignores irrelevant JSON, failed responses, and malformed JSON", async () => {
    const responses = [
      new Response(JSON.stringify({ theme: "dark" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ id: "505", username: "Failed" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
      new Response("{ malformed", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const originalFetch = (() =>
      Promise.resolve(responses.shift()!)) as typeof fetch;
    const { target, posted } = createTarget(originalFetch);
    install(target);

    await target.fetch("https://www.threads.com/irrelevant");
    const failedResponse = await target.fetch("https://www.threads.com/failed");
    const malformedResponse = await target.fetch("https://www.threads.com/malformed");

    expect(await failedResponse.json()).toEqual({
      id: "505",
      username: "Failed",
    });
    expect(await malformedResponse.text()).toBe("{ malformed");
    await settleObservers();
    expect(posted).toEqual([]);
  });

  it("does not read successful fetch or text XHR bodies with non-JSON media types", async () => {
    let cloneCalls = 0;
    const nonJsonResponse = {
      ok: true,
      headers: { get: () => "text/html; charset=utf-8" },
      clone() {
        cloneCalls += 1;
        throw new Error("non-JSON body was cloned");
      },
    } as unknown as Response;
    const originalFetch = (() =>
      Promise.resolve(nonJsonResponse)) as typeof fetch;
    const { target, posted } = createTarget(originalFetch);
    install(target);

    await target.fetch("https://www.threads.com/page");

    const textRequest = new FakeXMLHttpRequest();
    textRequest.status = 200;
    textRequest.responseContentType = "text/plain";
    textRequest.responseText = JSON.stringify({
      id: "515",
      username: "NotJsonMedia",
    });
    textRequest.send();
    textRequest.finish();
    await settleObservers();

    expect(cloneCalls).toBe(0);
    expect(posted).toEqual([]);
  });

  it("observes successful XHR JSON objects and JSON text without changing page flow", () => {
    const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    const { target, posted, emitMessage } = createTarget(originalFetch);
    install(target);
    emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });

    const jsonRequest = new FakeXMLHttpRequest();
    const sendResult = Symbol("send result");
    const requestBody = { ownedByPage: true };
    let pageLoadEvents = 0;
    jsonRequest.status = 200;
    jsonRequest.responseType = "json";
    jsonRequest.response = { id: "606", username: "JsonUser" };
    jsonRequest.sendResult = sendResult;
    jsonRequest.addEventListener("load", () => {
      pageLoadEvents += 1;
    });

    const returned = jsonRequest.send(requestBody);
    jsonRequest.finish();

    const textRequest = new FakeXMLHttpRequest();
    textRequest.status = 204;
    textRequest.responseType = "text";
    textRequest.responseContentType = "APPLICATION/JSON; CHARSET=UTF-8";
    textRequest.responseText = JSON.stringify({
      pk: "707",
      username: "TextUser",
    });
    textRequest.send();
    textRequest.finish();

    expect(returned).toBe(sendResult);
    expect(jsonRequest.sentBodies).toEqual([requestBody]);
    expect(pageLoadEvents).toBe(1);
    expect(posted).toEqual([
      {
        message: {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "jsonuser",
          threadsUserId: "606",
        },
        targetOrigin: "https://www.threads.com",
      },
      {
        message: {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "textuser",
          threadsUserId: "707",
        },
        targetOrigin: "https://www.threads.com",
      },
    ]);
  });

  it("isolates failed, irrelevant, and malformed XHR payloads", () => {
    const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    const { target, posted } = createTarget(originalFetch);
    install(target);

    const failed = new FakeXMLHttpRequest();
    failed.status = 500;
    failed.responseType = "json";
    failed.response = { id: "808", username: "Failed" };
    failed.send();
    failed.finish();

    const irrelevant = new FakeXMLHttpRequest();
    irrelevant.status = 200;
    irrelevant.responseType = "json";
    irrelevant.response = { theme: "dark" };
    irrelevant.send();
    irrelevant.finish();

    const malformed = new FakeXMLHttpRequest();
    malformed.status = 200;
    malformed.responseContentType = "application/json";
    malformed.responseText = "{ malformed";
    malformed.send();

    expect(() => malformed.finish()).not.toThrow();
    expect(posted).toEqual([]);
  });

  it("does not retain an observer when an XHR fails before the instance is reused", () => {
    const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    const { target, posted, emitMessage } = createTarget(originalFetch);
    install(target);
    emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });
    const request = new FakeXMLHttpRequest();

    request.send();
    request.fail();

    request.status = 200;
    request.responseType = "json";
    request.response = { id: "919", username: "Reused" };
    request.send();
    request.finish();

    expect(posted).toEqual([
      {
        message: {
          type: "TPD_IDENTITY_DISCOVERED",
          username: "reused",
          threadsUserId: "919",
        },
        targetOrigin: "https://www.threads.com",
      },
    ]);
  });

  it("preserves synchronous XHR send failures", () => {
    const failure = new Error("send failed");
    class ThrowingXMLHttpRequest extends EventTarget {
      status = 0;
      responseType = "";
      response: unknown = null;
      responseText = "";

      send(): never {
        throw failure;
      }
    }
    const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    const { target } = createTarget(originalFetch, ThrowingXMLHttpRequest);
    install(target);

    const request = new ThrowingXMLHttpRequest();

    expect(() => request.send()).toThrow(failure);
  });

  it("installs once and restores only wrappers it still owns", () => {
    const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    const { target } = createTarget(originalFetch);
    const originalSend = FakeXMLHttpRequest.prototype.send;
    const cleanup = install(target);
    const wrappedFetch = target.fetch;
    const wrappedSend = FakeXMLHttpRequest.prototype.send;

    const secondCleanup = identityObserver.installIdentityObserver(target);

    expect(secondCleanup).toBe(cleanup);
    expect(target.fetch).toBe(wrappedFetch);
    expect(FakeXMLHttpRequest.prototype.send).toBe(wrappedSend);

    cleanup();
    expect(target.fetch).toBe(originalFetch);
    expect(FakeXMLHttpRequest.prototype.send).toBe(originalSend);

    const replacementFetch = (() => Promise.reject(new Error("replacement"))) as typeof fetch;
    const replacementSend = function () {};
    const cleanupReinstalled = install(target);
    target.fetch = replacementFetch;
    FakeXMLHttpRequest.prototype.send = replacementSend;

    cleanupReinstalled();
    expect(target.fetch).toBe(replacementFetch);
    expect(FakeXMLHttpRequest.prototype.send).toBe(replacementSend);

    // FakeXMLHttpRequest is shared across every test in this file; leaving
    // the dummy replacement in place would silently break any later test's
    // XHR send() return value.
    FakeXMLHttpRequest.prototype.send = originalSend;
  });

  it("rolls back fetch when the XHR wrapper cannot be installed", () => {
    class LockedXMLHttpRequest extends EventTarget {
      send(): void {}
    }
    Object.defineProperty(LockedXMLHttpRequest.prototype, "send", {
      writable: false,
    });
    const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    const { target } = createTarget(originalFetch, LockedXMLHttpRequest);

    expect(() => identityObserver.installIdentityObserver(target)).toThrow();
    expect(target.fetch).toBe(originalFetch);
  });

  it("does not issue fetch or XHR requests while installing", () => {
    let fetchCalls = 0;
    let sendCalls = 0;
    class CountingXMLHttpRequest extends EventTarget {
      send(): void {
        sendCalls += 1;
      }
    }
    const originalFetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error("unused"));
    }) as typeof fetch;
    const { target, posted } = createTarget(
      originalFetch,
      CountingXMLHttpRequest,
    );

    install(target);

    expect(fetchCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(posted).toEqual([]);
  });

  describe("global enable gate", () => {
    it("does not observe before any enable signal arrives (defaults to disabled)", async () => {
      const payload = { user: { id: "1", username: "Alice" } };
      let fetchCalls = 0;
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const originalFetch = (() => {
        fetchCalls += 1;
        return Promise.resolve(response);
      }) as typeof fetch;
      const { target, posted } = createTarget(originalFetch);
      install(target);

      const returned = await target.fetch("https://www.threads.com/api/data");
      await settleObservers();

      expect(returned).toBe(response);
      expect(fetchCalls).toBe(1);
      expect(posted).toEqual([]);
    });

    it("cold start with the extension persisted OFF: a response arriving before the settings signal is never observed, even once the OFF signal itself arrives", async () => {
      const payload = { user: { id: "1", username: "Alice" } };
      const originalFetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);

      // The isolated content script hasn't finished loading settings yet,
      // but a network response already arrived - it must not be observed.
      await target.fetch("https://www.threads.com/api/data");
      await settleObservers();

      // The authoritative signal now arrives and confirms the persisted
      // setting was actually OFF.
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false });

      await target.fetch("https://www.threads.com/api/data");
      await settleObservers();

      expect(posted).toEqual([]);
    });

    it("stops cloning/parsing/emitting once disabled, while still returning the real fetch response", async () => {
      const payload = { user: { id: "1", username: "Alice" } };
      let fetchCalls = 0;
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const originalFetch = (() => {
        fetchCalls += 1;
        return Promise.resolve(response);
      }) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false });

      const returned = await target.fetch("https://www.threads.com/api/data");
      await settleObservers();

      expect(returned).toBe(response);
      expect(fetchCalls).toBe(1);
      expect(posted).toEqual([]);
    });

    it("stops observing XHR responses once disabled, without affecting the page's own request", () => {
      const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false });

      const request = new FakeXMLHttpRequest();
      request.status = 200;
      request.responseType = "json";
      request.response = { id: "1", username: "Alice" };
      const sendResult = Symbol("send result");
      request.sendResult = sendResult;

      const returned = request.send();
      request.finish();

      expect(returned).toBe(sendResult);
      expect(posted).toEqual([]);
    });

    it("resumes observing once re-enabled", async () => {
      const payload = { user: { id: "1", username: "Alice" } };
      const originalFetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false });
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });

      await target.fetch("https://www.threads.com/api/data");
      await settleObservers();

      expect(posted).toHaveLength(1);
    });

    it("ignores an enable signal from a foreign origin or a different window", async () => {
      const originalFetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ user: { id: "1", username: "Alice" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });
      // A forged/foreign-origin attempt to flip it back off must be ignored.
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false }, "https://evil.example");

      await target.fetch("https://www.threads.com/api/data");
      await settleObservers();

      expect(posted).toHaveLength(1);
    });

    it("does not emit a deferred JSON parse that resolves after being disabled, even though parsing began while enabled", async () => {
      const deferred = createDeferred<unknown>();
      const response = {
        ok: true,
        headers: { get: () => "application/json" },
        clone: () => ({ json: () => deferred.promise }),
      } as unknown as Response;
      const originalFetch = (() => Promise.resolve(response)) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });

      // Enters inspectFetchResponse and starts the (deferred) .json() parse
      // while still enabled.
      await target.fetch("https://www.threads.com/api/data");

      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false });
      deferred.resolve({ user: { id: "1", username: "Alice" } });
      await settleObservers();

      expect(posted).toEqual([]);
    });

    it("does not emit a deferred JSON parse from a stale enabled epoch, even after a later OFF->ON before it resolves", async () => {
      const deferred = createDeferred<unknown>();
      const response = {
        ok: true,
        headers: { get: () => "application/json" },
        clone: () => ({ json: () => deferred.promise }),
      } as unknown as Response;
      const originalFetch = (() => Promise.resolve(response)) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });

      await target.fetch("https://www.threads.com/api/data");

      // The parse straddles a full OFF -> ON cycle before it resolves - a
      // naive re-check of the live "enabled" boolean alone would wrongly
      // let this stale, pre-OFF parse emit once ON again.
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false });
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });
      deferred.resolve({ user: { id: "1", username: "Alice" } });
      await settleObservers();

      expect(posted).toEqual([]);
    });

    it("still emits a fresh response fetched after a later OFF->ON cycle", async () => {
      const payload = { user: { id: "2", username: "Bob" } };
      const originalFetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )) as typeof fetch;
      const { target, posted, emitMessage } = createTarget(originalFetch);
      install(target);
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: false });
      emitMessage({ type: "TPD_ENABLED_CHANGED", enabled: true });

      await target.fetch("https://www.threads.com/api/data");
      await settleObservers();

      expect(posted).toHaveLength(1);
    });

    it("removes its message listener on cleanup", () => {
      const originalFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
      const { target } = createTarget(originalFetch);
      const removeSpy = vi.spyOn(target, "removeEventListener");
      const cleanup = install(target);

      cleanup();

      expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function));
    });
  });
});
