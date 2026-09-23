import { expect, test } from '@playwright/test';

// The real bridge's API token, as `make console-e2e` configures it.
const token = process.env.STREAMLINE_API_TOKEN;
if (!token)
  throw new Error('STREAMLINE_API_TOKEN is unset — run these specs via `make console-e2e`');

// Bridge enrollment, per docs/user-journey.md stage 3: unlock with the API
// token, enroll the device credential, then switch the listener to encrypted.
// The bridge is the real one, so these specs prove its behavior, not a model.
test('enroll a credential and switch the bridge to encrypted', async ({ page }) => {
  await page.goto('/bridge.html');
  await page.getByRole('button', { name: /^Locked/ }).click();
  await page.getByPlaceholder('bridge API token').fill(token);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Unlocked/ })).toBeVisible();

  const keyId = `eli1-${'ab'.repeat(16)}`;
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Audio security', exact: true }).click();
  await page.getByLabel('Credential ID').fill(keyId);
  await page.getByLabel('PSK').fill('cd'.repeat(32));
  await page.getByRole('button', { name: 'Enroll credential' }).click();
  await expect(page.getByText(keyId)).toBeVisible();

  await page.getByRole('button', { name: 'Require encryption', exact: true }).click();
  await expect(page.getByText('All cleartext connections will close.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Require encryption for every device', exact: true })
    .click();
  await expect(page.getByText('Encrypted · TLS 1.3')).toBeVisible();
});

// The stage's failure promise: a rejected credentialed unlock names the
// failure and leaves the bridge locked.
test('a rejected token keeps the bridge locked and names the failure', async ({ page }) => {
  await page.goto('/bridge.html');
  await page.getByRole('button', { name: /^Locked/ }).click();
  await page.getByPlaceholder('bridge API token').fill('not-the-bridge-token');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();

  await expect(
    page.getByText('Enter the bridge API token configured on this bridge.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
});

test('production bridge loads its bundled font and recording entry routes', async ({ page }) => {
  const host = process.env.STREAMLINE_BRIDGE;
  if (!host) throw new Error('Run through make console-e2e');
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/font-src|Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  for (const path of ['/recordings', '/recordings/']) {
    await page.goto(`http://${host}${path}`);
    await expect(page.getByRole('heading', { name: 'Recordings', exact: true })).toBeVisible();
    const loaded = await page.evaluate(async () => {
      const faces = await document.fonts.load('400 16px "Nunito Sans Variable"');
      return faces.length > 0 && faces.every((face) => face.status === 'loaded');
    });
    expect(loaded).toBe(true);
  }
  expect(violations).toEqual([]);
});

test('credential removal names the device, supports cancel, and retains a rejection', async ({
  page,
  request,
}) => {
  const keyId = `eli1-${'ef'.repeat(16)}`;
  await request.put(`/api/transport/keys/${keyId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { psk: 'ab'.repeat(32) },
  });
  await page.goto('/bridge.html#/settings/security');
  await page.getByRole('button', { name: /^Locked/ }).click();
  await page.getByPlaceholder('bridge API token').fill(token);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  const row = page.locator('.transport-key').filter({ hasText: keyId });
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Remove credential ${keyId}?` });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toContainText('live audio connections');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(row.getByRole('button', { name: 'Remove', exact: true })).toBeFocused();
  await page.route(`**/api/transport/keys/${keyId}`, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'busy', message: 'Device is busy. Try again.' } }),
        })
      : route.continue(),
  );
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Device is busy');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
