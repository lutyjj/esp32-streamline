import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import {
  getAudioProfiles,
  getStatus,
  setActiveAudioProfile,
  setAudio,
  setAudioProfiles,
  setStream,
  setTarget,
  setTransport,
} from '../../src/device/lib/api';
import { type DeviceScenario, FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';

describe('mock audio transport', () => {
  let device: FakeDevice;

  function reach(scenario: DeviceScenario): void {
    device = new FakeDevice(scenario);
    setTransport(async (request) => {
      const response = await getResponse(device.handlers, request, {
        baseUrl: window.location.origin,
      });
      if (!response) throw new Error(`No mock handler for ${request.url}`);
      return response;
    });
  }

  beforeEach(() => unlockSettings(MOCK_ADMIN_KEY, false));

  afterEach(() => {
    forgetAdminKey();
    setTransport((request) => fetch(request));
  });

  it('sends audio while the input plays, and nothing while paused', async () => {
    reach('steady');
    const before = await getStatus();
    const flowing = await getStatus();
    expect(flowing.metrics.bytes_total).toBeGreaterThan(before.metrics.bytes_total);

    await setStream({ enabled: false });
    const paused = await getStatus();
    const stillPaused = await getStatus();
    expect(stillPaused.metrics.packets_total).toBe(paused.metrics.packets_total);
    expect(stillPaused.metrics.sequence).toBeGreaterThan(paused.metrics.sequence);
  });

  it('gates a quiet input to silence records while capture continues', async () => {
    reach('steady');
    device.inputPlaying = false;
    const before = await getStatus();
    const quiet = await getStatus();
    expect(quiet.metrics.packets_total).toBeGreaterThan(before.metrics.packets_total);
    expect(quiet.metrics.silence_packets_total).toBeGreaterThan(
      before.metrics.silence_packets_total,
    );
    expect(quiet.metrics.bytes_total).toBe(before.metrics.bytes_total);
  });

  it('does not transmit during setup or without a bridge target', async () => {
    reach('first-boot');
    const setup = await getStatus();
    expect((await getStatus()).metrics.packets_total).toBe(setup.metrics.packets_total);

    reach('steady');
    await setTarget({ target_host: '' });
    // The device restarts to apply the target.
    await expect(getStatus()).rejects.toThrow();
    const untargeted = await getStatus();
    expect((await getStatus()).metrics.packets_total).toBe(untargeted.metrics.packets_total);
  });

  it('applies levels at once while the codec runs, and restarts to apply them when it does not', async () => {
    reach('steady');
    const audio = { input_line: 2, input_gain: 12, adc_attenuation_db: 6 };
    await expect(setAudio(audio)).resolves.toEqual({ ok: true });
    expect((await getStatus()).audio.input_gain).toBe(12);

    device.codecRunning = false;
    await expect(setAudio({ ...audio, input_gain: 16 })).resolves.toEqual({
      ok: true,
      rebooting: true,
    });

    reach('steady');
    device.codecRunning = false;
    await expect(setActiveAudioProfile('')).resolves.toEqual({ ok: true, rebooting: true });
  });

  it('drops the active profile when levels are set by hand, as the firmware does', async () => {
    reach('steady');
    const catalog = await getAudioProfiles();
    const audio = { input_line: 2, input_gain: 12, adc_attenuation_db: 6 };
    await setAudioProfiles({ ...catalog, profiles: [{ id: 'loud', name: 'Loud', audio }] });
    await setActiveAudioProfile('loud');
    expect((await getAudioProfiles()).active_profile_id).toBe('loud');

    await setAudio({ ...audio, input_gain: 16 });
    expect((await getAudioProfiles()).active_profile_id).toBeNull();
  });
});
