import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { liveSource } from './liveSource';

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
      for (const path of [
        '/bridge.html#/sources',
        `/bridge.html#/sources/${source}`,
        '/bridge.html#/recordings',
        '/bridge.html#/settings/security',
        '/bridge.html#/settings/deployment',
      ]) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('button', { name: /^Bridge unlocked/ })).toBeVisible();
        await shoot(
          page,
          info,
          width,
          `bridge${path.replace(source, 'source').replaceAll(/[^a-z]/g, '-')}`,
        );
      }
      // The deployments that leave a place empty: no token, and no recording.
      await page.route('**/status', async (route) => {
        const json = await (await route.fetch()).json();
        await route.fulfill({ json: { ...json, api_token_configured: false } });
      });
      await page.route('**/api/recordings/capabilities', async (route) => {
        const json = await (await route.fetch()).json();
        await route.fulfill({ json: { ...json, enabled: false } });
      });
      for (const path of ['/bridge.html#/recordings', '/bridge.html#/settings/deployment']) {
        // A fresh page, so it reads the overridden answers rather than the ones it holds.
        await page.goto('about:blank');
        await page.goto(path);
        await expect(page.getByRole('button', { name: /^Read-only/ })).toBeVisible();
        await shoot(page, info, width, `bridge-off${path.replaceAll(/[^a-z]/g, '-')}`);
      }
    });
  }
}
