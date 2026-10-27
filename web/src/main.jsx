import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from './lib/theme.js';
import { App } from './App.jsx';
import './styles.css';

// Apply saved theme before React renders to prevent flash
applyTheme();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
