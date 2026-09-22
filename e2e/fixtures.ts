import { test as base, chromium, expect, type Worker, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const VIEWER = { id: '100200300', username: 'demo_alice' };
export const OTHER_VIEWER = { id: '100200999', username: 'demo_bob_viewer' };
export const PROFILE = 'demo_bob';
export const NICKNAME = 'Demo Bob';
const extensionPath = resolve('dist');

// Same minimal DOM contract as final-zip-smoke/run.mjs. This is synthetic HTML,
// not a capture of today's Threads DOM. Every HTTP(S) request is intercepted.
// `?as=other` serves another signed-in viewer and `?as=none` a signed-out page (`viewer: null`, which is what a
// logout's replacement document ships). `?hydrate=<ms>` leaves the viewer out until the page has "hydrated".
const viewerScript = (viewer: { id: string; username: string } | null) => `<script type="application/json" data-sjs>${JSON.stringify({ __bbox: { define: [['BarcelonaSharedData', [], { viewer }, 1]] } })}</script>`;
const header = `<div class="x1a8lsjc"><div><h1>${PROFILE}</h1><div><span>${PROFILE}</span></div><img alt="" src="/avatar.png"></div><div aria-label="Profile metadata">metadata</div></div>`;
const post = `<div class="post"><div class="header"><span class="identity"><a href="https://www.threads.com/@${PROFILE}">${PROFILE}</a></span><span class="meta"><a href="/t/topic">topic</a><span>&middot;</span><time>2h</time></span></div></div>`;

/** Lets a test hold every Threads document response, so a reload or navigation stays pending while the old page is still on screen. */
export const network: { hold: Promise<void> | null } = { hold: null };

function threadsDocument(url: URL): string {
  const as = url.searchParams.get('as');
  const viewer = as === 'none' ? null : as === 'other' ? OTHER_VIEWER : VIEWER;
  const hydrateMs = Number(url.searchParams.get('hydrate') ?? 0);
  const late = hydrateMs > 0
    ? `<script>setTimeout(() => document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(viewerScript(viewer)).replaceAll('</', '<\\/')}), ${hydrateMs})</script>`
    : '';
  return `<!doctype html><html lang="en"><head><title>Local Threads fixture</title>${hydrateMs > 0 ? '' : viewerScript(viewer)}${late}</head><body>${url.pathname === `/@${PROFILE}` ? header : '<h1>Home</h1>'}${post}</body></html>`;
}

export const test = base.extend<{ worker: Worker; extensionUrl: string }>({
  context: async ({ headless }, use, testInfo) => {
    await readFile(resolve(extensionPath, 'manifest.json'));
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless, locale: 'en-US', viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        '--lang=en-US', '--host-resolver-rules=MAP * ~NOTFOUND'],
    });
    const errors: string[] = [];
    await testInfo.attach('environment', { contentType: 'application/json', body: JSON.stringify({
      browser: context.browser()?.version(), platform: process.platform,
      manifestVersion: JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8')).version,
      data: 'synthetic, fresh temporary browser profile; HTTP(S) routed locally',
    }, null, 2) });
    context.on('weberror', error => errors.push(String(error.error())));
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.threads.com' && route.request().resourceType() === 'document') {
        if (network.hold) await network.hold;
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: threadsDocument(url) });
      } else if (url.hostname === 'elsewhere.test' && route.request().resourceType() === 'document') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Other site fixture</h1>' });
      } else if (url.hostname === 'www.threads.com' && url.pathname === '/avatar.png') {
        await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
      } else {
        await route.abort('blockedbyclient');
      }
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    try {
      await use(context);
      expect(errors, 'Uncaught browser page errors').toEqual([]);
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus || errors.length > 0;
      if (failed) {
        for (const [index, page] of context.pages().entries()) {
          if (!page.isClosed()) {
            const path = testInfo.outputPath(`page-${index}.png`);
            await page.screenshot({ path, timeout: 5000 }).then(() => testInfo.attach(`page-${index}`, { path, contentType: 'image/png' })).catch(() => {});
          }
        }
      }
      try {
        const path = failed ? testInfo.outputPath('trace.zip') : undefined;
        await context.tracing.stop({ path });
        if (path) await testInfo.attach('trace', { path, contentType: 'application/zip' });
      } finally {
        await context.close();
      }
    }
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionUrl: async ({ worker }, use) => {
    await use(`chrome-extension://${new URL(worker.url()).host}`);
  },
});

export { expect };

export async function saveNickname(page: Page) {
  await page.goto(`https://www.threads.com/@${PROFILE}`);
  await page.getByRole('button', { name: 'Add nickname', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nickname', exact: true }).fill(NICKNAME);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('https://www.threads.com/');
  await expect(page.locator('[data-tpd-nickname]')).toContainText(NICKNAME);
}

/** The browser tab id of a Threads page, found the way the popup's own active-tab query would: by its address. */
export async function tabIdOf(source: Page, worker: Worker): Promise<number> {
  const url = source.url();
  const id = await worker.evaluate(async (wanted) => (await chrome.tabs.query({ url: 'https://www.threads.com/*' })).find((tab) => tab.url === wanted)?.id, url);
  if (id === undefined) throw new Error(`No browser tab shows ${url}`);
  return id;
}

/**
 * The popup's "Open Dashboard", by the message it sends. The popup itself cannot be used as a tab here (it would become
 * the active tab), so a throwaway extension page sends the same message. Toolbar behaviour remains manual.
 * The background opens the Dashboard tab (or brings the one it already has forward); `dashboard` is the page showing the
 * session it answered with, or `null` when it refused.
 */
export async function requestDashboard(source: Page, worker: Worker, extensionUrl: string) {
  const sourceTabId = await tabIdOf(source, worker);
  const context = source.context();
  const sender = await context.newPage();
  await sender.goto(`${extensionUrl}/dashboard.html`);
  try {
    const answer = await sender.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'tpd:open-dashboard', sourceTabId: id }), sourceTabId);
    const sessionId = (answer as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId) return { answer, dashboard: null };
    // Found by the session it shows, never by "the next page that opened": two requests at once open pages of their own.
    const showing = () => context.pages().find((page) => page.url().startsWith(`${extensionUrl}/dashboard.html?session=${sessionId}`));
    await expect.poll(() => showing() !== undefined, { timeout: 10_000, message: 'the Dashboard tab did not open' }).toBe(true);
    return { answer, dashboard: showing() ?? null };
  } finally {
    await sender.close();
  }
}

export async function openDirectory(page: Page, worker: Worker, extensionUrl: string) {
  const { answer, dashboard } = await requestDashboard(page, worker, extensionUrl);
  expect(answer).toMatchObject({ ok: true, sessionId: expect.any(String) });
  if (!dashboard) throw new Error('The background did not open a Dashboard tab.');
  await expect(dashboard.getByRole('heading', { name: 'Private Directory', exact: true })).toBeVisible();
  return dashboard;
}
