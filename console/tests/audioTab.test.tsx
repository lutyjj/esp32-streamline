import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioTab } from '../src/components/AudioTab';
import { type DeviceStatus, setTransport } from '../src/lib/api';
import { deviceStatus } from '../src/mocks/fixtures';
import { refresh, status } from '../src/state/device';

let host: HTMLElement | null = null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answer the next status poll with a device holding these audio levels. */
function pollWith(audio: Partial<DeviceStatus['audio']>): void {
  setTransport((request) => {
    if (request.method === 'GET' && request.url.endsWith('/api/status')) {
      return Promise.resolve(jsonResponse(deviceStatus({ auth_required: false, audio })));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

const gainInput = () => host?.querySelector<HTMLInputElement>('#input_gain');

describe('AudioTab live reconcile', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false, audio: { input_gain: 4 } });
  });

  afterEach(() => {
    if (host) render(null, host);
    host = null;
    status.value = null;
    setTransport((request) => fetch(request));
  });

  it('follows a device-side change on a clean control within a poll', async () => {
    host = document.createElement('div');
    render(<AudioTab onCalibrate={() => {}} />, host);
    expect(gainInput()?.value).toBe('4');
    expect(host.textContent).not.toContain('Updated');

    // A board button raises the gain; the next poll carries it.
    pollWith({ input_gain: 7 });
    await act(async () => {
      await refresh();
    });

    expect(gainInput()?.value).toBe('7');
    // The move is announced on the field, not applied silently.
    expect(host.textContent).toContain('Updated');
  });

  it('preserves an in-progress edit across a poll and flags it unsaved', async () => {
    host = document.createElement('div');
    render(<AudioTab onCalibrate={() => {}} />, host);

    act(() => {
      const input = gainInput();
      if (input) {
        input.value = '15';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(gainInput()?.value).toBe('15');
    expect(host.textContent).toContain('Unsaved');

    // The device nudges gain while the user is still typing.
    pollWith({ input_gain: 8 });
    await act(async () => {
      await refresh();
    });

    // The user's edit stands; only clean fields follow the device.
    expect(gainInput()?.value).toBe('15');
    expect(host.textContent).toContain('Unsaved');
  });
});
