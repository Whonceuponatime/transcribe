// Minimal service worker for PWA installability (Add to Home Screen / Install app)
const CACHE_NAME = 'joclubs-v1';
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
