// Challenge rules: dates, task completion, and the midnight reset.
// Pure functions only (no DOM, no storage) so the rules are easy to reason about and test.

export const TOTAL_DAYS = 75;
export const WATER_GOAL_OZ = 128;
export const WATER_STEP_OZ = 16;
export const PAGES_GOAL = 10;

// The 7 required tasks, in checklist order.
export const TASKS = [
  { id: 'workout1', label: 'Workout #1' },
  { id: 'workout2', label: 'Workout #2' },
  { id: 'diet', label: 'Diet' },
  { id: 'alcohol', label: 'No alcohol' },
  { id: 'water', label: 'Water' },
  { id: 'reading', label: 'Reading' },
  { id: 'photo', label: 'Progress photo' },
];

// ---- Dates -------------------------------------------------------------
// Days are identified by local-date keys ("2026-10-31"), which also sort as strings.

export function dateKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

// Whole days from a to b (b - a); UTC math so DST changes don't skew it.
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function dayNumber(startKey, key) {
  return daysBetween(startKey, key) + 1;
}

// The newest day that can no longer be edited. During the grace window
// (midnight until graceHour) yesterday is still open.
export function lastClosedKey(now, graceHour) {
  return addDays(dateKey(now), now.getHours() < graceHour ? -2 : -1);
}

// Days that can still be edited, newest first.
export function openKeys(now, graceHour) {
  const today = dateKey(now);
  return now.getHours() < graceHour ? [today, addDays(today, -1)] : [today];
}

// ---- Days and tasks ----------------------------------------------------

export function emptyDay() {
  return {
    workout1: { done: false, outdoor: false },
    workout2: { done: false, outdoor: false },
    diet: false,
    alcohol: false,
    water: 0,
    reading: { title: '', pages: 0 },
    photo: false,
  };
}

export function normalizeDay(day) {
  const e = emptyDay();
  if (!day) return e;
  return {
    ...e,
    ...day,
    workout1: { ...e.workout1, ...day.workout1 },
    workout2: { ...e.workout2, ...day.workout2 },
    reading: { ...e.reading, ...day.reading },
  };
}

export function taskState(day) {
  const d = normalizeDay(day);
  return {
    workout1: d.workout1.done,
    workout2: d.workout2.done,
    diet: d.diet,
    alcohol: d.alcohol,
    water: d.water >= WATER_GOAL_OZ,
    reading: d.reading.pages >= PAGES_GOAL && d.reading.title.trim().length > 0,
    photo: d.photo,
    outdoor: (d.workout1.done && d.workout1.outdoor) || (d.workout2.done && d.workout2.outdoor),
  };
}

export function doneCount(day) {
  const s = taskState(day);
  return TASKS.filter((t) => s[t.id]).length;
}

// Labels of what's still missing. Days marked manual (logged off-app) count as complete.
export function missingTasks(day) {
  if (day?.manual) return [];
  const s = taskState(day);
  const missing = TASKS.filter((t) => !s[t.id]).map((t) => t.label);
  if (s.workout1 && s.workout2 && !s.outdoor) missing.push('Outdoor workout');
  return missing;
}

export function isDayComplete(day) {
  return missingTasks(day).length === 0;
}

// ---- State -------------------------------------------------------------

