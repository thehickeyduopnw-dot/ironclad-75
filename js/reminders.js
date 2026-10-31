// Evening reminders: links this phone to the reminder Worker (worker/reminders.js)
// and keeps it told whether today is finished, so it only pushes when tasks are left.

export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function call(url, path, body) {
  let res;
  try {
    res = await fetch(url.replace(/\/+$/, '') + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {});
  } catch {
    throw new Error("Couldn't reach the reminder service. Check the address and your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Reminder service error (${res.status}).`);
  return data;
}

// Ask permission, subscribe to push, and register with the Worker. Returns the link token.
export async function enable(rem, reminderTime, status) {
  if (!supported()) throw new Error("This browser can't receive push notifications.");
  if (!/^https:\/\//.test(rem.url)) throw new Error('Paste the full https:// address of your reminder service.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error("Notifications are blocked. Allow them for this app in your phone's settings.");

  const { publicKey } = await call(rem.url, '/vapid');
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe(); // the server key may have changed
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const { token } = await call(rem.url, '/subscribe', {
    token: rem.token || undefined,
    subscription: sub.toJSON(),
    reminderTime,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    status,
  });
  return token;
}

export async function disable(rem) {
  await call(rem.url, '/settings', { token: rem.token, enabled: false }).catch(() => {});
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
}

export const updateSettings = (rem, patch) => call(rem.url, '/settings', { token: rem.token, ...patch });
export const sendTest = (rem) => call(rem.url, '/test', { token: rem.token });

// Tell the Worker about today's progress, only when it changes.
let lastSync = '';
export function syncStatus(rem, status) {
  if (!rem?.on || !rem.url || !rem.token) return;
  const sig = JSON.stringify(status);
  if (sig === lastSync) return;
  lastSync = sig;
  call(rem.url, '/status', { token: rem.token, status }).catch(() => { lastSync = ''; });
}
