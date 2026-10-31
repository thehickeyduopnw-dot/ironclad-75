# Ironclad 75 API (for Muse)

**Base URL:** `https://<project-ref>.supabase.co/functions/v1/ironclad` (shown in the app under Settings → Cloud & Muse)

**Auth:** every request needs `Authorization: Bearer <API_KEY>`. Generate the key in the app (Settings → Cloud & Muse → API key for Muse). A missing or wrong key gets `401 {"error": "Missing or invalid API key."}` and no data.

All responses are JSON. Errors are `{"error": "..."}` with a matching status: `400` bad input, `401` bad key, `404` unknown path, `409` no phone registered for push, `502` the push service refused, `500` server error.

Dates are the phone's local dates. Times (`done_at`, `synced_at`) are ISO 8601 UTC. `synced_at` is when the phone last synced: if the phone hasn't been opened today, today's tasks show as not done.

## GET /today

```bash
curl https://<project-ref>.supabase.co/functions/v1/ironclad/today \
  -H "Authorization: Bearer <API_KEY>"
```

```json
{
  "date": "2026-10-31",
  "day_number": 23,
  "complete": false,
  "outdoor_rule_met": true,
  "logged_off_app": false,
  "tasks": {
    "workout_1": { "done": true, "done_at": "2026-10-31T14:05:12.000Z", "minutes": 45, "outdoor": true },
    "workout_2": { "done": false, "done_at": null, "minutes": 45, "outdoor": false },
    "diet": { "done": true, "done_at": "2026-10-31T13:00:41.000Z" },
    "no_alcohol": { "done": true, "done_at": "2026-10-31T13:00:43.000Z" },
    "water": { "done": false, "done_at": null, "oz": 96, "goal_oz": 128 },
    "reading": { "done": true, "done_at": "2026-10-31T04:12:09.000Z", "pages": 12, "goal_pages": 10, "title": "Atomic Habits" },
    "progress_photo": { "done": false, "done_at": null }
  },
  "synced_at": "2026-10-31T17:48:44.000Z"
}
```

- `complete` is true only when all 7 tasks are done **and** at least one finished workout was outdoors (`outdoor_rule_met`).
- `diet` = followed the diet with no cheat meals; `no_alcohol` = no alcohol.
- `day_number` is 1–75 within the current run, or `null` outside it.

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
  "synced_at": "2026-10-31T17:48:44.000Z"
}
```

- `total_days_completed`: fully completed days in the current run.
- `status`: `active`, `completed` (finished all 75), `not_started` (start date is in the future), `none` (no run), or `not_synced` (the phone hasn't synced yet).

## GET /history?days=7

```bash
curl "https://<project-ref>.supabase.co/functions/v1/ironclad/history?days=7" \
  -H "Authorization: Bearer <API_KEY>"
```

Returns `{ "days": [ ...7 days, newest first, each shaped like /today... ], "synced_at": "..." }`. `days` can be 1–365 and defaults to 7. Days with nothing logged come back with every task not done.

## POST /notify

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/ironclad/notify \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Day 23", "body": "Two tasks left: water and photo."}'
```

Response: `{"ok": true, "sent": true}`. `title` is required (up to 200 characters); `body` is optional (up to 1000). Tapping the notification opens the app.

## POST /device-token

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/ironclad/device-token \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"token": "<FCM_REGISTRATION_TOKEN>", "platform": "android"}'
```

Response: `{"ok": true}`. The app calls this by itself on launch and whenever its push token changes, so you normally never need it.
