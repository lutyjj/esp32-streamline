import { expect, type Page, test } from '@playwright/test';
import { liveSource } from './liveSource';

// The bridge console against the real bridge `make console-e2e` starts, fed by
// streamline-pcm-source, so these specs prove the bridge's behaviour, not a model.
const token = process.env.STREAMLINE_API_TOKEN;
const bridge = process.env.STREAMLINE_BRIDGE;
if (!token || !bridge) throw new Error('Run these specs through `make console-e2e`');

/** Answer the credential dialog a write opened. */
async function giveToken(page: Page, value = token ?? '') {
  await page.getByLabel('Bridge API token').fill(value);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

test('a source shows its reception and playback address, and pairing unlocks on demand', async ({
  page,
}) => {
  const id = await liveSource(page);
  await page.goto('/bridge.html#/sources');
  await page.getByRole('link', { name: id }).click();

  await expect(page.getByRole('heading', { name: id })).toBeVisible();
  await expect(page.getByText('Receiving')).toBeVisible();
  await expect(page.getByText(`/streamline.wav?source=${id}`)).toBeVisible();
  await expect(page.getByText('Connecting', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Make a new pairing token' }).click();
  await giveToken(page);
  await expect(page.getByRole('button', { name: 'Copy pairing token' })).toBeVisible();

  // The token is a secret: locking takes it off the screen.
  await page.getByRole('button', { name: /^Bridge unlocked/ }).click();
  await expect(page.getByRole('button', { name: 'Copy pairing token' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Bridge locked/ })).toBeVisible();
});

test('a recording runs from its source to a downloaded and deleted file', async ({ page }) => {
  const id = await liveSource(page);
  await page.goto(`/bridge.html#/sources/${id}`);
  await page.getByRole('button', { name: 'Record this source' }).click();
  await page.getByLabel('Title').fill('Journey take');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await giveToken(page);

  await expect(page).toHaveURL(/#\/recordings$/);
  await expect(page.getByRole('heading', { name: 'Journey take' })).toBeVisible();
  await expect(page.getByText('Recording', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop and save' }).click();
  await expect(page.getByText('“Journey take” is saved.')).toBeVisible();

  const saved = page.getByRole('listitem').filter({ hasText: 'Journey take' });
  const download = page.waitForEvent('download');
  await saved.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.wav$/);

  await saved.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(saved).toHaveCount(0);
});

test('requiring encryption drops a cleartext source until cleartext returns', async ({ page }) => {
  const id = await liveSource(page);
  const keyId = `eli1-${'ab'.repeat(16)}`;
  await page.goto('/bridge.html#/settings/security');
  await page.getByLabel('Credential ID').fill(keyId);
  await page.getByLabel('Key').fill('cd'.repeat(32));
  await page.getByRole('button', { name: 'Enroll' }).click();
  await giveToken(page);
  const credential = page.getByRole('listitem').filter({ hasText: keyId });
  await expect(credential).toContainText('Not connected');

  await page.getByRole('button', { name: 'Require encryption' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Require encryption' }).click();
  await expect(page.getByText('Encryption required')).toBeVisible();
  await page.goto(`/bridge.html#/sources/${id}`);
  await expect(page.getByText('Disconnected')).toBeVisible();

  await page.goto('/bridge.html#/settings/security');
  await page.getByRole('button', { name: 'Return to cleartext' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Return to cleartext' }).click();
  await expect(page.getByText('Cleartext', { exact: true })).toBeVisible();
  await credential.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No credential enrolled')).toBeVisible();

  await page.goto(`/bridge.html#/sources/${id}`);
  await expect(page.getByText('Receiving')).toBeVisible();
});

test('a rejected token keeps the bridge locked and says so', async ({ page }) => {
  await page.goto('/bridge.html#/sources');
  await page.getByRole('button', { name: /^Bridge locked/ }).click();
  await giveToken(page, 'not-the-bridge-token');

  await expect(page.getByText('The bridge did not accept this token.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Bridge locked/ })).toBeVisible();
});

test('a bridge without a token is read-only and names the option that sets one', async ({
  page,
}) => {
  await page.route('**/status', async (route) => {
    const status = await (await route.fetch()).json();
    await route.fulfill({ json: { ...status, api_token_configured: false } });
  });
  await page.goto('/bridge.html#/sources');
  await page.getByRole('button', { name: /^Read-only/ }).click();

  await expect(page).toHaveURL(/#\/settings\/deployment$/);
  await expect(
    page.getByText(/Set api_token in the Home Assistant app's configuration/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bridge (locked|unlocked)/ })).toHaveCount(0);
});

test('a bridge that does not record names the option that turns recording on', async ({ page }) => {
  await page.route('**/api/recordings/capabilities', async (route) => {
    const capabilities = await (await route.fetch()).json();
    await route.fulfill({ json: { ...capabilities, enabled: false } });
  });
  await page.goto('/bridge.html#/recordings');

  await expect(page.getByText('Recording is off')).toBeVisible();
  await expect(
    page.getByText(/recordings_enabled in the Home Assistant app's configuration/),
  ).toBeVisible();
});

test('the bridge serves its console at its root under its policy', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.goto(`http://${bridge}/#/sources`);
  await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
  await page.goto(`http://${bridge}/#/settings/security`);
  await expect(page.getByRole('heading', { name: 'Listener' })).toBeVisible();

  expect(violations).toEqual([]);
  expect((await page.request.get(`http://${bridge}/recordings`)).status()).toBe(404);
});

// The dev server strips `/ingress` before the bridge, as Home Assistant's ingress
// strips its own path: the console reads, writes and downloads through it.
test('under a path prefix, the console reads, writes and downloads through it', async ({
  page,
}) => {
  const id = await liveSource(page);
  const outside: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === new URL(page.url() || 'http://x/').origin &&
      !url.pathname.startsWith('/ingress/')
    )
      outside.push(url.pathname);
  });
  await page.goto('/ingress/#/sources');
  await page.getByRole('link', { name: id }).click();
  await expect(page.getByText('Receiving')).toBeVisible();
  await expect(page.getByText('a path a player cannot use')).toBeVisible();

  await page.goto('/ingress/#/recordings');
  await page.getByRole('button', { name: 'Unlock to see recordings' }).click();
  await giveToken(page);
  await page.getByLabel('Title').fill('Prefixed take');
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('heading', { name: 'Prefixed take' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop and save' }).click();
  const saved = page.getByRole('listitem').filter({ hasText: 'Prefixed take' });
  const download = page.waitForEvent('download');
  await saved.getByRole('button', { name: 'Download' }).click();
  expect(new URL((await download).url()).pathname).toMatch(/^\/ingress\/api\/recordings\//);
  await saved.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(saved).toHaveCount(0);

  expect(outside).toEqual([]);
});
