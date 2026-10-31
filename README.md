# Ironclad 75

A personal 75-day discipline challenge tracker. It's an installable web app (PWA) for your phone's home screen. All challenge data stays on the phone.

**Live app:** https://thehickeyduopnw-dot.github.io/ironclad-75/

**Rules:** 7 tasks every day: two 45-minute workouts (one outdoors), diet, no alcohol, a gallon of water, 10 pages of nonfiction, and a progress photo. If any task is missing when the day closes (midnight, plus an optional grace window that defaults to 3 AM), the run resets to Day 1.

## Screens

- **Today:** day counter and the 7-task checklist. After your reminder time, a banner shows what's left.
- **Calendar:** the 75-day grid. Tap a day to see its log. Past attempts are in the dropdown.
- **Photos:** side-by-side comparison (Day 1 vs any day), a full-screen view, and a gallery grouped by attempt.
- **Stats:** streaks, attempts, water and reading totals, what reset you, and the daily calorie calculator.
- **Settings:** start date, grace window, theme, sounds, evening reminder, backup, attempt history.

## Put it on your phone

**Android:** open the live link in **Chrome**. Tap **Install app on this phone** (on the welcome screen or in Settings), or use Chrome's **⋮** menu, then **Install app**.

**iPhone:** open the link in **Safari**, tap **Share**, then **Add to Home Screen**. iOS keeps the installed app's data separate from Safari's, so log in the installed app.

Keep using the same link: your data is saved under that address.

## Reminders

The phone can't schedule its own notifications, so a tiny free **Cloudflare Worker** sends one push at your reminder time, only if today isn't finished. It stores only the push address, your reminder time and time zone, and "today: done / N left". The push itself is empty; your phone writes the message from its own log.

One-time setup, about 10 minutes, all in the browser:

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up.
2. **Create the Worker.** Go to **Workers & Pages → Create → Create Worker** (the "Hello World" starter). Name it `ironclad-reminders` and click **Deploy**.
3. **Paste the code.** Click **Edit code**, delete everything in the editor, and paste in the whole of [`worker/reminders.js`](worker/reminders.js). Use the **Raw** button on GitHub to copy it cleanly. Click **Deploy**.
4. **Add storage.** Go to **Storage & Databases → KV → Create** (Workers KV), and name the namespace `ironclad`. Then, on your Worker, open **Bindings → Add binding → KV namespace**. Set the variable name to exactly **`KV`**, pick `ironclad`, and save.
5. **Add the schedule.** On your Worker, open **Settings → Trigger events → Add → Cron trigger**. Enter `*/5 * * * *` (every 5 minutes) and save.
6. **Link your phone.** Copy the Worker's address (e.g. `https://ironclad-reminders.yourname.workers.dev`). In the installed app, go to **Settings → Evening reminder**, paste the address, and tap **Turn on reminders**. Allow notifications when asked. Then tap **Send test**; a notification should arrive within a few seconds.

Reminders are checked every 5 minutes, so an 8:00 PM reminder arrives between 8:00 and 8:05. To use a new phone, import your backup first (it carries the link), then turn reminders on. If you lose the old phone without a backup, delete the `config` key in the `ironclad` KV namespace and link again.

## Backup

**Settings → Backup → Export backup** saves a single `.json` file to Downloads, with every photo included. Keep a copy somewhere safe, like Google Drive. **Import backup** replaces everything on the phone with a backup file. Chrome's "Clear browsing data → Cookies and site data" erases the app's data, so export regularly.

## Project layout

| Path | What it is |
|---|---|
| `index.html`, `styles.css` | Page shell and all styling (dark/light themes) |
| `js/challenge.js` | The rules: dates, completion, reset/win, calendar status, stats. Pure functions. |
| `js/app.js` | Screens and user input |
| `js/store.js` | IndexedDB storage (state + photos) |
| `js/calories.js` | Calorie burn calculator (Mifflin-St Jeor) |
| `js/reminders.js` | Links the phone to the reminder Worker |
| `js/backup.js` | Export/import |
| `js/feedback.js`, `js/photo.js`, `js/clock.js` | Sounds/vibration/confetti, photo shrinking, test-only time travel |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support, notifications, home-screen install |
| `worker/reminders.js` | The Cloudflare Worker that sends reminders |
| `tests/index.html` | Tests (open in a browser) |
| `tools/serve.ps1`, `tools/make-icons.ps1` | Local test server, icon generator (Windows PowerShell) |

There's no build step. Files are served as they are.

## Run it on your PC

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

- http://localhost:8080 is the app.
- http://localhost:8080/?debug turns on **test mode** for that browser tab: an orange "TEST MODE" stripe, separate practice data (your real log is never touched), and **Test tools** in Settings (+1 hour, +1 day, jump to 11:59 PM, complete the viewed day) for watching the midnight reset. Adding `?debug` to the live link works the same way.
- http://localhost:8080/tests/ runs the tests. http://localhost:8080/tests/stress.html?debug runs the stress tests (about 3 minutes): 2,000 simulated runs, a large history, and a 75-photo backup.

## Updating

Push to `main` and GitHub Pages redeploys in about a minute. The installed app shows the cached copy first, then picks up the new version on the next launch. If you add or rename a file, add it to `SHELL` in `sw.js` and change `VERSION`. If you change `worker/reminders.js`, paste it into the Cloudflare editor again.
