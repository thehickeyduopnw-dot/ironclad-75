# Ironclad 75 API (for Muse)

**Base URL:** `https://<project-ref>.supabase.co/functions/v1/ironclad` (shown in the app under Settings → Cloud & Muse)

**Auth:** every request needs `Authorization: Bearer <API_KEY>`. Generate the key in the app (Settings → Cloud & Muse → API key for Muse). A missing or wrong key gets `401 {"error": "Missing or invalid API key."}` and no data.

**What Muse can do:** read today, the summary, history and the reminder; log tasks (`/log`); change the evening reminder (`/reminder`); and send notifications (`/notify`). What stays in the app: progress photos, starting or restarting the challenge, and choosing which phone gets notifications.

All responses are JSON. Errors are `{"error": "..."}` with a matching status: `400` bad input, `401` bad key, `404` unknown path, `409` no phone registered for push / no active run, `429` too many changes waiting, `502` the push service refused, `500` server error.

Dates are the phone's local dates. Times (`done_at`, `started_at`, `ended_at`, `synced_at`) are ISO 8601 UTC.

**Freshness:** the phone is the source of truth and syncs whenever it's opened. `/today`, `/summary` and `/history` include `synced_at`, `synced_minutes_ago`, and `stale` (true when the last sync was over 3 hours ago, or never). When `stale` is true, "not done" may just mean "not synced yet": say so rather than reporting it as missed.

## GET /today

```bash
curl https://<project-ref>.supabase.co/functions/v1/ironclad/today \
  -H "Authorization: Bearer <API_KEY>"
```

```json
{
  "date": "2026-10-31",
  "day_number": 23,
  "in_run": true,
  "complete": false,
  "outdoor_rule_met": true,
  "logged_off_app": false,
  "tasks": {
    "workout_1": { "done": true, "done_at": "2026-10-31T14:52:12.000Z", "minutes": 47, "target_minutes": 45, "started_at": "2026-10-31T14:05:00.000Z", "ended_at": "2026-10-31T14:52:12.000Z", "outdoor": true },
    "workout_2": { "done": false, "done_at": null, "minutes": null, "target_minutes": 45, "started_at": null, "ended_at": null, "outdoor": false },
    "diet": { "done": true, "done_at": "2026-10-31T13:00:41.000Z" },
    "no_alcohol": { "done": true, "done_at": "2026-10-31T13:00:43.000Z" },
    "water": { "done": false, "done_at": null, "oz": 96, "goal_oz": 128 },
    "reading": { "done": true, "done_at": "2026-10-31T04:12:09.000Z", "pages": 12, "goal_pages": 10, "title": "Atomic Habits" },
    "progress_photo": { "done": false, "done_at": null }
  },
  "synced_at": "2026-10-31T17:48:44.000Z",
  "synced_minutes_ago": 12,
  "stale": false
}
```

- `complete` is true only when all 7 tasks are done **and** at least one finished workout was outdoors (`outdoor_rule_met`).
- `diet` = followed the diet with no cheat meals; `no_alcohol` = no alcohol.
- Workouts: `minutes` is the timed length (from the app's workout timer), or `null` if the workout was checked off without the timer. `target_minutes` is always 45. The two workouts can't be back to back; the app warns when timed workouts are under an hour apart.
- `day_number` is 1–75 within the current run, or `null` outside it. `in_run` says whether the date belongs to the current run.

## GET /summary

```bash
curl https://<project-ref>.supabase.co/functions/v1/ironclad/summary \
  -H "Authorization: Bearer <API_KEY>"
```

```json
{
  "start_date": "2026-10-09",
  "current_day": 23,
  "total_days_completed": 22,
  "today_complete": false,
  "status": "active",
  "attempts": 3,
  "last_reset_date": "2026-10-08",
  "last_reset_missing": ["Water", "Progress photo"],
  "synced_at": "2026-10-31T17:48:44.000Z",
  "synced_minutes_ago": 12,
  "stale": false
}
```

- `total_days_completed`: fully completed days in the current run.
- `status`: `active`, `completed` (finished all 75), `not_started` (start date is in the future), `none` (no run), or `not_synced` (the phone hasn't synced yet).
- `attempts`: how many runs there have been, including the current one.
- `last_reset_date` / `last_reset_missing`: the day that ended the most recent reset run, and what was missed that day (`null` if there's never been a reset).

## GET /history?days=7

```bash
curl "https://<project-ref>.supabase.co/functions/v1/ironclad/history?days=7" \
  -H "Authorization: Bearer <API_KEY>"
```

Returns `{ "days": [ ...7 days, newest first, each shaped like /today... ], "synced_at", "synced_minutes_ago", "stale" }`. `days` can be 1–365 and defaults to 7. Days with nothing logged come back with every task not done. Check `in_run`: days before the current run started are `"in_run": false` and aren't missed days.

## POST /log

Logs activity for today. Only include the tasks you're changing.

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/ironclad/log \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"tasks": {"water": {"add_oz": 16}, "diet": true, "workout_1": {"done": true, "outdoor": true, "minutes": 50}}}'
```

Response: `{"ok": true, "change_id": "chg_...", "day": { ...today, shaped like /today... }}`. The change shows in `/today` right away. The phone applies it the next time the app opens or comes to the foreground, or within a minute if it's already open. If the phone can't apply it (for example the day closed before the phone saw it), it drops out of `/today` on the next sync.

| Task | Accepts |
|---|---|
| `workout_1`, `workout_2` | `true` / `false`, or `{"done": bool, "outdoor": bool, "minutes": 0–600, "started_at": ISO time, "ended_at": ISO time}`. Marking one outdoor clears the other. With both times and no `minutes`, the length is worked out. `done: false` clears the end time and minutes. |
| `diet`, `no_alcohol` | `true` / `false`, or `{"done": bool}` |
| `water` | `{"add_oz": 16}` (negative to undo), `{"oz": 96}` (set the total), `{"done": true}` (a full gallon), or `{"done": false}` (back to 112 oz if it was at or over the goal). 0–256 oz. |
| `reading` | `{"add_pages": 5}`, `{"pages": 12}`, `{"done": true}` (10 pages), `{"done": false}` (back to 9 pages at most), and/or `{"title": "..."}`. The last book title is reused if none is given. |
| `progress_photo` | Not accepted: photos are taken in the app. |

Optional `"date"`: today, or yesterday until your grace window closes (3 AM by default), just like in the app. Errors: `400` invalid task or closed date, `409` no active run, `429` over 200 changes waiting for the phone.

## GET /reminder

```bash
curl https://<project-ref>.supabase.co/functions/v1/ironclad/reminder \
  -H "Authorization: Bearer <API_KEY>"
```

Response: `{"time": "20:00", "enabled": true}`. This is the evening push sent if the day isn't finished.

## POST /reminder

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/ironclad/reminder \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"time": "21:30", "enabled": true}'
```

Response: `{"ok": true, "reminder": {"time": "21:30", "enabled": true}}`. `time` is 24-hour `HH:MM`; either field can be sent alone. The app's Settings update to match.

## POST /notify

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/ironclad/notify \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Day 23", "body": "Two tasks left: water and photo."}'
```

Response: `{"ok": true, "sent": true}`. `title` is required (up to 200 characters); `body` is optional (up to 1000). Tapping the notification opens the app. Use this for any reminder at any time.

## Phone-only endpoints

`POST /device-token` (where notifications go), `POST /sync`, `GET /changes`, `POST /changes/ack` and the API key endpoints are used by the app itself with its own secret, not with the API key. `/cron` is called by the backend's schedule with a secret the database generates.
