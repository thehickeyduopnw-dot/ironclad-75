// Ironclad 75: screens, user input, and wiring between the rules, storage and feedback.

import * as C from './challenge.js';
import * as store from './store.js';
import * as fx from './feedback.js';
import * as clock from './clock.js';
import { prepareImage } from './photo.js';
import * as K from './calories.js';
import * as cloud from './cloud.js';
import * as B from './backup.js';

const screen = document.getElementById('screen');
const overlay = document.getElementById('overlay');
const nav = document.getElementById('nav');

let state;
let tab = 'today';
let viewKey = null; // day shown on Today: today, or yesterday during the grace window
let openSignature = '';
let celebrated = false; // confetti plays once per win screen
let installPrompt = null; // Chrome/Android's deferred install prompt
let storageBroken = false; // saved data failed to load: don't overwrite it
let calRun = null; // calendar: null = current run, else index into state.attempts
let calKey = null; // calendar: selected date
let photoList = []; // sorted date keys that have a stored photo
let cmpA = null; // photos: left side of the comparison
let cmpB = null; // photos: right side

const themeMeta = document.querySelector('meta[name="theme-color"]');
const prefersLight = matchMedia('(prefers-color-scheme: light)');
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const photoUrls = new Map(); // dateKey -> object URL for thumbnails

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => C.parseKey(key).toLocaleDateString(undefined, opts);
const graceLabel = (h) => (h === 0 ? 'midnight' : `${h}:00 AM`);
const CHECK = '<span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>';

// ---- Startup -------------------------------------------------------------

// Fill in fields added by newer versions of the app.
function withDefaults(s) {
  return {
    ...s,
    settings: { ...C.defaultState().settings, ...s.settings },
    profile: { ...K.defaultProfile(), ...s.profile },
    cloud: { url: '', secret: '', pushToken: null, ...s.cloud },
  };
}

async function init() {
  try {
    state = withDefaults((await store.loadState()) ?? C.defaultState());
  } catch (err) {
    // Never fall back to a blank log that the next save would write over the real one.
    storageBroken = true;
    state = withDefaults(C.defaultState());
    toast(`Couldn't open this phone's saved data (${err.message}). Close and reopen the app; nothing will be saved until it loads.`);
  }
  if (clock.isDebug) document.body.classList.add('test-mode');
  // A reload keeps the old history entry; the app always starts on Today.
  if (history.state?.tab) history.replaceState(null, '');
  applySettings();
  await refreshPhotoList();
  evaluateNow();
  render();
  store.requestPersistence();
  if (cloudOn()) {
    syncNow().catch(() => {});
    refreshPushToken(false).catch(() => {});
  }
  addEventListener('online', syncSoon);
  // While the app is open, pick up anything Muse logged within a minute.
  setInterval(() => {
    if (cloudOn() && !document.hidden && navigator.onLine) cloud.pullChanges(state.cloud, cloudHooks).catch(() => {});
  }, 60000);

  setInterval(() => tick(false), 20000);
  // Running workout timers and the "Day closes in" countdown.
  setInterval(() => { if (tab === 'today' && !document.hidden) updateTimers(); }, 1000);
  setInterval(() => { if (tab === 'today' && !document.hidden) updateCountdown(); }, 30000);
  if (state.cloud.needsRelink && !clock.isDebug) toast('Backup restored. Reconnect Cloud & Muse in Settings to keep syncing.');
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { type: 'module' }).catch(() => {});
  }
}

// Re-check the rules as time passes (midnight, end of the grace window).
// Coming back to the foreground also reloads saved data, in case the app was
// changed in another window (e.g. a Chrome tab and the installed app).
async function tick(force) {
  if (force && !storageBroken) {
    const saved = await store.loadState().catch(() => null);
    if (saved) state = withDefaults(saved);
    await refreshPhotoList();
    syncSoon();
  }
  const changed = evaluateNow();
  const sig = currentOpenSignature();
  if (changed || force || sig !== openSignature) render();
}

function currentOpenSignature() {
  return C.openKeys(clock.now(), state.settings.graceHour).join();
}

function evaluateNow() {
  const { state: next } = C.evaluate(state, clock.now());
  if (next === state) return false;
  state = next;
  save();
  return true;
}

function save() {
  if (storageBroken) return;
  store.saveState(state).catch((err) => toast(`Couldn't save: ${err.message}`));
  syncSoon();
}

// ---- Cloud (Supabase backend for Muse and push) -------------------------------------------
// Test mode never syncs: practice data must not reach the real backend.

const cloudOn = () => !clock.isDebug && !storageBroken && cloud.linked(state.cloud);
const cloudHooks = { payload: () => cloudPayload(), apply: (changes) => applyRemoteChanges(changes) };
const syncSoon = () => { if (cloudOn()) cloud.scheduleSync(state.cloud, cloudHooks); };
const syncNow = () => cloud.syncNow(state.cloud, cloudHooks);

// Changes Muse made through the API. Each is checked against the same rules as a tap
// (only open days of an active run) and applied at most once. Returns which ids were
// applied and which were rejected (e.g. the day had closed), for the acknowledgement.
function applyRemoteChanges(changes) {
  const seen = new Set(state.cloud.appliedIds || []);
  const applied = [];
  const rejected = [];
  const logged = [];
  for (const ch of changes) {
    if (seen.has(ch.id)) { applied.push(ch.id); continue; }
    let ok = true;
    if (ch.type === 'reminder' && ch.reminder) {
      state = { ...state, settings: { ...state.settings, reminderTime: ch.reminder.time, reminderPush: ch.reminder.enabled } };
      logged.push('reminder');
    } else if (ch.type === 'log') {
      ok = updateDay(ch.date, (d) => C.applyApiTasks(d, ch.tasks, C.lastReadingTitle(state, ch.date)), { quiet: true, at: ch.created_at }).applied;
      if (ok) logged.push(...Object.keys(ch.tasks).map((k) => k.replace('_', ' ')));
    }
    if (ok) {
      seen.add(ch.id);
      applied.push(ch.id);
    } else {
      rejected.push(ch.id);
    }
  }
  state = { ...state, cloud: { ...state.cloud, appliedIds: [...seen].slice(-300) } };
  save();
  if (logged.length) {
    render();
    toast(`Updated from Muse: ${[...new Set(logged)].join(', ')}`);
  }
  return { applied, rejected };
}

function cloudPayload() {
  const now = clock.now();
  const today = C.dateKey(now);
  const a = state.attempt;
  const days = [];
  if (a) {
    for (let i = 0; i < C.TOTAL_DAYS; i++) {
      const key = C.addDays(a.startDate, i);
      if (key > today) break;
      days.push(C.toApiDay(state.days[key], key, i + 1));
    }
  }
  const st = C.computeStats(state, now);
  const lastReset = [...state.attempts].reverse().find((r) => r.result === 'reset');
  return {
    progress: {
      start_date: a?.startDate ?? null,
      status: !a ? 'none' : a.startDate > today ? 'not_started' : a.status,
      total_days_completed: st.currentStreak,
      longest_streak: st.longestStreak,
      attempt: a?.status === 'completed' ? state.attempts.length : state.attempts.length + 1,
      attempts: st.attempts,
      last_reset_date: lastReset?.endDate ?? null,
      last_reset_missing: lastReset?.missing ?? null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      grace_hour: state.settings.graceHour,
    },
    days,
    applied_ids: (state.cloud.appliedIds || []).slice(-100),
    reminder: { time: state.settings.reminderTime, enabled: state.settings.reminderPush !== false },
  };
}

// Keep the backend's push token current (on launch and whenever it changes).
async function refreshPushToken(ask = false) {
  if (!cloudOn()) return null;
  const token = await cloud.getPushToken(ask);
  if (token && token !== state.cloud.pushToken) {
    await cloud.registerToken(state.cloud, token);
    state = { ...state, cloud: { ...state.cloud, pushToken: token } };
    save();
  }
  return token;
}

