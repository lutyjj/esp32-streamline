import { render } from 'preact';
import { BridgeApp } from './bridge/BridgeApp';
import { startBridgePolling } from './bridge/state';
import './styles.css';
import './bridge/styles.css';

startBridgePolling();

const root = document.getElementById('app');
if (root) render(<BridgeApp />, root);
