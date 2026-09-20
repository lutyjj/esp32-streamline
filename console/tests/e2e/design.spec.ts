import { expect, test } from '@playwright/test';

for (const width of [390, 800, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`console workspaces at ${width}px in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      for (const path of [
        '/#/audio',
        '/#/connections',
        '/#/settings',
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
          const isBridge = path.includes('bridge');
          await page
            .getByPlaceholder(isBridge ? 'bridge API token' : 'admin key')
            .fill(isBridge ? (process.env.STREAMLINE_API_TOKEN ?? '') : 'a'.repeat(48));
          await page.getByRole('button', { name: 'Unlock', exact: true }).click();
        }
        await expect(page.getByRole('button', { name: /^Unlocked/ })).toBeVisible();
        if (path.endsWith('audio')) {
          await page.getByRole('button', { name: 'Manage profiles', exact: true }).click();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: info.outputPath(`${path.replaceAll(/[^a-z]/g, '-')}.png`),
          fullPage: true,
        });
        const categories = page.locator('.view:not([hidden]) .settings-select select');
        if (await categories.count()) {
          const options = await categories.locator('option').evaluateAll((items) =>
            items.map((item) => ({
              value: item.getAttribute('value') ?? '',
              label: item.textContent ?? '',
            })),
          );
          for (const option of options) {
            if (width <= 900) await categories.selectOption(option.value);
            else
              await page
                .locator('.view:not([hidden]) .settings-nav')
                .getByRole('button', { name: option.label, exact: true })
                .click();
            for (const disclosure of await page
              .locator('.disclosure-summary[aria-expanded="false"]:visible')
              .all()) {
              await disclosure.click();
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBeLessThanOrEqual(width);
            await page.screenshot({
              path: info.outputPath(
                `${path.includes('bridge') ? 'bridge' : 'device'}-${option.value}-expanded.png`,
              ),
              fullPage: true,
            });
          }
        }
      }
    });
  }
}
