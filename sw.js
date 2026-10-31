// Service worker (module). Offline: the app shell is cached, served from cache, and
// refreshed in the background, so a new deploy shows up on the next launch.
// Bump VERSION when the file list changes.
// Push: see the 'push' handler below.

import { dateKey, dayNumber, missingTasks } from './js/challenge.js';
import { loadState } from './js/store.js';

const VERSION = 'ironclad-v10';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/challenge.js',
  './js/store.js',
  './js/clock.js',
  './js/feedback.js',
  './js/photo.js',
  './js/calories.js',
  './js/cloud.js',
  './js/cloud-config.js',
  './js/backup.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Only the app's own page shares the index.html cache slot (not e.g. /tests/).
  const scope = new URL(self.registration.scope).pathname;
  const path = new URL(req.url).pathname;
  const isApp = req.mode === 'navigate' && (path === scope || path === `${scope}index.html`);

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const key = isApp ? './index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Pushes come from Firebase Cloud Messaging as data-only messages:
// { kind: 'reminder' } (text written here from the phone's own log) or
// { kind: 'message', title, body } (e.g. sent by Muse through POST /notify).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    const payload = event.data?.json() ?? {};
    data = payload.data ?? payload.notification ?? payload;
  } catch {}
  event.waitUntil(data.title ? notify(data.title, data.body || '') : showReminder());
});

function notify(title, body) {
  return self.registration.showNotification(title, {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: 'ironclad-message',
    vibrate: [80, 60, 80],
  });
}

async function showReminder() {
  let title = 'Ironclad 75';
  let body = "Finish today's tasks before midnight.";
  try {
    const state = await loadState();
    const a = state?.attempt;
    const today = dateKey(new Date());
    if (a?.status === 'active' && a.startDate <= today) {
      const missing = missingTasks(state.days[today]);
      const n = dayNumber(a.startDate, today);
      if (missing.length) {
        title = `Day ${n}: ${missing.length} task${missing.length === 1 ? '' : 's'} left`;
        body = missing.join(' · ');
      } else {
        title = `Day ${n} complete`;
        body = 'Everything is logged. Nice work.';
      }
    }
  } catch {}
  return self.registration.showNotification(title, {
    body,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    tag: 'daily-reminder',
    renotify: true,
    vibrate: [80, 60, 80],
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(self.registration.scope);
  })());
});
