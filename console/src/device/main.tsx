import './app.css';
import { createRoot } from 'react-dom/client';
import { startPolling } from './state/device';
import { App } from './ui/App';

// Dev/e2e mock mode; the build replaces the flag, so bundles drop this branch.
if (import.meta.env.VITE_MOCK) {
  const { startDeviceMock } = await import('./mocks/browser');
  await startDeviceMock();
}

void startPolling();

const root = document.getElementById('app');
if (root) createRoot(root).render(<App />);
