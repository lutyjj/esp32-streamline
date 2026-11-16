import { expect, test } from '@playwright/test';

test('the flasher offers the install from a manifest that parses', async ({ page }) => {
  await page.goto('/flasher.html');
  const install = page.locator('esp-web-install-button');
  await expect(install).toHaveAttribute('install-supported');
  await expect(page.getByRole('button', { name: 'Connect & install' })).toBeVisible();
  const builds = await install.evaluate(async (button) => {
    const manifest = new URL(button.getAttribute('manifest') ?? '', document.baseURI);
    return (await (await fetch(manifest)).json()).builds.length;
  });
  expect(builds).toBeGreaterThan(0);
});

test('a press on the install button reaches esp-web-tools', async ({ page }) => {
  // No board answers here: the port request finds none, as when the user picks nothing.
  await page.addInitScript(() => {
    Reflect.get(navigator, 'serial').requestPort = () =>
      Promise.reject(new DOMException('No port selected by the user.', 'NotFoundError'));
  });
  await page.goto('/flasher.html');
  await page.getByRole('button', { name: 'Connect & install' }).click();
  await expect(page.getByText('No port selected')).toBeVisible();
});

test('the flasher says what works where the browser has no Web Serial', async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(Navigator.prototype, 'serial'));
  await page.goto('/flasher.html');
  await expect(page.locator('esp-web-install-button')).toHaveAttribute('install-unsupported');
  await expect(page.getByText("This browser cannot reach the board's USB port.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect & install' })).toBeHidden();
});
