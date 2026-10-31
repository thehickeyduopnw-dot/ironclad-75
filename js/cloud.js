// Cloud sync, push token and API key management for the Supabase backend
// (supabase/functions/ironclad). Local-first: the phone saves first; syncing
// happens quietly in the background and simply retries later when it fails.

import { firebaseConfig, vapidKey } from './cloud-config.js';

const FIREBASE = 'https://www.gstatic.com/firebasejs/10.14.1';
const LAST_SYNC_KEY = 'ironclad.lastSync';

export const linked = (cloud) => !!(cloud?.url && cloud?.secret);
export const pushConfigured = () => !!(firebaseConfig && vapidKey);

async function call(url, path, { secret, method = 'POST', body } = {}) {
  let res;
  try {
    res = await fetch(url.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-App-Secret': secret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the cloud backend. Check the address and your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Cloud backend error (${res.status}).`);
  return data;
}

const app = (cloud, path, opts) => call(cloud.url, path, { ...opts, secret: cloud.secret });

// First connection: the backend hands this phone its secret (only once).
export async function link(url) {
  if (!/^https:\/\//.test(url)) throw new Error('Paste the full https:// address of your backend.');
  const { app_secret } = await call(url, '/link', { body: {} });
  return { url: url.replace(/\/+$/, ''), secret: app_secret, pushToken: null };
}

// ---- Sync -------------------------------------------------------------------------------

let timer = null;
let running = false;
let again = false;

export function lastSync() {
  try { return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0; } catch { return 0; }
}

// Debounced background sync. Never throws; failures just wait for the next change,
// the next launch, or the connection coming back.
export function scheduleSync(cloud, buildPayload, delay = 2500) {
  if (!linked(cloud)) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(cloud, buildPayload).catch(() => {}), delay);
}

export async function syncNow(cloud, buildPayload) {
  if (!linked(cloud)) return;
  if (running) { again = true; return; }
  running = true;
  try {
    await app(cloud, '/sync', { body: buildPayload() });
    try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch {}
  } finally {
    running = false;
    if (again) { again = false; scheduleSync(cloud, buildPayload, 500); }
  }
}

// ---- Push (Firebase Cloud Messaging) -----------------------------------------------------

// Returns this phone's FCM token, or null if push isn't available/allowed.
// Only asks for permission when `ask` is true (i.e. from a button tap).
export async function getPushToken(ask) {
  if (!pushConfigured() || !('Notification' in window) || !('serviceWorker' in navigator)) return null;
  if (Notification.permission === 'default' && ask) await Notification.requestPermission();
  if (Notification.permission !== 'granted') return null;
  const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import(`${FIREBASE}/firebase-app.js`),
    import(`${FIREBASE}/firebase-messaging.js`),
  ]);
  if (!(await isSupported())) return null;
  const fb = getApps()[0] || initializeApp(firebaseConfig);
  const reg = await navigator.serviceWorker.ready;
  return getToken(getMessaging(fb), { vapidKey, serviceWorkerRegistration: reg });
}

export const registerToken = (cloud, token) => app(cloud, '/device-token', { body: { token, platform: 'android' } });
export const sendTest = (cloud) => app(cloud, '/notify', { body: { title: 'Ironclad 75', body: 'Test notification from your cloud backend.' } });

// ---- API key for Muse ---------------------------------------------------------------------

export const apiKeyStatus = (cloud) => app(cloud, '/api-key', { method: 'GET' });
export const regenerateApiKey = (cloud) => app(cloud, '/api-key/regenerate', { body: {} });
export const revokeApiKey = (cloud) => app(cloud, '/api-key/revoke', { body: {} });
