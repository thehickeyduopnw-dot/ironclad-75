// Ironclad 75 cloud API: a Supabase Edge Function. Paste this whole file into the
// function editor (setup steps: README → "Cloud backend and Muse API").
// Written as plain JavaScript (valid TypeScript) so the same file also runs in the
// browser tests (tests/index.html) with a fake database and push sender.
//
// Who can call what:
//   Muse (Authorization: Bearer <API key>)   GET /today, /summary, /history · POST /log, /reminder, /notify, /device-token
//   The phone app (X-App-Secret header)        all of the above, plus POST /sync, /changes/ack, /api-key/* · GET /changes, /api-key
//   Anyone                                     POST /link (only until the phone has linked) · /cron (sends at most
//                                              one due reminder; returns no data)
//
// Secrets (Edge Functions → Secrets): FIREBASE_SERVICE_ACCOUNT = the Firebase service account JSON.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, X-App-Secret, Content-Type, apikey, x-client-info',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status, error) => json({ error }, status);

const TOTAL_DAYS = 75;
const enc = (s) => new TextEncoder().encode(s);

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSecret(prefix) {
  return prefix + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

// ---- Dates (in the phone's time zone) ----------------------------------------------

export function localDate(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// Day number within the current run, or null outside it.
function dayNumberFor(progress, date) {
  if (!progress?.start_date || !['active', 'completed'].includes(progress.status)) return null;
  const n = daysBetween(progress.start_date, date) + 1;
  return n >= 1 && n <= TOTAL_DAYS ? n : null;
}

// A day with nothing logged, in the same shape the phone syncs.
export function emptyDay(date, dayNumber) {
  const task = () => ({ done: false, done_at: null });
  return {
    date,
    day_number: dayNumber,
    complete: false,
    outdoor_rule_met: false,
    tasks: {
      workout_1: { ...task(), minutes: 45, outdoor: false },
      workout_2: { ...task(), minutes: 45, outdoor: false },
      diet: task(),
      no_alcohol: task(),
      water: { ...task(), oz: 0, goal_oz: 128 },
      reading: { ...task(), pages: 0, goal_pages: 10, title: null },
      progress_photo: task(),
    },
  };
}

// ---- Data views -------------------------------------------------------------------------

async function context(env) {
  const progress = await env.db.getKV('progress');
  const tz = progress?.tz || 'UTC';
  return { progress, tz, today: localDate(env.now(), tz) };
}

function dayView(row, date, progress) {
  const n = dayNumberFor(progress, date);
  const day = row ? { ...row } : emptyDay(date, n);
  if (n != null) day.day_number = n;
  return day;
}

async function todayView(env) {
  const { progress, today } = await context(env);
  const rows = await env.db.getDays(today.date, today.date);
  return { ...dayView(rows[0]?.data, today.date, progress), synced_at: progress?.synced_at ?? null };
}

async function summaryView(env) {
  const { progress, today } = await context(env);
  const rows = await env.db.getDays(today.date, today.date);
  return {
    start_date: progress?.start_date ?? null,
    current_day: dayNumberFor(progress, today.date),
    total_days_completed: progress?.total_days_completed ?? 0,
    today_complete: !!rows[0]?.data?.complete,
    status: progress?.status ?? 'not_synced',
    synced_at: progress?.synced_at ?? null,
  };
}

async function historyView(env, count) {
  const { progress, today } = await context(env);
  const from = addDays(today.date, -(count - 1));
  const rows = new Map((await env.db.getDays(from, today.date)).map((r) => [r.date, r.data]));
  const days = [];
  for (let i = 0; i < count; i++) {
    const date = addDays(today.date, -i);
    days.push(dayView(rows.get(date), date, progress));
  }
  return { days, synced_at: progress?.synced_at ?? null };
}

// ---- Push ---------------------------------------------------------------------------------

async function deliver(env, data) {
  const device = await env.db.getKV('device');
  if (!device?.token) return { ok: false, status: 409, error: 'No phone is registered for notifications yet. Open the app and allow notifications.' };
  const res = await env.sendPush(device.token, data);
  if (res.unregistered) await env.db.setKV('device', null);
  return res;
}

// Called every 5 minutes by the cron job. Sends at most one reminder per local day.
export async function runReminder(env) {
  const reminder = await env.db.getKV('reminder');
  const { progress, today } = await context(env);
  if (!reminder?.enabled) return 'off';
  if (today.time < (reminder.time || '20:00')) return 'waiting';
  if ((await env.db.getKV('reminder_last_sent')) === today.date) return 'already sent today';
  if (progress?.status !== 'active' || dayNumberFor(progress, today.date) == null) return 'no active run';
  const rows = await env.db.getDays(today.date, today.date);
  if (rows[0]?.data?.complete) return 'day complete';
  const res = await deliver(env, { kind: 'reminder' }); // the phone writes the text from its own log
  if (res.status === 409) return 'no device';
  await env.db.setKV('reminder_last_sent', today.date);
  return res.ok ? 'sent' : `push failed (${res.status})`;
}

// ---- Logging from Muse -----------------------------------------------------------------
// Changes are applied here right away (so /today and the reminder see them) and queued
// for the phone, which applies the same rules (applyApiTasks in js/challenge.js) on its
// next sync. The phone's log stays the source of truth.

const GOAL_OZ = 128;
const GOAL_PAGES = 10;
const MAX_OZ = GOAL_OZ * 2;
const MAX_PAGES = 2000;
const MAX_QUEUE = 200;
const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Check a /log body. Returns an error message, or null when valid.
export function checkLogTasks(tasks) {
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return 'tasks must be an object.';
  const names = Object.keys(tasks);
  if (!names.length) return 'tasks is empty.';
  const flagOk = (v) => typeof v === 'boolean' || (v && typeof v === 'object' && (v.done === undefined || typeof v.done === 'boolean'));
  for (const name of names) {
    const v = tasks[name];
    switch (name) {
      case 'workout_1':
      case 'workout_2':
        if (!flagOk(v) || (typeof v === 'object' && v.outdoor !== undefined && typeof v.outdoor !== 'boolean')) return `${name} must be true/false or {"done": bool, "outdoor": bool}.`;
        break;
      case 'diet':
      case 'no_alcohol':
        if (!flagOk(v)) return `${name} must be true/false or {"done": bool}.`;
        break;
      case 'water':
        if (!v || typeof v !== 'object' || !(isNum(v.oz) || isNum(v.add_oz) || v.done === true)) return 'water needs "oz", "add_oz" or "done": true.';
        if ((v.oz !== undefined && !isNum(v.oz)) || (v.add_oz !== undefined && !isNum(v.add_oz))) return 'water amounts must be numbers.';
        break;
      case 'reading':
        if (!v || typeof v !== 'object' || !(isNum(v.pages) || isNum(v.add_pages) || v.done === true || typeof v.title === 'string')) return 'reading needs "pages", "add_pages", "done": true or "title".';
        if (v.title !== undefined && (typeof v.title !== 'string' || v.title.length > 200)) return 'reading.title must be text (up to 200 characters).';
        break;
      case 'progress_photo':
        return 'Progress photos can only be taken in the app.';
      default:
        return `Unknown task "${name}". Use workout_1, workout_2, diet, no_alcohol, water or reading.`;
    }
  }
  return null;
}

// Apply logged tasks to a day in the API shape. Mirrors applyApiTasks in js/challenge.js.
export function applyLog(day, tasks, nowIso, lastTitle = null) {
  const d = structuredClone(day);
  const t = d.tasks;
  const before = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.done]));
  const flag = (v) => (typeof v === 'boolean' ? v : v?.done);
  for (const [name, other] of [['workout_1', 'workout_2'], ['workout_2', 'workout_1']]) {
    const v = tasks[name];
    if (v === undefined) continue;
    if (typeof flag(v) === 'boolean') t[name].done = flag(v);
    if (typeof v?.outdoor === 'boolean') {
      t[name].outdoor = v.outdoor;
      if (v.outdoor) t[other].outdoor = false;
    }
  }
  if (typeof flag(tasks.diet) === 'boolean') t.diet.done = flag(tasks.diet);
  if (typeof flag(tasks.no_alcohol) === 'boolean') t.no_alcohol.done = flag(tasks.no_alcohol);
  const w = tasks.water;
  if (w) {
    let oz = t.water.oz;
    if (isNum(w.oz)) oz = w.oz;
    if (isNum(w.add_oz)) oz += w.add_oz;
    if (w.done === true) oz = Math.max(oz, GOAL_OZ);
    t.water.oz = clampInt(oz, 0, MAX_OZ);
  }
  t.water.done = t.water.oz >= GOAL_OZ;
  const r = tasks.reading;
  if (r) {
    if (typeof r.title === 'string') t.reading.title = r.title.trim().slice(0, 200) || null;
    let pages = t.reading.pages;
    if (isNum(r.pages)) pages = r.pages;
    if (isNum(r.add_pages)) pages += r.add_pages;
    if (r.done === true) pages = Math.max(pages, GOAL_PAGES);
    t.reading.pages = clampInt(pages, 0, MAX_PAGES);
    if (!t.reading.title && lastTitle) t.reading.title = lastTitle;
  }
  t.reading.done = t.reading.pages >= GOAL_PAGES && !!t.reading.title;
  for (const [k, v] of Object.entries(t)) {
    if (!v.done) v.done_at = null;
    else if (!before[k]) v.done_at = nowIso;
  }
  d.outdoor_rule_met = (t.workout_1.done && t.workout_1.outdoor) || (t.workout_2.done && t.workout_2.outdoor);
  d.complete = Object.values(t).every((v) => v.done) && d.outdoor_rule_met;
  return d;
}

