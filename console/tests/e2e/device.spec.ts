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
  await expect(page.getByText(/Settings saved\. Reconnect/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Unlocked/ })).toBeVisible();
});

// Stage 6, per docs/user-journey.md: a provisioned device that cannot reach its
// Wi-Fi explains why on its setup network instead of opening first-run setup,
// and a Wi-Fi change keeps its key and target and ends in the network handoff.
test('recovery: the cause is named and a Wi-Fi change hands off', async ({ page }) => {
  await page.goto('/?scenario=recovery');
  await expect(page.getByText(/can’t find home\. It retries every minute/)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'First-run setup' })).toBeHidden();
  await expect(page.getByText('Waiting for Wi-Fi')).toBeVisible();

  await page.getByRole('link', { name: 'Change Wi-Fi' }).click();
  await page.getByRole('button', { name: 'Startup report' }).click();
  await expect(page.getByText(/^v0\.9\.0: .*network-not-found/)).toBeVisible();
  await page.getByRole('button', { name: 'Unlock to edit' }).click();
  await page.getByPlaceholder('admin key').fill(mockAdminKey);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByLabel('Network name').fill('New Wi-Fi');
  await page.getByRole('button', { name: 'Save & restart' }).click();

  await expect(
    page.getByText(/Settings saved\. Reconnect to your own Wi-Fi/).first(),
  ).toBeVisible();
  const settings = await page.evaluate(async () => (await fetch('/api/settings')).json());
  expect(settings.ssid).toBe('New Wi-Fi');
  expect(settings.target_host).not.toBe('');
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

test('audio drafts survive navigation and profiles capture saved settings', async ({ page }) => {
  await page.goto('/#/audio');
  await unlock(page);
  await page.getByRole('button', { name: 'Adjust input', exact: true }).click();
  await page.getByLabel('Input gain').fill('12');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Audio', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByLabel('Input gain')).toHaveValue('12');
  await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save current settings as a profile' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Input settings applied')).toBeVisible();
  await page.getByLabel('Profile name').fill('Turntable');
  await page.getByRole('button', { name: 'Save current settings as a profile' }).click();
  await expect(page.getByLabel('Saved profile')).toContainText('Turntable');
  const catalog = await page.evaluate(async () => (await fetch('/api/audio-profiles')).json());
  expect(catalog.profiles[0].audio.input_gain).toBe(12);
});

test('commissioning key custody is explicit across two browser origins', async ({ page }) => {
  // Deterministic entropy aligns the commissioned key with the steady fake device.
  await page.addInitScript(() => {
    crypto.getRandomValues = ((bytes: Uint8Array) =>
      bytes.fill(0xaa)) as typeof crypto.getRandomValues;
  });
  await page.goto('/?scenario=first-boot');
  const setup = page.getByRole('dialog', { name: 'First-run setup' });
  await setup.getByLabel('Your Wi-Fi network').fill('home');
  await setup.getByLabel('Wi-Fi password').fill('correct horse');
  await setup.getByRole('button', { name: 'Continue' }).click();
  await expect(setup.getByText(/Browser storage only remembers this address/)).toBeVisible();
  // biome-ignore lint/performance/useDomNodeTextContent: a Playwright locator reads the rendered key the user copies, not a DOM property.
  const savedKey = await setup.locator('.keyblock').innerText();
  await setup.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(setup.getByLabel('Your Wi-Fi network')).toHaveValue('home');
  await setup.getByRole('button', { name: 'Continue' }).click();
  await setup.getByRole('button', { name: 'I saved my key, join network' }).click();
  await expect(setup.getByRole('heading', { name: 'Joining home…' })).toBeVisible();
  // localhost and 127.0.0.1 are separate origins; storage must not imply transfer.
  await page.goto('http://localhost:5173/');
  await page.getByRole('button', { name: /^Locked/ }).click();
  await expect(page.getByPlaceholder('admin key')).toHaveValue('');
  await page.getByPlaceholder('admin key').fill(savedKey);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Unlocked/ })).toBeVisible();
});

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

  // An external API client answers the digest challenge with nothing but
  // standard web crypto (`crypto.subtle` exists here because the e2e server
  // is a secure localhost origin) — proof the API needs no custom client.
  await page.evaluate(async (key) => {
    const hex = (buffer: ArrayBuffer) =>
      [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const sha256 = async (text: string) =>
      hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    const pause = () =>
      new Request('/api/stream', {
        method: 'POST',
        body: new URLSearchParams({ enabled: 'false' }),
      });

    const challenged = await fetch(pause());
    const header = challenged.headers.get('WWW-Authenticate') ?? '';
    const nonce = /nonce="([^"]+)"/.exec(header)?.[1] ?? '';
    const realm = /realm="([^"]+)"/.exec(header)?.[1] ?? '';
    const ha1 = await sha256(`admin:${realm}:${key}`);
    const ha2 = await sha256('POST:/api/stream');
    const response = await sha256(`${ha1}:${nonce}:00000001:e2e:auth:${ha2}`);
    const answered = pause();
    answered.headers.set(
      'Authorization',
      `Digest username="admin", realm="${realm}", nonce="${nonce}", uri="/api/stream", ` +
        `response="${response}", qop=auth, nc=00000001, cnonce="e2e", algorithm=SHA-256`,
    );
    await fetch(answered);
  }, mockAdminKey);

  // The next status poll names the state in the tile and the callout.
  await expect(page.getByText('Streaming is paused. The input meter stays live.')).toBeVisible();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Streaming is paused. The input meter stays live.')).toBeHidden();
  await expect(page.getByText('Sending audio', { exact: true })).toBeVisible();
});

