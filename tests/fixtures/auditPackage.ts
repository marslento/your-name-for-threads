import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ROOT } from "./repoFiles";

export function createAuditPackage(dir: string, version: string): string {
  const manifest = {
    manifest_version: 3,
    version,
    name: "__MSG_extension_name__",
    description: "__MSG_extension_description__",
    default_locale: "en",
    permissions: ["storage"],
    host_permissions: ["https://www.threads.com/*"],
    icons: { "16": "icons/icon16.png", "128": "icons/icon128.png" },
    action: {
      default_title: "__MSG_action_title__",
      default_icon: { "16": "icons/icon16.png" },
      default_popup: "src/popup/index.html",
    },
    background: { service_worker: "service-worker-loader.js" },
    content_scripts: [{
      matches: ["https://www.threads.com/*"],
      js: ["assets/content.js"],
      css: ["assets/style.css"],
    }],
    web_accessible_resources: [{
      matches: ["https://www.threads.com/*"],
      resources: ["assets/page.js", "dashboard.html"],
    }],
  };
  const files: Record<string, string | Buffer> = {
    "manifest.json": JSON.stringify(manifest),
    "_locales/en/messages.json": JSON.stringify({
      extension_name: { message: "Audit fixture" },
      extension_description: { message: "A small package for release audit tests." },
      action_title: { message: "Open fixture" },
    }),
    "service-worker-loader.js": "void 0;\n",
    "src/popup/index.html": "<!doctype html><html lang=\"en\"><title>Popup fixture</title></html>\n",
    "dashboard.html": "<!doctype html><html lang=\"en\"><title>Dashboard fixture</title></html>\n",
    "assets/content.js": "void 0;\n",
    "assets/page.js": "void 0;\n",
    "assets/style.css": "body { color: black; }\n",
    "icons/icon16.png": readFileSync(join(ROOT, "icons/icon16.png")),
    "icons/icon128.png": readFileSync(join(ROOT, "icons/icon128.png")),
  };

  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}
