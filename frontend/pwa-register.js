'use strict';

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .catch(error => console.warn('[BGA PWA] Service worker registration failed:', error));
  });
}
