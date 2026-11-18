import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  try {
    registerSW({
      immediate: true,
      onRegisterError() {
        // Ignore service worker registration errors inside restricted iframe sandboxes
      },
    });
  } catch {
    // Ignore registration errors in restricted contexts
  }
}

createRoot(document.getElementById('root')!).render(<App />);
