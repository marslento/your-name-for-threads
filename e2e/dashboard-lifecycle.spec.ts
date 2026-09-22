import { test, expect, network, NICKNAME, saveNickname, requestDashboard, openDirectory, tabIdOf, VIEWER, OTHER_VIEWER } from './fixtures';
import type { BrowserContext, Page, Worker } from '@playwright/test';

/**
 * The Dashboard source lifecycle (docs/architecture.md, DL01-DL18),
 * against the real built extension in real Chromium. The Threads pages are synthetic and every request is intercepted, so
 * what this shows is the extension's own behaviour with the browser's real events and real timers - which a jsdom test with
 * a fake clock cannot show - and NOT anything about the real threads.com (DL06 stays owed to the owner).
 */
const LOCKED = 'Could not confirm the current Threads account';

interface StoredSession { sessionId: string; state: string; sourceTabId: number; dashboardTabId?: number; ownerThreadsUserId: string }

const sessionArea = <T>(worker: Worker, key: string) => worker.evaluate(async (k) => (await chrome.storage.session.get(k))[k], key) as Promise<T | undefined>;
const sessions = async (worker: Worker) => Object.values((await sessionArea<Record<string, StoredSession>>(worker, 'tpd:dashboardSessions')) ?? {});
const activeSessions = async (worker: Worker) => (await sessions(worker)).filter((session) => session.state === 'active');
const tabContext = async (worker: Worker, tabId: number) => (await sessionArea<Record<number, { state: string; ownerThreadsUserId?: string; documentId?: string }>>(worker, 'tpd:tabContexts'))?.[tabId];

/** A Threads page whose account the extension has confirmed, like one the popup would offer "Open Dashboard" for. */
async function threadsSource(context: BrowserContext, worker: Worker, marker: string, params = '') {
  const page = await context.newPage();
  await page.goto(`https://www.threads.com/?src=${marker}${params}`);
  const tabId = await tabIdOf(page, worker);
  await expect.poll(async () => (await tabContext(worker, tabId))?.state, { timeout: 15_000 }).toBe('confirmed');
  return { page, tabId };
}

const closes = (page: Page, timeout = 10_000) => expect.poll(() => page.isClosed(), { timeout, message: 'the Dashboard tab was not closed' }).toBe(true);
const stays = async (page: Page, ms = 2_000) => { await new Promise((resolve) => setTimeout(resolve, ms)); expect(page.isClosed(), 'the tab was closed').toBe(false); };
const directory = (dashboard: Page) => dashboard.getByRole('heading', { name: 'Private Directory', exact: true });
const storedNicknames = (worker: Worker) => worker.evaluate(async () => JSON.stringify((await chrome.storage.local.get('directories')).directories ?? {}));

test.afterEach(() => { network.hold = null; });

test('DL01/DL13/DL16: reloading the source ends its Dashboard, drops the unsaved draft, keeps what was saved, and never brings the old session back', async ({ page, context, worker, extensionUrl }) => {
  await saveNickname(page);
  await expect.poll(async () => (await tabContext(worker, await tabIdOf(page, worker)))?.state, { timeout: 15_000 }).toBe('confirmed');
  const dashboard = await openDirectory(page, worker, extensionUrl);
  await expect(dashboard.getByText(NICKNAME, { exact: true })).toBeVisible();
  await dashboard.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await dashboard.getByRole('textbox', { name: 'Nickname', exact: true }).fill('Unsaved draft');
  const oldUrl = dashboard.url();

  await page.evaluate('location.reload()');
  await closes(dashboard);

  expect(await storedNicknames(worker)).toContain(NICKNAME);
  expect(await storedNicknames(worker)).not.toContain('Unsaved draft');
  const stale = await context.newPage();
  await stale.goto(oldUrl); // DL16: a pasted old Dashboard URL authorizes nothing
  await expect(stale.getByText(LOCKED)).toBeVisible();
  await stale.close();

  // DL13: the same account is confirmed again, and still nothing comes back; the popup opens a NEW session.
  await expect.poll(async () => (await tabContext(worker, await tabIdOf(page, worker)))?.state, { timeout: 15_000 }).toBe('confirmed');
  expect(await activeSessions(worker)).toEqual([]);
  const fresh = await openDirectory(page, worker, extensionUrl);
  expect(fresh.url()).not.toBe(oldUrl);
  await expect(fresh.getByText(NICKNAME, { exact: true })).toBeVisible();
  await expect(fresh.locator('input[value="Unsaved draft"]')).toHaveCount(0);
});

