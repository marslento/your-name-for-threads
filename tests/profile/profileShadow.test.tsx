import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProfileShadow,
  type ProfileShadowSurface,
} from "../../src/content/ui/profile/profileShadow";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mountedSurfaces = new Set<ProfileShadowSurface>();

function createSurface(host: HTMLElement): ProfileShadowSurface | null {
  const surface = createProfileShadow(host);
  if (surface) mountedSurfaces.add(surface);
  return surface;
}

function connectedHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

afterEach(() => {
  act(() => {
    for (const surface of mountedSurfaces) surface.unmount();
  });
  mountedSurfaces.clear();
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("createProfileShadow", () => {
  it("renders only inside an owned Shadow Root with one scoped stylesheet", async () => {
    const host = connectedHost();
    const sibling = document.createElement("aside");
    document.body.append(sibling);
    const surface = createSurface(host);

    expect(surface).not.toBeNull();
    await act(async () => {
      surface?.render(<p data-testid="profile-shadow-content">Nickname</p>);
    });

    expect(host.shadowRoot?.querySelector('[data-testid="profile-shadow-content"]')?.textContent)
      .toBe("Nickname");
    expect(document.querySelector('[data-testid="profile-shadow-content"]')).toBeNull();
    expect(host.shadowRoot?.querySelectorAll("style")).toHaveLength(1);
    const stylesheet = host.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(stylesheet).not.toBe("");
    expect(stylesheet).not.toContain("@import");
    expect(stylesheet).not.toContain("__VITE_ASSET__");
    expect(stylesheet).not.toContain("/assets/");
    expect(stylesheet).not.toContain(".woff2");
    expect(stylesheet).toContain("[data-tpd-profile-root]");
    expect(stylesheet).toContain("[data-tpd-profile-root].dark");
    expect(document.head.querySelectorAll("style, link")).toHaveLength(0);
    expect(Array.from(document.body.children)).toEqual([
      host,
      sibling,
      (surface?.portalContainer.getRootNode() as ShadowRoot).host,
    ]);
  });

  it("reuses its React root and updates the rendered content", async () => {
    const surface = createSurface(connectedHost());

    await act(async () => {
      surface?.render(<p>First</p>);
      surface?.render(<p>Second</p>);
    });

    expect(surface?.container.textContent).toBe("Second");
  });

  it("mounts its dialog portal outside scrolling Profile ancestors", () => {
    const scrollingRegion = document.createElement("main");
    scrollingRegion.style.overflow = "auto";
    scrollingRegion.style.transform = "translateZ(0)";
    const host = document.createElement("div");
    scrollingRegion.append(host);
    document.body.append(scrollingRegion);
    const surface = createSurface(host);

    const portalRoot = surface?.portalContainer.getRootNode();
    expect(portalRoot).toBeInstanceOf(ShadowRoot);
    const portalHost = (portalRoot as ShadowRoot).host;
    expect(portalHost.parentElement).toBe(document.body);
    expect(scrollingRegion.contains(portalHost)).toBe(false);
  });

  it("applies light and dark tokens on its own React container", () => {
    const surface = createSurface(connectedHost());

    expect(surface?.container.classList.contains("dark")).toBe(false);
    expect(surface?.portalContainer.classList.contains("dark")).toBe(false);
    surface?.setTheme("dark");
    expect(surface?.container.classList.contains("dark")).toBe(true);
    expect(surface?.portalContainer.classList.contains("dark")).toBe(true);
    surface?.setTheme("light");
    expect(surface?.container.classList.contains("dark")).toBe(false);
    expect(surface?.portalContainer.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("removes only its own nodes when unmounted repeatedly", () => {
    const host = connectedHost();
    const surface = createSurface(host);
    const portalHost = (surface?.portalContainer.getRootNode() as ShadowRoot).host;
    const unrelated = document.createElement("section");
    host.shadowRoot?.append(unrelated);

    act(() => {
      surface?.unmount();
      surface?.unmount();
    });

    expect(Array.from(host.shadowRoot?.children ?? [])).toEqual([unrelated]);
    expect(host.isConnected).toBe(true);
    expect(portalHost.isConnected).toBe(false);
  });

  it("fails without touching an unexpected existing Shadow Root", () => {
    const host = connectedHost();
    const existingRoot = host.attachShadow({ mode: "open" });
    const existingNode = document.createElement("span");
    existingRoot.append(existingNode);

    expect(createProfileShadow(host)).toBeNull();
    expect(Array.from(existingRoot.children)).toEqual([existingNode]);
  });

  it("fails safely when Shadow setup throws", () => {
    const host = connectedHost();
    vi.spyOn(host, "attachShadow").mockImplementation(() => {
      throw new Error("Shadow DOM unavailable");
    });

    expect(() => createProfileShadow(host)).not.toThrow();
    expect(createProfileShadow(host)).toBeNull();
    expect(host.childElementCount).toBe(0);
  });

  it("creates Shadow-owned nodes with the host document", () => {
    const hostDocument = document.implementation.createHTMLDocument("Profile");
    const createElement = vi.spyOn(hostDocument, "createElement");
    const host = hostDocument.createElement("div");

    const surface = createSurface(host);

    expect(surface?.container.ownerDocument).toBe(hostDocument);
    expect(host.shadowRoot?.querySelector("style")?.ownerDocument).toBe(hostDocument);
    expect(createElement.mock.calls.map(([tagName]) => tagName)).toEqual(
      expect.arrayContaining(["style", "div"]),
    );
  });
});
