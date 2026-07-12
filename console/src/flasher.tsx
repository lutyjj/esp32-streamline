import 'esp-web-tools/dist/web/install-button.js';
import { render } from 'preact';
import { WebFlasher } from './components/WebFlasher';
import { initializeThemePreference } from './lib/theme';
import './styles.css';

initializeThemePreference();

const root = document.getElementById('app');
if (root) render(<WebFlasher />, root);