test('DL02: a reload that is still waiting on the network has already ended the Dashboard - it does not wait for the new page or for ten seconds', async ({ context, worker, extensionUrl }) => {
  const { page } = await threadsSource(context, worker, 'slow');
  const dashboard = await openDirectory(page, worker, extensionUrl);
  let release!: () => void;
  network.hold = new Promise<void>((resolve) => { release = resolve; });

  const startedAt = Date.now();
  await page.evaluate('location.reload()'); // returns as the navigation starts; the response is being held
  await closes(dashboard, 5_000);

  // The response is still being held, so the new page cannot have arrived: nothing but the navigation's start can have caused it.
  expect(Date.now() - startedAt, 'under the old ten second grace window').toBeLessThan(5_000);
  release();
});

// Closing the old Dashboard is not enough: the popup must also reject the unloading
// document's proof until the replacement document confirms an account.
test('F1: while a reload is still on the network the popup cannot open a Dashboard from the old page, and nothing can be saved; the page that arrives can', async ({ page, worker, extensionUrl }) => {
  await saveNickname(page);
  const sourceTabId = await tabIdOf(page, worker);
  await expect.poll(async () => (await tabContext(worker, sourceTabId))?.state, { timeout: 15_000 }).toBe('confirmed');
  const old = await openDirectory(page, worker, extensionUrl);
  let release!: () => void;
  network.hold = new Promise<void>((resolve) => { release = resolve; });

  await page.evaluate('location.reload()');
  await closes(old, 5_000);
  const early = await requestDashboard(page, worker, extensionUrl);

  expect(early.answer).toMatchObject({ ok: false, error: 'source_tab_not_confirmed' });
  expect(early.dashboard).toBeNull();
  expect(await activeSessions(worker)).toEqual([]);
  expect(await storedNicknames(worker)).not.toContain('Reload probe');

  release(); // the new page arrives and proves the account again
  await expect.poll(async () => (await tabContext(worker, sourceTabId))?.state, { timeout: 15_000 }).toBe('confirmed');
  const fresh = await openDirectory(page, worker, extensionUrl);
  await expect(fresh.getByText(NICKNAME, { exact: true })).toBeVisible();
});

test('DL03: a source that leaves Threads for a site the extension has no access to ends its Dashboard', async ({ context, worker, extensionUrl }) => {
  const { page } = await threadsSource(context, worker, 'leave');
  const dashboard = await openDirectory(page, worker, extensionUrl);

  await page.goto('https://elsewhere.test/');

  await closes(dashboard);
  expect(await activeSessions(worker)).toEqual([]);
});

test('DL04: closing the source closes only its own Dashboard; another source for the same account is not adopted', async ({ context, worker, extensionUrl }) => {
  const first = await threadsSource(context, worker, 'one');
  const second = await threadsSource(context, worker, 'two');
  const dashboardOne = await openDirectory(first.page, worker, extensionUrl);
  const dashboardTwo = await openDirectory(second.page, worker, extensionUrl);
  expect((await activeSessions(worker)).map((session) => session.sourceTabId).sort()).toEqual([first.tabId, second.tabId].sort());

  await first.page.close();

  await closes(dashboardOne);
  await stays(dashboardTwo);
  await expect(directory(dashboardTwo)).toBeVisible();
  expect(await activeSessions(worker)).toEqual([expect.objectContaining({ sourceTabId: second.tabId })]);
});

