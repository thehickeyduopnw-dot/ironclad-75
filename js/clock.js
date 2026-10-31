// The app's notion of "now". In debug mode (open the app with ?debug once)
// Settings gets time-travel buttons so the midnight reset can be tested without waiting.

const OFFSET_KEY = 'ironclad.clockOffset';
const DEBUG_KEY = 'ironclad.debug';

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
}

if (new URLSearchParams(location.search).has('debug')) write(DEBUG_KEY, '1');

export const isDebug = read(DEBUG_KEY) === '1';
let offset = isDebug ? Number(read(OFFSET_KEY) || 0) : 0;

export function now() {
  return new Date(Date.now() + offset);
}

export function shiftClock(ms) {
  offset += ms;
  write(OFFSET_KEY, String(offset));
}

export function resetClock() {
  offset = 0;
  write(OFFSET_KEY, null);
}

export function disableDebug() {
  resetClock();
  write(DEBUG_KEY, null);
}
