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
  await page.getByLabel('Credential ID').fill(keyId);
  await page.getByLabel('PSK').fill('cd'.repeat(32));
  await page.getByRole('button', { name: 'Enroll credential' }).click();
  await expect(page.getByText(keyId)).toBeVisible();

  await page.getByText('Encrypt incoming audio', { exact: true }).click();
  await expect(page.getByRole('switch', { name: /Encrypt incoming audio/ })).toBeChecked();
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
