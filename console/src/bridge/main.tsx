import './app.css';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';

const root = document.getElementById('app');
if (root) createRoot(root).render(<App />);
