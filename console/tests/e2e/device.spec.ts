import { expect, type Page, test } from '@playwright/test';

// The device console against the fake device (src/device/mocks): linen's
// components on Preact, the hash routes, and the journeys docs/user-journey.md
// promises for what the console has so far.

/** The fake device's admin key (`MOCK_ADMIN_KEY` in src/device/mocks/device.ts). */
const mockAdminKey = 'a'.repeat(48);

async function answerKey(page: Page, key: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Unlock settings' });
  await dialog.getByLabel('Admin key').fill(key);
  await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
}

test('places and sections are hash routes that mark where the page is', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/#\/audio$/);
  const places = page.getByRole('navigation', { name: 'Device console' }).first();
  await expect(places.getByRole('link', { name: 'Audio' })).toHaveAttribute('aria-current', 'page');

  await places.getByRole('link', { name: 'Maintenance' }).click();
  await expect(page).toHaveURL(/#\/maintenance\/updates$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Maintenance' })).toBeVisible();
  await page.getByRole('link', { name: 'Diagnostics' }).click();
  await expect(page.getByRole('link', { name: 'Diagnostics' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Back retraces the moves, and a reload keeps the place.
  await page.goBack();
  await expect(page).toHaveURL(/#\/maintenance\/updates$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Maintenance' })).toBeVisible();
});

test('a locked write asks for the key, keeps a refusal beside it, then completes', async ({
  page,
}) => {
  await page.goto('/#/audio');
  await expect(page.getByText('Sending audio')).toBeVisible();
  await page.getByRole('button', { name: 'Pause streaming' }).click();

  await answerKey(page, 'f'.repeat(48));
  const field = page.getByRole('dialog').getByLabel('Admin key');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(
    page.getByText('The device did not accept this key.', { exact: false }),
  ).toBeVisible();
  await answerKey(page, mockAdminKey);

  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Settings unlocked/ })).toBeVisible();

  // Locking needs no key; the next write asks again, and declining writes nothing.
  await page.getByRole('button', { name: /^Settings unlocked/ }).click();
  await page.getByRole('button', { name: 'Resume streaming' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
});

test('a restart is narrated until the device answers from its new start', async ({ page }) => {
  await page.goto('/#/maintenance/reset');
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restart' }).click();
  await answerKey(page, mockAdminKey);
  await expect(page.getByText('Back online after the restart.')).toBeVisible();
});

test('recovery names the network it cannot find and leads to its Wi-Fi', async ({ page }) => {
  await page.goto('/?scenario=recovery#/audio');
  await expect(page.getByText('StreamLine can’t find Old router.')).toBeVisible();
  await expect(page.getByText(/retries every minute/)).toBeVisible();
  await page.getByRole('link', { name: 'Change Wi-Fi' }).click();
  await expect(page).toHaveURL(/#\/device\/wifi$/);
  await expect(page.getByText('Old router', { exact: true })).toBeVisible();
});
