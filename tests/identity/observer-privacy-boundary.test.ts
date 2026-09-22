import { afterEach, describe, expect, it, vi } from "vitest";

import { installIdentityObserver } from "../../src/page/identityObserver";

/**
 * What the page observer may take from Threads (Phase 4 Task 46; threat T10). The privacy statements say it "keeps only pairs of a
 * username and its numeric ID", reads no cookie and no page storage, reads no request header or body, and no response header but the
 * content type. Types do not prove that, and a parser that walks arbitrary JSON is exactly where a token could be picked up by
 * accident. So this runs the real observer over a response that is full of bait, on both of the ways a page can fetch, and looks
 * at everything that crosses the boundary: what it posts, and which properties of the request and the response it touched.
 */
const ORIGIN = "https://www.threads.com";
const PROBES = ["TOKEN_PROBE", "DTSG_PROBE", "SESSION_PROBE", "CSRF_PROBE", "COOKIE_PROBE", "EMAIL_PROBE", "PHONE_PROBE", "BIO_PROBE", "NOTE_PROBE", "PIC_PROBE", "HEADER_PROBE", "AUTH_PROBE", "BODY_PROBE", "LSD_PROBE"];

/** A response shaped like Threads' own, with the identity pairs the observer is there for, and everything else it must leave alone. */
const BAIT = {
  data: {
    viewer: { username: "Alice_Probe", id: "1001", access_token: "TOKEN_PROBE", fb_dtsg: "DTSG_PROBE", sessionid: "SESSION_PROBE", email: "EMAIL_PROBE@example.com", phone: "PHONE_PROBE" },
    users: [
      { username: "bob_probe", pk: "1002", profile_pic_url: "https://example.com/PIC_PROBE.png", biography: "BIO_PROBE", private_note: "NOTE_PROBE" },
      { username: "carol_probe", note: "no id at all, so no pair" },
      { id: "1003", access_token: "TOKEN_PROBE", note: "an id and no username, so no pair" },
      { username: "dave_probe", id: "not-a-number-TOKEN_PROBE" },
    ],
  },
  extensions: { csrf: "CSRF_PROBE", lsd: "LSD_PROBE", cookie: "COOKIE_PROBE" },
};

interface Posted {
  message: unknown;
  targetOrigin: string;
}

class SpiedXMLHttpRequest extends EventTarget {
  status = 200;
  responseType = "";
  response: unknown = null;
  responseText = JSON.stringify(BAIT);
  readonly headerNamesAsked: string[] = [];
  readonly otherCalls: string[] = [];

  send(): void {}

  getResponseHeader(name: string): string | null {
    this.headerNamesAsked.push(name);
    return name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : "HEADER_PROBE";
  }

  getAllResponseHeaders(): string {
    this.otherCalls.push("getAllResponseHeaders");
    return "x-token: HEADER_PROBE";
  }

  finish(): void {
    this.dispatchEvent(new Event("loadend"));
  }
}

function createTarget(fetchImplementation: typeof fetch) {
  const posted: Posted[] = [];
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const target = {
    fetch: fetchImplementation,
    XMLHttpRequest: SpiedXMLHttpRequest,
    location: { hostname: "www.threads.com", origin: ORIGIN },
    postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }),
    addEventListener: (type: string, listener: (event: MessageEvent<unknown>) => void) => void (type === "message" && listeners.add(listener)),
    removeEventListener: (type: string, listener: (event: MessageEvent<unknown>) => void) => void (type === "message" && listeners.delete(listener)),
  } as unknown as Window;
  const enable = () => {
    const event = { data: { type: "TPD_ENABLED_CHANGED", enabled: true }, origin: ORIGIN, source: target } as unknown as MessageEvent<unknown>;
    for (const listener of [...listeners]) listener(event);
  };
  return { target, posted, enable };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.restoreAllMocks();
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Records every property read on `value`, and hands back a proxy that behaves as it does. */
function spy<T extends object>(value: T, touched: string[], wrap: Partial<Record<string, (inner: unknown) => unknown>> = {}): T {
  return new Proxy(value, {
    get(target, property) {
      const name = typeof property === "symbol" ? property.toString() : property;
      touched.push(name);
      const inner = Reflect.get(target, property, target);
      if (wrap[name]) return wrap[name](inner);
      return typeof inner === "function" ? inner.bind(target) : inner;
    },
  });
}

let cookieReads = 0;
let storageReads = 0;
function watchCookiesAndStorage(): void {
  cookieReads = 0;
  storageReads = 0;
  Object.defineProperty(document, "cookie", { configurable: true, get: () => ((cookieReads += 1), ""), set: () => {} });
  for (const name of ["getItem", "setItem", "key", "length"] as const) {
    if (name === "length") continue;
    vi.spyOn(Storage.prototype, name).mockImplementation(() => ((storageReads += 1), null));
  }
}

