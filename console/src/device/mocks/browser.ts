/**
 * Boot the device console against its fake backend: a Mock Service Worker
 * intercepts the page's API calls before render. The entry calls this only
 * when the build runs with `VITE_MOCK=1`, so production bundles carry none
 * of it. The bridge console needs no mock — dev and e2e run the real bridge.
 */

import { getResponse } from 'msw';
import { setupWorker } from 'msw/browser';
import { type DeviceScenario, FakeDevice } from './device';

const SCENARIOS: readonly DeviceScenario[] = ['steady', 'first-boot', 'recovery'];

/** The journey stage the fake device starts in, from `?scenario=`. */
function scenarioFromLocation(): DeviceScenario {
  const requested = new URLSearchParams(window.location.search).get('scenario');
  return SCENARIOS.find((scenario) => scenario === requested) ?? 'steady';
}

export async function startDeviceMock(): Promise<void> {
  const device = new FakeDevice(scenarioFromLocation());
  // A page served over plain HTTP to another machine has no service workers,
  // so the page answers its own API calls from the same handlers.
  if (!('serviceWorker' in navigator)) {
    const network = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      return (await getResponse(device.handlers, request)) ?? network(request);
    };
    return;
  }
  await setupWorker(...device.handlers).start({ onUnhandledFrame: 'bypass' });
}
