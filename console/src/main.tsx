import { render } from 'preact';
import { App } from './app';
import { startPolling } from './state/device';
import { initializeThemePreference } from './state/theme';
// Imported for its effects: OTA phase narration on the status stream.
import './state/ota';
import './styles.css';

// Dev/e2e mock mode; the build replaces the flag, so bundles drop this branch.
if (import.meta.env.VITE_MOCK) {
  const { startDeviceMock } = await import('./mocks/browser');
  await startDeviceMock();
}

initializeThemePreference();
startPolling();

const root = document.getElementById('app');
if (root) render(<App />, root);
