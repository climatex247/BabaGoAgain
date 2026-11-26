'use strict';

const CACHE_NAME = 'bga-public-shell-v1';
const SHELL_URLS = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/assets/bga-app-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache APIs, authentication, wallet, admin, user data, or media uploads.
  if (url.pathname.startsWith('/api/') ||
      /^(?:\/(?:login|register|dashboard|profile|referrals|community|messages|notifications|media|wallet|admin-center|founder-dashboard|forgot-password|reset-password|verify-email))(?:\/|$)/.test(url.pathname)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cachedHome = await caches.match('/');
        if (url.pathname === '/' && cachedHome) return cachedHome;
        return (await caches.match('/offline.html')) || Response.error();
      })
    );
    return;
  }

  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request))
    );
  }
});
