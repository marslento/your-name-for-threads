import { readFile } from 'node:fs/promises';
import { test, expect, VIEWER, PROFILE, NICKNAME, saveNickname, openDirectory } from './fixtures';

type StoredDirectories = { directories: Record<string, unknown>; accountBindings: Record<string, string> };

test('post nicknames align with authors and stay visible beside hidden ghost timestamps', async ({ page }, testInfo) => {
  await saveNickname(page);
  // Reduced from the supplied Threads header: username wrappers, centered
  // metadata container, and a separate top-aligned/hidden time group.
  await page.locator('body').evaluate((body, username) => {
    const header = (ghost: boolean) => `
      <article data-layout="${ghost ? 'ghost' : 'regular'}">
        <div class="author-header">
          <span class="author-column"><div><span><div>
            <a href="/@${username}"><span>${username}</span></a>
          </div></span></div></span>
          <div class="metadata-column">
            <div class="time-line" ${ghost ? 'style="visibility:hidden"' : ''}>
              <span><a href="/@${username}/post/123"><time>1小時</time></a></span>
            </div>
          </div>
        </div>
        <p>${ghost ? 'Ghost post' : 'Regular post'}</p>
      </article>`;
    (body as unknown as { innerHTML: string }).innerHTML = `<style>
      body { margin: 16px; background: #101010; color: #eee; font: 15px/1.4 Arial, sans-serif; }
      article { padding: 16px 0; border-bottom: 1px solid #333; }
      a { color: inherit; text-decoration: none; }
      .author-header, .metadata-column { display: flex; align-items: center; overflow: hidden; }
      .author-column { font-weight: 600; }
      .metadata-column { flex: 1; min-width: 0; height: 100%; }
      .time-line { display: flex; flex-shrink: 0; line-height: 1.4; color: #777; }
    </style>${header(false)}${header(true)}`;
  }, PROFILE);

  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 600 });
    for (const kind of ['regular', 'ghost']) {
      const post = page.locator(`[data-layout="${kind}"]`);
      const nickname = post.locator('[data-tpd-nickname]');
      await expect(nickname).toHaveCount(1);
      await expect(nickname).toBeVisible();
      await expect(nickname).toHaveText(`[${NICKNAME}]`);
      const authorBox = (await post.locator('.author-column').boundingBox())!;
      const nicknameBox = (await nickname.boundingBox())!;
      expect(Math.abs(authorBox.y + authorBox.height / 2 - nicknameBox.y - nicknameBox.height / 2)).toBeLessThan(1);
      expect(nicknameBox.x).toBeGreaterThanOrEqual(authorBox.x + authorBox.width);
      expect(nicknameBox.x + nicknameBox.width).toBeLessThanOrEqual(width - 16);
      expect(await post.locator('.time-line [data-tpd-nickname]').count()).toBe(0);
    }
    await expect(page.locator('[data-layout="ghost"] time')).toBeHidden();
    await expect(page.locator('[data-layout="regular"] time')).toBeVisible();
    const path = testInfo.outputPath(`post-layout-${width}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`post-layout-${width}`, { path, contentType: 'image/png' });
  }
});

test('first-run tour finishes, opens the fixture, and stays finished after reload', async ({ page, context, extensionUrl, worker }) => {
  const popupPath = await worker.evaluate(() => chrome.runtime.getManifest().action!.default_popup!);
  await page.goto(`${extensionUrl}/${popupPath}`);
  await expect(page.getByText('Step 1 of 3', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Directory' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Step 2 of 3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Step 3 of 3', { exact: true })).toBeVisible();
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open Threads', exact: true }).click();
  const threads = await opened;
  await expect(threads).toHaveURL('https://www.threads.com/');
  await expect(threads).toHaveTitle('Local Threads fixture');
  await expect(page.getByRole('button', { name: 'Open Directory' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open Directory' })).toBeVisible();
  await expect(page.getByText('Step 1 of 3', { exact: true })).toHaveCount(0);
});

test('nickname reaches feed and Directory; backup downloads and imports without changes', async ({ page, worker, extensionUrl }, testInfo) => {
  await saveNickname(page);
  const stored = await worker.evaluate(() => chrome.storage.local.get<StoredDirectories>(['directories', 'accountBindings']));
  expect(stored.accountBindings[VIEWER.id]).toEqual(expect.any(String));
  expect(JSON.stringify(stored.directories)).toContain(`"username":"${PROFILE}"`);
  const dashboard = await openDirectory(page, worker, extensionUrl);
  await expect(dashboard.getByText(NICKNAME, { exact: true })).toBeVisible();
  const baseUrl = dashboard.url().split('#')[0];
  for (const [route, text] of [['settings', 'Show nicknames on'], ['about', 'Supported browsers']]) {
    await dashboard.goto(`${baseUrl}#/${route}`);
    await expect(dashboard.getByText(text, { exact: true })).toBeVisible();
  }
  await dashboard.goto(`${baseUrl}#/backup-sync`);
  const downloaded = dashboard.waitForEvent('download');
  await dashboard.getByRole('button', { name: 'Export Backup', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^your-name-for-threads-backup-.*\.json$/);
  const backupPath = testInfo.outputPath('synthetic-backup.json');
  await download.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  expect(backup).toMatchObject({ format: 'threads-private-directory-backup', exportedBy: { threadsUserId: VIEWER.id }, contacts: [expect.objectContaining({ nickname: NICKNAME })] });
  await dashboard.locator('input[type=file]').setInputFiles(backupPath);
  await expect(dashboard.getByRole('heading', { name: 'Import Preview', exact: true })).toBeVisible();
  await expect(dashboard.getByText('This backup changes nothing in your Directory.', { exact: true })).toBeVisible();
  await dashboard.getByRole('button', { name: 'Apply Backup', exact: true }).click();
  await expect(dashboard.getByRole('heading', { name: 'Import Complete', exact: true })).toBeVisible();
  await dashboard.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dashboard.getByRole('button', { name: 'Export Backup', exact: true })).toBeVisible();
  expect(await worker.evaluate(() => chrome.storage.local.get<StoredDirectories>(['directories', 'accountBindings']))).toEqual(stored);
});

