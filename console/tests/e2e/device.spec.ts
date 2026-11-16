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
  const condition = page.getByText('Waiting for the restart to finish.');
  await expect(condition).toBeVisible();
  await expect(page.getByText('Back online after the restart.')).toBeVisible();
  await expect(condition).toBeHidden();
});

test('recovery names the network it cannot find and leads to its Wi-Fi', async ({ page }) => {
  await page.goto('/?scenario=recovery#/audio');
  await expect(page.getByText('StreamLine can’t find Old router.')).toBeVisible();
  await expect(page.getByText(/retries every minute/)).toBeVisible();
  await page.getByRole('link', { name: 'Change Wi-Fi' }).click();
  await expect(page).toHaveURL(/#\/device\/wifi$/);
  await expect(page.getByText('Old router', { exact: true })).toBeVisible();
});

test('first contact holds Join until the key is kept, then hands off to the home network', async ({
  page,
}) => {
  await page.goto('/?scenario=first-boot');
  await expect(page.getByRole('heading', { level: 1, name: 'Set up StreamLine' })).toBeVisible();
  // A refused Join takes the focus to the first field it refused.
  await page.getByRole('button', { name: 'Join network' }).click();
  await expect(page.getByLabel('Network name')).toBeFocused();
  await page.getByLabel('Network name').fill('home');
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Join network' }).click();
  await expect(
    page.getByText('Confirm the admin key is saved outside this console.'),
  ).toBeVisible();

  await page.getByRole('checkbox', { name: 'I saved the key outside this console' }).click();
  await page.getByRole('button', { name: 'Join network' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Joining home' })).toBeVisible();
  await expect(page.getByText('http://streamline-0000.local/')).toBeVisible();
});

test('an open network is a choice that names what it exposes', async ({ page }) => {
  await page.goto('/?scenario=first-boot');
  await page.getByLabel('Network name').fill('Cafe guest');
  await page.getByRole('button', { name: 'Join network' }).click();
  await expect(
    page.getByText('Enter the network’s password, or choose an open network.'),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'This network has no password' }).click();
  await expect(page.getByText('Anyone in range can join an open network.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'I saved the key outside this console' }).click();
  await page.getByRole('button', { name: 'Join network' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Joining Cafe guest' })).toBeVisible();
});

test('recovery changes Wi-Fi with the admin key and hands off', async ({ page }) => {
  await page.goto('/?scenario=recovery#/device/wifi');
  await page.getByLabel('Network name').fill('home');
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Join network' }).click();
  await page
    .getByRole('dialog', { name: 'Join home?' })
    .getByRole('button', { name: 'Join network' })
    .click();
  await answerKey(page, mockAdminKey);
  await expect(page.getByRole('heading', { level: 1, name: 'Joining home' })).toBeVisible();
});

test('a found bridge fills the form, and only Save writes it and restarts', async ({ page }) => {
  await page.goto('/#/bridge');
  await page.getByRole('link', { name: 'Change bridge' }).click();
  await expect(page).toHaveURL(/#\/bridge\/target$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Connect a bridge' })).toBeVisible();

  await page.getByRole('button', { name: 'Search the network' }).click();
  const found = page.getByRole('listitem').filter({ hasText: '192.0.2.21:39000' });
  await found.getByRole('button', { name: 'Use' }).click();
  await expect(page.getByLabel('Bridge address')).toHaveValue('192.0.2.21');
  await expect(found.getByRole('button', { name: 'Use' })).toBeDisabled();

  // Use saved nothing: leaving asks first, and staying keeps the draft.
  await page.getByRole('link', { name: 'Bridge', exact: true }).first().click();
  const leave = page.getByRole('dialog', { name: 'Leave without saving?' });
  await leave.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Bridge address')).toHaveValue('192.0.2.21');

  await page.getByRole('button', { name: 'Save' }).click();
  await answerKey(page, mockAdminKey);
  await expect(page).toHaveURL(/#\/bridge$/);
  await expect(page.getByText('Back online after the bridge change.')).toBeVisible();
  await expect(page.getByText(/^192\.0\.2\.21:39000$/)).toBeVisible();
});

test('adjusting the input holds a draft until Save, and leaving it asks first', async ({
  page,
}) => {
  await page.goto('/#/audio');
  await page.getByRole('link', { name: 'Adjust input' }).click();
  await expect(page).toHaveURL(/#\/audio\/levels$/);
  await page.getByLabel('Gain').fill('12');

  await page.getByRole('link', { name: 'Audio', exact: true }).first().click();
  await page
    .getByRole('dialog', { name: 'Leave without saving?' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.getByLabel('Gain')).toHaveValue('12');

  await page.getByRole('button', { name: 'Save' }).click();
  await answerKey(page, mockAdminKey);
  await expect(page.getByText('Input levels saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.getByRole('link', { name: 'Audio', exact: true }).first().click();
  await expect(page).toHaveURL(/#\/audio$/);
  await expect(page.getByText(/gain 12 ·/)).toBeVisible();
});

test('a profile keeps the applied levels and is chosen on Audio', async ({ page }) => {
  await page.goto('/#/audio');
  await page.getByRole('link', { name: 'Manage profiles' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Profiles' })).toBeVisible();
  await page.getByRole('button', { name: 'Save applied levels' }).click();
  const naming = page.getByRole('dialog', { name: 'Save the applied levels' });
  await naming.getByLabel('Name').fill('Loud room');
  await naming.getByRole('button', { name: 'Save' }).click();
  await answerKey(page, mockAdminKey);
  await expect(naming).toBeHidden();
  await expect(page.getByRole('listitem').filter({ hasText: 'Loud room' })).toBeVisible();

  await page.getByRole('link', { name: 'Audio', exact: true }).first().click();
  await expect(page.getByRole('combobox', { name: 'Profile' })).toBeVisible();
});

test('calibration names playback heard while it measures the quiet, and cancels to Audio', async ({
  page,
}) => {
  await page.goto('/#/audio/levels');
  await page.getByRole('link', { name: 'Calibrate' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Calibrate' })).toBeVisible();
  await page.getByRole('button', { name: 'Measure the quiet' }).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  // The fake device's input always plays.
  await expect(page.getByText('That sounds like playback', { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/#\/audio$/);
});