// Most recent book title, so "reading: 12 pages" counts without repeating the title.
async function lastTitleBefore(env, date) {
  const rows = await env.db.getDays(addDays(date, -60), date);
  return rows.map((r) => r.data?.tasks?.reading?.title).find((t) => t) ?? null;
}

async function queueChange(env, change) {
  const queue = (await env.db.getKV('pending_changes')) || [];
  if (queue.length >= MAX_QUEUE) return false;
  queue.push(change);
  await env.db.setKV('pending_changes', queue);
  return true;
}

// ---- Request handling ----------------------------------------------------------------

async function matches(env, kvKey, presented) {
  if (!presented) return false;
  const saved = await env.db.getKV(kvKey);
  return !!saved?.hash && saved.hash === (await sha256(presented));
}

export async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/ironclad(?=\/|$)/, '') || '/';
  const route = `${req.method} ${path}`;

  try {
    if (route === 'GET /') return json({ service: 'ironclad-75', ok: true });
    if (path === '/cron') return json({ result: await runReminder(env) });

    if (route === 'POST /link') {
      if (await env.db.getKV('app_secret')) return fail(403, 'This backend is already linked to a phone.');
      const secret = randomSecret('app_');
      await env.db.setKV('app_secret', { hash: await sha256(secret), created_at: env.now().toISOString() });
      return json({ app_secret: secret });
    }

    // Check credentials before reading anything else from the request.
    const bearer = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
    const byKey = await matches(env, 'api_key', bearer);
    const byApp = await matches(env, 'app_secret', req.headers.get('X-App-Secret'));
    if (!byKey && !byApp) return fail(401, 'Missing or invalid API key.');
    const needApp = () => (byApp ? null : fail(401, 'Missing or invalid app secret.'));

    let body = {};
    if (req.method === 'POST') {
      const text = await req.text();
      try { body = text ? JSON.parse(text) : {}; } catch { return fail(400, 'Request body must be JSON.'); }
    }

    switch (route) {
      case 'GET /today':
        return json(await todayView(env));
      case 'GET /summary':
        return json(await summaryView(env));
      case 'GET /history': {
        const raw = url.searchParams.get('days') ?? '7';
        const count = Number(raw);
        if (!Number.isInteger(count) || count < 1 || count > 365) return fail(400, 'days must be a whole number from 1 to 365.');
        return json(await historyView(env, count));
      }
      case 'POST /notify': {
        const { title, body: text } = body;
        if (typeof title !== 'string' || !title.trim() || title.length > 200) return fail(400, 'title is required (up to 200 characters).');
        if (text != null && (typeof text !== 'string' || text.length > 1000)) return fail(400, 'body must be text (up to 1000 characters).');
        const res = await deliver(env, { kind: 'message', title: title.trim(), body: (text || '').trim() });
        return res.ok ? json({ ok: true, sent: true }) : fail(res.status === 409 ? 409 : 502, res.error || 'Push service error.');
      }
      case 'POST /device-token': {
        const { token, platform = 'android' } = body;
        if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return fail(400, 'token is required.');
        await env.db.setKV('device', { token, platform: String(platform).slice(0, 20), updated_at: env.now().toISOString() });
        return json({ ok: true });
      }
      case 'POST /sync': {
        const denied = needApp();
        if (denied) return denied;
        const days = Array.isArray(body.days) ? body.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d?.date)) : [];
        if (days.length > 400) return fail(400, 'Too many days in one sync.');
        // Muse changes the phone hasn't picked up yet stay visible on top of its copy.
        const pending = ((await env.db.getKV('pending_changes')) || []).filter((c) => c.type === 'log');
        const rows = days.map((d) => {
          let data = d;
          for (const c of pending) if (c.date === d.date) data = applyLog(data, c.tasks, c.created_at);
          return { date: d.date, day_number: d.day_number ?? null, data, updated_at: env.now().toISOString() };
        });
        if (rows.length) await env.db.upsertDays(rows);
        if (body.progress) await env.db.setKV('progress', { ...body.progress, synced_at: env.now().toISOString() });
        if (body.reminder) await env.db.setKV('reminder', { time: body.reminder.time || '20:00', enabled: !!body.reminder.enabled });
        return json({ ok: true, days: days.length });
      }
      case 'POST /log': {
        const { progress, today } = await context(env);
        const date = body.date ?? today.date;
        const grace = Number.isInteger(progress?.grace_hour) ? progress.grace_hour : 3;
        const yesterdayOpen = date === addDays(today.date, -1) && today.time < `${String(grace).padStart(2, '0')}:00`;
        if (date !== today.date && !yesterdayOpen) return fail(400, `date must be today, or yesterday before ${grace}:00 AM (the grace window).`);
        const problem = checkLogTasks(body.tasks);
        if (problem) return fail(400, problem);
        const dayNumber = dayNumberFor(progress, date);
        if (progress?.status !== 'active' || dayNumber == null) return fail(409, 'There is no active challenge run on that date.');
        const nowIso = env.now().toISOString();
        const change = { id: randomSecret('chg_').slice(0, 24), type: 'log', date, tasks: body.tasks, created_at: nowIso };
        if (!(await queueChange(env, change))) return fail(429, 'Too many changes waiting for the phone. Open the app to sync.');
        const rows = await env.db.getDays(date, date);
        const current = dayView(rows[0]?.data, date, progress);
        const updated = applyLog(current, body.tasks, nowIso, await lastTitleBefore(env, date));
        await env.db.upsertDays([{ date, day_number: dayNumber, data: updated, updated_at: nowIso }]);
        return json({ ok: true, change_id: change.id, day: updated });
      }
      case 'POST /reminder': {
        const current = (await env.db.getKV('reminder')) || { time: '20:00', enabled: true };
        const { time, enabled } = body;
        if (time !== undefined && !(typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return fail(400, 'time must be "HH:MM" (24-hour).');
        if (enabled !== undefined && typeof enabled !== 'boolean') return fail(400, 'enabled must be true or false.');
        if (time === undefined && enabled === undefined) return fail(400, 'Send "time" and/or "enabled".');
        const reminder = { time: time ?? current.time, enabled: enabled ?? current.enabled };
        await env.db.setKV('reminder', reminder);
        if (!(await queueChange(env, { id: randomSecret('chg_').slice(0, 24), type: 'reminder', reminder, created_at: env.now().toISOString() }))) {
          return fail(429, 'Too many changes waiting for the phone. Open the app to sync.');
        }
        return json({ ok: true, reminder });
      }
      case 'GET /changes': {
        const denied = needApp();
        if (denied) return denied;
        return json({ changes: (await env.db.getKV('pending_changes')) || [] });
      }
      case 'POST /changes/ack': {
        const denied = needApp();
        if (denied) return denied;
        const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
        const queue = (await env.db.getKV('pending_changes')) || [];
        await env.db.setKV('pending_changes', queue.filter((c) => !ids.has(c.id)));
        return json({ ok: true });
      }
      case 'GET /api-key': {
        const denied = needApp();
        if (denied) return denied;
        const k = await env.db.getKV('api_key');
        return json({ active: !!k?.hash, created_at: k?.created_at ?? null });
      }
      case 'POST /api-key/regenerate': {
        const denied = needApp();
        if (denied) return denied;
        const key = randomSecret('ic75_');
        const created_at = env.now().toISOString();
        await env.db.setKV('api_key', { hash: await sha256(key), created_at });
        return json({ api_key: key, created_at });
      }
      case 'POST /api-key/revoke': {
        const denied = needApp();
        if (denied) return denied;
        await env.db.setKV('api_key', null);
        return json({ ok: true });
      }
    }
    return fail(404, 'Not found.');
  } catch (e) {
    return fail(500, e?.message || 'Server error.');
  }
}

