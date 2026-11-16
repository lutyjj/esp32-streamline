import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { liveSource } from './liveSource';

/** A screenshot's name for `path`, with the source's own id left out. */
function name(path: string, source: string): string {
  return path.replace(source, 'source').replaceAll(/[^a-z]/g, '-');
}

/** A whole screen, within the width it is drawn at, for review. */
async function shoot(page: Page, info: TestInfo, width: number, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

const DEVICE_SCREENS = [
  '/#/audio',
  '/#/bridge',
  '/#/device/wifi',
  '/#/device/hardware',
  '/#/device/access',
  '/#/maintenance/updates',
  '/#/maintenance/diagnostics',
  '/#/maintenance/api',
  '/#/maintenance/reset',
];

for (const width of [390, 800, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`device console screens at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const path of DEVICE_SCREENS) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(
          page.getByRole('button', { name: /^Settings (locked|unlocked)/ }),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.screenshot({
          path: info.outputPath(`device${path.replaceAll(/[^a-z]/g, '-')}.png`),
          fullPage: true,
        });
      }
    });

    test(`bridge console screens at ${width}px in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const source = await liveSource(page);
      // Unlocked first, so Recordings shows its sessions and files.
      await page.goto('/bridge.html#/recordings');
      await page.getByRole('button', { name: 'Unlock to see recordings' }).click();
      await page.getByLabel('Bridge API token').fill(process.env.STREAMLINE_API_TOKEN ?? '');
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      // Each screen with the content that marks it drawn, not only its title.
      const screens: [string, string][] = [
        ['/bridge.html#/sources', source],
        [`/bridge.html#/sources/${source}`, 'Reception'],
        ['/bridge.html#/recordings', 'Saved recordings'],
        ['/bridge.html#/settings/security', 'Listener'],
        ['/bridge.html#/settings/deployment', 'Version'],
      ];
      for (const [path, drawn] of screens) {
        await page.goto(path);
        await expect(page.getByText(drawn, { exact: true }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /^Bridge unlocked/ })).toBeVisible();
        await shoot(page, info, width, `bridge${name(path, source)}`);
      }
      // A deployment without a token, then one without recording storage either.
      await page.route('**/status', async (route) => {
        const json = await (await route.fetch()).json();
        await route.fulfill({ json: { ...json, api_token_configured: false } });
      });
      const readOnly: [string, string][] = [
        ['/bridge.html#/recordings', 'Recordings need the bridge API token'],
        ['/bridge.html#/settings/security', 'Listener'],
        [`/bridge.html#/sources/${source}`, 'Reception'],
        ['/bridge.html#/settings/deployment', 'Version'],
      ];
      for (const [path, drawn] of readOnly) {
        // A fresh page, so it reads the overridden answers rather than the ones it holds.
        await page.goto('about:blank');
        await page.goto(path);
        await expect(page.getByText(drawn, { exact: true }).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /^Read-only/ })).toBeVisible();
        await shoot(page, info, width, `bridge-read-only${name(path, source)}`);
      }
      await page.route('**/api/recordings/capabilities', async (route) => {
        const json = await (await route.fetch()).json();
        await route.fulfill({ json: { ...json, enabled: false } });
      });
      await page.goto('about:blank');
      await page.goto('/bridge.html#/recordings');
      await expect(page.getByText('Recording is off')).toBeVisible();
      await shoot(page, info, width, 'bridge-recording-off');
    });

    test(`flasher at ${width}px in ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto('/flasher.html');
      await expect(page.getByRole('button', { name: 'Connect & install' })).toBeVisible();
      await shoot(page, info, width, 'flasher');
      await page.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, 'serial'));
      await page.goto('/flasher.html');
      await expect(page.getByText("This browser cannot reach the board's USB port.")).toBeVisible();
      await shoot(page, info, width, 'flasher-unsupported');
    });
  }
}
