import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restart, setTransport } from '../src/lib/api';
import { useTransact } from '../src/lib/hooks';
import { rebootWait } from '../src/state/rebootWait';
import { toasts } from '../src/state/toasts';

let host: HTMLElement;

function response(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

function RestartTransaction() {
  const transact = useTransact();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          transact.run(() => restart(), {
            busyText: 'Restarting…',
            reboots: 'the restart',
          })
        }
      >
        Restart
      </button>
      <output>{transact.state.text}</output>
    </>
  );
}

function mount(): HTMLButtonElement {
  host = document.createElement('div');
  render(<RestartTransaction />, host);
  const button = host.querySelector('button');
  if (!button) throw new Error('restart button did not render');
  return button;
}

beforeEach(() => {
  rebootWait.value = null;
  toasts.value = [];
});

afterEach(() => {
  render(null, host);
  setTransport((request) => fetch(request));
});

describe('rebooting transactions', () => {
  it.each([200, 202])('arms one reboot wait after a %i reboot acknowledgement', async (status) => {
    setTransport(async () => response(status, '{"rebooting":true}'));

    mount().click();

    await vi.waitFor(() => expect(rebootWait.value?.label).toBe('the restart'));
    expect(toasts.value.filter((entry) => entry.kind === 'wait')).toHaveLength(1);
  });

  it('does not arm a wait when a successful acknowledgement says not to reboot', async () => {
    setTransport(async () => response(200, '{"rebooting":false}'));

    mount().click();

    await vi.waitFor(() => expect(host.querySelector('output')?.textContent).toBe('Done'));
    expect(rebootWait.value).toBeNull();
  });

  it.each([
    [400, '{"error":"invalid request"}', 'invalid request'],
    [401, '{"error":"unauthorized"}', 'unlock settings'],
  ])('shows a %i rejection without arming a wait', async (status, body, expected) => {
    setTransport(async () => response(status, body));

    mount().click();

    await vi.waitFor(() => expect(host.querySelector('output')?.textContent).toContain(expected));
    expect(rebootWait.value).toBeNull();
  });

  it('shows a transport failure without arming a wait', async () => {
    setTransport(async () => {
      throw new TypeError('network disconnected');
    });

    mount().click();

    await vi.waitFor(() =>
      expect(host.querySelector('output')?.textContent).toContain('network disconnected'),
    );
    expect(rebootWait.value).toBeNull();
  });

  it('ignores a second click while the first request is still in flight', async () => {
    let resolveResponse: ((value: Response) => void) | undefined;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    setTransport(transport);
    const button = mount();

    button.click();
    button.click();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());

    resolveResponse?.(response(200, '{"rebooting":true}'));
    await vi.waitFor(() => expect(rebootWait.value?.label).toBe('the restart'));
    expect(toasts.value.filter((entry) => entry.kind === 'wait')).toHaveLength(1);
  });
});