// System → Buttons: assigning an action reaches the device — the settings
// read-back reports it, not just this browser's optimistic state — and a
// destructive assignment warns in place before any press can fire it.
test('a button action assignment reaches the device and warns when destructive', async ({
  page,
}) => {
  await page.goto('/');
  await unlock(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();

  const key3 = page.getByLabel('Key 3 action');
  await page.getByRole('link', { name: /Device Name, lights/ }).click();
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

// Stage 2, per docs/user-journey.md: the device offers the bridges it finds on
// its network. Use fills the target fields and only Save writes them, so
// typing an address stays possible beside the list.
test('a discovered bridge fills the stream target and only Save writes it', async ({ page }) => {
  const target = async () =>
    (await page.evaluate(async () => (await fetch('/api/settings')).json())).target_host;
  await page.goto('/#/settings/bridge');
  await unlock(page);

  await page.getByRole('button', { name: 'Find bridges' }).click();
  await expect(page.getByText('Found 2 bridges on your network.')).toBeVisible();
  await page.getByRole('button', { name: 'Use StreamLine Bridge-2' }).click();

  await expect(page.getByLabel('Host or IP')).toHaveValue('192.0.2.21');
  await expect(page.getByText('Entered below')).toBeVisible();
  expect(await target()).not.toBe('192.0.2.21');
  await page.getByRole('button', { name: 'Save & restart' }).click();
  await expect.poll(target).toBe('192.0.2.21');
});

// The bridge guide searches as it asks for the bridge, and a bridge that
// advertises its console port also fills the player handoff's console address.
test('the bridge guide offers found bridges and their console address', async ({ page }) => {
  await page.goto('/#/settings/bridge');
  await unlock(page);
  await page.getByRole('button', { name: 'Guide me' }).click();
  const guide = page.getByRole('dialog', { name: 'Bridge setup' });
  await guide.getByRole('button', { name: 'Continue' }).click();

  await guide.getByRole('button', { name: 'Use StreamLine Bridge-2' }).click();
  await expect(guide.getByLabel('Host or IP')).toHaveValue('192.0.2.21');
  await guide.getByRole('button', { name: 'Save & connect' }).click();
  await guide.getByRole('button', { name: 'Continue' }).click();

  await expect(guide.getByLabel('Bridge console address')).toHaveValue('http://192.0.2.21:8088/');
  await expect(guide.getByRole('link', { name: 'Open bridge to listen' })).toBeVisible();
});
