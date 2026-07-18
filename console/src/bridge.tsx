import { render } from 'preact';
import { BridgeApp } from './bridge/BridgeApp';
import { startBridgePolling } from './bridge/state';
import { initializeThemePreference } from './state/theme';
import './styles.css';
import './bridge/styles.css';

// Dev/e2e mock mode; the build replaces the flag, so bundles drop this branch.
if (import.meta.env.VITE_MOCK) {
  const { startBridgeMock } = await import('./mocks/browser');
  await startBridgeMock();
}

initializeThemePreference();
startBridgePolling();

const root = document.getElementById('app');
if (root) render(<BridgeApp />, root);
