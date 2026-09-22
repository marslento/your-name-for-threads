import { afterEach, describe, expect, it } from "vitest";

import {
  MountRegistry,
  type SurfaceMount,
} from "../../src/content/runtime/MountRegistry";

function connectedHost(tagName = "div"): HTMLElement {
  const host = document.createElement(tagName);
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("MountRegistry", () => {
  it("reuses one connected mount without calling the duplicate factory", () => {
    const registry = new MountRegistry();
    const host = connectedHost();
    let createCount = 0;
    const create = () => {
      createCount += 1;
      return () => {};
    };

    const first = registry.getOrCreate({
      key: "card:alpha",
      surface: "card",
      host,
      create,
    });
    const duplicate = registry.getOrCreate({
      key: "card:alpha",
      surface: "card",
      host,
      create,
    });

    expect(duplicate).toBe(first);
    expect(registry.get("card:alpha")).toBe(first);
    expect(createCount).toBe(1);
  });

  it("suppresses a different-host duplicate while the original is connected", () => {
    const registry = new MountRegistry();
    const originalHost = connectedHost("article");
    const duplicateHost = connectedHost("aside");
    let duplicateCreateCount = 0;
    const original = registry.getOrCreate({
      key: "tile:alpha",
      surface: "tile",
      host: originalHost,
      create: () => () => {},
    });

    const duplicate = registry.getOrCreate({
      key: "tile:alpha",
      surface: "tile",
      host: duplicateHost,
      create: () => {
        duplicateCreateCount += 1;
        return () => {};
      },
    });

    expect(duplicate).toBe(original);
    expect(duplicate.host).toBe(originalHost);
    expect(duplicateCreateCount).toBe(0);
  });

  it("unmounts a detached same-key mount before creating its replacement", () => {
    const registry = new MountRegistry();
    const staleHost = connectedHost();
    const events: string[] = [];
    const stale = registry.getOrCreate({
      key: "panel:alpha",
      surface: "panel",
      host: staleHost,
      create: () => () => {
        events.push("stale:unmount");
      },
    });
    staleHost.remove();
    const replacementHost = connectedHost();

    const replacement = registry.getOrCreate({
      key: "panel:alpha",
      surface: "panel",
      host: replacementHost,
      create: () => {
        events.push("replacement:create");
        return () => {};
      },
    });

    expect(replacement).not.toBe(stale);
    expect(replacement.host).toBe(replacementHost);
    expect(registry.get("panel:alpha")).toBe(replacement);
    expect(events).toEqual(["stale:unmount", "replacement:create"]);
  });

  it("retains no record when detached replacement creation throws", () => {
    const registry = new MountRegistry();
    const staleHost = connectedHost();
    let staleUnmountCount = 0;
    registry.getOrCreate({
      key: "drawer:alpha",
      surface: "drawer",
      host: staleHost,
      create: () => () => {
        staleUnmountCount += 1;
      },
    });
    staleHost.remove();
    const failure = new Error("mount failed");

    expect(() =>
      registry.getOrCreate({
        key: "drawer:alpha",
        surface: "drawer",
        host: connectedHost(),
        create: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);

    expect(staleUnmountCount).toBe(1);
    expect(registry.get("drawer:alpha")).toBeUndefined();
  });

  it("creates a detached same-key replacement after stale unmount throws", () => {
    const registry = new MountRegistry();
    const staleHost = connectedHost();
    registry.getOrCreate({
      key: "popover:alpha",
      surface: "popover",
      host: staleHost,
      create: () => () => {
        throw new Error("stale unmount failed");
      },
    });
    staleHost.remove();
    const replacementHost = connectedHost();
    let replacement: SurfaceMount | undefined;

    expect(() => {
      replacement = registry.getOrCreate({
        key: "popover:alpha",
        surface: "popover",
        host: replacementHost,
        create: () => () => {},
      });
    }).not.toThrow();

    expect(replacement?.host).toBe(replacementHost);
    expect(registry.get("popover:alpha")).toBe(replacement);
  });

  it("preserves a connected same-key mount registered while stale cleanup runs", () => {
    const registry = new MountRegistry();
    const staleHost = connectedHost();
    const reentrantHost = connectedHost("section");
    let reentrant: SurfaceMount | undefined;
    let outerCreateCount = 0;
    let reentrantUnmountCount = 0;
    registry.getOrCreate({
      key: "dock:alpha",
      surface: "dock",
      host: staleHost,
      create: () => () => {
        reentrant = registry.getOrCreate({
          key: "dock:alpha",
          surface: "dock",
          host: reentrantHost,
          create: () => () => {
            reentrantUnmountCount += 1;
          },
        });
      },
    });
    staleHost.remove();

    const result = registry.getOrCreate({
      key: "dock:alpha",
      surface: "dock",
      host: connectedHost("aside"),
      create: () => {
        outerCreateCount += 1;
        return () => {};
      },
    });

    expect(result).toBe(reentrant);
    expect(registry.get("dock:alpha")).toBe(reentrant);
    expect(reentrant?.host).toBe(reentrantHost);
    expect(outerCreateCount).toBe(0);
    expect(reentrantUnmountCount).toBe(0);
  });

  it("stops after one stale cleanup when it registers a detached same-key mount", () => {
    const registry = new MountRegistry();
    const staleHost = connectedHost();
    const reentrantHost = document.createElement("section");
    let reentrant: SurfaceMount | undefined;
    let reentrantUnmountCount = 0;
    let outerCreateCount = 0;
    registry.getOrCreate({
      key: "rail:alpha",
      surface: "rail",
      host: staleHost,
      create: () => () => {
        reentrant = registry.getOrCreate({
          key: "rail:alpha",
          surface: "rail",
          host: reentrantHost,
          create: () => () => {
            reentrantUnmountCount += 1;
          },
        });
      },
    });
    staleHost.remove();

    const result = registry.getOrCreate({
      key: "rail:alpha",
      surface: "rail",
      host: connectedHost("aside"),
      create: () => {
        outerCreateCount += 1;
        return () => {};
      },
    });

    expect(result).toBe(reentrant);
    expect(registry.get("rail:alpha")).toBe(reentrant);
    expect(reentrant?.host).toBe(reentrantHost);
    expect(reentrantUnmountCount).toBe(0);
    expect(outerCreateCount).toBe(0);
  });

  it("discards a losing outer mount when its factory registers the same key", () => {
    const registry = new MountRegistry();
    let inner: SurfaceMount | undefined;
    let innerUnmountCount = 0;
    let outerUnmountCount = 0;

    let result: SurfaceMount | undefined;
    expect(() => {
      result = registry.getOrCreate({
        key: "tray:alpha",
        surface: "tray",
        host: connectedHost("aside"),
        create: () => {
          inner = registry.getOrCreate({
            key: "tray:alpha",
            surface: "tray",
            host: connectedHost("section"),
            create: () => () => {
              innerUnmountCount += 1;
            },
          });
          return () => {
            outerUnmountCount += 1;
            throw new Error("outer unmount failed");
          };
        },
      });
    }).not.toThrow();

    expect(result).toBe(inner);
    expect(registry.get("tray:alpha")).toBe(inner);
    expect(innerUnmountCount).toBe(0);
    expect(outerUnmountCount).toBe(1);
  });

  it("direct unmount is idempotent and releases ownership before caller code", () => {
    const registry = new MountRegistry();
    let callerUnmountCount = 0;
    let ownedDuringCallerUnmount = true;
    const mount = registry.getOrCreate({
      key: "widget:alpha",
      surface: "widget",
      host: connectedHost(),
      create: () => () => {
        callerUnmountCount += 1;
        ownedDuringCallerUnmount = registry.get("widget:alpha") !== undefined;
      },
    });

    mount.unmount();
    mount.unmount();

    expect(callerUnmountCount).toBe(1);
    expect(ownedDuringCallerUnmount).toBe(false);
    expect(registry.get("widget:alpha")).toBeUndefined();
  });

  it("cleans only the requested key", () => {
    const registry = new MountRegistry();
    let alphaUnmountCount = 0;
    let betaUnmountCount = 0;
    registry.getOrCreate({
      key: "row:alpha",
      surface: "row",
      host: connectedHost(),
      create: () => () => {
        alphaUnmountCount += 1;
      },
    });
    const beta = registry.getOrCreate({
      key: "row:beta",
      surface: "row",
      host: connectedHost(),
      create: () => () => {
        betaUnmountCount += 1;
      },
    });

    registry.cleanupKey("row:alpha");

    expect(registry.get("row:alpha")).toBeUndefined();
    expect(registry.get("row:beta")).toBe(beta);
    expect(alphaUnmountCount).toBe(1);
    expect(betaUnmountCount).toBe(0);
  });

  it("cleans detached hosts and preserves connected mounts", () => {
    const registry = new MountRegistry();
    const detachedHost = connectedHost();
    let detachedUnmountCount = 0;
    registry.getOrCreate({
      key: "badge:detached",
      surface: "badge",
      host: detachedHost,
      create: () => () => {
        detachedUnmountCount += 1;
      },
    });
    const connected = registry.getOrCreate({
      key: "badge:connected",
      surface: "badge",
      host: connectedHost(),
      create: () => () => {},
    });
    detachedHost.remove();

    registry.cleanupDetached();

    expect(registry.get("badge:detached")).toBeUndefined();
    expect(registry.get("badge:connected")).toBe(connected);
    expect(detachedUnmountCount).toBe(1);
  });

  it("cleans every mount on one surface and preserves other surfaces", () => {
    const registry = new MountRegistry();
    const unmountedKeys: string[] = [];
    for (const key of ["card:alpha", "card:beta"]) {
      registry.getOrCreate({
        key,
        surface: "card",
        host: connectedHost(),
        create: () => () => {
          unmountedKeys.push(key);
        },
      });
    }
    const drawer = registry.getOrCreate({
      key: "drawer:alpha",
      surface: "drawer",
      host: connectedHost(),
      create: () => () => {
        unmountedKeys.push("drawer:alpha");
      },
    });

    registry.cleanupSurface("card");

    expect(registry.get("card:alpha")).toBeUndefined();
    expect(registry.get("card:beta")).toBeUndefined();
    expect(registry.get("drawer:alpha")).toBe(drawer);
    expect(unmountedKeys).toEqual(["card:alpha", "card:beta"]);
  });

  it("cleans every registered mount", () => {
    const registry = new MountRegistry();
    const unmountedKeys: string[] = [];
    for (const [key, surface] of [
      ["card:alpha", "card"],
      ["drawer:beta", "drawer"],
    ]) {
      registry.getOrCreate({
        key,
        surface,
        host: connectedHost(),
        create: () => () => {
          unmountedKeys.push(key);
        },
      });
    }

    registry.cleanupAll();

    expect(registry.get("card:alpha")).toBeUndefined();
    expect(registry.get("drawer:beta")).toBeUndefined();
    expect(unmountedKeys).toEqual(["card:alpha", "drawer:beta"]);
  });

  it("isolates an exact-key unmount failure", () => {
    const registry = new MountRegistry();
    registry.getOrCreate({
      key: "chip:alpha",
      surface: "chip",
      host: connectedHost(),
      create: () => () => {
        throw new Error("unmount failed");
      },
    });

    expect(() => registry.cleanupKey("chip:alpha")).not.toThrow();
    expect(registry.get("chip:alpha")).toBeUndefined();
  });

  it("continues detached cleanup after an unmount failure", () => {
    const registry = new MountRegistry();
    const firstHost = connectedHost();
    const secondHost = connectedHost();
    const events: string[] = [];
    registry.getOrCreate({
      key: "chip:first",
      surface: "chip",
      host: firstHost,
      create: () => () => {
        events.push("first");
        throw new Error("unmount failed");
      },
    });
    registry.getOrCreate({
      key: "chip:second",
      surface: "chip",
      host: secondHost,
      create: () => () => {
        events.push("second");
      },
    });
    firstHost.remove();
    secondHost.remove();

    expect(() => registry.cleanupDetached()).not.toThrow();
    expect(events).toEqual(["first", "second"]);
    expect(registry.get("chip:first")).toBeUndefined();
    expect(registry.get("chip:second")).toBeUndefined();
  });

  it("continues surface cleanup after an unmount failure", () => {
    const registry = new MountRegistry();
    const events: string[] = [];
    registry.getOrCreate({
      key: "chip:first",
      surface: "chip",
      host: connectedHost(),
      create: () => () => {
        events.push("first");
        throw new Error("unmount failed");
      },
    });
    registry.getOrCreate({
      key: "chip:second",
      surface: "chip",
      host: connectedHost(),
      create: () => () => {
        events.push("second");
      },
    });

    expect(() => registry.cleanupSurface("chip")).not.toThrow();
    expect(events).toEqual(["first", "second"]);
    expect(registry.get("chip:first")).toBeUndefined();
    expect(registry.get("chip:second")).toBeUndefined();
  });

  it("continues cleanup-all after an unmount failure", () => {
    const registry = new MountRegistry();
    const events: string[] = [];
    registry.getOrCreate({
      key: "chip:first",
      surface: "chip",
      host: connectedHost(),
      create: () => () => {
        events.push("first");
        throw new Error("unmount failed");
      },
    });
    registry.getOrCreate({
      key: "drawer:second",
      surface: "drawer",
      host: connectedHost(),
      create: () => () => {
        events.push("second");
      },
    });

    expect(() => registry.cleanupAll()).not.toThrow();
    expect(events).toEqual(["first", "second"]);
    expect(registry.get("chip:first")).toBeUndefined();
    expect(registry.get("drawer:second")).toBeUndefined();
  });

  it("preserves a same-key replacement registered reentrantly during cleanup", () => {
    const registry = new MountRegistry();
    const replacementHost = connectedHost("section");
    let replacementUnmountCount = 0;
    let replacement: SurfaceMount | undefined;
    registry.getOrCreate({
      key: "slot:alpha",
      surface: "slot",
      host: connectedHost("article"),
      create: () => () => {
        replacement = registry.getOrCreate({
          key: "slot:alpha",
          surface: "slot",
          host: replacementHost,
          create: () => () => {
            replacementUnmountCount += 1;
          },
        });
      },
    });

    registry.cleanupAll();

    expect(registry.get("slot:alpha")).toBe(replacement);
    expect(registry.get("slot:alpha")?.host).toBe(replacementHost);
    expect(replacementUnmountCount).toBe(0);
  });
});
