import { expect, type Page, test } from '@playwright/test';

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

/** The fake device's admin key (`MOCK_ADMIN_KEY` in src/mocks/device.ts). */
const mockAdminKey = 'a'.repeat(48);

async function unlock(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Locked/ }).click();
  await page.getByPlaceholder('admin key').fill(mockAdminKey);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Unlocked/ })).toBeVisible();
}

// Stage 5's paused-state promise, per docs/user-journey.md: a press never
// leaves a mystery. Something outside this browser — a device button, an API
// client — pauses streaming; the Overview must name the state and offer the
// way out.
test('an out-of-band streaming pause is named and recoverable', async ({ page }) => {
  await page.goto('/');
  await unlock(page);

  await page.evaluate(async (key) => {
    await fetch('/api/stream', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: new URLSearchParams({ enabled: 'false' }),
    });
  }, mockAdminKey);

  // The next status poll names the state in the tile and the callout.
  await expect(page.getByText('Streaming is paused.')).toBeVisible();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Streaming is paused.')).toBeHidden();
  await expect(page.getByText('Streaming', { exact: true })).toBeVisible();
});

// System → Buttons: assigning an action reaches the device — the settings
// read-back reports it, not just this browser's optimistic state — and a
// destructive assignment warns in place before any press can fire it.
test('a button action assignment reaches the device and warns when destructive', async ({
  page,
}) => {
  await page.goto('/');
  await unlock(page);
  await page.getByRole('link', { name: 'System' }).click();

  const key3 = page.getByLabel('Key 3 action');
  await expect(key3).toHaveValue('none');
  await key3.selectOption('factory_reset');
  await expect(page.getByText('one press, no confirmation')).toBeVisible();

  await expect
    .poll(async () => {
      const settings = await page.evaluate(async () => (await fetch('/api/settings')).json());
      const entry = settings.button_actions.find(
        (action: { id: string; action: string }) => action.id === 'key3',
      );
      return entry?.action;
    })
    .toBe('factory_reset');
});
