// Full backup: one JSON file with the app state and every photo (as data URLs).

import * as store from './store.js';

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Builds the file in pieces so a few dozen photos don't become one giant string.
export async function exportBackup(state) {
  const parts = [`{"app":"ironclad-75","format":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"state":${JSON.stringify(state)},"photos":{`];
  let count = 0;
  for (const key of (await store.photoKeys()).sort()) {
    const rec = await store.getPhoto(key);
    if (!rec) continue;
    parts.push(`${count ? ',' : ''}${JSON.stringify(key)}:${JSON.stringify(await toDataUrl(rec.blob))}`);
    count++;
  }
  parts.push('}}');

  const blob = new Blob(parts, { type: 'application/json' });
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ironclad-75-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { photos: count, bytes: blob.size };
}

export async function readBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't a valid backup.");
  }
  if (data?.app !== 'ironclad-75' || !data.state?.days || !data.state?.settings) {
    throw new Error("That file isn't an Ironclad 75 backup.");
  }
  return data;
}

// Replaces everything on this device with the backup. Photos are written first and
// old ones removed last, so a failure partway never leaves the log without its photos.
export async function restoreBackup(data) {
  const photos = data.photos || {};
  for (const [key, url] of Object.entries(photos)) {
    await store.putPhoto(key, await (await fetch(url)).blob());
  }
  // Reminders point at the old phone's push address; they're re-enabled from Settings.
  const reminders = { url: '', token: '', ...data.state.reminders, on: false };
  await store.saveState({ ...data.state, reminders });
  for (const key of await store.photoKeys()) {
    if (!(key in photos)) await store.deletePhoto(key);
  }
}
