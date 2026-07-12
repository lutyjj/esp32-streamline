import { render } from 'preact';
import { App } from './app';
import { initializeThemePreference } from './lib/theme';
import { startPolling } from './state/device';
// Imported for its effects: OTA phase narration on the status stream.
import './state/ota';
import './styles.css';

initializeThemePreference();
startPolling();

const root = document.getElementById('app');
if (root) render(<App />, root);
