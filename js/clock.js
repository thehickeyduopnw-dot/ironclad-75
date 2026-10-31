// The app's notion of "now". Test mode (open the app with ?debug) adds time-travel
// buttons to Settings so the midnight reset can be tested without waiting.
// Test mode lasts only for that browser tab and uses separate practice data
// (see store.js), so it can never touch the real log or the installed app's clock.

const DEBUG_KEY = 'ironclad.debug';
const OFFSET_KEY = 'ironclad.clockOffset';

function session(key, value) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {}
  return null;
}

// Older versions kept test mode in localStorage, which the installed app shares.
try {
  localStorage.removeItem(DEBUG_KEY);
  localStorage.removeItem(OFFSET_KEY);
} catch {}

if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')) session(DEBUG_KEY, '1');

export const isDebug = session(DEBUG_KEY) === '1';
let offset = isDebug ? Number(session(OFFSET_KEY) || 0) : 0;

export function now() {
  return new Date(Date.now() + offset);
}

export function shiftClock(ms) {
  offset += ms;
  session(OFFSET_KEY, String(offset));
}

export function resetClock() {
  offset = 0;
  session(OFFSET_KEY, null);
}

export function disableDebug() {
  resetClock();
  session(DEBUG_KEY, null);
}
