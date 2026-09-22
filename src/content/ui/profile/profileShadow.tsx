import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import sonnerStyles from "sonner/dist/styles.css?inline";
import type { ThreadsTheme } from "../../theme/detectThreadsTheme";
import profileShadowStyles from "../../../styles/tailwind.css?inline";

export interface ProfileShadowSurface {
  readonly container: HTMLDivElement;
  readonly portalContainer: HTMLDivElement;
  render(children: ReactNode): void;
  setTheme(theme: ThreadsTheme): void;
  unmount(): void;
}

export function createProfileShadow(host: HTMLElement): ProfileShadowSurface | null {
  if (host.shadowRoot) return null;

  const ownerDocument = host.ownerDocument;
  let shadowRoot: ShadowRoot | undefined;
  let style: HTMLStyleElement | undefined;
  let container: HTMLDivElement | undefined;
  let portalHost: HTMLDivElement | undefined;
  let portalStyle: HTMLStyleElement | undefined;
  let portalContainer: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  try {
    shadowRoot = host.attachShadow({ mode: "open" });
    style = ownerDocument.createElement("style");
    style.textContent = `${profileShadowStyles}\n${sonnerStyles}`;
    container = ownerDocument.createElement("div");
    container.dataset.tpdProfileRoot = "";
    shadowRoot.append(style, container);

    portalHost = ownerDocument.createElement("div");
    portalHost.dataset.tpdProfilePortalHost = "";
    const portalRoot = portalHost.attachShadow({ mode: "open" });
    portalStyle = style.cloneNode(true) as HTMLStyleElement;
    portalContainer = ownerDocument.createElement("div");
    portalContainer.dataset.tpdProfileRoot = "";
    portalRoot.append(portalStyle, portalContainer);
    ownerDocument.body.append(portalHost);

    root = createRoot(container, {
      onCaughtError: () => {},
    });
  } catch {
    try {
      root?.unmount();
    } catch {
      // Failed setup remains contained to this extension surface.
    }
    style?.remove();
    container?.remove();
    portalStyle?.remove();
    portalContainer?.remove();
    portalHost?.remove();
    return null;
  }

  let mounted = true;
  return {
    container,
    portalContainer,
    render(children) {
      if (mounted) root.render(children);
    },
    setTheme(theme) {
      if (!mounted) return;
      container.classList.toggle("dark", theme === "dark");
      portalContainer.classList.toggle("dark", theme === "dark");
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      try {
        root.unmount();
      } catch {
        // Cleanup must not disturb Threads when React teardown fails.
      }
      style.remove();
      container.remove();
      portalStyle.remove();
      portalContainer.remove();
      portalHost.remove();
    },
  };
}