function expectOnlyThePairs(posted: Posted[]): void {
  expect(posted.every((entry) => entry.targetOrigin === ORIGIN)).toBe(true);
  expect(
    posted.map((entry) => entry.message),
    "exactly the two pairs that have both a username and a numeric ID, with exactly these fields",
  ).toEqual([
    { type: "TPD_IDENTITY_DISCOVERED", username: "alice_probe", threadsUserId: "1001" },
    { type: "TPD_IDENTITY_DISCOVERED", username: "bob_probe", threadsUserId: "1002" },
  ]);
  const everything = JSON.stringify(posted);
  for (const probe of PROBES) expect(everything, `${probe} left the observer`).not.toContain(probe);
}

describe("the page observer over a response full of bait", () => {
  it("(control) does post the two pairs it is there for, with the exact fields, so that the absence of the rest means something", async () => {
    watchCookiesAndStorage();
    const { target, posted, enable } = createTarget((async () => new Response(JSON.stringify(BAIT), { headers: { "content-type": "application/json" } })) as typeof fetch);
    cleanups.push(installIdentityObserver(target));
    enable();

    await target.fetch("https://www.threads.com/api/graphql");
    await settle();

    expectOnlyThePairs(posted);
  });

  it("through fetch: posts only the pairs, asks the response for nothing but its status and its content type, and never looks at the request", async () => {
    watchCookiesAndStorage();
    const responseTouched: string[] = [];
    const headersAsked: string[] = [];
    const requestTouched: string[] = [];
    const realFetch = (async () => {
      const response = new Response(JSON.stringify(BAIT), { headers: { "content-type": "application/json", "x-token": "HEADER_PROBE" } });
      return spy(response, responseTouched, {
        headers: (headers) =>
          new Proxy(headers as Headers, {
            get(target, property) {
              if (property === "get") return (name: string) => (headersAsked.push(name), target.get(name));
              headersAsked.push(`(${String(property)})`);
              const inner = Reflect.get(target, property, target);
              return typeof inner === "function" ? inner.bind(target) : inner;
            },
          }),
      });
    }) as unknown as typeof fetch;
    const { target, posted, enable } = createTarget(realFetch);
    cleanups.push(installIdentityObserver(target));
    enable();
    const request = spy({ url: "https://www.threads.com/api/graphql", method: "POST", headers: { authorization: "Bearer AUTH_PROBE", "x-csrftoken": "CSRF_PROBE" }, body: "BODY_PROBE" }, requestTouched);

    await target.fetch(request as unknown as RequestInfo);
    await settle();

    expectOnlyThePairs(posted);
    expect(requestTouched, "the request the page made is passed on, and not read").toEqual([]);
    expect(headersAsked, "the response's headers: the content type, and nothing else").toEqual(["content-type"]);
    // "then" is the engine asking whether the value a promise resolves to is itself a promise; it is not the observer.
    expect([...new Set(responseTouched)].filter((name) => name !== "then").sort(), "the response's own properties: its status and its headers, and a clone to read the body from").toEqual(["clone", "headers", "ok"]);
    expect(cookieReads, "no cookie was read").toBe(0);
    expect(storageReads, "no page storage was read or written").toBe(0);
  });

  it("through XMLHttpRequest: posts only the pairs, asks for the content type and no other header, and reads no cookie or storage", () => {
    watchCookiesAndStorage();
    const { target, posted, enable } = createTarget((async () => new Response("")) as typeof fetch);
    cleanups.push(installIdentityObserver(target));
    enable();

    const xhr = new (target as unknown as { XMLHttpRequest: typeof SpiedXMLHttpRequest }).XMLHttpRequest();
    xhr.send();
    xhr.finish();

    expectOnlyThePairs(posted);
    expect(xhr.headerNamesAsked, "the response header names it asked for").toEqual(["content-type"]);
    expect(xhr.otherCalls, "no other way of reading the response's headers").toEqual([]);
    expect(cookieReads).toBe(0);
    expect(storageReads).toBe(0);
  });

  it("leaves the page's own fetch result and its request exactly as they were", async () => {
    let seen: unknown;
    const original = (async (input: unknown) => ((seen = input), new Response("{}", { headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;
    const { target, enable } = createTarget(original);
    cleanups.push(installIdentityObserver(target));
    enable();
    const request = { url: "https://www.threads.com/x" };

    const response = await target.fetch(request as unknown as RequestInfo);

    expect(seen, "the very object the page passed").toBe(request);
    expect(await response.json()).toEqual({});
  });
});
