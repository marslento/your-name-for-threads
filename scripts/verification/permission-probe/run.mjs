// Drives a throwaway headless browser, with the built extension loaded, to observe what the manifest's
// permissions really allow (Phase 4 Task 15). Everything is local: www.threads.com and elsewhere.test are
// mapped to a server on 127.0.0.1:8443, the profile is a temp directory, and only the process started here
// is killed. Windows-only as written (taskkill). See README.md in this directory.
//
//   node run.mjs <path to msedge.exe, or another Chromium that honours --load-extension> <path to dist>
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER = process.argv[2];
const EXT = process.argv[3];
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), "tpd-permission-probe-"));

await import("./server.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (path) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json();

function client(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) {
        const { res, rej } = pending.get(d.id);
        pending.delete(d.id);
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { res, rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

const evaluate = async (target, expression) => {
  const r = await target.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
  return r.result.value;
};

const child = spawn(
  BROWSER,
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${EXT}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--host-resolver-rules=MAP www.threads.com 127.0.0.1:8443, MAP elsewhere.test 127.0.0.1:8443",
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const result = { browser: BROWSER };
try {
  let version;
  for (let i = 0; i < 40 && !version; i++) {
    await sleep(500);
    version = await json("/json/version").catch(() => undefined);
  }
  if (!version) throw new Error("the browser never opened its debugging port");
  result.product = version.Browser;

  // The browser's own built-in extensions also run service workers: pick this extension's by its file name.
  let sw;
  for (let i = 0; i < 30 && !sw; i++) {
    await sleep(500);
    sw = (await json("/json/list")).find((t) => t.type === "service_worker" && t.url.endsWith("/service-worker-loader.js"));
  }
  if (!sw) {
    result.targets = (await json("/json/list")).map((t) => `${t.type} ${t.url}`);
    throw new Error("the extension's service worker never appeared (was the extension loaded?)");
  }
  const extId = new URL(sw.url).host;
  result.extensionId = extId;

  const browser = await client(version.webSocketDebuggerUrl);
  await browser.send("Target.createTarget", { url: "https://www.threads.com/start" });
  await browser.send("Target.createTarget", { url: "https://elsewhere.test/start" });
  await browser.send("Target.createTarget", { url: `chrome-extension://${extId}/dashboard.html?session=probe#/directory` });
  await sleep(2500);

  const worker = await client(sw.webSocketDebuggerUrl);

  result.static = await evaluate(
    worker,
    `(async () => {
      const out = {};
      const dash = chrome.runtime.getURL("dashboard.html");
      const all = await chrome.tabs.query({});
      out.allTabs = all.map((t) => ({ id: t.id, url: t.url === undefined ? "<undefined>" : t.url, title: t.title === undefined ? "<undefined>" : t.title, pendingUrl: t.pendingUrl === undefined ? "<undefined>" : t.pendingUrl }));
      out.queryByUrl_threads = (await chrome.tabs.query({ url: "https://www.threads.com/*" })).map((t) => t.id);
      out.queryByUrl_elsewhere = (await chrome.tabs.query({ url: "https://elsewhere.test/*" })).map((t) => t.id);
      out.queryByUrl_ownDashboard = (await chrome.tabs.query({ url: dash + "*" })).map((t) => t.id);
      out.getContexts_tab = (await chrome.runtime.getContexts({ contextTypes: ["TAB"] })).map((c) => ({ tabId: c.tabId, windowId: c.windowId, documentUrl: c.documentUrl }));
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      out.activeTab = active.map((t) => ({ id: t.id, url: t.url === undefined ? "<undefined>" : t.url }));
      const wins = await chrome.windows.getAll();
      try { await chrome.windows.update(wins[0].id, { focused: true }); out.windowsUpdate = "ok"; } catch (e) { out.windowsUpdate = "threw: " + e.message; }
      try { await chrome.tabs.update(all[0].id, { active: true }); out.tabsUpdate = "ok"; } catch (e) { out.tabsUpdate = "threw: " + e.message; }
      try { const t = await chrome.tabs.create({ url: dash + "?session=probe2#/directory" }); out.tabsCreate = "ok id " + t.id; } catch (e) { out.tabsCreate = "threw: " + e.message; }
      out.manifestPermissions = chrome.runtime.getManifest().permissions;
      out.manifestHosts = chrome.runtime.getManifest().host_permissions;
      return out;
    })()`,
  );

  // Who can fetch a web-accessible resource, and can the Dashboard copy to the clipboard with no clipboard permission.
  const resource = await evaluate(worker, `chrome.runtime.getManifest().web_accessible_resources[0].resources[0]`);
  const listed = await json("/json/list");
  const fetchProbe = `fetch("chrome-extension://${extId}/${resource}").then((r) => "status " + r.status, (e) => "blocked: " + e.message)`;
  result.webAccessibleResource = { resource, fetchedFrom: {} };
  for (const host of ["www.threads.com", "elsewhere.test"]) {
    const target = listed.find((t) => t.type === "page" && t.url.includes(host));
    const c = await client(target.webSocketDebuggerUrl);
    result.webAccessibleResource.fetchedFrom[host] = await evaluate(c, fetchProbe);
    c.close();
  }
  const dashTarget = listed.find((t) => t.type === "page" && t.url.includes("session=probe#"));
  const dash = await client(dashTarget.webSocketDebuggerUrl);
  await dash.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const clip = await dash.send("Runtime.evaluate", {
    expression: `navigator.clipboard.writeText("probe").then(() => "written", (e) => "rejected: " + e.name + ": " + e.message)`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true, // the click is emulated, and so is the window's focus: a real click in a real window is still to be seen
  });
  result.clipboardWriteTextFromDashboard = clip.result.value;
  dash.close();

  await evaluate(
    worker,
    `globalThis.__ev = []; chrome.tabs.onUpdated.addListener((id, ci, t) => globalThis.__ev.push({ id, ci: JSON.parse(JSON.stringify(ci)), tabUrl: t.url === undefined ? "<undefined>" : t.url, status: t.status })); "recorder installed"`,
  );

  const pageOf = async (needle) => (await json("/json/list")).find((t) => t.type === "page" && t.url.includes(needle));
  const events = async () => evaluate(worker, `(() => { const e = globalThis.__ev; globalThis.__ev = []; return e; })()`);
  const threadsPage = await pageOf("www.threads.com");
  const page = await client(threadsPage.webSocketDebuggerUrl);
  const threadsTabId = result.static.allTabs.find((t) => t.url.startsWith("https://www.threads.com/"))?.id;

  await page.send("Page.navigate", { url: "https://elsewhere.test/away" });
  await sleep(2500);
  result.navigateThreadsToElsewhere = (await events()).filter((e) => e.id === threadsTabId);

  await page.send("Page.navigate", { url: "https://www.threads.com/back" });
  await sleep(2500);
  result.navigateElsewhereBackToThreads = (await events()).filter((e) => e.id === threadsTabId);

  await page.send("Page.reload");
  await sleep(2500);
  result.reloadThreads = (await events()).filter((e) => e.id === threadsTabId);

  worker.close();
  page.close();
  browser.close();
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already gone
  }
  await sleep(1500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // a lingering lock is harmless in the temp directory
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
