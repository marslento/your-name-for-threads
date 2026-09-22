import { describe, expect, it } from "vitest";

import {
  parseBulkRouteDefinitions,
  parseKnownUserObjects,
} from "../../src/page/identityObserver";
import bulkRouteDefinitions from "../fixtures/threads/bulk-route-definitions.json";

const observedAt = "2026-09-11T01:02:03.000Z";

describe("parseBulkRouteDefinitions", () => {
  it("maps a profile route to its root-view user ID", () => {
    const rootRoute = bulkRouteDefinitions.payloads["/@RootUser"];

    expect(
      parseBulkRouteDefinitions(
        { payloads: { "/@RootUser": rootRoute } },
        observedAt,
      ),
    ).toEqual([
      {
        username: "rootuser",
        threadsUserId: "10001",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("maps a profile route to its hostable-view user ID", () => {
    const hostableRoute = bulkRouteDefinitions.payloads["/@HostUser"];

    expect(
      parseBulkRouteDefinitions(
        { payloads: { "/@HostUser": hostableRoute } },
        observedAt,
      ),
    ).toEqual([
      {
        username: "hostuser",
        threadsUserId: "20002",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("falls back to a valid hostable-view ID when the root-view ID is invalid", () => {
    expect(
      parseBulkRouteDefinitions(
        {
          payloads: {
            "/@Fallback": {
              rootView: { props: { user_id: "invalid" } },
              hostableView: { props: { user_id: "21212" } },
            },
          },
        },
        observedAt,
      ),
    ).toEqual([
      {
        username: "fallback",
        threadsUserId: "21212",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("prefers a valid root-view ID over a valid hostable-view ID", () => {
    expect(
      parseBulkRouteDefinitions(
        {
          payloads: {
            "/@Priority": {
              rootView: { props: { user_id: "31313" } },
              hostableView: { props: { user_id: "41414" } },
            },
          },
        },
        observedAt,
      ),
    ).toEqual([
      {
        username: "priority",
        threadsUserId: "31313",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("rejects non-string and non-ASCII-digit user IDs", () => {
    expect(
      parseBulkRouteDefinitions(
        {
          payloads: {
            "/@number": { rootView: { props: { user_id: 123 } } },
            "/@unicode": { rootView: { props: { user_id: "１２３" } } },
            "/@valid": { rootView: { props: { user_id: "0123" } } },
          },
        },
        observedAt,
      ),
    ).toEqual([
      {
        username: "valid",
        threadsUserId: "0123",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("rejects an empty normalized route username", () => {
    expect(
      parseBulkRouteDefinitions(
        {
          payloads: {
            "/@": { rootView: { props: { user_id: "111" } } },
            "/@StillValid": { rootView: { props: { user_id: "222" } } },
          },
        },
        observedAt,
      ),
    ).toEqual([
      {
        username: "stillvalid",
        threadsUserId: "222",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("recognizes only exact profile route keys", () => {
    const definition = { rootView: { props: { user_id: "123" } } };

    expect(
      parseBulkRouteDefinitions(
        {
          payloads: {
            "@missing-slash": definition,
            "/@nested/replies": definition,
            "/@Exact": definition,
          },
        },
        observedAt,
      ),
    ).toEqual([
      {
        username: "exact",
        threadsUserId: "123",
        source: "network",
        observedAt,
      },
    ]);
  });

  it.each([undefined, null, false, 42, "payload", [], {}, { payloads: null }])(
    "returns an empty result for malformed payload %j",
    (payload) => {
      expect(() => parseBulkRouteDefinitions(payload, observedAt)).not.toThrow();
      expect(parseBulkRouteDefinitions(payload, observedAt)).toEqual([]);
    },
  );

  it("skips malformed route definitions without losing later observations", () => {
    expect(
      parseBulkRouteDefinitions(
        {
          payloads: {
            "/@null": null,
            "/@missing-view": {},
            "/@missing-props": { rootView: {} },
            "/@Valid": { hostableView: { props: { user_id: "909" } } },
          },
        },
        observedAt,
      ),
    ).toEqual([
      {
        username: "valid",
        threadsUserId: "909",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("deduplicates normalized identity pairs in encounter order", () => {
    expect(
      parseBulkRouteDefinitions(
        {
          payloads: {
            "/@Alice": { rootView: { props: { user_id: "111" } } },
            "/@alice": { hostableView: { props: { user_id: "111" } } },
            "/@Bob": { rootView: { props: { user_id: "222" } } },
          },
        },
        observedAt,
      ),
    ).toEqual([
      {
        username: "alice",
        threadsUserId: "111",
        source: "network",
        observedAt,
      },
      {
        username: "bob",
        threadsUserId: "222",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("ignores a throwing route property and continues deterministically", () => {
    const payloads: Record<string, unknown> = {};
    Object.defineProperty(payloads, "/@Broken", {
      enumerable: true,
      get() {
        throw new Error("malformed route accessor");
      },
    });
    payloads["/@Valid"] = { rootView: { props: { user_id: "404" } } };

    expect(() =>
      parseBulkRouteDefinitions({ payloads }, observedAt)
    ).not.toThrow();
    expect(parseBulkRouteDefinitions({ payloads }, observedAt)).toEqual([
      {
        username: "valid",
        threadsUserId: "404",
        source: "network",
        observedAt,
      },
    ]);
  });
});

describe("parseKnownUserObjects", () => {
  it("maps an id-and-username object", () => {
    expect(
      parseKnownUserObjects({ id: "30003", username: "  @Alice  " }, observedAt),
    ).toEqual([
      {
        username: "alice",
        threadsUserId: "30003",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("maps a pk-and-username object", () => {
    expect(parseKnownUserObjects({ pk: "40004", username: "Bob" }, observedAt)).toEqual([
      {
        username: "bob",
        threadsUserId: "40004",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("falls back to a valid pk when id is invalid", () => {
    expect(
      parseKnownUserObjects(
        { id: "invalid", pk: "41004", username: "FallbackPk" },
        observedAt,
      ),
    ).toEqual([
      {
        username: "fallbackpk",
        threadsUserId: "41004",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("maps the named nested-user shape", () => {
    expect(
      parseKnownUserObjects(
        { user: { pk: "50005", username: "NestedUser" } },
        observedAt,
      ),
    ).toEqual([
      {
        username: "nesteduser",
        threadsUserId: "50005",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("discovers a known user object below the payload root", () => {
    expect(
      parseKnownUserObjects(
        { data: { edges: [{ node: { id: "60006", username: "DeepUser" } }] } },
        observedAt,
      ),
    ).toEqual([
      {
        username: "deepuser",
        threadsUserId: "60006",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("skips malformed candidates without losing later observations", () => {
    expect(() =>
      parseKnownUserObjects(
        [
          { id: 123, username: "number-id" },
          { id: "１２３", username: "unicode-id" },
          { id: "70007", username: "  @  " },
          { pk: "80008", username: "ValidUser" },
        ],
        observedAt,
      )
    ).not.toThrow();

    expect(
      parseKnownUserObjects(
        [
          { id: 123, username: "number-id" },
          { id: "１２３", username: "unicode-id" },
          { id: "70007", username: "  @  " },
          { pk: "80008", username: "ValidUser" },
        ],
        observedAt,
      ),
    ).toEqual([
      {
        username: "validuser",
        threadsUserId: "80008",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("handles cyclic object graphs without throwing", () => {
    const cyclic: Record<string, unknown> = {
      user: { id: "90009", username: "CycleUser" },
    };
    cyclic.self = cyclic;

    expect(() => parseKnownUserObjects(cyclic, observedAt)).not.toThrow();
    expect(parseKnownUserObjects(cyclic, observedAt)).toEqual([
      {
        username: "cycleuser",
        threadsUserId: "90009",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("visits depth 12 but does not visit depth 13", () => {
    const payload: Record<string, unknown> = {};
    let cursor = payload;

    for (let depth = 0; depth < 12; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    Object.assign(cursor, { id: "1200", username: "AtLimit" });
    cursor.next = { id: "1300", username: "PastLimit" };

    expect(parseKnownUserObjects(payload, observedAt)).toEqual([
      {
        username: "atlimit",
        threadsUserId: "1200",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("stops after the 2,000-node traversal budget", () => {
    const payload = Array.from({ length: 2_001 }, () => ({})) as Array<
      Record<string, unknown>
    >;
    payload[0] = { id: "101", username: "Early" };
    payload[2_000] = { id: "202", username: "PastBudget" };

    expect(parseKnownUserObjects(payload, observedAt)).toEqual([
      {
        username: "early",
        threadsUserId: "101",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("counts primitive values toward the 2,000-node budget", () => {
    const payload: Record<string, unknown> = {};
    for (let index = 0; index < 2_000; index += 1) {
      payload[`primitive-${index}`] = index;
    }
    payload.afterBudget = { id: "505", username: "TooLate" };

    expect(parseKnownUserObjects(payload, observedAt)).toEqual([]);
  });

  it("deduplicates normalized identity pairs in traversal order", () => {
    expect(
      parseKnownUserObjects(
        [
          { id: "111", username: "First" },
          { user: { pk: "111", username: "@first" } },
          { pk: "222", username: "Second" },
        ],
        observedAt,
      ),
    ).toEqual([
      {
        username: "first",
        threadsUserId: "111",
        source: "network",
        observedAt,
      },
      {
        username: "second",
        threadsUserId: "222",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("continues through children of a duplicate candidate", () => {
    expect(
      parseKnownUserObjects(
        [
          { id: "111", username: "Parent" },
          {
            pk: "111",
            username: "@parent",
            child: { id: "222", username: "Child" },
          },
        ],
        observedAt,
      ),
    ).toEqual([
      {
        username: "parent",
        threadsUserId: "111",
        source: "network",
        observedAt,
      },
      {
        username: "child",
        threadsUserId: "222",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("ignores throwing properties and continues deterministically", () => {
    const payload: Record<string, unknown> = {
      valid: { id: "303", username: "AfterGetter" },
    };
    Object.defineProperty(payload, "id", {
      enumerable: true,
      get() {
        throw new Error("malformed accessor");
      },
    });

    expect(() => parseKnownUserObjects(payload, observedAt)).not.toThrow();
    expect(parseKnownUserObjects(payload, observedAt)).toEqual([
      {
        username: "aftergetter",
        threadsUserId: "303",
        source: "network",
        observedAt,
      },
    ]);
  });

  it("does not treat inherited fields as a known user shape", () => {
    const inherited = Object.create({ id: "606", username: "PrototypeUser" });

    expect(parseKnownUserObjects(inherited, observedAt)).toEqual([]);
  });
});