// ---- Real database (Supabase REST) and push (FCM HTTP v1) ---------------------------------

export function restDb(baseUrl, serviceKey) {
  const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (serviceKey.startsWith('eyJ')) headers.Authorization = `Bearer ${serviceKey}`; // legacy JWT keys
  const rest = async (path, init = {}) => {
    const res = await fetch(`${baseUrl}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Database error ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const upsert = { Prefer: 'resolution=merge-duplicates,return=minimal' };
  return {
    async getKV(key) {
      const rows = await rest(`kv?key=eq.${encodeURIComponent(key)}&select=value`);
      return rows[0]?.value ?? null;
    },
    setKV: (key, value) => (value == null
      ? rest(`kv?key=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } })
      : rest('kv', { method: 'POST', headers: upsert, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) })),
    upsertDays: (rows) => rest('days', { method: 'POST', headers: upsert, body: JSON.stringify(rows) }),
    getDays: (from, to) => rest(`days?date=gte.${from}&date=lte.${to}&select=date,data&order=date.desc`),
  };
}

let cachedToken = null; // { token, exp }

// OAuth access token for FCM, signed with the service account's private key (RS256).
export async function googleAccessToken(account, fetchImpl = fetch, nowSec = Math.floor(Date.now() / 1000)) {
  if (cachedToken && cachedToken.exp > nowSec + 60 && cachedToken.email === account.client_email) return cachedToken.token;
  const part = (o) => b64url(enc(JSON.stringify(o)));
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600,
  })}`;
  const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(unsigned));
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google sign-in for FCM failed: ${data.error_description || data.error || res.status}`);
  cachedToken = { token: data.access_token, exp: nowSec + (data.expires_in || 3600), email: account.client_email };
  return cachedToken.token;
}

// Data-only message: the phone's service worker shows it (and writes reminder text itself).
export async function sendFcm(accountJson, token, data, fetchImpl = fetch) {
  if (!accountJson) return { ok: false, status: 500, error: 'FIREBASE_SERVICE_ACCOUNT secret is not set.' };
  const account = JSON.parse(accountJson);
  const access = await googleAccessToken(account, fetchImpl);
  const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, data, webpush: { headers: { Urgency: 'high', TTL: '3600' } } } }),
  });
  const out = await res.json().catch(() => ({}));
  const unregistered = res.status === 404 || (out.error?.details || []).some((d) => d.errorCode === 'UNREGISTERED');
  return { ok: res.ok, status: res.status, error: out.error?.message, unregistered };
}

if (typeof Deno !== 'undefined') {
  const env = {
    db: restDb(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
    now: () => new Date(),
    // Either spelling of the secret's name works.
    sendPush: (token, data) => sendFcm(Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? Deno.env.get('firebase_service_account'), token, data),
  };
  Deno.serve((req) => handle(req, env));
}
