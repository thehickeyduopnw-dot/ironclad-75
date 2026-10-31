// Ironclad 75 reminder service: a Cloudflare Worker (free plan) that sends one evening
// push when the day isn't finished. Setup steps: README → "Reminders".
// Needs a KV namespace bound as `KV` and a cron trigger every 5 minutes.
//
// The push carries no data. The phone's service worker reads its own on-device log
// to write the notification. All this service stores is the push address, the
// reminder time, the time zone, and "today: done / N left".

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const SUBJECT = 'https://thehickeyduopnw-dot.github.io/ironclad-75/'; // contact for push services

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jsonB64 = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

// VAPID keys are made on first use and kept in KV, so there's nothing to configure.
async function vapidKeys(env) {
  const saved = await env.KV.get('vapid', 'json');
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = {
    publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  await env.KV.put('vapid', JSON.stringify(keys));
  return keys;
}

// An empty push needs only a signed VAPID header (no payload encryption).
export async function sendPush(env, subscription) {
  const keys = await vapidKeys(env);
  const claims = { aud: new URL(subscription.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT };
  const unsigned = `${jsonB64({ typ: 'JWT', alg: 'ES256' })}.${jsonB64(claims)}`;
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const res = await (env.FETCH || fetch)(subscription.endpoint, {
    method: 'POST',
    headers: { TTL: '3600', Urgency: 'high', Authorization: `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}` },
  });
  return res.status;
}

// Local date and HH:MM in the phone's time zone.
export function localNow(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Runs on the cron trigger. Sends at most one reminder per local day.
export async function runReminder(env, ms) {
  const cfg = await env.KV.get('config', 'json');
  if (!cfg?.subscription || !cfg.enabled) return 'off';
  const { date, time } = localNow(ms, cfg.tz || 'UTC');
  if (time < cfg.reminderTime || cfg.lastSent === date) return 'waiting';
  const st = cfg.status;
  if (st?.active === false) return 'no active run';
  if (st?.date === date && st.complete) return 'day complete';

  const code = await sendPush(env, cfg.subscription);
  cfg.lastSent = date;
  if (code === 404 || code === 410) cfg.subscription = null; // phone unsubscribed
  await env.KV.put('config', JSON.stringify(cfg));
  return `sent (${code})`;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(req.url).pathname;

    if (req.method === 'GET' && path === '/vapid') return json({ publicKey: (await vapidKeys(env)).publicKey });
    if (req.method !== 'POST') return json({ ok: true, service: 'ironclad-reminders' });

    const body = await req.json().catch(() => ({}));
    let cfg = await env.KV.get('config', 'json');

    // The first phone to subscribe gets a token; later calls must present it.
    if (path === '/subscribe') {
      if (cfg?.token && body.token !== cfg.token) {
        return json({ error: 'This reminder service is already linked to another device. Import your backup on this phone first, or clear the "config" key in Cloudflare KV.' }, 403);
      }
      if (!body.subscription?.endpoint) return json({ error: 'Missing push subscription.' }, 400);
      cfg = {
        ...cfg,
        token: cfg?.token || crypto.randomUUID(),
        subscription: body.subscription,
        reminderTime: body.reminderTime || '20:00',
        tz: body.tz || 'UTC',
        enabled: true,
        status: body.status ?? cfg?.status ?? null,
      };
      await env.KV.put('config', JSON.stringify(cfg));
      return json({ token: cfg.token });
    }

    if (!cfg || body.token !== cfg.token) return json({ error: 'This phone is not linked to the reminder service.' }, 403);

    if (path === '/status') {
      cfg.status = body.status;
      if (body.status?.tz) cfg.tz = body.status.tz;
    } else if (path === '/settings') {
      if (body.reminderTime) cfg.reminderTime = body.reminderTime;
      if (body.tz) cfg.tz = body.tz;
      if ('enabled' in body) cfg.enabled = !!body.enabled;
    } else if (path === '/test') {
      if (!cfg.subscription) return json({ error: 'No phone subscribed.' }, 400);
      return json({ status: await sendPush(env, cfg.subscription) });
    } else {
      return json({ error: 'Unknown endpoint.' }, 404);
    }
    await env.KV.put('config', JSON.stringify(cfg));
    return json({ ok: true });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminder(env, event.scheduledTime));
  },
};