test('damaged account is quarantined; recovery export and confirmed clear preserve another account', async ({ page, worker, extensionUrl }, testInfo) => {
  await saveNickname(page);
  const dashboard = await openDirectory(page, worker, extensionUrl);
  const healthy = { directoryId: 'other-directory', contacts: {
    other: { id: 'other', username: 'other_person', nickname: 'Other account private nickname', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', identityUpdatedAt: '2026-09-01T00:00:00.000Z' },
  }, tombstones: {}, identityIndex: { 'username:other_person': 'other' }, identityConflicts: {} };
  const damaged = { directoryId: 'wrong-id', contacts: { probe: { nickname: 'PRIVATE_RECOVERY_PROBE' } }, rawMarker: [1, 2, 3] };
  const directoryId = await worker.evaluate(async ({ owner, healthy, damaged }) => {
    const storage = await chrome.storage.local.get<StoredDirectories>(['directories', 'accountBindings']);
    const id = storage.accountBindings[owner];
    await chrome.storage.local.set({
      directories: { ...storage.directories, [id]: damaged, 'other-directory': healthy },
      accountBindings: { ...storage.accountBindings, '900800700': 'other-directory' },
    });
    return id;
  }, { owner: VIEWER.id, healthy, damaged });
  await expect(dashboard.getByRole('heading', { name: 'Your data needs recovery' })).toBeVisible();
  await expect(dashboard.getByText('PRIVATE_RECOVERY_PROBE', { exact: false })).toHaveCount(0);
  await expect(dashboard.getByRole('navigation')).toHaveCount(0);
  const downloaded = dashboard.waitForEvent('download');
  await dashboard.getByRole('button', { name: 'Export recovery data', exact: true }).click();
  const download = await downloaded;
  const path = testInfo.outputPath('synthetic-recovery.json');
  await download.saveAs(path);
  const dump = JSON.parse(await readFile(path, 'utf8'));
  expect(dump).toMatchObject({ format: 'your-name-for-threads-recovery', scope: 'directory' });
  expect(dump.storage.directories).toEqual({ [directoryId]: damaged });
  expect(dump.storage.accountBindings).toEqual({ [VIEWER.id]: directoryId });
  const clear = "Clear this account's data";
  await dashboard.getByRole('button', { name: clear, exact: true }).click();
  await dashboard.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await worker.evaluate(() => chrome.storage.local.get<StoredDirectories>('directories'))).directories[directoryId]).toEqual(damaged);
  await dashboard.getByRole('button', { name: clear, exact: true }).click();
  await dashboard.getByRole('alertdialog').getByRole('button', { name: clear, exact: true }).click();
  await expect(dashboard.getByRole('heading', { name: 'Private Directory', exact: true })).toBeVisible();
  const after = await worker.evaluate(() => chrome.storage.local.get(['directories', 'accountBindings']));
  expect(after.directories).toEqual({ 'other-directory': healthy });
  expect(after.accountBindings).toEqual({ '900800700': 'other-directory' });
});

test('loaded manifest restricts content scripts to Threads and other sites stay undecorated', async ({ page, worker }) => {
  const matches = await worker.evaluate(() => chrome.runtime.getManifest().content_scripts?.map(script => script.matches));
  expect(matches).toEqual([['https://www.threads.com/*'], ['https://www.threads.com/*']]);
  await page.goto('https://elsewhere.test/');
  await expect(page.getByRole('heading', { name: 'Other site fixture' })).toBeVisible();
  await expect(page.locator('[data-tpd-profile-host], [data-tpd-nickname]')).toHaveCount(0);
});
