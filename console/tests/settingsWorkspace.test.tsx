import { render } from 'preact';
import { act } from 'preact/test-utils';
import { expect, it } from 'vitest';
import { SettingsWorkspace } from '../src/components/SettingsWorkspace';

it('keeps a draft while switching sections through desktop and phone navigation', () => {
  const host = document.createElement('div');
  act(() =>
    render(
      <SettingsWorkspace
        label="Settings"
        sections={[
          {
            id: 'name',
            label: 'Name',
            content: <input aria-label="Device name" defaultValue="Kitchen" />,
          },
          {
            id: 'access',
            label: 'Access',
            content: <p>Key settings</p>,
          },
        ]}
      />,
      host,
    ),
  );
  const input = host.querySelector('input');
  if (!input) throw new Error('Name field missing');
  input.value = 'Listening room';
  act(() => {
    host
      .querySelectorAll('nav button')[1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(input.closest('section')?.hidden).toBe(true);
  const select = host.querySelector('select');
  if (!select) throw new Error('Phone navigation missing');
  act(() => {
    select.value = 'name';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(input.closest('section')?.hidden).toBe(false);
  expect(input.value).toBe('Listening room');
  expect(host.querySelector('nav button[aria-current="page"]')?.textContent).toBe('Name');
  render(null, host);
});