export function defaultState() {
  return {
    version: 1,
    settings: { graceHour: 3, reminderTime: '20:00', sound: true, theme: 'system' },
    attempt: null, // the current run
    attempts: [], // finished runs: reset, completed, or restarted
    days: {}, // dateKey -> day log (kept across attempts)
    pendingEvent: null, // reset/win screen to show until acknowledged
  };
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newAttempt(startKey) {
  return { id: newId(), startDate: startKey, status: 'active', evaluatedThrough: null };
}

// Most recent book title, to prefill the reading card.
export function lastReadingTitle(state, beforeKey) {
  const keys = Object.keys(state.days).filter((k) => k < beforeKey).sort().reverse();
  for (const k of keys) {
    const t = state.days[k]?.reading?.title?.trim();
    if (t) return t;
  }
  return '';
}

// Check every closed day of the current run. The first incomplete day ends the run
// and a new one starts today; finishing day 75 completes it. Returns a new state
// (or the same object when nothing changed) plus the event to show, if any.
export function evaluate(state, now) {
  const a = state.attempt;
  if (!a || a.status !== 'active') return { state, event: null };

  const closed = lastClosedKey(now, state.settings.graceHour);
  let d = a.evaluatedThrough ? addDays(a.evaluatedThrough, 1) : a.startDate;
  if (d < a.startDate) d = a.startDate;
  let through = a.evaluatedThrough;

  while (d <= closed) {
    const n = dayNumber(a.startDate, d);
    const day = state.days[d];

    if (!isDayComplete(day)) {
      const record = {
        id: a.id, startDate: a.startDate, endDate: d, result: 'reset',
        failedDay: n, daysCompleted: n - 1, missing: missingTasks(day),
      };
      const event = { type: 'reset', ...record, attemptNumber: state.attempts.length + 1 };
      return {
        state: { ...state, attempts: [...state.attempts, record], attempt: newAttempt(dateKey(now)), pendingEvent: event },
        event,
      };
    }

    through = d;
    if (n >= TOTAL_DAYS) {
      const record = { id: a.id, startDate: a.startDate, endDate: d, result: 'completed', daysCompleted: TOTAL_DAYS, missing: [] };
      const event = { type: 'won', ...record, attemptNumber: state.attempts.length + 1 };
      return {
        state: {
          ...state,
          attempts: [...state.attempts, record],
          attempt: { ...a, status: 'completed', evaluatedThrough: d },
          pendingEvent: event,
        },
        event,
      };
    }
    d = addDays(d, 1);
  }

  if (through === a.evaluatedThrough) return { state, event: null };
  return { state: { ...state, attempt: { ...a, evaluatedThrough: through } }, event: null };
}

// Start a new run on startKey. The current run goes into history if it had begun.
// Days before today count as done off-app (marked manual) so they don't reset at once.
export function restart(state, startKey, now) {
  const today = dateKey(now);
  const attempts = [...state.attempts];
  const a = state.attempt;
  if (a && a.status === 'active' && a.startDate <= today) {
    const reached = Math.max(0, daysBetween(a.startDate, today));
    attempts.push({ id: a.id, startDate: a.startDate, endDate: today, result: 'restarted', daysCompleted: reached, missing: [] });
  }
  const days = { ...state.days };
  for (let k = startKey; k < today; k = addDays(k, 1)) {
    days[k] = { ...normalizeDay(days[k]), manual: true };
  }
  return { ...state, attempts, days, attempt: newAttempt(startKey), pendingEvent: null };
}

// ---- Calendar and stats -------------------------------------------------

// Status of one date within a run, for the calendar grid. `run` is the current
// attempt or a finished record from state.attempts (those have a `result`).
export function runDayStatus(state, run, key, now) {
  if (key < run.startDate || dayNumber(run.startDate, key) > TOTAL_DAYS) return 'none';
  if (run.result) {
    if (key < run.endDate) return 'done';
    if (key === run.endDate) return run.result === 'reset' ? 'missed' : run.result === 'completed' ? 'done' : 'none';
    return 'none';
  }
  if (run.status === 'completed') return 'done';
  const today = dateKey(now);
  if (key > today) return 'upcoming';
  if (isDayComplete(state.days[key])) return 'done';
  if (key === today) return 'today';
  return openKeys(now, state.settings.graceHour).includes(key) ? 'open' : 'missed';
}

export function computeStats(state, now) {
  const today = dateKey(now);
  const a = state.attempt;
  const active = a && a.status === 'active';

  let current = 0;
  if (a?.status === 'completed') current = TOTAL_DAYS;
  else if (active) {
    for (let k = a.startDate; k <= today; k = addDays(k, 1)) {
      if (isDayComplete(state.days[k])) current++;
    }
  }

  const totals = (fromKey) => {
    let waterOz = 0, pages = 0;
    const books = new Set();
    for (const [k, d] of Object.entries(state.days)) {
      if (fromKey && (k < fromKey || k > today)) continue;
      waterOz += d.water || 0;
      pages += d.reading?.pages || 0;
      const t = d.reading?.title?.trim().toLowerCase();
      if (t && (d.reading.pages || 0) > 0) books.add(t);
    }
    return { waterOz, pages, books: books.size };
  };

  const causes = {};
  for (const r of state.attempts) {
    if (r.result !== 'reset') continue;
    for (const m of r.missing) causes[m] = (causes[m] || 0) + 1;
  }

  return {
    currentStreak: current,
    longestStreak: Math.max(current, 0, ...state.attempts.map((r) => r.daysCompleted)),
    attempts: state.attempts.length + (active ? 1 : 0),
    resets: state.attempts.filter((r) => r.result === 'reset').length,
    daysCompleted: state.attempts.reduce((n, r) => n + r.daysCompleted, 0) + (active ? current : 0),
    run: a && a.startDate <= today ? totals(a.startDate) : { waterOz: 0, pages: 0, books: 0 },
    allTime: totals(null),
    resetCauses: Object.entries(causes).sort((x, y) => y[1] - x[1]),
  };
}

// Which run a date belongs to: { run, number (attempt #), day (1-75) }, or null.
export function runForKey(state, key) {
  const a = state.attempt;
  if (a && key >= a.startDate && dayNumber(a.startDate, key) <= TOTAL_DAYS) {
    const number = a.status === 'completed' ? state.attempts.length : state.attempts.length + 1;
    return { run: a, number, day: dayNumber(a.startDate, key) };
  }
  for (let i = state.attempts.length - 1; i >= 0; i--) {
    const r = state.attempts[i];
    if (key >= r.startDate && key <= r.endDate) return { run: r, number: i + 1, day: dayNumber(r.startDate, key) };
  }
  return null;
}
