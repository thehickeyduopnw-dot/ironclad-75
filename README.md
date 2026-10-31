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

## Cloud backend and Muse API

An optional backend on **Supabase** (database + Edge Function) syncs your daily log so the **Muse** assistant can read your progress, log tasks for you, change your reminder, and send you notifications. Push uses **Firebase Cloud Messaging (FCM)**. Both are free plans, and no credit card is needed. The app stays local-first: it saves on the phone first, works fully offline, and syncs quietly when it can. Photos never leave the phone. API details are in [docs/API.md](docs/API.md).

The evening reminder runs on this backend too. Without it, Today still shows a reminder banner after your reminder time.

One-time setup, about 15 minutes, all in the browser:

**Supabase (the database and API)**
1. Sign up at https://supabase.com and create a **New project** (name it `ironclad-75`, pick a region near you, and save the database password it generates).
2. **SQL Editor:** paste [`supabase/setup.sql`](supabase/setup.sql) and click **Run**.
3. **Edge Functions → Deploy a new function → Via Editor.** Name it exactly `ironclad`, replace the sample code with the whole of [`supabase/functions/ironclad/index.ts`](supabase/functions/ironclad/index.ts) (use GitHub's **Raw** button to copy it), and click **Deploy**.
4. Open the function's **Details/Settings** and turn **off** "Verify JWT" ("Enforce JWT verification"). The function checks your own API key instead; with this on, Supabase blocks Muse's requests.
5. **Integrations → Cron → Create job:** every 5 minutes (`*/5 * * * *`), type **Supabase Edge Function**, function `ironclad`, method **POST**, path/URL ending in `/ironclad/cron`. (Or run [`supabase/cron.sql`](supabase/cron.sql) with your project ref filled in.)

**Firebase (push notifications only)**

6. At https://console.firebase.google.com create a project (Google Analytics not needed).
7. **Project settings → General → Your apps → Web (`</>`):** register an app and copy the `firebaseConfig` it shows. These are public identifiers, safe to share.
8. **Project settings → Cloud Messaging → Web Push certificates → Generate key pair:** copy the public key.
9. Steps 7 and 8 go into [`js/cloud-config.js`](js/cloud-config.js). Send them to Claude, or paste them in yourself and push.
10. **Project settings → Service accounts → Generate new private key.** This downloads a JSON file, and it is a **secret**: don't share or commit it. In Supabase, go to **Edge Functions → Secrets → Add new secret**, name it `FIREBASE_SERVICE_ACCOUNT`, and paste the whole file's contents as the value.

**Phone**

11. In the installed app: **Settings → Cloud & Muse**. Paste `https://<your-project-ref>.supabase.co/functions/v1/ironclad`, tap **Connect**, and allow notifications.
12. Tap **Generate** under "API key for Muse" and copy the key. It's shown only once. Give Muse the address and the key.

The first phone to connect becomes the only phone the backend accepts. To move to a new phone, import your backup there; the link comes with it.

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
| `js/cloud.js`, `js/cloud-config.js` | Cloud sync, push token, API key (phone side) |
| `js/backup.js` | Export/import |
| `js/feedback.js`, `js/photo.js`, `js/clock.js` | Sounds/vibration/confetti, photo shrinking, test-only time travel |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support, notifications, home-screen install |
| `supabase/` | Backend: database setup SQL and the API Edge Function |
| `docs/API.md` | API reference for Muse |
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

Push to `main` and GitHub Pages redeploys in about a minute. The installed app shows the cached copy first, then picks up the new version on the next launch. If you add or rename a file, add it to `SHELL` in `sw.js` and change `VERSION`. If you change `supabase/functions/ironclad/index.ts`, paste it into the Supabase function editor again and deploy.
