import { expect, test } from '@playwright/test';

// The device console's first journey, per docs/user-journey.md stage 2:
// three onboarding steps, the key shown once, the handoff narrated, and the
// commissioning browser left unlocked on the provisioned device.
test('first boot: Wi-Fi, admin key, join, provisioned', async ({ page }) => {
  await page.goto('/?scenario=first-boot');
  const setup = page.getByRole('dialog', { name: 'First-run setup' });
  await expect(setup).toBeVisible();

  await setup.getByLabel('Your Wi-Fi network').fill('home');
  await setup.getByLabel('Wi-Fi password').fill('correct horse');
  await setup.getByRole('button', { name: 'Continue' }).click();

  // The generated admin key appears once, in full.
  await expect(setup.getByText(/^[0-9a-f]{48}$/)).toBeVisible();
  await setup.getByRole('button', { name: 'I saved my key, join network' }).click();

  // The join step explains the handoff and names the home address.
  await expect(setup.getByRole('heading', { name: 'Joining home…' })).toBeVisible();
  await expect(setup.getByText('http://streamline-0000.local/')).toBeVisible();
  await setup.getByRole('button', { name: 'Close' }).click();

  // Provisioned: the handoff story stays visible and this browser is unlocked.
  await expect(page.getByText('The setup network disappears now')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Unlocked/ })).toBeVisible();
});

// Stage 2's failure promise: a rejected key names the rejection and leaves
// settings locked.
test('a wrong admin key is rejected and settings stay locked', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Locked/ }).click();
  await page.getByPlaceholder('admin key').fill('f'.repeat(48));
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();

  await expect(page.getByText('admin key rejected')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Locked/ })).toBeVisible();
});
