import { render } from 'preact';
import { afterEach, expect, it } from 'vitest';
import { FieldFlag } from '../src/components/FieldFlag';
import type { DeviceField } from '../src/lib/hooks';

let host: HTMLElement | null = null;

afterEach(() => {
  if (host) render(null, host);
  host = null;
});

/** A DeviceField stub carrying only what the flag reads. */
function field(over: Partial<DeviceField>): DeviceField {
  return { value: '', dirty: false, revision: 0, set: () => {}, commit: () => {}, ...over };
}

function mount(f: DeviceField): HTMLElement {
  host = document.createElement('div');
  render(<FieldFlag field={f} />, host);
  return host;
}

it('marks an unsaved edit', () => {
  expect(mount(field({ dirty: true })).textContent).toBe('Unsaved');
});

it('announces a device move on a clean field', () => {
  expect(mount(field({ revision: 2 })).textContent).toBe('Updated');
});

it('an unsaved edit wins over a stale device move', () => {
  expect(mount(field({ dirty: true, revision: 2 })).textContent).toBe('Unsaved');
});

it('says nothing while the field just mirrors the device', () => {
  expect(mount(field({})).textContent).toBe('');
});
