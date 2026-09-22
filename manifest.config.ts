import { defineManifest } from "@crxjs/vite-plugin";

import { PHASE_ONE_VERSION } from "./src/shared/constants.ts";

export default defineManifest({
  manifest_version: 3,
  name: "__MSG_extension_name__",
  version: PHASE_ONE_VERSION,
  description: "__MSG_extension_description__",
  default_locale: "en",
  permissions: ["storage"],
  host_permissions: ["https://www.threads.com/*"],
  // The four sizes Chrome and Edge use (extensions page, install prompt, store
  // listing); tests/manifest-icons.test.ts reads each file's real pixel size.
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  background: {
    service_worker: "src/background/serviceWorker.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/index.html",
    // The toolbar is drawn at 16 (and 32 on high-DPI); saying so beats a scaled 48.
    default_icon: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
    },
  },
  options_page: "dashboard.html",
  content_scripts: [
    {
      matches: ["https://www.threads.com/*"],
      js: ["src/page/identityObserver.ts"],
      run_at: "document_start",
      world: "MAIN",
    },
    {
      matches: ["https://www.threads.com/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
});
