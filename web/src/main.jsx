// Font imports — processed by esbuild, woff2 files copied to assets/
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/space-grotesk/index.css';
import '@fontsource-variable/jetbrains-mono/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, fetchAndApplyTheme } from './lib/theme.js';
import { App } from './App.jsx';
import './styles.css';

// Apply saved template + mode before React renders (second application in case
// theme-init.js missed something — inline styles win over CSS vars from init).
applyTheme();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// After mount: fetch server-side theme (GET /api/theme, ETag-cached)
fetchAndApplyTheme();