test('DL05: a source that signs out ends its Dashboard, and the next account opens its own, with none of the first account\'s data', async ({ context, worker, extensionUrl }) => {
  await saveNickname(await context.newPage());
  const { page } = await threadsSource(context, worker, 'switch');
  const dashboard = await openDirectory(page, worker, extensionUrl);
  await expect(dashboard.getByText(NICKNAME, { exact: true })).toBeVisible();

  await page.goto('https://www.threads.com/?src=switch&as=none'); // the logout's replacement document: viewer null
  await closes(dashboard);
  await page.goto('https://www.threads.com/?src=switch&as=other'); // then another account signs in
  await expect.poll(async () => (await tabContext(worker, await tabIdOf(page, worker)))?.ownerThreadsUserId, { timeout: 15_000 }).toBe(OTHER_VIEWER.id);
  const other = await openDirectory(page, worker, extensionUrl);

  await expect(other.getByText(NICKNAME, { exact: true })).toHaveCount(0);
  expect((await activeSessions(worker)).map((session) => session.ownerThreadsUserId)).toEqual([OTHER_VIEWER.id]);
  const owners = await worker.evaluate(async () => Object.keys((await chrome.storage.local.get('accountBindings')).accountBindings ?? {}));
  expect(owners).toContain(VIEWER.id); // the first account's data is still there, and still its own
});

test('DL07/DL08: with two sources for one account, only the one that noticed the sign-out loses its Dashboard - until the other notices too', async ({ context, worker, extensionUrl }) => {
  const first = await threadsSource(context, worker, 'a1');
  const second = await threadsSource(context, worker, 'a2');
  const dashboardOne = await openDirectory(first.page, worker, extensionUrl);
  const dashboardTwo = await openDirectory(second.page, worker, extensionUrl);

  await first.page.goto('https://www.threads.com/?src=a1&as=none');
  await closes(dashboardOne);
  await stays(dashboardTwo); // the accepted boundary: the other tab has not noticed, so its Dashboard stands
  await expect(directory(dashboardTwo)).toBeVisible();

  await second.page.evaluate('location.reload()'); // and now it does
  await closes(dashboardTwo);
  expect(await activeSessions(worker)).toEqual([]);
});

test('DL09: pressing Open Dashboard again - or twice at once - brings the same Dashboard forward, and another source gets its own', async ({ context, worker, extensionUrl }) => {
  const first = await threadsSource(context, worker, 'dup1');
  const second = await threadsSource(context, worker, 'dup2');
  const dashboardPages = () => context.pages().filter((candidate) => candidate.url().startsWith(`${extensionUrl}/dashboard.html?session=`));

  const both = await Promise.all([requestDashboard(first.page, worker, extensionUrl), requestDashboard(first.page, worker, extensionUrl)]);
  await expect.poll(() => dashboardPages().length).toBe(1);
  expect((await activeSessions(worker)).filter((session) => session.sourceTabId === first.tabId)).toHaveLength(1);
  expect(both.map((result) => (result.answer as { sessionId: string }).sessionId)[0]).toBe((both[1].answer as { sessionId: string }).sessionId);

  const again = await requestDashboard(first.page, worker, extensionUrl);
  expect(again.answer).toMatchObject({ ok: true, sessionId: (both[0].answer as { sessionId: string }).sessionId });
  expect(dashboardPages()).toHaveLength(1);

  await requestDashboard(second.page, worker, extensionUrl);
  await expect.poll(() => dashboardPages().length).toBe(2);
  const bound = await activeSessions(worker);
  expect(bound.map((session) => session.sourceTabId).sort()).toEqual([first.tabId, second.tabId].sort());
});

