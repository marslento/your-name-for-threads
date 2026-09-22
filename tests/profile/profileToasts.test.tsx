import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import {
  ProfileToaster,
  showProfileToast,
  type ProfileToastOutcome,
} from "../../src/content/ui/profile/profileToasts";
import {
  createProfileShadow,
  type ProfileShadowSurface,
} from "../../src/content/ui/profile/profileShadow";
import { t } from "../../src/i18n/t";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mountedSurfaces = new Set<ProfileShadowSurface>();

function createSurface(): { host: HTMLElement; surface: ProfileShadowSurface } {
  const host = document.createElement("div");
  document.body.append(host);
  const surface = createProfileShadow(host);
  if (!surface) throw new Error("Expected a Profile Shadow surface");
  mountedSurfaces.add(surface);
  return { host, surface };
}

afterEach(() => {
  act(() => {
    toast.dismiss();
    for (const surface of mountedSurfaces) surface.unmount();
  });
  mountedSurfaces.clear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("showProfileToast", () => {
  it.each([
    ["created", "success", "profile_nicknameCreated"],
    ["updated", "success", "profile_nicknameUpdated"],
    ["deleted", "success", "profile_deleteSuccess"],
    ["save-error", "error", "profile_saveError"],
    ["delete-error", "error", "profile_deleteError"],
  ] as const)("maps %s to an exact %s notification", (outcome, semantic, messageKey) => {
    const success = vi.spyOn(toast, "success").mockReturnValue("success-toast");
    const error = vi.spyOn(toast, "error").mockReturnValue("error-toast");

    showProfileToast(outcome);

    expect(success).toHaveBeenCalledTimes(semantic === "success" ? 1 : 0);
    expect(error).toHaveBeenCalledTimes(semantic === "error" ? 1 : 0);
    expect(semantic === "success" ? success : error).toHaveBeenCalledWith(t(messageKey));
  });

  it.each(["numeric-id-upgrade", "identity-cache-update", "username-rename", "theme-change"])(
    "does not expose passive %s feedback",
    (passiveOutcome) => {
      const success = vi.spyOn(toast, "success").mockReturnValue("success-toast");
      const error = vi.spyOn(toast, "error").mockReturnValue("error-toast");

      showProfileToast(passiveOutcome as ProfileToastOutcome);

      expect(success).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );
});

describe("ProfileToaster", () => {
  it("renders a localized bottom-center host inside the owned Shadow Root", async () => {
    const { host, surface } = createSurface();

    await act(async () => {
      surface.render(<ProfileToaster theme="light" />);
    });
    await act(async () => {
      showProfileToast("created");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toaster = surface.container.querySelector<HTMLElement>("[data-sonner-toaster]");
    expect(toaster).not.toBeNull();
    expect(toaster?.getRootNode()).toBe(host.shadowRoot);
    expect(document.body.querySelector("[data-sonner-toaster]")).toBeNull();
    expect(toaster?.closest("section")?.getAttribute("aria-label")).toContain(
      t("profile_notificationsLabel"),
    );
    expect(toaster?.dataset.xPosition).toBe("center");
    expect(toaster?.dataset.yPosition).toBe("bottom");
  });

  it("applies explicit light and dark themes, including a live prop change", async () => {
    const { surface } = createSurface();

    await act(async () => {
      surface.render(<ProfileToaster theme="light" />);
    });
    await act(async () => {
      showProfileToast("created");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(surface.container.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme"))
      .toBe("light");

    await act(async () => {
      surface.render(<ProfileToaster theme="dark" />);
    });
    expect(surface.container.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme"))
      .toBe("dark");
  });

  it("ships asset-free Sonner selectors in the Shadow-local style payload", () => {
    const { host } = createSurface();
    const stylesheet = host.shadowRoot?.querySelector("style")?.textContent ?? "";

    expect(stylesheet).toContain("[data-sonner-toaster]");
    expect(stylesheet).toContain("[data-sonner-toast]");
    expect(stylesheet).not.toContain("@import");
    expect(stylesheet).not.toContain("url(");
    expect(stylesheet).not.toContain("/assets");
    expect(stylesheet).not.toContain("__VITE_ASSET__");
    expect(stylesheet).not.toContain("/@vite");
    expect(stylesheet).not.toContain(".woff2");
  });
});
