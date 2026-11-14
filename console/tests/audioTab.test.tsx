import { getResponse } from 'msw';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioProfiles } from '../src/components/AudioProfiles';
import { AudioTab } from '../src/components/AudioTab';
import { type StatusResponse, setTransport } from '../src/lib/api';
import { FakeDevice } from '../src/mocks/device';
import { deviceContract, deviceStatus } from '../src/mocks/fixtures';
import { audioProfiles, contract, refresh, status } from '../src/state/device';
import { rebootWait } from '../src/state/rebootWait';

let host: HTMLElement | null = null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answer the next status poll with a device holding these audio levels. */
function pollWith(audio: Partial<StatusResponse['audio']>): void {
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
    render(<AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />, host);
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
    render(<AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />, host);

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

  it('locks every input during a save and follows the confirming poll', async () => {
    host = document.createElement('div');
    render(<AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />, host);
    let finish: (response: Response) => void = () => {};
    setTransport((request) =>
      request.method === 'POST'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(
            jsonResponse(deviceStatus({ auth_required: false, audio: { input_gain: 1 } })),
          ),
    );
    act(() => {
      const input = gainInput()!;
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host
        ?.querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    expect(
      host.querySelectorAll('.audio-controls fieldset input, .audio-controls fieldset select'),
    ).toHaveLength(3);
    await act(async () => {
      finish(jsonResponse({ ok: true, rebooting: false }));
    });
    await act(async () => {
      await refresh();
    });
    expect(gainInput()?.value).toBe('1');
    expect(host.querySelector('fieldset')?.disabled).toBe(false);
    expect(host.textContent).not.toContain('Unsaved');
  });

  it('discards an input draft using the latest applied state without writing', async () => {
    host = document.createElement('div');
    render(<AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />, host);
    let writes = 0;
    setTransport((request) => {
      if (request.method === 'POST') writes++;
      return Promise.resolve(jsonResponse({}));
    });
    act(() => {
      const input = gainInput()!;
      input.value = '12';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      status.value = deviceStatus({ auth_required: false, audio: { input_gain: 7 } });
    });
    act(() => {
      [...host!.querySelectorAll('button')]
        .find((button) => button.textContent === 'Discard changes')
        ?.click();
    });
    expect(gainInput()?.value).toBe('7');
    expect(host.textContent).not.toContain('Unsaved');
    expect(writes).toBe(0);
  });
});

describe('AudioTab on the setup network', () => {
  afterEach(() => {
    status.value = null;
    rebootWait.value = null;
    setTransport((request) => fetch(request));
  });

  it('saves setup-mode levels for after setup instead of restarting', async () => {
    const device = new FakeDevice('first-boot');
    setTransport(async (request) => {
      const response = await getResponse(device.handlers, request, {
        baseUrl: window.location.origin,
      });
      if (!response) throw new Error(`No mock handler for ${request.url}`);
      return response;
    });
    status.value = deviceStatus({ mode: 'setup', auth_required: false });
    const view = document.createElement('div');
    render(<AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />, view);
    const input = view.querySelector<HTMLInputElement>('#input_gain');
    act(() => {
      if (!input) throw new Error('gain field missing');
      input.value = '3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(view.textContent).toContain('Saved changes apply once setup completes.');
    await vi.waitFor(() =>
      expect(view.textContent).toContain('Saved. These levels apply once setup completes.'),
    );
    expect(rebootWait.value).toBeNull();
    render(null, view);
  });

  it('lets recovery turn a running local route off but not start one', async () => {
    // Recovery starts the codec only for a route that was on at boot, and an
    // unconfigured device has nothing to persist the route into yet.
    for (const [mode, routeOn, enabled] of [
      ['recovery', true, true],
      ['recovery', false, false],
      ['setup', false, false],
    ] as const) {
      status.value = deviceStatus({
        mode,
        auth_required: false,
        analog_passthrough: { enabled: routeOn, active: routeOn, fault: null },
      });
      const view = document.createElement('div');
      await act(async () =>
        render(<AudioTab onCalibrate={() => {}} onSetupBridge={() => {}} />, view),
      );
      const toggle = view.querySelector<HTMLInputElement>('input[role="switch"]');
      expect(toggle?.disabled, `${mode} with the route ${routeOn ? 'on' : 'off'}`).toBe(!enabled);
      if (mode === 'recovery' && !routeOn) {
        expect(view.textContent).toContain('once StreamLine is back on your Wi-Fi');
      }
      render(null, view);
    }
  });
});

describe('AudioProfiles', () => {
  afterEach(() => {
    status.value = null;
    contract.value = null;
    audioProfiles.value = null;
    rebootWait.value = null;
    setTransport((request) => fetch(request));
  });

  it('narrates a restart the activation answers without waiting on a settings read', async () => {
    status.value = deviceStatus({ auth_required: false });
    contract.value = deviceContract();
    audioProfiles.value = {
      board_id: status.value.capabilities.board_id,
      schema_version: 1,
      profiles: [
        {
          id: 'vinyl',
          name: 'Vinyl',
          audio: { input_line: 2, input_gain: 0, adc_attenuation_db: 9 },
        },
      ],
      active_profile_id: null,
    };
    // A device that is going down answers the write, then never the reads.
    setTransport((request) =>
      request.method === 'POST'
        ? Promise.resolve(jsonResponse({ ok: true, rebooting: true }))
        : new Promise<Response>(() => {}),
    );
    const view = document.createElement('div');
    await act(async () => render(<AudioProfiles />, view));

    await act(async () =>
      [...view.querySelectorAll('button')]
        .find((button) => button.textContent === 'Apply profile')
        ?.click(),
    );

    await vi.waitFor(() => expect(rebootWait.value).not.toBeNull());
    expect(view.textContent).toContain('Saved — device is restarting');
    render(null, view);
  });
});
