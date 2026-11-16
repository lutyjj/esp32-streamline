import 'esp-web-tools/dist/web/install-button.js';
import './app.css';
import { createRoot } from 'react-dom/client';
import { FlasherPage } from './FlasherPage';

const root = document.getElementById('app');
if (root) createRoot(root).render(<FlasherPage />);
