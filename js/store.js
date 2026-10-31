// On-device storage: one IndexedDB database with the app state and the photos.

const DB_NAME = 'ironclad-75';
const DB_VERSION = 1;
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv'); // 'state' -> app state object
      db.createObjectStore('photos'); // dateKey -> { blob, date, savedAt }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const loadState = () => run('kv', 'readonly', (s) => s.get('state'));
export const saveState = (state) => run('kv', 'readwrite', (s) => s.put(state, 'state'));

export const getPhoto = (key) => run('photos', 'readonly', (s) => s.get(key));
export const putPhoto = (key, blob) => run('photos', 'readwrite', (s) => s.put({ blob, date: key, savedAt: Date.now() }, key));
export const deletePhoto = (key) => run('photos', 'readwrite', (s) => s.delete(key));
export const photoKeys = () => run('photos', 'readonly', (s) => s.getAllKeys());

// Ask the browser not to evict our data under storage pressure.
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
