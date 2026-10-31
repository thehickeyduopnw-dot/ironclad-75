# Ironclad 75

A personal 75-day discipline challenge tracker. It's an installable web app (PWA) for your iPhone home screen. All data stays on the phone.

**Rules:** 7 tasks every day: two 45-minute workouts (one outdoors), diet, no alcohol, a gallon of water, 10 pages of nonfiction, and a progress photo. If any task is missing when the day closes (midnight, plus an optional grace window that defaults to 3 AM), the run resets to Day 1.

## Project layout

| Path | What it is |
|---|---|
| `index.html`, `styles.css` | Page shell and all styling (dark/light themes) |
| `js/challenge.js` | The rules: dates, task completion, reset/win evaluation. Pure functions. |
| `js/app.js` | Screens and user input |
| `js/store.js` | IndexedDB storage (state + photos) |
| `js/feedback.js` | Sounds, vibration, confetti |
| `js/clock.js` | "Now", with a test-only time-travel offset |
| `js/photo.js` | Shrinks photos before saving |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and home-screen install |
| `tests/index.html` | Rule tests (open in a browser) |
| `tools/serve.ps1` | Local test server (Windows PowerShell, no installs needed) |
| `tools/make-icons.ps1` | Regenerates the icons |

There's no build step. The files are served as they are.

## Run it on your PC

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open:
- http://localhost:8080 for the app
- http://localhost:8080/?debug for the app plus **Test tools** in Settings (time travel: +1 hour, +1 day, jump to 11:59 PM, complete the viewed day). Use them to watch the midnight reset happen. "Hide test tools" turns them off.
- http://localhost:8080/tests/ for the rule tests

Tip: in Chrome or Edge, press F12, then Ctrl+Shift+M, to view it at phone size.

## Put it on your phone

Phones need an **https** address to install the app, so deploy it (free):

**Vercel (recommended; Stage 4 reminders will need it)**
1. Put this folder in a GitHub repository.
2. Go to https://vercel.com/new, sign in with GitHub, and import the repository. Leave every setting at its default (no framework, no build command).
3. You get a URL like `https://ironclad-75.vercel.app`. Every push to GitHub redeploys it.

**Netlify Drop (quickest for a one-off test)**
Go to https://app.netlify.com/drop and drag this folder onto the page. Create a free account to keep the site.

**Install on Android:** open the URL in **Chrome**. Then either tap **Install app on this phone** (on the welcome screen or in Settings), or open Chrome's **⋮** menu and tap **Install app** / **Add to Home screen**. Launch it from the icon. It opens full screen, works offline, and the back button returns to Today.

**Install on iPhone:** open the URL in **Safari**, tap **Share**, then **Add to Home Screen**. (iOS keeps the installed app's data separate from Safari's, so log in the installed app.)

> On Android, Chrome may clear site data if you use "Clear browsing data → Cookies and site data". Avoid that, and use Export (coming in Stage 5) for backups.

## Updating

After you change files and redeploy, the installed app picks up the new version the *next* time it's opened (it shows the cached copy first so it works offline). If you add or rename a file, add it to the `SHELL` list in `sw.js` and change `VERSION`.
