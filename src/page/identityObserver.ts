import type { IdentityObservation } from "../domain/identity";
import {
  isValidThreadsUserId,
  normalizeThreadsUserId,
  normalizeUsername,
} from "../domain/validation";

const MAX_TRAVERSAL_DEPTH = 12;
const MAX_VISITED_NODES = 2_000;
const installations = new WeakMap<Window, () => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function readOwnProperty(value: object, key: string): unknown {
  try {
    return Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function ownKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function readValidViewUserId(
  definition: Record<string, unknown>,
  viewKey: "rootView" | "hostableView",
): string | undefined {
  const view = readOwnProperty(definition, viewKey);
  if (!isRecord(view)) {
    return undefined;
  }

  const props = readOwnProperty(view, "props");
  if (!isRecord(props)) {
    return undefined;
  }

  const userId = readOwnProperty(props, "user_id");
  return typeof userId === "string" && isValidThreadsUserId(userId)
    ? userId
    : undefined;
}

export function parseBulkRouteDefinitions(
  payload: unknown,
  observedAt: string,
): IdentityObservation[] {
  if (!isRecord(payload)) {
    return [];
  }

  const payloads = readOwnProperty(payload, "payloads");
  if (!isRecord(payloads)) {
    return [];
  }

  const seenPairs = new Map<string, Set<string>>();

  return ownKeys(payloads).flatMap((routeKey) => {
    const routeMatch = /^\/@([^/]+)$/.exec(routeKey);
    if (!routeMatch) {
      return [];
    }

    const definition = readOwnProperty(payloads, routeKey);
    if (!isRecord(definition)) {
      return [];
    }

    const userId =
      readValidViewUserId(definition, "rootView") ??
      readValidViewUserId(definition, "hostableView");

    if (!userId) {
      return [];
    }

    let username: string;
    try {
      username = normalizeUsername(routeMatch[1]);
    } catch {
      return [];
    }

    const idsForUsername = seenPairs.get(username) ?? new Set<string>();
    if (idsForUsername.has(userId)) {
      return [];
    }
    idsForUsername.add(userId);
    seenPairs.set(username, idsForUsername);

    return [{
      username,
      threadsUserId: normalizeThreadsUserId(userId),
      source: "network" as const,
      observedAt,
    }];
  });
}

export function parseKnownUserObjects(
  payload: unknown,
  observedAt: string,
): IdentityObservation[] {
  const observations: IdentityObservation[] = [];
  const seen = new WeakSet<object>();
  const seenPairs = new Map<string, Set<string>>();
  let visitedNodes = 0;

  function visit(value: unknown, depth = 0): void {
    if (
      typeof value === "object" &&
      value !== null &&
      seen.has(value)
    ) {
      return;
    }
    if (visitedNodes >= MAX_VISITED_NODES) {
      return;
    }
    visitedNodes += 1;

    if (typeof value !== "object" || value === null) {
      return;
    }
    seen.add(value);

    if (isRecord(value)) {
      const usernameValue = readOwnProperty(value, "username");
      const id = readOwnProperty(value, "id");
      const pk = readOwnProperty(value, "pk");
      const userId =
        typeof id === "string" && isValidThreadsUserId(id)
          ? id
          : typeof pk === "string" && isValidThreadsUserId(pk)
            ? pk
            : undefined;
      if (typeof usernameValue === "string" && userId) {
        try {
          const username = normalizeUsername(usernameValue);
          const idsForUsername = seenPairs.get(username) ?? new Set<string>();
          if (!idsForUsername.has(userId)) {
            idsForUsername.add(userId);
            seenPairs.set(username, idsForUsername);

            observations.push({
              username,
              threadsUserId: normalizeThreadsUserId(userId),
              source: "network",
              observedAt,
            });
          }
        } catch {
          // Ignore malformed candidate objects and continue traversal.
        }
      }
    }

    if (depth < MAX_TRAVERSAL_DEPTH) {
      for (const key of ownKeys(value)) {
        if (visitedNodes >= MAX_VISITED_NODES) {
          break;
        }
        visit(readOwnProperty(value, key), depth + 1);
      }
    }
  }

  visit(payload);
  return observations;
}

export function emitIdentityDiscoveries(
  payload: unknown,
  target: Window = window,
): void {
  const observedAt = new Date().toISOString();
  const observations: IdentityObservation[] = [];

  try {
    observations.push(...parseBulkRouteDefinitions(payload, observedAt));
  } catch {
    // A malformed page payload must not affect Threads.
  }
  try {
    observations.push(...parseKnownUserObjects(payload, observedAt));
  } catch {
    // A malformed page payload must not affect Threads.
  }

  const seen = new Set<string>();
  for (const { username, threadsUserId } of observations) {
    if (!threadsUserId) {
      continue;
    }

    const key = `${username}\0${threadsUserId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    try {
      target.postMessage(
        { type: "TPD_IDENTITY_DISCOVERED", username, threadsUserId },
        target.location.origin,
      );
    } catch {
      // Posting observations is best-effort and must not affect Threads.
    }
  }
}

function inspectFetchResponse(
  response: Response,
  target: Window,
  isStillCurrent: () => boolean,
): void {
  try {
    if (
      !response.ok ||
      !isJsonMediaType(response.headers.get("content-type"))
    ) {
      return;
    }

    void response.clone().json().then(
      (payload) => {
        if (isStillCurrent()) emitIdentityDiscoveries(payload, target);
      },
      () => {},
    );
  } catch {
    // Reading observations is best-effort and must not affect Threads.
  }
}

function isJsonMediaType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0].trim() ?? "";
  return /^application\/(?:json|[^/\s;]+\+json)$/i.test(mediaType);
}

function inspectXhrResponse(request: XMLHttpRequest, target: Window): void {
  try {
    if (request.status < 200 || request.status >= 300) {
      return;
    }

    if (request.responseType === "json") {
      emitIdentityDiscoveries(request.response, target);
      return;
    }

    if (
      (request.responseType === "" || request.responseType === "text") &&
      isJsonMediaType(request.getResponseHeader("content-type"))
    ) {
      emitIdentityDiscoveries(JSON.parse(request.responseText), target);
    }
  } catch {
    // Reading observations is best-effort and must not affect Threads.
  }
}

const ENABLED_MESSAGE_TYPE = "TPD_ENABLED_CHANGED";

function readEnabledSignal(data: unknown): boolean | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  const type = readOwnProperty(data, "type");
  const enabled = readOwnProperty(data, "enabled");
  return type === ENABLED_MESSAGE_TYPE && typeof enabled === "boolean" ? enabled : null;
}

export function installIdentityObserver(target: Window = window): () => void {
  const existingCleanup = installations.get(target);
  if (existingCleanup) {
    return existingCleanup;
  }

  // The isolated content script owns chrome.storage and only reads it at
  // document_idle, well after this MAIN-world script runs at document_start.
  // Starting "enabled" would let early network responses be cloned/parsed
  // while a persisted-OFF setting hasn't been reported yet, so this must
  // fail closed until the authoritative signal arrives.
  let enabled = false;
  // Bumped every time `enabled` actually changes, so an in-flight async
  // JSON parse can tell it belongs to a stale enabled epoch even if the
  // live boolean happens to read the same way again later (e.g. a full
  // OFF -> ON cycle completing before that parse resolves).
  let revision = 0;
  const onMessage = (event: MessageEvent<unknown>) => {
    try {
      if (event.source !== target || event.origin !== target.location.origin) {
        return;
      }
      const signal = readEnabledSignal(event.data);
      if (signal !== null && signal !== enabled) {
        enabled = signal;
        revision += 1;
      }
    } catch {
      // Observation must not affect Threads.
    }
  };
  target.addEventListener("message", onMessage);

  const originalFetch = target.fetch;
  const xhrPrototype = (
    target as Window & { XMLHttpRequest: typeof XMLHttpRequest }
  ).XMLHttpRequest.prototype;
  const originalSend = xhrPrototype.send;

  const wrappedFetch = function (
    this: Window,
    ...args: Parameters<typeof fetch>
  ): ReturnType<typeof fetch> {
    const result = Reflect.apply(originalFetch, this, args);
    try {
      void result.then(
        (response) => {
          if (!enabled) return;
          const startRevision = revision;
          inspectFetchResponse(response, target, () => enabled && revision === startRevision);
        },
        () => {},
      );
    } catch {
      // Observation must not alter the page's fetch result.
    }
    return result;
  } as typeof fetch;

  const wrappedSend = function (
    this: XMLHttpRequest,
    ...args: Parameters<XMLHttpRequest["send"]>
  ) {
    const observe = () => {
      if (enabled) inspectXhrResponse(this, target);
    };
    let listening = false;
    try {
      this.addEventListener("loadend", observe, { once: true });
      listening = true;
    } catch {
      // Continue with the page's request even if observation cannot attach.
    }

    try {
      return Reflect.apply(originalSend, this, args);
    } catch (error) {
      if (listening) {
        try {
          this.removeEventListener("loadend", observe);
        } catch {
          // Preserve the original send failure.
        }
      }
      throw error;
    }
  } as XMLHttpRequest["send"];

  target.fetch = wrappedFetch;
  try {
    xhrPrototype.send = wrappedSend;
  } catch (error) {
    target.removeEventListener("message", onMessage);
    if (target.fetch === wrappedFetch) {
      target.fetch = originalFetch;
    }
    throw error;
  }

  let active = true;
  const cleanup = () => {
    if (!active) {
      return;
    }
    active = false;

    target.removeEventListener("message", onMessage);
    if (target.fetch === wrappedFetch) {
      target.fetch = originalFetch;
    }
    if (xhrPrototype.send === wrappedSend) {
      xhrPrototype.send = originalSend;
    }
    if (installations.get(target) === cleanup) {
      installations.delete(target);
    }
  };

  installations.set(target, cleanup);
  return cleanup;
}

if (
  typeof window !== "undefined" &&
  window.location.hostname === "www.threads.com"
) {
  try {
    installIdentityObserver(window);
  } catch {
    // Failure to observe must not affect Threads page startup.
  }
}
