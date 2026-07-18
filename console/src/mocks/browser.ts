/**
 * Boot a console against its fake backend: a Mock Service Worker intercepts
 * the page's API calls before render. Entries call this only when the build
 * runs with `VITE_MOCK=1`, so production bundles carry none of it.
 */

import { setupWorker } from 'msw/browser';
import { FakeBridge } from './bridge';
import { type DeviceScenario, FakeDevice } from './device';

/** The journey stage the fake device starts in, from `?scenario=`. */
function scenarioFromLocation(): DeviceScenario {
  const requested = new URLSearchParams(window.location.search).get('scenario');
  return requested === 'first-boot' ? 'first-boot' : 'steady';
}

export async function startDeviceMock(): Promise<void> {
  const device = new FakeDevice(scenarioFromLocation());
  await setupWorker(...device.handlers).start({ onUnhandledRequest: 'bypass' });
}

export async function startBridgeMock(): Promise<void> {
  const bridge = new FakeBridge();
  await setupWorker(...bridge.handlers).start({ onUnhandledRequest: 'bypass' });
}
