import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetCard } from '../src/components/SystemTab';
import { setTransport } from '../src/lib/api';
import { deviceStatus } from '../src/mocks/fixtures';
import { refresh, status, unreachable } from '../src/state/device';
import { resetHandoff } from '../src/state/resetHandoff';

let host: HTMLElement;

function response(code: number, body: string): Response {
  return new Response(body, { status: code, headers: { 'Content-Type': 'application/json' } });
}

function mount(): HTMLElement {
  host = document.createElement('div');
  render(<ResetCard />, host);
  return host;
}

function click(label: string): void {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  expect(button, `button "${label}"`).toBeDefined();
  act(() => button?.click());
}

beforeEach(() => {
  status.value = deviceStatus({ auth_required: false });
  resetHandoff.value = null;
  unreachable.value = false;
});

afterEach(() => {
  render(null, host);
  setTransport((request) => fetch(request));
});

describe('factory reset handoff', () => {
  it('enters the setup handoff on acknowledgement instead of reboot polling', async () => {
    setTransport(async () =>
      response(
        200,
        '{"rebooting":true,"setup_network":{"ssid":"esp32-streamline-1AA8B2","password":"abcd-efgh-ijkm-npqr"}}',
      ),
    );
    mount();

    click('Factory reset');
    click('Erase everything');
    await vi.waitFor(() =>
      expect(resetHandoff.value).toEqual({
        ssid: 'esp32-streamline-1AA8B2',
        password: 'abcd-efgh-ijkm-npqr',
      }),
    );
    expect(host.textContent).toContain('192.168.71.1');
    expect(host.textContent).toContain('Installed firmware stays');
    // The stable setup password is repeated, matching the device's label.
    expect(host.textContent).toContain('abcd-efgh-ijkm-npqr');
  });

  it('keeps a rejection inline and retryable', async () => {
    setTransport(async () => response(403, '{"error":"locked"}'));
    mount();

    click('Factory reset');
    click('Erase everything');
    await vi.waitFor(() => expect(host.querySelector('.actionstate')?.textContent).toBeTruthy());
    expect(resetHandoff.value).toBe(null);
    // The trigger is back for a retry.
    expect(
      [...host.querySelectorAll('button')].some((b) => b.textContent === 'Factory reset'),
    ).toBe(true);
  });

  it('treats a dropped connection as the handoff itself', async () => {
    setTransport(async () => {
      throw new TypeError('network down');
    });
    mount();

    click('Factory reset');
    click('Erase everything');
    // The response never arrived, so the credentials are unknown but the
    // handoff still happens.
    await vi.waitFor(() => expect(resetHandoff.value).toBe('unknown'));
    expect(host.textContent).toContain('label or serial log');
  });

  it('suppresses the unreachable alarm and survives navigation', async () => {
    resetHandoff.value = 'unknown';
    setTransport(async () => {
      throw new TypeError('gone');
    });
    await refresh();
    expect(unreachable.value).toBe(false);

    // A remount (tab navigation) still lands on the handoff, not the form.
    mount();
    expect(host.textContent).toContain('192.168.71.1');
  });
});
