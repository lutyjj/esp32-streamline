import { expect, test } from '@playwright/test';
import { MOCK_BRIDGE_TOKEN } from '../../src/mocks/bridge';

// Bridge enrollment, per docs/user-journey.md stage 3: unlock with the API
// token, enroll the device credential, then switch the listener to encrypted.
test('enroll a credential and switch the bridge to encrypted', async ({ page }) => {
  await page.goto('/bridge.html');
  await page.getByRole('button', { name: /^Locked/ }).click();
  await page.getByPlaceholder('bridge API token').fill(MOCK_BRIDGE_TOKEN);
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
  await page.getByPlaceholder('bridge API token').fill('wrong-token');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();

  await expect(page.getByText('invalid API token')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
});
