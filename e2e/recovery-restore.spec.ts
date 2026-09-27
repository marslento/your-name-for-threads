import { readFile } from 'node:fs/promises';
import type { Page, TestInfo, Worker } from '@playwright/test';
import { test, expect, VIEWER, NICKNAME, saveNickname, openDirectory } from './fixtures';

// Recovery Restore 1.1.0 in the built extension (Chromium, synthetic Threads pages and data only). This is not the
// Chrome/Edge manual acceptance: that is recorded separately against the release candidate.

type Stored = { directories: Record<string, { contacts?: Record<string, unknown> }>; accountBindings: Record<string, string> };
const snapshot = (worker: Worker) => worker.evaluate(() => chrome.storage.local.get<Stored>(['directories', 'accountBindings']));

/** The damage the old username fallback left: a second numeric lookup entry for a contact that stores another ID (or none). */
async function damageLookupIndex(worker: Worker, owner: string) {
  await worker.evaluate(async (owner) => {
    const all = await chrome.storage.local.get<{ directories: Record<string, { contacts: Record<string, unknown>; identityIndex?: Record<string, string> }>; accountBindings: Record<string, string> }>(['directories', 'accountBindings']);
    const id = all.accountBindings[owner];
    const directory = all.directories[id];
    const [contactId] = Object.keys(directory.contacts);
    await chrome.storage.local.set({ directories: { ...all.directories, [id]: { ...directory, identityIndex: { ...directory.identityIndex, 'threads:1': contactId } } } });
  }, owner);
}

async function exportRecoveryFile(dashboard: Page, testInfo: TestInfo, name: string) {
  const downloaded = dashboard.waitForEvent('download');
  await dashboard.getByRole('button', { name: 'Export recovery data', exact: true }).click();
  const path = testInfo.outputPath(name);
  await (await downloaded).saveAs(path);
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ format: 'your-name-for-threads-recovery', scope: 'directory' });
  return path;
}

async function confirmRestore(dashboard: Page) {
  await dashboard.getByRole('button', { name: 'Restore', exact: true }).click();
  await dashboard.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }).click();
}

const restoredNotice = 'Directory restored. Contacts: 1, deleted records: 0. You can now export a normal backup.';

test('the Recovery page restores a damaged Directory from its own recovery file, and writes nothing before the confirmation', async ({ page, worker, extensionUrl }, testInfo) => {
  await saveNickname(page);
  const dashboard = await openDirectory(page, worker, extensionUrl);
  const good = await snapshot(worker);
  const directoryId = good.accountBindings[VIEWER.id];
  await damageLookupIndex(worker, VIEWER.id);
  await expect(dashboard.getByRole('heading', { name: 'Your data needs recovery' })).toBeVisible();
  const file = await exportRecoveryFile(dashboard, testInfo, 'synthetic-recovery-direct.json');
  const damaged = await snapshot(worker);

  await dashboard.getByLabel('Choose Recovery File', { exact: true }).setInputFiles(file);
  await expect(dashboard.getByText("This file matches this account's damaged directory, which can be repaired from it.", { exact: true })).toBeVisible();
  await expect(dashboard.getByText('Keeps the ID each contact currently stores. This restore does not verify Threads identities.', { exact: true })).toBeVisible();
  expect(await snapshot(worker), 'analysing the file wrote nothing').toEqual(damaged);
  await dashboard.getByRole('button', { name: 'Restore', exact: true }).click();
  await dashboard.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dashboard.getByRole('alertdialog')).toHaveCount(0);
  expect(await snapshot(worker), 'a cancelled confirmation wrote nothing').toEqual(damaged);

  await confirmRestore(dashboard);

  await expect(dashboard.getByRole('heading', { name: 'Private Directory', exact: true })).toBeVisible();
  await expect(dashboard.getByText(restoredNotice, { exact: true })).toBeVisible();
  await expect(dashboard.getByText(NICKNAME, { exact: true })).toBeVisible();
  const restored = await snapshot(worker);
  expect(restored.accountBindings).toEqual(good.accountBindings);
  expect(restored.directories[directoryId].contacts).toEqual(good.directories[directoryId].contacts);

  // A normal backup of the restored Directory still round-trips.
  await dashboard.goto(`${dashboard.url().split('#')[0]}#/backup-sync`);
  const downloaded = dashboard.waitForEvent('download');
  await dashboard.getByRole('button', { name: 'Export Backup', exact: true }).click();
  const backupPath = testInfo.outputPath('synthetic-backup-after-restore.json');
  await (await downloaded).saveAs(backupPath);
  await dashboard.getByLabel('Choose JSON Backup File', { exact: true }).setInputFiles(backupPath);
  await expect(dashboard.getByText('This backup changes nothing in your Directory.', { exact: true })).toBeVisible();
});

test('after a clear, Backup & Import restores the same recovery file into the empty account', async ({ page, worker, extensionUrl }, testInfo) => {
  await saveNickname(page);
  const dashboard = await openDirectory(page, worker, extensionUrl);
  const good = await snapshot(worker);
  const directoryId = good.accountBindings[VIEWER.id];
  await damageLookupIndex(worker, VIEWER.id);
  await expect(dashboard.getByRole('heading', { name: 'Your data needs recovery' })).toBeVisible();
  const file = await exportRecoveryFile(dashboard, testInfo, 'synthetic-recovery-cleared.json');
  const clear = "Clear this account's data";
  await dashboard.getByRole('button', { name: clear, exact: true }).click();
  await dashboard.getByRole('alertdialog').getByRole('button', { name: clear, exact: true }).click();
  await expect(dashboard.getByRole('heading', { name: 'Private Directory', exact: true })).toBeVisible();
  const cleared = await snapshot(worker);
  expect(cleared.accountBindings[VIEWER.id]).toBeUndefined();

  await dashboard.goto(`${dashboard.url().split('#')[0]}#/backup-sync`);
  await expect(dashboard.getByRole('heading', { name: 'Restore from a recovery file', exact: true })).toBeVisible();
  await expect(dashboard.getByRole('button', { name: 'Export Backup', exact: true })).toHaveCount(0);
  await dashboard.getByLabel('Choose Recovery File', { exact: true }).setInputFiles(file);
  await expect(dashboard.getByText("This file can be restored into this account's empty directory.", { exact: true })).toBeVisible();
  expect(await snapshot(worker), 'analysing the file wrote nothing').toEqual(cleared);

  await confirmRestore(dashboard);

  await expect(dashboard.getByText(restoredNotice, { exact: true })).toBeVisible();
  await expect(dashboard.getByRole('button', { name: 'Export Backup', exact: true })).toBeVisible();
  const restored = await snapshot(worker);
  expect(restored.accountBindings[VIEWER.id]).toBe(directoryId);
  expect(restored.directories[directoryId].contacts).toEqual(good.directories[directoryId].contacts);

  // The same file again is refused now that the account has data, and nothing is offered to get around that.
  await dashboard.getByLabel('Choose Recovery File', { exact: true }).setInputFiles(file);
  await expect(dashboard.getByText('This account already has data. This version does not merge or overwrite, and your current data is unchanged. Keep the recovery file.', { exact: true })).toBeVisible();
  expect(await snapshot(worker)).toEqual(restored);
});
