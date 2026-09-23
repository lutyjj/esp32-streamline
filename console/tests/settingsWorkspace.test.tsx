import { render } from 'preact';
import { act } from 'preact/test-utils';
import { expect, it } from 'vitest';
import { SettingsWorkspace } from '../src/components/SettingsWorkspace';
import { sectionFromHash, useRouteHash } from '../src/state/route';

it('keeps a draft while switching sections through addressable settings tasks', async () => {
  window.location.hash = '#/settings/name';
  const host = document.createElement('div');
  function RoutedSettings() {
    const hash = useRouteHash();
    return (
      <SettingsWorkspace
        baseHref="#/settings"
        selected={sectionFromHash(hash, 'settings')}
        label="Settings"
        sections={[
          {
            id: 'name',
            label: 'Name',
            content: <input aria-label="Device name" defaultValue="Kitchen" />,
          },
          { id: 'access', label: 'Access', content: <p>Key settings</p> },
        ]}
      />
    );
  }
  act(() => render(<RoutedSettings />, host));
  const input = host.querySelector('input');
  if (!input) throw new Error('Name field missing');
  input.value = 'Listening room';
  await act(async () => {
    window.location.hash = host.querySelectorAll('nav a')[1].getAttribute('href')!;
    window.dispatchEvent(new Event('hashchange'));
  });
  expect(input.closest('section')?.hidden).toBe(true);
  await act(async () => {
    window.location.hash = '#/settings/name';
    window.dispatchEvent(new Event('hashchange'));
  });
  expect(input.closest('section')?.hidden).toBe(false);
  expect(input.value).toBe('Listening room');
  expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toBe('Name');
  render(null, host);
});