test('DL10: ordinary in-page navigation and page churn do not end a Dashboard, and it can still save afterwards', async ({ page, worker, extensionUrl }) => {
  await saveNickname(page);
  await expect.poll(async () => (await tabContext(worker, await tabIdOf(page, worker)))?.state, { timeout: 15_000 }).toBe('confirmed');
  const dashboard = await openDirectory(page, worker, extensionUrl);

  // Not typed against the DOM (the e2e project has no DOM lib): these run in the Threads page.
  await page.evaluate(`(() => {
    history.pushState({}, '', '/@demo_bob/post/1'); // Feed -> Profile -> Post, as the app does it
    history.pushState({}, '', location.href); // pushState to the same URL: the same event a reload gives
    history.replaceState({}, '', '/@demo_bob');
    location.hash = '#comments';
    const frame = document.createElement('iframe');
    frame.src = 'about:blank';
    document.body.append(frame);
  })()`);
  await stays(dashboard, 2_500);

  expect(await activeSessions(worker)).toHaveLength(1);
  await expect(directory(dashboard)).toBeVisible();
  await dashboard.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await dashboard.getByRole('textbox', { name: 'Nickname', exact: true }).fill('After in-page navigation');
  await dashboard.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => storedNicknames(worker)).toContain('After in-page navigation');
});

test('DL15: a Dashboard tab the person has sent elsewhere is not closed by mistake, and nothing throws', async ({ context, worker, extensionUrl }) => {
  const { page } = await threadsSource(context, worker, 'stray');
  const dashboard = await openDirectory(page, worker, extensionUrl);
  await dashboard.goto('https://elsewhere.test/');
  await expect(dashboard.getByRole('heading', { name: 'Other site fixture' })).toBeVisible();

  await page.evaluate('location.reload()');
  await expect.poll(async () => (await activeSessions(worker)).length).toBe(0);

  await stays(dashboard, 1_500); // the unrelated page it now is stays open
  expect(dashboard.url()).toBe('https://elsewhere.test/');
});

test('DL16: closing a Dashboard ends only its session - the source keeps its account, and a new one opens', async ({ context, worker, extensionUrl }) => {
  const { page, tabId } = await threadsSource(context, worker, 'keep');
  const dashboard = await openDirectory(page, worker, extensionUrl);
  const oldUrl = dashboard.url();

  await dashboard.close();

  await expect.poll(async () => (await sessions(worker)).length).toBe(0);
  expect((await tabContext(worker, tabId))?.state).toBe('confirmed');
  expect(page.isClosed()).toBe(false);
  const fresh = await openDirectory(page, worker, extensionUrl);
  expect(fresh.url()).not.toBe(oldUrl);
  const stale = await context.newPage();
  await stale.goto(oldUrl);
  await expect(stale.getByText(LOCKED)).toBeVisible();
});

test('DL17: a source that dies while its Dashboard is being opened leaves no Dashboard that can be used', async ({ context, worker, extensionUrl }) => {
  const { page } = await threadsSource(context, worker, 'race');
  const sessionPages = () => context.pages().filter((candidate) => candidate.url().startsWith(`${extensionUrl}/dashboard.html?session=`));

  const opening = requestDashboard(page, worker, extensionUrl).catch(() => null);
  await page.close();
  await opening;

  await expect.poll(async () => (await activeSessions(worker)).length).toBe(0);
  for (const dashboard of sessionPages()) {
    await expect(dashboard.getByText(LOCKED)).toBeVisible(); // still on screen at worst, and locked
    await expect(directory(dashboard)).toHaveCount(0);
  }
});

test('DL18: the first-evidence retry runs on the browser\'s real timers without an Illegal invocation, and confirms once the page has hydrated', async ({ context, worker }) => {
  const problems: string[] = [];
  context.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  context.on('weberror', (error) => problems.push(String(error.error())));
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(error.message));

  await page.goto('https://www.threads.com/?src=hydrate&hydrate=1500'); // the viewer is not in the page until 1.5 s after load
  const tabId = await tabIdOf(page, worker);
  await expect.poll(async () => (await tabContext(worker, tabId))?.state, { timeout: 15_000 }).toBe('confirmed');

  expect(problems.filter((problem) => /Illegal invocation/.test(problem))).toEqual([]);
});
