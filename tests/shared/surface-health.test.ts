import { describe, expect, it, vi } from "vitest";

import {
  READY_SURFACES,
  SURFACES,
  SurfaceHealthTracker,
  anyDegraded,
  isSurfaceHealth,
  isSurfaceName,
  parseSurfaceHealth,
  surfaceHealth,
  worstOf,
} from "../../src/shared/surfaceHealth";

/**
 * The surface health model (Phase 4 Task 21). Two things matter: the surfaces are independent, and nothing
 * but a closed-set name and a closed-set state can pass through it, because a snapshot is sent between
 * contexts, held in session storage and copied into public bug reports.
 */
const snapshot = (profile: "ready" | "degraded", postAuthor: "ready" | "degraded") => ({ profile, "post-author": postAuthor }) as const;

describe("the closed sets", () => {
  it("has exactly the two surfaces the plan names, each ready or degraded", () => {
    expect([...SURFACES]).toEqual(["profile", "post-author"]);
    expect(READY_SURFACES).toEqual(snapshot("ready", "ready"));
    expect(isSurfaceName("profile")).toBe(true);
    expect(isSurfaceName("feed")).toBe(false);
    expect(isSurfaceName(undefined)).toBe(false);
    expect(isSurfaceHealth("degraded")).toBe(true);
    expect(isSurfaceHealth("broken")).toBe(false);
  });
});

describe("SurfaceHealthTracker", () => {
  it("starts with every surface ready", () => {
    expect(new SurfaceHealthTracker().snapshot()).toEqual(snapshot("ready", "ready"));
  });

  it("keeps the surfaces independent: degrading one leaves the other ready, in both directions", () => {
    const profile = new SurfaceHealthTracker();
    const feed = new SurfaceHealthTracker();

    profile.report("profile", "degraded");
    feed.report("post-author", "degraded");

    expect(profile.snapshot()).toEqual(snapshot("degraded", "ready"));
    expect(feed.snapshot()).toEqual(snapshot("ready", "degraded"));
  });

  it("restores a surface without touching the other", () => {
    const tracker = new SurfaceHealthTracker();
    tracker.report("profile", "degraded");
    tracker.report("post-author", "degraded");

    tracker.report("profile", "ready");

    expect(tracker.snapshot()).toEqual(snapshot("ready", "degraded"));
  });

  it("ignores a surface it does not know, so the set cannot grow by someone reporting a name", () => {
    const tracker = new SurfaceHealthTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);

    tracker.report("feed", "degraded");
    tracker.report("__proto__", "degraded");
    tracker.report("constructor", "degraded");

    expect(tracker.snapshot()).toEqual(snapshot("ready", "ready"));
    expect(Object.keys(tracker.snapshot())).toEqual(["profile", "post-author"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("says nothing when a report changes nothing, so a surface that fails on every mutation is not a stream of messages", () => {
    const tracker = new SurfaceHealthTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);

    tracker.report("profile", "ready");
    tracker.report("profile", "degraded");
    for (let i = 0; i < 50; i += 1) tracker.report("profile", "degraded");
    tracker.report("profile", "ready");
    tracker.report("profile", "ready");

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("hands out a snapshot that cannot be changed from outside", () => {
    const tracker = new SurfaceHealthTracker();
    tracker.report("profile", "degraded");
    const held = tracker.snapshot();

    expect(Object.isFrozen(held)).toBe(true);
    expect(() => {
      (held as { profile: string }).profile = "ready";
    }).toThrow();
    tracker.report("profile", "ready");
    expect(held.profile).toBe("degraded"); // what was handed out is a moment, not a live view
  });

  it("does not let a throwing listener stop the others, or stop the change", () => {
    const tracker = new SurfaceHealthTracker();
    const heard = vi.fn();
    tracker.subscribe(() => {
      throw new Error("bad listener");
    });
    tracker.subscribe(heard);

    tracker.report("profile", "degraded");

    expect(heard).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot().profile).toBe("degraded");
  });

  it("stops telling a listener once it unsubscribes", () => {
    const tracker = new SurfaceHealthTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);

    unsubscribe();
    tracker.report("profile", "degraded");

    expect(listener).not.toHaveBeenCalled();
  });

  it("can be put back to all ready without telling anyone", () => {
    const tracker = new SurfaceHealthTracker();
    tracker.report("profile", "degraded");
    const listener = vi.fn();
    tracker.subscribe(listener);

    tracker.reset();

    expect(tracker.snapshot()).toEqual(snapshot("ready", "ready"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("shares one tracker per page", () => {
    surfaceHealth.reset();
    surfaceHealth.report("post-author", "degraded");

    expect(surfaceHealth.snapshot()).toEqual(snapshot("ready", "degraded"));
    surfaceHealth.reset();
  });
});

describe("parseSurfaceHealth: what crosses a message or session storage is rebuilt, not trusted", () => {
  it("accepts a well-formed snapshot", () => {
    expect(parseSurfaceHealth(snapshot("degraded", "ready"))).toEqual(snapshot("degraded", "ready"));
  });

  it("rebuilds from the two known surfaces alone, dropping anything else it carried", () => {
    const parsed = parseSurfaceHealth({ ...snapshot("ready", "ready"), url: "https://www.threads.com/@alice_handle", username: "alice_handle", note: "secret" });

    expect(parsed).toEqual(snapshot("ready", "ready"));
    expect(JSON.stringify(parsed)).not.toMatch(/alice_handle|secret|threads\.com/);
    expect(Object.keys(parsed!)).toEqual(["profile", "post-author"]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "profile=ready"],
    ["a number", 1],
    ["an array", ["ready", "ready"]],
    ["an empty object", {}],
    ["a missing surface", { profile: "ready" }],
    ["an unknown state", { profile: "ready", "post-author": "broken" }],
    ["a state that is not a string", { profile: "ready", "post-author": 1 }],
    ["a state of a different case", { profile: "READY", "post-author": "ready" }],
  ])("drops the whole report for %s", (_name, value) => {
    expect(parseSurfaceHealth(value)).toBeUndefined();
  });

  it("does not read an inherited or accessor property as a state", () => {
    const inherited = Object.create({ profile: "ready", "post-author": "ready" });
    const accessor = { profile: "ready", get "post-author"() { return "ready"; } };

    expect(parseSurfaceHealth(inherited)).toBeUndefined();
    expect(parseSurfaceHealth(accessor)).toBeUndefined();
  });

  it("returns a frozen snapshot", () => {
    expect(Object.isFrozen(parseSurfaceHealth(snapshot("ready", "ready")))).toBe(true);
  });
});

describe("anyDegraded and worstOf", () => {
  it("anyDegraded is true if either surface is, and false for none or nothing", () => {
    expect(anyDegraded(snapshot("ready", "ready"))).toBe(false);
    expect(anyDegraded(snapshot("degraded", "ready"))).toBe(true);
    expect(anyDegraded(snapshot("ready", "degraded"))).toBe(true);
    expect(anyDegraded(undefined)).toBe(false);
  });

  it("worstOf is degraded, per surface, wherever any snapshot is", () => {
    expect(worstOf([snapshot("ready", "ready"), snapshot("degraded", "ready"), snapshot("ready", "degraded")])).toEqual(snapshot("degraded", "degraded"));
    expect(worstOf([snapshot("ready", "ready"), snapshot("ready", "ready")])).toEqual(snapshot("ready", "ready"));
    expect(worstOf([snapshot("degraded", "ready")])).toEqual(snapshot("degraded", "ready"));
  });

  it("worstOf has nothing to say about no snapshots", () => {
    expect(worstOf([])).toBeUndefined();
  });
});
