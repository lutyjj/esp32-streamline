import { expect, test } from '@playwright/test';

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

    test(`bridge console workspaces at ${width}px in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const path of [
        '/bridge.html#/sources',
        '/bridge.html#/recordings',
        '/bridge.html#/settings',
      ]) {
        await page.goto(path);
        await expect(page.locator('.page-heading:visible')).toBeVisible();
        await expect(page.getByRole('button', { name: /^(Locked|Unlocked)/ })).toBeVisible();
        const lock = page.getByRole('button', { name: /^Locked/ });
        if (await lock.isVisible()) {
          await lock.click();
          await page
            .getByPlaceholder('bridge API token')
            .fill(process.env.STREAMLINE_API_TOKEN ?? '');
          await page.getByRole('button', { name: 'Unlock', exact: true }).click();
        }
        await expect(page.getByRole('button', { name: /^Unlocked/ })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: info.outputPath(`${path.replaceAll(/[^a-z]/g, '-')}.png`),
          fullPage: true,
        });
        const categories = page.locator('.view:not([hidden]) .settings-nav a');
        const destinations = await categories.evaluateAll((links) =>
          links.map((link) => link.getAttribute('href') || ''),
        );
        for (const destination of destinations) {
          await page.evaluate((hash) => {
            window.location.hash = hash;
          }, destination);
          await expect(page.getByRole('link', { name: 'All settings', exact: true })).toBeVisible();
          const closed = page.locator('.disclosure-summary[aria-expanded="false"]:visible');
          for (let opened = 0; (await closed.count()) > 0 && opened < 30; opened++)
            await closed.first().click();
          await expect(closed).toHaveCount(0);
          await page.evaluate(() => window.scrollTo(0, 0));
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await page.screenshot({
            path: info.outputPath(`bridge-${destination.split('/').at(-1)}-expanded.png`),
            fullPage: true,
          });
        }
      }
    });
  }
}
