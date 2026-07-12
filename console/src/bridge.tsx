import { render } from 'preact';
import { BridgeApp } from './bridge/BridgeApp';
import { startBridgePolling } from './bridge/state';
import { initializeThemePreference } from './lib/theme';
import './styles.css';
import './bridge/styles.css';

initializeThemePreference();
startBridgePolling();

const root = document.getElementById('app');
if (root) render(<BridgeApp />, root);