async function refreshPhotoList() {
  photoList = (await store.photoKeys().catch(() => [])).sort();
}

const fmtTime = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

function applySettings() {
  const { theme, sound } = state.settings;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  syncThemeColor();
  fx.setSound(sound);
}

// Android tints the status bar with theme-color, so keep it matching the page.
function syncThemeColor() {
  const { theme } = state.settings;
  const light = theme === 'light' || (theme === 'system' && prefersLight.matches);
  themeMeta.content = light ? '#F3F2EC' : '#0B0B0C';
}
prefersLight.addEventListener('change', () => state && syncThemeColor());

// ---- Rendering -------------------------------------------------------------

function render() {
  openSignature = currentOpenSignature();
  for (const b of nav.querySelectorAll('[data-tab]')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  renderOverlay();
  const screens = { today: renderToday, calendar: renderCalendar, photos: renderPhotos, stats: renderStats, settings: renderSettings };
  screen.innerHTML = screens[tab]();
  screen.dataset.screen = tab;
  if (tab === 'today') patchToday();
  if (tab === 'settings') loadApiKeyInfo();
  else freshApiKey = null; // a new key is shown once, only until you leave Settings
  loadPhotos();
}

function attemptNumber() {
  return state.attempts.length + 1;
}

function bestRun() {
  return Math.max(0, ...state.attempts.map((a) => a.daysCompleted));
}

function renderToday() {
  const now = clock.now();
  const today = C.dateKey(now);
  const a = state.attempt;

  if (!a) return onboarding();
  if (a.status === 'completed') return victory();
  if (a.startDate > today) {
    const wait = C.daysBetween(today, a.startDate);
    return `<section class="hero-msg">
      <p class="eyebrow">Attempt #${attemptNumber()}</p>
      <h1 class="mega">${wait}</h1>
      <p class="lead">day${wait === 1 ? '' : 's'} until Day 1 on ${fmtDate(a.startDate, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <button class="btn-primary" data-action="start-today">Start today instead</button>
    </section>`;
  }

  const open = C.openKeys(now, state.settings.graceHour).filter((k) => k >= a.startDate);
  if (!open.includes(viewKey)) viewKey = today;
  const n = C.dayNumber(a.startDate, viewKey);
  const day = prefillDay(viewKey);
  const yesterday = open[1];

  return `
    <header class="hero">
      <div class="hero-top"><span class="eyebrow">Attempt #${attemptNumber()}</span><span class="eyebrow">${fmtDate(viewKey)}</span></div>
      <div class="daynum"><span class="day-label">Day</span><span class="num">${n}</span><span class="of">of ${C.TOTAL_DAYS}</span></div>
      <div class="run-bar" aria-hidden="true"><span id="run-fill"></span></div>
      <p id="closes-in" class="closes-in"></p>
    </header>
    ${yesterday ? graceSwitch(a, today, yesterday) : ''}
    ${eveningBanner(now, today)}
    <div id="status" class="status"></div>
    <section class="tasks">${taskCards(day)}</section>`;
}

// In-app reminder: works even without the push service.
function eveningBanner(now, today) {
  if (viewKey !== today) return '';
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const left = C.missingTasks(state.days[today]).length;
  if (!left || hhmm < state.settings.reminderTime) return '';
  return `<div class="banner" role="status"><b>${left} task${left === 1 ? '' : 's'} left</b> · day closes in ${untilClose(today, now)}.</div>`;
}

// When a day stops being editable: midnight after it, plus the grace window.
function closeTime(key) {
  const t = C.parseKey(C.addDays(key, 1));
  t.setHours(state.settings.graceHour, 0, 0, 0);
  return t;
}

// "HH:MM" left until the day closes.
function untilClose(key, now = clock.now()) {
  const mins = Math.max(0, Math.floor((closeTime(key) - now) / 60000));
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function updateCountdown() {
  const el = screen.querySelector('#closes-in');
  if (!el || !viewKey) return;
  const now = clock.now();
  const complete = C.isDayComplete(state.days[viewKey]);
  const soon = closeTime(viewKey) - now < 3600e3;
  el.className = `closes-in ${!complete && soon ? 'soon' : ''}`;
  el.textContent = complete ? `Day closes in ${untilClose(viewKey, now)} · all done` : `Day closes in ${untilClose(viewKey, now)}`;
}

// Live "mm:ss" on running workout timers.
function updateTimers() {
  for (const el of screen.querySelectorAll('[data-since]')) {
    const secs = Math.max(0, Math.floor((clock.now() - Date.parse(el.dataset.since)) / 1000));
    el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }
}

const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function workoutSub(w) {
  if (C.workoutRunning(w)) return `Running · started ${fmtClock(w.startedAt)}`;
  if (w.done && w.minutes != null) {
    const span = w.startedAt && w.endedAt ? ` · ${fmtClock(w.startedAt)}–${fmtClock(w.endedAt)}` : '';
    return `${w.minutes} min${span}${w.minutes < C.WORKOUT_MINUTES ? ` (under ${C.WORKOUT_MINUTES})` : ''}`;
  }
  if (w.done) return `${C.WORKOUT_MINUTES} minutes · logged without timer`;
  return `${C.WORKOUT_MINUTES} minutes`;
}

function workoutTimer(id, w) {
  if (w.done) return '';
  if (C.workoutRunning(w)) {
    return `<div class="workout-timer">
      <span class="elapsed" data-since="${w.startedAt}">0:00</span>
      <button class="chip timer on" data-action="wk-finish" data-id="${id}">Finish</button>
      <button class="chip" data-action="wk-cancel" data-id="${id}" aria-label="Cancel timer">Cancel</button>
    </div>`;
  }
  return `<div class="workout-timer"><button class="chip timer" data-action="wk-start" data-id="${id}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Start timer</button></div>`;
}

// During the grace window both yesterday and today can be edited.
function graceSwitch(a, today, yesterday) {
  const yDay = state.days[yesterday];
  const left = C.missingTasks(yDay).length;
  const yNote = left ? `${left} left · closes ${graceLabel(state.settings.graceHour)}` : 'Complete';
  const btn = (key, label, note, warn) =>
    `<button class="seg-btn ${viewKey === key ? 'on' : ''} ${warn ? 'warn' : ''}" data-action="view" data-key="${key}">
      <b>${label}</b><small>${note}</small></button>`;
  return `<div class="seg" role="group" aria-label="Choose day">
    ${btn(yesterday, `Day ${C.dayNumber(a.startDate, yesterday)}`, yNote, left > 0)}
    ${btn(today, `Day ${C.dayNumber(a.startDate, today)}`, 'Today', false)}
  </div>`;
}

// Carry the book title over from the last day you read.
function prefillDay(key) {
  const day = C.normalizeDay(state.days[key]);
  if (!day.reading.title) {
    const title = C.lastReadingTitle(state, key);
    if (title) {
      day.reading.title = title;
      state = { ...state, days: { ...state.days, [key]: day } };
      save();
    }
  }
  return day;
}

function taskCards(day) {
  const s = C.taskState(day);
  const pct = Math.min(1, day.water / C.WATER_GOAL_OZ);
  const circ = 2 * Math.PI * 34;

  const workout = (id, label) => `
    <div class="card workout ${s[id] ? 'done' : ''}" data-task="${id}">
      <div class="workout-top">
        <button class="card-main" data-action="toggle" data-id="${id}" aria-pressed="${s[id]}">
          <span class="card-text"><span class="card-title">${label}</span><span class="card-sub">${workoutSub(day[id])}</span></span>${CHECK}
        </button>
        <button class="chip ${day[id].outdoor ? 'on' : ''}" data-action="outdoor" data-id="${id}" aria-pressed="${day[id].outdoor}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          Outdoor</button>
      </div>
      ${workoutTimer(id, day[id])}
    </div>`;

  const toggle = (id, label, sub) => `
    <button class="card card-main toggle ${s[id] ? 'done' : ''}" data-task="${id}" data-action="toggle" data-id="${id}" aria-pressed="${s[id]}">
      <span class="card-text"><span class="card-title">${label}</span><span class="card-sub">${sub}</span></span>${CHECK}
    </button>`;

  return `
    ${workout('workout1', 'Workout #1')}
    ${workout('workout2', 'Workout #2')}
    <p id="outdoor-hint" class="hint"></p>
    <p id="gap-hint" class="hint bad" hidden>Workouts look back to back: the two can't be done consecutively. Leave at least ${C.MIN_WORKOUT_GAP_MIN} minutes between them.</p>
    ${toggle('diet', 'Follow diet', dietSub())}
    ${toggle('alcohol', 'No alcohol', 'Zero drinks today')}

    <div class="card water ${s.water ? 'done' : ''}" data-task="water">
      <button class="ring-btn" data-action="water-add" aria-label="Add 16 ounces">
        <svg class="ring" viewBox="0 0 80 80" aria-hidden="true">
          <circle class="ring-bg" cx="40" cy="40" r="34"/>
          <circle class="ring-fg" cx="40" cy="40" r="34" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct)}"/>
        </svg>
        <span class="ring-label"><b>${day.water}</b><small>/ ${C.WATER_GOAL_OZ} oz</small></span>
      </button>
      <div class="water-side">
        <span class="card-title">Water</span>
        <span class="card-sub">${Math.max(0, C.WATER_GOAL_OZ - day.water)} oz to go</span>
        <div class="water-presets">
          ${[8, 12, 16, 32].map((oz) => `<button class="chip" data-action="water-add" data-oz="${oz}">+${oz}</button>`).join('')}
        </div>
        <div class="row water-custom">
          <input class="field" id="water-custom" type="number" inputmode="numeric" min="1" max="${C.MAX_WATER_OZ}" placeholder="oz" aria-label="Custom amount in ounces">
          <button class="btn-add" data-action="water-custom">Add</button>
          <button class="btn-icon" data-action="water-sub" aria-label="Undo last water" ${day.water ? '' : 'disabled'}>−</button>
        </div>
      </div>
      ${CHECK}
    </div>

    <div class="card reading ${s.reading ? 'done' : ''}" data-task="reading">
      <div class="card-head">
        <span class="card-text"><span class="card-title">Read 10 pages</span><span class="card-sub">Nonfiction</span></span>${CHECK}
      </div>
      <input class="field" data-field="title" value="${esc(day.reading.title)}" placeholder="Book title" autocomplete="off" enterkeyhint="done" aria-label="Book title">
      <div class="row stepper">
        <button class="btn-icon" data-action="pages-sub" aria-label="One page fewer">−</button>
        <label class="pages"><input data-field="pages" type="number" inputmode="numeric" min="0" max="2000" value="${day.reading.pages}" aria-label="Pages read"><span>pages</span></label>
        <button class="btn-icon" data-action="pages-add" aria-label="One more page">+</button>
        <button class="chip" data-action="pages-ten">+10</button>
      </div>
    </div>

    <div class="card photo ${s.photo ? 'done' : ''}" data-task="photo">
      <label class="card-main photo-pick">
        <input class="visually-hidden" type="file" accept="image/*" data-field="photo">
        <span class="thumb-wrap">${day.photo ? `<img class="thumb" data-photo-key="${viewKey}" alt="Progress photo">` : '<svg class="cam" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>'}</span>
        <span class="card-text"><span class="card-title">Progress photo</span><span class="card-sub">${day.photo ? 'Tap to retake' : 'Tap to take or choose'}</span></span>${CHECK}
      </label>
    </div>`;
}

function dietSub() {
  const est = K.estimate(state.profile);
  return est ? `No cheat meals · ${est.target.toLocaleString()} cal target` : 'No cheat meals';
}

// Update completion markers in place (keeps keyboard focus while typing).
function patchToday() {
  if (tab !== 'today' || !viewKey || !state.attempt) return;
  const day = C.normalizeDay(state.days[viewKey]);
  const s = C.taskState(day);
  for (const t of C.TASKS) {
    const el = screen.querySelector(`[data-task="${t.id}"]`);
    if (el) el.classList.toggle('done', s[t.id]);
  }

  const hint = screen.querySelector('#outdoor-hint');
  if (hint) {
    const anyOutdoorMarked = day.workout1.outdoor || day.workout2.outdoor;
    hint.className = `hint ${s.outdoor ? 'ok' : s.workout1 && s.workout2 ? 'bad' : ''}`;
    hint.textContent = s.outdoor ? 'Outdoor workout logged'
      : anyOutdoorMarked ? 'Finish the outdoor workout to count it'
      : 'One workout must be outdoors: tap Outdoor';
  }
  const gap = screen.querySelector('#gap-hint');
  if (gap) gap.hidden = !C.workoutsBackToBack(day);
  updateCountdown();
  updateTimers();

  const status = screen.querySelector('#status');
  if (status) {
    const done = C.doneCount(day);
    const complete = C.isDayComplete(day);
    const n = C.dayNumber(state.attempt.startDate, viewKey);
    status.className = `status ${complete ? 'complete' : ''}`;
    status.innerHTML = complete
      ? `<span class="stamp">Day ${n} complete</span>`
      : `<span class="count"><b>${done}</b>/${C.TASKS.length} done</span><span class="dots">${C.TASKS.map((t) => `<i class="${s[t.id] ? 'on' : ''}"></i>`).join('')}</span>`;
    const fill = screen.querySelector('#run-fill');
    if (fill) fill.style.width = `${((n - 1 + (complete ? 1 : 0)) / C.TOTAL_DAYS) * 100}%`;
  }
}

// Fill every <img data-photo-key> on screen from IndexedDB.
async function loadPhotos() {
  for (const img of screen.querySelectorAll('img[data-photo-key]')) {
    const key = img.dataset.photoKey;
    if (!photoUrls.has(key)) {
      const rec = await store.getPhoto(key).catch(() => null);
      if (!rec) { img.remove(); continue; }
      photoUrls.set(key, URL.createObjectURL(rec.blob));
    }
    img.src = photoUrls.get(key);
  }
}

function onboarding() {
  const items = ['Workout #1 · 45 min', 'Workout #2 · 45 min (one outdoors)', 'Follow your diet, no cheat meals', 'No alcohol', 'Drink a gallon of water', 'Read 10 pages of nonfiction', 'Take a progress photo'];
  return `<section class="onboard">
    <p class="eyebrow">Ironclad 75</p>
    <h1 class="title">75 days.<br>7 tasks.<br><span class="accent">No days off.</span></h1>
    <ol class="rules">${items.map((i) => `<li>${i}</li>`).join('')}</ol>
    <p class="lead">Miss anything by midnight and you're back to Day 1.</p>
    <button class="btn-primary" data-action="start-today">Start Day 1 today</button>
    <div class="alt-start">
      <label for="start-date" class="muted">Or start on another date</label>
      <div class="row"><input type="date" id="start-date" class="field" min="${earliestStart()}" value="${C.dateKey(clock.now())}"><button class="btn-secondary" data-action="start-on-date">Set</button></div>
    </div>
    ${installPrompt && !isInstalled() ? '<button class="btn-secondary install-btn" data-action="install">Install app on this phone</button>' : ''}
  </section>`;
}

function victory() {
  return `<section class="hero-msg win">
    <p class="eyebrow">Attempt #${state.attempts.length}</p>
    <h1 class="mega">75<span>/75</span></h1>
    <p class="lead">Challenge complete. Every task, every day.</p>
    <button class="btn-primary" data-action="start-today">Start a new run</button>
  </section>`;
}

function renderOverlay() {
  const e = state.pendingEvent;
  overlay.hidden = !e;
  if (!e) return (overlay.innerHTML = '');
  if (e.type === 'won') {
    overlay.innerHTML = `<div class="sheet win" role="dialog" aria-modal="true" aria-labelledby="ov-title">
      <p class="eyebrow">Attempt #${e.attemptNumber}</p>
      <h1 id="ov-title" class="mega">75<span>/75</span></h1>
      <p class="lead">You finished. ${fmtDate(e.startDate)} to ${fmtDate(e.endDate)}, no days off.</p>
      <button class="btn-primary" data-action="ack">Done</button>
    </div>`;
    if (!celebrated) fx.dayComplete();
    celebrated = true;
    return;
  }
  overlay.innerHTML = `<div class="sheet reset" role="dialog" aria-modal="true" aria-labelledby="ov-title">
    <p class="eyebrow">Attempt #${e.attemptNumber} ended</p>
    <h1 id="ov-title" class="title">Back to<br><span class="danger">Day 1</span></h1>
    <p class="lead">Day ${e.failedDay} (${fmtDate(e.endDate)}) wasn't finished.</p>
    <p class="missing">Missed: ${e.missing.map(esc).join(', ')}</p>
    <div class="stat-row">
      <div><b>${e.daysCompleted}</b><span>days completed</span></div>
      <div><b>${bestRun()}</b><span>best run</span></div>
      <div><b>${state.attempts.length}</b><span>attempts so far</span></div>
    </div>
    <button class="btn-primary" data-action="ack">Start Day 1 today</button>
  </div>`;
}

function renderSettings() {
  const st = state.settings;
  const a = state.attempt;
  const history = [...state.attempts].reverse();
  const resultLabel = { reset: 'Reset', completed: 'Completed', restarted: 'Restarted' };
  const graceOpts = [0, 1, 2, 3, 4].map((h) => `<option value="${h}" ${st.graceHour === h ? 'selected' : ''}>${h === 0 ? 'None (strict midnight)' : `Until ${h}:00 AM`}</option>`).join('');
  const themeOpts = [['system', 'Match phone'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => `<option value="${v}" ${st.theme === v ? 'selected' : ''}>${l}</option>`).join('');

  return `<section class="settings">
    <h2 class="screen-title">Settings</h2>
    ${installRow()}

    <div class="group">
      <div class="setting col">
        <label for="set-start">Start date${a ? '' : ' (not started)'}</label>
        <div class="row"><input type="date" id="set-start" class="field" min="${earliestStart()}" value="${a ? a.startDate : C.dateKey(clock.now())}"><button class="btn-secondary" data-action="change-start">Change</button></div>
        <small class="muted">Changing it starts a new run. Days before today count as done off-app.</small>
      </div>
      <div class="setting">
        <label for="set-grace">Grace window</label>
        <select id="set-grace" data-setting="graceHour">${graceOpts}</select>
      </div>
      <small class="muted pad">Lets you finish logging yesterday after midnight, e.g. if you did it but forgot to tap.</small>
      <div class="setting">
        <label for="set-theme">Appearance</label>
        <select id="set-theme" data-setting="theme">${themeOpts}</select>
      </div>
      <div class="setting">
        <label for="set-sound">Sounds</label>
        <input type="checkbox" id="set-sound" class="switch" data-setting="sound" ${st.sound ? 'checked' : ''}>
      </div>
    </div>

    <div class="group">
      <h3>Attempt history</h3>
      ${history.length ? `<ul class="history">${history.map((h, i) => `
        <li><span><b>#${history.length - i}</b> ${fmtDate(h.startDate)} – ${fmtDate(h.endDate)}</span>
        <span class="tag ${h.result}">${resultLabel[h.result]} · ${h.daysCompleted}d</span></li>`).join('')}</ul>`
        : '<p class="muted">No past attempts yet.</p>'}
    </div>

    ${remindersGroup()}
    ${cloudGroup()}
    ${backupGroup()}
    ${a ? '<div class="group"><button class="btn-danger" data-action="restart">Restart challenge</button></div>' : ''}
    ${clock.isDebug ? debugPanel() : ''}
  </section>`;
}

// ---- Calendar ----------------------------------------------------------------

const STATUS_LABEL = { done: 'Complete', today: 'In progress', open: 'Still open', missed: 'Missed', upcoming: 'Upcoming', none: 'Not reached' };

function renderCalendar() {
  const runs = state.attempts;
  if (!state.attempt && !runs.length) {
    return `<section class="empty"><p class="eyebrow">Calendar</p><h2>No run yet</h2><p class="muted">Start your challenge on the Today tab.</p></section>`;
  }
  if (calRun != null && !runs[calRun]) calRun = null;
  const activeRun = state.attempt?.status === 'active';
  if (calRun == null && !activeRun) calRun = runs.length - 1; // a finished run is already in history
  const run = calRun == null ? state.attempt : runs[calRun];
  const now = clock.now();
  const today = C.dateKey(now);
  const end = C.addDays(run.startDate, C.TOTAL_DAYS - 1);
  if (!calKey || calKey < run.startDate || calKey > end) {
    calKey = run.result ? run.endDate : today >= run.startDate && today <= end ? today : run.startDate;
  }

  // Pad the first week so columns line up with weekdays.
  const lead = C.parseKey(run.startDate).getDay();
  let cells = '<span class="cal-pad"></span>'.repeat(lead);
  let done = 0;
  for (let i = 0; i < C.TOTAL_DAYS; i++) {
    const key = C.addDays(run.startDate, i);
    const status = C.runDayStatus(state, run, key, now);
    if (status === 'done') done++;
    const d = C.parseKey(key);
    const month = i === 0 || d.getDate() === 1 ? `<small>${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>` : '';
    const progress = status === 'today' || status === 'open' ? `<i style="--p:${C.doneCount(state.days[key]) / C.TASKS.length}"></i>` : '';
    cells += `<button class="cal-cell ${status} ${key === calKey ? 'sel' : ''}" data-action="cal-day" data-key="${key}"
      aria-label="Day ${i + 1}, ${fmtDate(key)}: ${STATUS_LABEL[status]}">${month}<b>${i + 1}</b>${progress}</button>`;
  }

  const options = [
    ...(activeRun ? [`<option value=""${calRun == null ? 'selected' : ''}>Current · Attempt #${runs.length + 1}</option>`] : []),
    ...runs.map((r, i) => `<option value="${i}" ${calRun === i ? 'selected' : ''}>#${i + 1} · ${fmtDate(r.startDate, { month: 'short', day: 'numeric' })} – ${fmtDate(r.endDate, { month: 'short', day: 'numeric' })} · ${r.result}</option>`).reverse(),
  ].join('');

  return `<section class="calendar">
    <div class="cal-top">
      <h2 class="screen-title">Calendar</h2>
      <span class="cal-count"><b>${done}</b>/${C.TOTAL_DAYS}</span>
    </div>
    ${runs.length ? `<select id="cal-run" class="calc-select cal-run" aria-label="Choose attempt">${options}</select>` : ''}
    <div class="cal-week" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend">
      <span><i class="done"></i>Complete</span><span><i class="today"></i>Today</span>
      <span><i class="missed"></i>Missed</span><span><i class="upcoming"></i>Upcoming</span>
    </div>
    ${dayDetail(run, calKey, now)}
  </section>`;
}

function dayDetail(run, key, now) {
  const status = C.runDayStatus(state, run, key, now);
  const n = C.dayNumber(run.startDate, key);
  const raw = state.days[key];
  const head = `<div class="cal-detail-head">
      <div><p class="eyebrow">Day ${n}</p><h3>${fmtDate(key, { weekday: 'long', month: 'long', day: 'numeric' })}</h3></div>
      <span class="tag ${status}">${STATUS_LABEL[status]}</span>
    </div>`;

  if (status === 'upcoming' || status === 'none' || (!raw && status !== 'missed')) {
    return `<div class="cal-detail">${head}<p class="muted">${status === 'none' ? 'No log for this day.' : 'Nothing logged yet.'}</p></div>`;
  }
  if (raw?.manual) return `<div class="cal-detail">${head}<p class="muted">Completed off-app.</p></div>`;

  const d = C.normalizeDay(raw);
  const s = C.taskState(d);
  const row = (ok, label, detail = '') =>
    `<li class="${ok ? 'on' : ''}"><span class="mark" aria-hidden="true">${ok ? '✓' : '✕'}</span><span>${label}</span><small>${detail}</small></li>`;
  const outdoorNote = (w) => (d[w].outdoor ? 'Outdoor' : '');
  const editable = !run.result && C.openKeys(now, state.settings.graceHour).includes(key);

  return `<div class="cal-detail">${head}
    <div class="cal-detail-body">
      <ul class="cal-tasks">
        ${row(s.workout1, 'Workout #1', outdoorNote('workout1'))}
        ${row(s.workout2, 'Workout #2', outdoorNote('workout2'))}
        ${row(s.diet, 'Diet')}
        ${row(s.alcohol, 'No alcohol')}
        ${row(s.water, 'Water', `${d.water} oz`)}
        ${row(s.reading, 'Reading', d.reading.pages ? `${d.reading.pages} p${d.reading.title ? ` · ${esc(d.reading.title)}` : ''}` : '')}
        ${row(s.photo, 'Photo')}
      </ul>
      ${d.photo ? `<img class="cal-photo" data-photo-key="${key}" alt="Progress photo, day ${n}">` : ''}
    </div>
    ${s.workout1 && s.workout2 && !s.outdoor ? '<p class="warn-text fine">Neither workout was outdoors.</p>' : ''}
    ${editable ? `<button class="btn-secondary wide" data-action="cal-open" data-key="${key}">Edit in Today</button>` : ''}
  </div>`;
}

// ---- Stats ---------------------------------------------------------------------

function statsTiles() {
  const st = C.computeStats(state, clock.now());
  const gal = (oz) => (oz / 128).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const fmt = (n) => n.toLocaleString();
  const tile = (value, label, cls = '') => `<div class="tile ${cls}"><b>${value}</b><span>${label}</span></div>`;
  const maxCause = st.resetCauses[0]?.[1] || 1;

  return `
    <div class="tiles">
      ${tile(st.currentStreak, 'current streak', 'hot')}
      ${tile(st.longestStreak, 'longest streak')}
      ${tile(st.attempts, st.attempts === 1 ? 'attempt' : 'attempts')}
      ${tile(st.daysCompleted, 'days completed')}
    </div>
    <div class="group totals">
      <h3>Water</h3>
      <div class="total-row"><span>This run</span><b>${gal(st.run.waterOz)} gal</b></div>
      <div class="total-row"><span>All time</span><b>${gal(st.allTime.waterOz)} gal</b></div>
      <h3>Reading</h3>
      <div class="total-row"><span>This run</span><b>${fmt(st.run.pages)} pages</b></div>
      <div class="total-row"><span>All time</span><b>${fmt(st.allTime.pages)} pages · ${st.allTime.books} book${st.allTime.books === 1 ? '' : 's'}</b></div>
    </div>
    ${st.resetCauses.length ? `<div class="group">
      <h3>What reset you</h3>
      <ul class="causes">${st.resetCauses.map(([label, count]) => `
        <li><span>${esc(label)}</span><span class="bar"><i style="width:${(count / maxCause) * 100}%"></i></span><b>${count}×</b></li>`).join('')}
      </ul>
    </div>` : ''}`;
}

function renderStats() {
  const p = state.profile;
  const imperial = p.units === 'imperial';
  const seg = (key, value, label) =>
    `<button class="seg-btn ${p[key] === value ? 'on' : ''}" data-action="profile" data-key="${key}" data-v="${value}" aria-pressed="${p[key] === value}"><b>${label}</b></button>`;
  const input = (key, label, unit, attrs = '') =>
    `<label class="calc-field"><span>${label}</span><span class="calc-input"><input type="number" inputmode="decimal" data-profile="${key}" value="${esc(p[key])}" ${attrs}><small>${unit}</small></span></label>`;

  return `<section class="stats">
    <h2 class="screen-title">Stats</h2>
    ${statsTiles()}

    <div class="group calc">
      <h3>Daily calorie burn</h3>
      <div id="calc-result" class="calc-result">${calcResult()}</div>

      <div class="seg calc-seg">${seg('sex', 'male', 'Male')}${seg('sex', 'female', 'Female')}</div>
      <div class="calc-grid">
        ${input('age', 'Age', 'yrs', 'min="13" max="100"')}
        ${imperial
          ? `${input('weightLb', 'Weight', 'lb')}${input('heightFt', 'Height', 'ft', 'min="3" max="8"')}${input('heightIn', '&nbsp;', 'in', 'min="0" max="11"')}`
          : `${input('weightKg', 'Weight', 'kg')}${input('heightCm', 'Height', 'cm')}`}
      </div>

      <label class="calc-label" for="calc-activity">Activity level</label>
      <select id="calc-activity" class="calc-select" data-profile="activity">
        ${K.ACTIVITY.map((a) => `<option value="${a.id}" ${p.activity === a.id ? 'selected' : ''}>${a.label} (${a.note})</option>`).join('')}
      </select>

      <label class="calc-label" for="calc-goal">Goal</label>
      <select id="calc-goal" class="calc-select" data-profile="goal">
        ${K.GOALS.map((g) => `<option value="${g.id}" ${p.goal === g.id ? 'selected' : ''}>${g.label}</option>`).join('')}
      </select>

      <div class="calc-units">
        <span class="muted">Units</span>
        <div class="seg">${seg('units', 'imperial', 'lb / ft')}${seg('units', 'metric', 'kg / cm')}</div>
      </div>
      <p class="muted fine">Estimate using the Mifflin-St Jeor equation. Not medical advice.</p>
    </div>

  </section>`;
}

function calcResult() {
  const est = K.estimate(state.profile);
  if (!est) return '<p class="muted calc-empty">Enter your age, weight and height to see your daily burn.</p>';
  const fmt = (n) => n.toLocaleString();
  return `
    <div class="calc-big"><b>${fmt(est.tdee)}</b><span>calories burned / day</span></div>
    <div class="calc-row"><span>Resting (BMR)</span><b>${fmt(est.bmr)}</b></div>
    <div class="calc-row target"><span>Eat to ${est.goal.label.toLowerCase()}</span><b>${fmt(est.target)}</b></div>
    ${est.floored ? '<p class="fine warn-text">Raised to the safe minimum for your sex.</p>' : ''}`;
}

function setProfile(patch) {
  state = { ...state, profile: { ...state.profile, ...patch } };
  save();
  const el = screen.querySelector('#calc-result');
  if (el) el.innerHTML = calcResult();
}

// ---- Photos --------------------------------------------------------------------

function photoLabel(key) {
  const r = C.runForKey(state, key);
  return r ? `Day ${r.day}` : fmtDate(key, { month: 'short', day: 'numeric' });
}

function renderPhotos() {
  if (!photoList.length) {
    return `<section class="empty"><p class="eyebrow">Photos</p><h2>No photos yet</h2><p class="muted">Take your first progress photo on the Today tab.</p></section>`;
  }
  // Default comparison: Day 1 of this run vs the latest photo.
  const cur = state.attempt;
  if (!photoList.includes(cmpA)) cmpA = (cur && photoList.find((k) => k >= cur.startDate)) || photoList[0];
  if (!photoList.includes(cmpB)) cmpB = photoList[photoList.length - 1];

  const options = (sel) => [...photoList].reverse().map((k) =>
    `<option value="${k}" ${k === sel ? 'selected' : ''}>${photoLabel(k)} · ${fmtDate(k, { month: 'short', day: 'numeric' })}</option>`).join('');
  const pane = (side, key) => `
    <figure class="cmp">
      <button class="cmp-img" data-action="lightbox" data-key="${key}" aria-label="View ${photoLabel(key)} full screen">
        <img data-photo-key="${key}" alt="${photoLabel(key)} progress photo"><span class="cmp-tag">${photoLabel(key)}</span>
      </button>
      <select class="cmp-select" data-cmp="${side}" aria-label="${side === 'a' ? 'Left' : 'Right'} photo">${options(key)}</select>
    </figure>`;

  // Gallery grouped by attempt, newest first.
  const groups = new Map();
  for (const k of [...photoList].reverse()) {
    const r = C.runForKey(state, k);
    const label = r ? `Attempt #${r.number}${r.run === state.attempt && r.run.status === 'active' ? ' (current)' : ''}` : 'Other';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(k);
  }
  const gallery = [...groups].map(([label, keys]) => `
    <h3 class="g-head">${label}</h3>
    <div class="gallery">${keys.map((k) => `
      <button class="g-item ${k === cmpB ? 'sel' : ''}" data-action="cmp-pick" data-key="${k}" aria-label="Compare ${photoLabel(k)}">
        <img data-photo-key="${k}" alt="" loading="lazy"><span>${photoLabel(k).replace('Day ', '')}</span>
      </button>`).join('')}
    </div>`).join('');

  return `<section class="photos">
    <div class="cal-top"><h2 class="screen-title">Photos</h2><span class="cal-count"><b>${photoList.length}</b> total</span></div>
    <div class="compare">${pane('a', cmpA)}${pane('b', cmpB)}</div>
    <p class="muted fine center">Tap a photo below to compare it with ${photoLabel(cmpA)}. Tap a big photo to see it full screen.</p>
    ${gallery}
  </section>`;
}

function openLightbox(key) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${photoUrls.get(key) || ''}" alt="${photoLabel(key)} progress photo">
    <p>${photoLabel(key)} · ${fmtDate(key, { weekday: 'short', month: 'long', day: 'numeric' })}</p>`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

// ---- Reminders and backup (Settings) -------------------------------------------

const README_URL = 'https://github.com/thehickeyduopnw-dot/ironclad-75#cloud-backend-and-muse-api';
let freshApiKey = null; // shown once after generating, then forgotten
let apiKeyInfo = null; // { active, created_at } from the backend
let relinkBlocked = false; // Connect was refused: the backend is linked to another phone

function remindersGroup() {
  const pushReady = cloudOn() && state.cloud.pushToken;
  const time = `<div class="setting">
      <label for="set-remind">Reminder time</label>
      <input type="time" id="set-remind" class="time-input" data-setting="reminderTime" value="${state.settings.reminderTime}">
    </div>`;
  const body = pushReady
    ? `<div class="setting">
        <label for="set-remind-push">Push notification</label>
        <input type="checkbox" id="set-remind-push" class="switch" data-setting="reminderPush" ${state.settings.reminderPush !== false ? 'checked' : ''}>
      </div>
      <small class="muted pad">Sent at ${fmtTime(state.settings.reminderTime)} only if something is left. Today also shows a banner.</small>`
    : `<p class="muted pad-y">Today shows a banner after this time. For a push notification, connect the cloud backend below.</p>`;
  return `<div class="group"><h3>Evening reminder</h3>${time}${body}</div>`;
}

function cloudGroup() {
  if (clock.isDebug) return '<div class="group"><h3>Cloud &amp; Muse</h3><p class="muted pad-y">Turned off in test mode.</p></div>';
  if (!cloud.linked(state.cloud)) {
    const relink = state.cloud.needsRelink
      ? '<p class="warn-text pad-y">Restored from a backup. Backups don\'t include the cloud link, so tap Connect to re-link this phone.</p>'
      : '';
    // The backend only accepts the first phone; a restored or new phone needs the old link cleared.
    const blocked = relinkBlocked
      ? `<p class="pad-y fine">The backend is still linked to your previous phone. In Supabase, open <b>Table Editor → kv</b>, delete the <code>app_secret</code> row, then tap Connect again. Your data and API key stay as they are.</p>`
      : '';
    return `<div class="group"><h3>Cloud &amp; Muse</h3>
      ${relink}${blocked}
      <div class="setting col">
        <label for="cloud-url">Backend address</label>
        <input id="cloud-url" class="field" type="url" inputmode="url" autocomplete="off" placeholder="https://xxxx.supabase.co/functions/v1/ironclad" value="${esc(state.cloud.url || '')}">
        <button class="btn-primary" data-action="cloud-link">Connect</button>
        <small class="muted">Syncs your daily log so Muse can read it and log tasks for you, and enables push notifications. Your photos stay on the phone. One-time setup: <a href="${README_URL}" target="_blank" rel="noopener">guide</a>.</small>
      </div></div>`;
  }
  const last = cloud.lastSync();
  const synced = last ? `Synced ${new Date(last).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Not synced yet';
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const push = !cloud.pushConfigured() ? '<span class="muted">not set up yet (Firebase settings missing)</span>'
    : state.cloud.pushToken ? '<b class="accent">on</b>'
    : perm === 'denied' ? '<span class="warn-text">blocked in phone settings</span>'
    : '<button class="btn-secondary" data-action="cloud-push">Enable</button>';
  const key = freshApiKey
    ? `<div class="key-box"><p class="fine warn-text">Copy it now: it won't be shown again.</p><code id="api-key">${esc(freshApiKey)}</code>
        <button class="btn-primary" data-action="key-copy">Copy API key</button></div>`
    : `<p class="muted pad-y">API key: ${apiKeyInfo == null ? '…' : apiKeyInfo.active ? `active since ${new Date(apiKeyInfo.created_at).toLocaleDateString()}` : 'none'}</p>`;

  return `<div class="group"><h3>Cloud &amp; Muse</h3>
    <div class="setting"><span>${synced}</span><button class="btn-secondary" data-action="cloud-sync">Sync now</button></div>
    <div class="setting"><span>Notifications</span>${push}</div>
    ${state.cloud.pushToken ? '<div class="setting"><span>Test</span><button class="btn-secondary" data-action="cloud-test">Send test</button></div>' : ''}
    <h3>API key for Muse</h3>
    ${key}
    <div class="row pad-b">
      <button class="btn-secondary grow" data-action="key-new">${apiKeyInfo?.active ? 'Regenerate' : 'Generate'}</button>
      ${apiKeyInfo?.active ? '<button class="btn-secondary grow" data-action="key-revoke">Revoke</button>' : ''}
    </div>
    <p class="muted fine pad-b">API address: <code>${esc(state.cloud.url)}</code></p>
  </div>`;
}

// Fetch the key status once per visit to Settings.
function loadApiKeyInfo() {
  if (!cloudOn() || apiKeyInfo) return;
  cloud.apiKeyStatus(state.cloud).then((info) => {
    apiKeyInfo = info;
    if (tab === 'settings') render();
  }).catch(() => {});
}

function backupGroup() {
  const last = state.lastBackupAt ? new Date(state.lastBackupAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'never';
  return `<div class="group">
    <h3>Backup</h3>
    <p class="muted pad-y">Everything lives only on this phone. Export a backup (photos included) every week or so and keep it somewhere safe, like Google Drive.</p>
    <p class="muted fine pad-b">Backups don't include the Cloud &amp; Muse link (it's a secret that lets a device act as this phone). After restoring, reconnect in Cloud &amp; Muse.</p>
    <div class="row pad-b">
      <button class="btn-secondary grow" data-action="export">Export backup</button>
      <label class="btn-secondary grow file-btn">Import backup<input class="visually-hidden" type="file" accept="application/json,.json" data-field="import"></label>
    </div>
    <p class="muted fine pad-b">Last export: ${last}</p>
  </div>`;
}

// Run an async button action with a busy label; errors become a toast.
async function busy(el, label, fn) {
  const old = el.textContent;
  el.disabled = true;
  el.textContent = label;
  try {
    await fn();
  } catch (err) {
    toast(err.message || String(err));
  } finally {
    el.disabled = false;
    el.textContent = old;
  }
}

function installRow() {
  if (isInstalled()) return '';
  if (installPrompt) {
    return `<div class="group"><div class="setting">
      <span class="col-text"><b>Install on this phone</b><small class="muted">Home-screen icon, full screen, works offline</small></span>
      <button class="btn-secondary" data-action="install">Install</button>
    </div></div>`;
  }
  return `<div class="group"><p class="muted install-help">To install: open the browser menu <b>⋮</b> and tap <b>Install app</b> or <b>Add to Home screen</b>.</p></div>`;
}

function debugPanel() {
  return `<div class="group debug">
    <h3>Test tools</h3>
    <p class="muted">Practice data only: your real log isn't touched. Simulated time: <b>${clock.now().toLocaleString()}</b></p>
    <div class="btn-grid">
      <button class="btn-secondary" data-action="dbg" data-v="hour">+1 hour</button>
      <button class="btn-secondary" data-action="dbg" data-v="day">+1 day</button>
      <button class="btn-secondary" data-action="dbg" data-v="midnight">Jump to 11:59 PM</button>
      <button class="btn-secondary" data-action="dbg" data-v="fill">Complete viewed day</button>
      <button class="btn-secondary" data-action="dbg" data-v="reset">Real time</button>
      <button class="btn-secondary" data-action="dbg" data-v="off">Leave test mode</button>
    </div>
  </div>`;
}

// ---- Actions -------------------------------------------------------------------

// Apply a change to one day's log, then give feedback for anything newly finished.
// `quiet` (changes from Muse): no sounds or screen updates; the caller re-renders.
// `at`: when the change was made, for the done_at times.
function updateDay(key, mutate, { rerender = true, quiet = false, at = null } = {}) {
  // The 20-second clock check may lag: make sure this day is still open first.
  evaluateNow();
  const a = state.attempt;
  if (a?.status !== 'active' || key < a.startDate || !C.openKeys(clock.now(), state.settings.graceHour).includes(key)) {
    if (!quiet) {
      render();
      toast('That day has closed.');
    }
    return { gained: [], applied: false };
  }
  const before = C.normalizeDay(state.days[key]);
  const prev = C.taskState(before);
  const wasComplete = C.isDayComplete(before);
  const day = structuredClone(before);
  mutate(day);

  const next = C.taskState(day);
  const gained = C.TASKS.filter((t) => next[t.id] && !prev[t.id]).map((t) => t.id);
  const lost = C.TASKS.some((t) => prev[t.id] && !next[t.id]);
  // When each task was finished (shared with Muse through the API).
  day.doneAt = { ...day.doneAt };
  for (const t of C.TASKS) {
    if (gained.includes(t.id)) day.doneAt[t.id] = at || clock.now().toISOString();
    else if (!next[t.id]) delete day.doneAt[t.id];
  }

  state = { ...state, days: { ...state.days, [key]: day } };
  save();
  if (quiet) return { gained, applied: true };

  if (rerender) render();
  else patchToday();
  for (const id of gained) screen.querySelector(`[data-task="${id}"]`)?.classList.add('just-done');

  if (C.isDayComplete(day) && !wasComplete) {
    fx.dayComplete();
    screen.querySelector('#status')?.classList.add('just-done');
  } else if (gained.length) fx.taskDone();
  else if (lost) fx.taskUndone();
  return { gained, applied: true };
}

// Further back than this, the "done off-app" days alone would finish the challenge.
const earliestStart = () => C.addDays(C.dateKey(clock.now()), -(C.TOTAL_DAYS - 1));

function startRun(startKey) {
  const today = C.dateKey(clock.now());
  if (startKey < earliestStart()) {
    toast(`The start date can be at most ${C.TOTAL_DAYS - 1} days ago.`);
    return;
  }
  if (startKey < today) {
    const days = C.daysBetween(startKey, today);
    if (!confirm(`Start on ${fmtDate(startKey)}? The ${days} day${days === 1 ? '' : 's'} before today will count as completed off-app.`)) return;
  }
  state = C.restart(state, startKey, clock.now());
  viewKey = null;
  save();
  showToday();
}

// Jump straight to Today, keeping the back-button history in step with the tab.
function showToday() {
  if (history.state?.tab) history.replaceState(null, '');
  tab = 'today';
  render();
  window.scrollTo(0, 0);
}

let lastWaterAdd = 0;

function addWater(oz) {
  lastWaterAdd = oz;
  const { gained } = updateDay(viewKey, (d) => { d.water = Math.min(d.water + oz, C.MAX_WATER_OZ); });
  if (!gained.length) fx.smallStep();
}

function finishWorkout(w) {
  const now = clock.now().toISOString();
  w.done = true;
  if (w.startedAt) {
    w.endedAt = now;
    w.minutes = C.elapsedMinutes(w.startedAt, now);
  }
}

const actions = {
  toggle(el) {
    const id = el.dataset.id;
    updateDay(viewKey, (d) => {
      if (id !== 'workout1' && id !== 'workout2') {
        d[id] = !d[id];
        return;
      }
      const w = d[id];
      if (C.workoutRunning(w)) return finishWorkout(w); // tapping a running workout finishes it
      w.done = !w.done;
      if (!w.done) Object.assign(w, { startedAt: null, endedAt: null, minutes: null });
    });
  },
  'wk-start'(el) {
    const now = clock.now().toISOString();
    updateDay(viewKey, (d) => { Object.assign(d[el.dataset.id], { startedAt: now, endedAt: null, minutes: null }); });
    fx.smallStep();
  },
  'wk-finish'(el) {
    updateDay(viewKey, (d) => finishWorkout(d[el.dataset.id]));
  },
  'wk-cancel'(el) {
    updateDay(viewKey, (d) => { Object.assign(d[el.dataset.id], { startedAt: null, endedAt: null, minutes: null }); });
  },
  outdoor(el) {
    const id = el.dataset.id;
    updateDay(viewKey, (d) => {
      d[id].outdoor = !d[id].outdoor;
      // Only one workout needs to be the outdoor one.
      const other = id === 'workout1' ? 'workout2' : 'workout1';
      if (d[id].outdoor) d[other].outdoor = false;
    });
    fx.smallStep();
  },
  'water-add'(el) {
    addWater(Number(el.dataset.oz) || C.WATER_STEP_OZ);
  },
  'water-custom'() {
    const oz = Math.round(Number(document.getElementById('water-custom')?.value));
    if (!(oz > 0 && oz <= C.MAX_WATER_OZ)) return toast(`Enter an amount from 1 to ${C.MAX_WATER_OZ} oz.`);
    addWater(oz);
  },
  // "−" undoes the last amount added (16 oz if nothing was added this session).
  'water-sub'() {
    const oz = lastWaterAdd || C.WATER_STEP_OZ;
    lastWaterAdd = 0;
    updateDay(viewKey, (d) => { d.water = Math.max(0, d.water - oz); });
  },
  'pages-add'() { updateDay(viewKey, (d) => { d.reading.pages += 1; }); },
  'pages-sub'() { updateDay(viewKey, (d) => { d.reading.pages = Math.max(0, d.reading.pages - 1); }); },
  'pages-ten'() { updateDay(viewKey, (d) => { d.reading.pages += 10; }); },
  view(el) {
    viewKey = el.dataset.key;
    render();
  },
  'start-today'() { startRun(C.dateKey(clock.now())); },
  'start-on-date'() {
    const v = document.getElementById('start-date').value;
    if (v) startRun(v);
  },
  'change-start'() {
    const v = document.getElementById('set-start').value;
    if (!v) return;
    if (state.attempt && !confirm('This ends your current run and starts a new one. Continue?')) return;
    startRun(v);
  },
  'cmp-pick'(el) {
    cmpB = el.dataset.key;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  lightbox(el) {
    openLightbox(el.dataset.key);
  },
  'cloud-link'(el) {
    busy(el, 'Connecting…', async () => {
      let linkedCloud;
      try {
        linkedCloud = await cloud.link(document.getElementById('cloud-url').value.trim());
      } catch (err) {
        if (/already linked/i.test(err.message)) {
          relinkBlocked = true;
          render();
          throw new Error('The backend is still linked to your previous phone. See the steps in Cloud & Muse.');
        }
        throw err;
      }
      relinkBlocked = false;
      state = { ...state, cloud: { ...linkedCloud, appliedIds: state.cloud.appliedIds || [] } };
      save();
      await syncNow();
      const token = await refreshPushToken(true).catch(() => null);
      apiKeyInfo = null;
      render();
      loadApiKeyInfo();
      toast(token ? 'Connected. Synced, and notifications are on.' : 'Connected and synced.');
    });
  },
  'cloud-sync'(el) {
    busy(el, 'Syncing…', async () => {
      await syncNow();
      render();
    });
  },
  'cloud-push'(el) {
    busy(el, 'Enabling…', async () => {
      const token = await refreshPushToken(true);
      if (!token) throw new Error("Notifications weren't allowed. Allow them for this app in your phone's settings.");
      render();
    });
  },
  'cloud-test'(el) {
    busy(el, 'Sending…', async () => {
      await cloud.sendTest(state.cloud);
      toast('Test sent. It should arrive in a few seconds.');
    });
  },
  'key-new'(el) {
    if (apiKeyInfo?.active && !confirm('Make a new API key? The old one stops working right away, so update it in Muse.')) return;
    busy(el, 'Generating…', async () => {
      const { api_key, created_at } = await cloud.regenerateApiKey(state.cloud);
      freshApiKey = api_key;
      apiKeyInfo = { active: true, created_at };
      render();
    });
  },
  'key-revoke'(el) {
    if (!confirm('Revoke the API key? Muse will lose access until you generate a new one.')) return;
    busy(el, 'Revoking…', async () => {
      await cloud.revokeApiKey(state.cloud);
      freshApiKey = null;
      apiKeyInfo = { active: false, created_at: null };
      render();
    });
  },
  async 'key-copy'() {
    try {
      await navigator.clipboard.writeText(freshApiKey);
      toast('API key copied.');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('api-key'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast('Press and hold to copy the selected key.');
    }
  },
  export(el) {
    busy(el, 'Preparing…', async () => {
      const { photos, bytes } = await B.exportBackup(state);
      state = { ...state, lastBackupAt: Date.now() };
      save();
      render();
      toast(`Backup saved: ${photos} photo${photos === 1 ? '' : 's'}, ${(bytes / 1048576).toFixed(1)} MB. Check your Downloads.`);
    });
  },
  'cal-day'(el) {
    calKey = el.dataset.key;
    render();
    screen.querySelector('.cal-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  'cal-open'(el) {
    viewKey = el.dataset.key;
    goTab('today');
  },
  profile(el) {
    const { key, v } = el.dataset;
    if (key === 'units') state = { ...state, profile: K.convertUnits(state.profile, v) };
    else state = { ...state, profile: { ...state.profile, [key]: v } };
    save();
    render();
  },
  async install() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    render();
  },
  restart() {
    if (!confirm('Restart the challenge at Day 1 today? Your current run goes into history.')) return;
    startRun(C.dateKey(clock.now()));
  },
  ack() {
    state = { ...state, pendingEvent: null };
    save();
    viewKey = null;
    showToday();
  },
  dbg(el) {
    const v = el.dataset.v;
    if (v === 'hour') clock.shiftClock(3600e3);
    if (v === 'day') clock.shiftClock(86400e3);
    if (v === 'midnight') {
      const n = clock.now();
      const target = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 0);
      clock.shiftClock(target - n);
    }
    if (v === 'reset') clock.resetClock();
    if (v === 'off') { clock.disableDebug(); location.replace(location.pathname); return; }
    if (v === 'fill' && state.attempt) {
      const key = viewKey || C.dateKey(clock.now());
      updateDay(key, (d) => {
        d.workout1 = { done: true, outdoor: true };
        d.workout2 = { done: true, outdoor: false };
        d.diet = d.alcohol = true;
        d.water = C.WATER_GOAL_OZ;
        d.reading = { title: d.reading.title || 'Test book', pages: 10 };
        d.photo = true; // flag only, no image stored
      }, { rerender: false });
    }
    evaluateNow();
    render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el);
});

// Tabs other than Today sit one history entry above it, so Android's back
// button returns to Today instead of closing the app.
function goTab(next) {
  if (next === tab) return;
  if (next === 'today' && history.state?.tab) return history.back(); // popstate renders
  if (tab === 'today') history.pushState({ tab: next }, '');
  else history.replaceState({ tab: next }, '');
  tab = next;
  render();
  window.scrollTo(0, 0);
}

nav.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) goTab(b.dataset.tab);
});

addEventListener('popstate', () => {
  tab = history.state?.tab || 'today';
  render();
  window.scrollTo(0, 0);
});

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // show our own Install button instead of Chrome's mini-bar
  installPrompt = e;
  if (state) render();
});

addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('Installed. Open Ironclad from your home screen.');
  if (state) render();
});

// Typing in the reading fields updates the log without rebuilding the screen.
screen.addEventListener('input', (e) => {
  const key = e.target.dataset.profile;
  if (key) return setProfile({ [key]: e.target.value });
  const f = e.target.dataset.field;
  if (f === 'title') updateDay(viewKey, (d) => { d.reading.title = e.target.value; }, { rerender: false });
  if (f === 'pages') {
    const pages = Math.max(0, Math.min(2000, parseInt(e.target.value, 10) || 0));
    updateDay(viewKey, (d) => { d.reading.pages = pages; }, { rerender: false });
  }
});

screen.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.field === 'photo' && t.files?.[0]) {
    const key = viewKey;
    try {
      const blob = await prepareImage(t.files[0]);
      await store.putPhoto(key, blob);
      if (photoUrls.has(key)) URL.revokeObjectURL(photoUrls.get(key));
      photoUrls.set(key, URL.createObjectURL(blob));
      if (!photoList.includes(key)) photoList = [...photoList, key].sort();
      updateDay(key, (d) => { d.photo = true; });
    } catch (err) {
      toast(err.message || 'Could not save the photo.');
    }
    return;
  }
  if (t.dataset.field === 'import' && t.files?.[0]) {
    try {
      const data = await B.readBackup(t.files[0]);
      const days = Object.keys(data.state.days).length;
      const photos = Object.keys(data.photos || {}).length;
      const when = new Date(data.exportedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      if (!confirm(`Replace everything on this phone with the backup from ${when}? (${days} logged days, ${photos} photos)`)) return;
      toast('Restoring…');
      await B.restoreBackup(data);
      location.reload();
    } catch (err) {
      toast(err.message || 'Could not import that backup.');
    } finally {
      t.value = '';
    }
    return;
  }
  if (t.id === 'cal-run') {
    calRun = t.value === '' ? null : Number(t.value);
    calKey = null;
    render();
    return;
  }
  if (t.dataset.cmp) {
    if (t.dataset.cmp === 'a') cmpA = t.value;
    else cmpB = t.value;
    render();
    return;
  }
  const setting = t.dataset.setting;
  if (setting) {
    const value = t.type === 'checkbox' ? t.checked : setting === 'graceHour' ? Number(t.value) : t.value;
    if (setting === 'reminderTime' && !value) return;
    state = { ...state, settings: { ...state.settings, [setting]: value } };
    save(); // also syncs the reminder time to the backend
    applySettings();
    if (setting === 'graceHour' && evaluateNow()) render();
    if (setting === 'reminderTime') render();
  }
});

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.role = 'status';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

init();
