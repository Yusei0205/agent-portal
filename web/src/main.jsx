import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import '@fontsource/orbitron/latin-500.css';
import '@fontsource/orbitron/latin-700.css';
import './styles.css';
import './hud.css';
import { initPointerGlow } from './lib/theme.js';

initPointerGlow();
createRoot(document.getElementById('root')).render(<App />);
