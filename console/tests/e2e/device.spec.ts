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
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restart' }).click();
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
  await page.getByRole('textbox', { name: 'Password' }).fill('correct horse');
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
  await page.getByRole('checkbox', { name: 'I saved the key outside this console' }).click();
  await page.getByRole('button', { name: 'Join network' }).click();
  // The device refuses a protected network without a password, on that field.
  await expect(page.getByRole('textbox', { name: 'Password' })).toHaveAccessibleDescription(
    /A protected network needs its password/,
  );
  await page.getByRole('checkbox', { name: 'This network has no password' }).click();
  await expect(page.getByText('Anyone in range can join an open network.')).toBeVisible();
  await page.getByRole('button', { name: 'Join network' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Joining Cafe guest' })).toBeVisible();
});

test('recovery changes Wi-Fi with the admin key and hands off', async ({ page }) => {
  await page.goto('/?scenario=recovery#/device/wifi');
  await page.getByLabel('Network name').fill('home');
  await page.getByRole('textbox', { name: 'Password' }).fill('correct horse');
  await page.getByRole('button', { name: 'Join network' }).click();
  await page
    .getByRole('alertdialog', { name: 'Join home?' })
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
  const leave = page.getByRole('alertdialog', { name: 'Leave without saving?' });
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
    .getByRole('alertdialog', { name: 'Leave without saving?' })
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

test('Connect a bridge opened directly shows the saved target', async ({ page }) => {
  await page.goto('/#/bridge/target');
  await expect(page.getByLabel('Bridge address')).toHaveValue('192.0.2.20');
  await expect(page.getByLabel('Port')).toHaveValue('39000');
});

test('a button set to factory reset asks first and then warns on its row', async ({ page }) => {
  await page.goto('/#/device/hardware');
  await page.getByRole('combobox', { name: 'Key 3 action' }).click();
  await page.getByRole('option', { name: 'Factory reset' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Make Key 3 a factory reset button?' });
  await ask.getByRole('button', { name: 'Make it factory reset' }).click();
  await answerKey(page, mockAdminKey);
  await expect(ask).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Key 3 action' })).toHaveText(/Factory reset/);
  await expect(page.getByText('One press erases every setting', { exact: false })).toBeVisible();

  // A light changes as it is chosen, and the name reaches the rail and the tab.
  await page.getByRole('radio', { name: 'Off' }).click();
  await expect(page.getByText('Always dark.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Turntable');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveTitle('Turntable · StreamLine');
});

test('a new admin key is kept before it saves, then the device takes only it', async ({ page }) => {
  await page.goto('/#/device/access');
  await page.getByRole('button', { name: 'Replace admin key' }).click();
  const next = await page.getByLabel('New admin key', { exact: true }).textContent();
  expect(next).toMatch(/^[0-9a-f]{48}$/);

  await page.getByRole('button', { name: 'Save new key' }).click();
  await expect(page.getByText('Confirm the new key is saved outside this console.')).toBeVisible();
  await page.getByText('I saved the new key outside this console').click();
  await page.getByRole('button', { name: 'Save new key' }).click();
  await answerKey(page, mockAdminKey);
  await expect(page.getByText('The device takes the new admin key now.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Settings unlocked/ })).toBeVisible();

  // Locked again, the old key is refused and the new one opens the next change.
  await page.getByRole('button', { name: /^Settings unlocked/ }).click();
  await page.getByRole('button', { name: /^Settings locked/ }).click();
  await answerKey(page, mockAdminKey);
  await expect(
    page.getByText('The device did not accept this key.', { exact: false }),
  ).toBeVisible();
  await answerKey(page, next ?? '');
  await expect(page.getByRole('button', { name: /^Settings unlocked/ })).toBeVisible();
});

test('the theme is chosen at the foot of the rail', async ({ page }) => {
  await page.goto('/#/audio');
  await page.getByRole('radio', { name: 'Dark' }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('an update is checked, installed with its progress, and rolled back', async ({ page }) => {
  await page.goto('/#/maintenance/updates');
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await answerKey(page, mockAdminKey);
  await expect(page.getByText('Version 0.5.0-mock is available.')).toBeVisible();

  await page.getByRole('button', { name: 'Install 0.5.0-mock' }).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(page.getByText('Waiting for the firmware update to finish.')).toBeVisible();
  await expect(page.getByText('Updated to 0.5.0-mock.')).toBeVisible();
  await expect(page.getByText('Finished')).toBeVisible();

  await page.getByRole('button', { name: 'Roll back' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByText('Back online after the rollback.')).toBeVisible();
  await expect(page.getByText('Went back to the previous image')).toBeVisible();
});

test('the log and the crash dump open with the key', async ({ page }) => {
  await page.goto('/#/maintenance/diagnostics');
  await page.getByRole('button', { name: 'Unlock to read' }).click();
  await answerKey(page, mockAdminKey);
  await expect(page.getByText('codec: ES8388 ready at 48000 Hz')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^streamline-.+-coredump\.bin$/);
  await page.getByRole('button', { name: 'Erase' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erase' }).click();
  await expect(page.getByText('No crash dump is stored')).toBeVisible();
});

test('a factory reset ends on the setup network it names', async ({ page }) => {
  await page.goto('/#/maintenance/reset');
  await page.getByRole('button', { name: 'Factory reset' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Factory reset' }).click();
  await answerKey(page, mockAdminKey);
  await expect(
    page.getByRole('heading', { level: 1, name: 'The device is ready to set up again' }),
  ).toBeVisible();
  await expect(page.getByText('http://192.168.71.1/')).toBeVisible();
});
