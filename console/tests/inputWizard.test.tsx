import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputWizard } from '../src/components/InputWizard';
import { setTransport } from '../src/lib/api';
import { CAL_POLL_MS, CAL_SILENCE_SAMPLES } from '../src/lib/calibration';
import { deviceStatus } from '../src/mocks/fixtures';
import { status } from '../src/state/device';

let mountedHost: HTMLElement | null = null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('InputWizard', () => {
  beforeEach(() => {
    status.value = deviceStatus({ auth_required: false });
  });

  afterEach(() => {
    if (mountedHost) render(null, mountedHost);
    mountedHost = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    setTransport((request) => fetch(request));
  });

  it('announces the passthrough choice and adds its step on capable boards', () => {
    const host = document.createElement('div');
    render(<InputWizard onClose={() => {}} />, host);

    expect(host.textContent).toContain('Set up your input');
    expect(host.textContent).toContain('then offers the local analog output');
    expect(host.querySelectorAll('.stepdots i')).toHaveLength(5);
  });

  it('stays a pure level guide on boards without the route', () => {
    const s = deviceStatus({ auth_required: false });
    status.value = {
      ...s,
      capabilities: { ...s.capabilities, analog_passthrough: null },
    };
    const host = document.createElement('div');
    render(<InputWizard onClose={() => {}} />, host);

    expect(host.textContent).not.toContain('local analog output');
    expect(host.querySelectorAll('.stepdots i')).toHaveLength(4);
  });

  it('keeps cancellation open until restore succeeds and offers recovery after failure', async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    let restoreAttempts = 0;
    let finishRestore: (() => void) | undefined;
    setTransport(async (request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/status')) {
        // A near-silent input: the example device streams, so quiet every
        // channel the calibration samples.
        return jsonResponse(
          deviceStatus({
            auth_required: false,
            metrics: {
              playing: false,
              rms_left: 20,
              rms_right: 0,
              peak_abs_left: 0,
              peak_abs_right: 0,
            },
          }),
        );
      }
      if (request.method === 'POST' && request.url.endsWith('/api/settings/audio')) {
        const form = await request.formData();
        const atten = Number(form.get('adc_attenuation_db'));
        writes.push(atten);
        if (atten === 9) {
          restoreAttempts += 1;
          if (restoreAttempts === 1) throw new TypeError('device unreachable');
          return new Promise<Response>((resolve) => {
            finishRestore = () => resolve(jsonResponse({ ok: true }));
          });
        }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });

    const onClose = vi.fn();
    mountedHost = document.createElement('div');
    render(<InputWizard onClose={onClose} />, mountedHost);
    const button = (label: string) =>
      [...(mountedHost?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (candidate) => candidate.textContent === label,
      );

    act(() => button('Start')?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAL_POLL_MS * CAL_SILENCE_SAMPLES);
    });
    expect(button('Continue')?.disabled).toBe(false);

    act(() => button('Continue')?.click());
    await vi.waitFor(() => expect(writes).toEqual([0]));
    act(() => button('Cancel')?.click());

    await vi.waitFor(() =>
      expect(mountedHost?.textContent).toContain('Previous levels need attention'),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(writes).toEqual([0, 9]);
    expect(button('Retry restore')).toBeDefined();
    expect(button('Close without restoring')).toBeDefined();

    act(() => button('Retry restore')?.click());
    await vi.waitFor(() => expect(writes).toEqual([0, 9, 9]));
    expect(onClose).not.toHaveBeenCalled();
    expect(
      [...(mountedHost?.querySelectorAll<HTMLButtonElement>('button') ?? [])].every(
        (candidate) => candidate.disabled,
      ),
    ).toBe(true);

    finishRestore?.();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
