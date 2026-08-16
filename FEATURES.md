# Namma Metro Route Finder — Features & How They Work

A route finder for Bengaluru's Namma Metro (Purple, Green, Yellow lines) built as a
plain HTML/CSS/JavaScript site — no framework, no build step. It works fully offline
after the first load, installs as a PWA, and is wrapped as an Android app via
Capacitor.

Live site: https://arunoyour.github.io/Kr_Metro/

## Contents

- [Data model](#data-model)
- [Route finding](#route-finding)
- [Live GPS tracking](#live-gps-tracking)
- [Proximity alerts](#proximity-alerts)
- [Wrong-direction detection](#wrong-direction-detection)
- [Nearest station map](#nearest-station-map)
- [Metro operating hours](#metro-operating-hours)
- [Offline support (PWA)](#offline-support-pwa)
- [Install prompt](#install-prompt)
- [Session persistence](#session-persistence)
- [iOS reliability](#ios-reliability)
- [Android app (Capacitor)](#android-app-capacitor)
- [File map](#file-map)

---

## Data model

**Files:** `data.js`

All station and line data is hand-transcribed from the official Namma Metro map,
stored as plain JS objects — no backend, no database:

- `METRO_LINES` — each line (`purple`/`green`/`yellow`) lists its stations **in
  physical order**. Interchange stations (Majestic, R V Road) appear once, in both
  lines' arrays that meet there — that's what represents an interchange, rather than
  a separate "interchange" data structure.
- `STATION_NAMES` — station id → display name.
- `STATION_COORDS` — station id → real `{ lat, lon }`, sourced from OpenStreetMap
  (Overpass API + Nominatim for one station Overpass didn't return). The official
  metro map is a schematic diagram with no real geographic scale, so these had to
  come from an external source — they're what makes GPS tracking and the nearest-
  station map possible at all.

## Route finding

**Files:** `router.js`

The network is modelled as a graph of `(station, line)` nodes, not just stations —
because an interchange station belongs to two lines, the cost of continuing versus
switching depends on *which line you arrived on*, not just which station you're at.

- **Same-line edges** (adjacent stations on one line): weight `1`.
- **Switch edges** (same station, different line): weight `1000`.
- **Dijkstra's algorithm** finds the cheapest path from every line the origin
  station serves to every line the destination station serves. Because switching
  costs 1000× a normal hop, the search always prefers the route with the **fewest
  line changes first**, and only uses stop-count as a tiebreaker among routes with
  equal switches — matching how a real rider thinks about a route, not just "fewest
  stations."
- The resulting path is grouped into **ride segments** (one per line used), each
  tagged with a `towards` terminus — computed from which end of the line's station
  array the segment is heading toward. This is what lets the UI say "Board Purple
  Line **towards Whitefield**" instead of just naming the line, matching real
  platform signage (a line runs both directions through any given station).

## Live GPS tracking

**Files:** `geo.js` (`JourneyTracker` class)

Once a route is picked and "Track my journey live" is tapped, `JourneyTracker`
watches `navigator.geolocation.watchPosition` and matches real position to progress
along the *specific boarded itinerary* — deliberately conservative:

- The itinerary is flattened into one ordered stop list spanning all segments
  (switches don't duplicate the shared station).
- On each GPS fix, distance to only the **next few stops** (a small lookahead
  window) is checked — never the whole trip — so a stray GPS jitter or a station on
  a different line can't cause a false jump.
- Progress (`currentIndex`) **only ever moves forward**. Reaching a stop requires
  being within 150m of it.
- Two GPS quality states are distinguished, because they read very differently to a
  rider: **"no-fix"** (never got a first GPS lock yet — common indoors/cold-start)
  vs. **"lost"** (had a good fix, then lost it, e.g. went underground). Underground
  loss of signal is handled honestly: progress freezes at the last confirmed stop
  with a clear "signal lost" indicator, rather than guessing at movement with no
  data.
- `watchPosition`'s native timeout is 10s; a separate 25s watchdog independently
  catches the case where fixes keep arriving but are all too imprecise to trust.

## Proximity alerts

**Files:** `geo.js`, `app.js`, `style.css`

When GPS comes within 200m of an upcoming stop **that needs the rider to actually do
something** (switch lines or get off — plain pass-through stops are silently
skipped), `JourneyTracker` emits an `approachingAlert`. The UI:

- Plays a two-tone chime (generated with the **Web Audio API** — no audio file, so
  there's nothing extra for the service worker to cache) and a vibration pulse
  (`navigator.vibrate`, Android only — see [iOS reliability](#ios-reliability)).
- **Repeats every ~2.5s** and shows an **Acknowledge** button — a single alert is
  too easy to miss with the phone in a pocket. By design, only tapping Acknowledge
  stops it; it does not auto-stop even after the stop has actually been passed.
- A real edge case handled explicitly: a single sparse GPS fix can satisfy *both*
  the 200m alert threshold and the 150m arrival threshold in the same update (e.g. a
  big jump between fixes). The alert is evaluated against the *pre-advance* target
  first, and arrival/error states always take priority over an in-progress alert —
  otherwise tracking could stop right after "arrived" while the UI is stuck showing
  "still approaching," with no later update left to correct it.

## Wrong-direction detection

**Files:** `geo.js`, `app.js`

If a rider boards a train heading the wrong way, `JourneyTracker` tracks a rolling
window of "distance to next stop" across the last 3 GPS fixes. If that distance has
been **strictly increasing** each time (beyond a 25m margin, to filter GPS noise),
it's a strong signal the rider is moving away from their planned route — not just
noisy positioning.

- Unlike the proximity alert, this is **not** a repeating alarm: one chime +
  vibration, then a persistent warning banner ("you may be on the wrong train,
  consider crossing to the opposite platform") until the rider dismisses it **or**
  the trend reverses on its own (auto-detected and auto-cleared — no need to
  dismiss if they've already corrected course).
- The rolling window resets whenever progress genuinely advances, so stale
  distance readings from before a switch can't produce a false positive against the
  new target.

## Nearest station map

**Files:** `map.js`, `vendor/leaflet/`

A standalone "Find your nearest station" feature, independent of route planning:

- Uses `navigator.geolocation.watchPosition` plus the same haversine distance
  function as `geo.js` to find the closest station by straight-line distance —
  pure math, works fully offline.
- The **visual map** uses **Leaflet** with OpenStreetMap tiles — the one part of
  this app that needs a live network connection (tile images), since the official
  map is schematic and has no real coordinate system to plot a position on. Leaflet
  itself is bundled locally (`vendor/leaflet/`, installed via npm, not loaded from a
  CDN), so it's precached by the service worker and works inside the Capacitor app
  too.
- The rider's position is a pulsing red marker (`.you-are-here-icon`, animated
  border via CSS). The map **auto-zooms once**, on the very first GPS fix, then just
  moves the marker in place on later updates — it doesn't yank the view back if the
  rider has since panned or zoomed manually.
- Every station is plotted as a small dot in its actual line color, for context.

## Metro operating hours

**Files:** `timings.js`

BMRC (the operator) doesn't publish machine-readable timing data — each of the 12
timetables (3 lines × 4 day-types: Monday / Tue–Fri / Saturday / Sunday) on
[bmrc.co.in/metro-timings](https://www.bmrc.co.in/metro-timings/) is a **scanned
image**, not a table. These were read and transcribed by hand.

- Deliberately scoped to what a rider needs in the moment — **first train, last
  train, and a frequency range** per line/direction/day-type — rather than the full
  operational schedule, which also includes short-turning services and
  specific-time morning/evening loop trains between arbitrary station pairs. That
  fuller detail would be a much larger, more error-prone transcription effort, and
  brittle to maintain since BMRC's images get replaced periodically.
- `metroDayTypeKey()` maps the current date to the right day-type bucket, and
  `getServiceStatus()` compares current time-of-day against first/last train to
  show one of three states directly on each itinerary segment: **running now**
  (with frequency + last train), **not running yet today**, or **done for the day**.

## Offline support (PWA)

**Files:** `sw.js`, `manifest.json`

- `sw.js` is a service worker that **precaches the entire app shell** (HTML, CSS,
  all JS, icons, manifest, Leaflet's JS/CSS) on first load, using a cache-first
  strategy. After that, the app works with **zero network access** — verified on
  the live site: every app resource loads with `transferSize: 0` once the service
  worker is controlling the page.
- Runtime requests also get cached as they succeed, and page navigations fall back
  to the cached shell when offline.
- The cache is versioned (`CACHE_NAME`) — bumped on every deploy that changes any
  precached file, so returning visitors actually receive updates instead of being
  stuck on a stale cache indefinitely.
- `manifest.json` + a generated icon set (a purple/green/yellow interchange mark,
  rasterized from SVG via canvas — no image-editing tool needed) make the site
  installable to a home screen as a standalone app.

## Install prompt

**Files:** `app.js`, `style.css`

Chrome/Edge/Android fire a `beforeinstallprompt` event once PWA install criteria
are met, but the browser's own native prompt only fires once and is easy to miss.
This is captured and shown instead as a **persistent bottom bar** with an Install
button, available any time until the rider installs or explicitly dismisses it
(dismissal remembered via `localStorage`). iOS Safari never fires this event at
all — the bar simply doesn't appear there, which is an Apple platform limitation,
not a bug.

## Session persistence

**Files:** `app.js`

The last-picked From/To stations are saved to `localStorage` and the route is
automatically recomputed and displayed on reopen — useful for a daily commute that
doesn't need re-entering every time. The swap (⇅) button also **immediately
re-runs the route search** if a route is already displayed, instead of only
swapping the input fields and leaving the itinerary stale until "Find Route" is
tapped again.

## iOS reliability

**Files:** `app.js`

Real-world iPhone testing surfaced platform limits worth documenting plainly rather
than papering over:

- **Vibration is impossible on iOS in any browser** — WebKit (which every iOS
  browser, including Chrome, is required to use) has never implemented the
  Vibration API. No code workaround exists; only a true native app wrapper (like
  the Android Capacitor build) could add real haptics on iOS.
- The Web Audio `AudioContext` is defensively **re-resumed before every chime**,
  not just once at the initial unlock — iOS re-suspends it after the tab is
  backgrounded.
- Tracking requests a **Screen Wake Lock** to keep the page foregrounded (and thus
  JS actually running) while active — the trade-off (battery use, only helps if the
  phone is out and visible, not pocketed) is disclosed directly under the track
  button, not just in passing.

## Android app (Capacitor)

**Files:** `capacitor.config.json`, `android/`, `www/`

The existing site is wrapped as-is into a native Android shell via **Capacitor** —
no rewrite, since Capacitor's WebView supports the same browser APIs
(Geolocation, Vibration, Web Audio, Wake Lock) the site already uses.

- `www/` is the web asset root Capacitor packages — a copy of the root site files,
  kept in sync manually since there's no build step.
- `android/` is the generated native project (package `com.arunoyour.krmetro`).
  `AndroidManifest.xml` adds `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, and
  `VIBRATE` on top of Capacitor's default `INTERNET` permission.
- App icon, adaptive icon, and splash screens were generated from the same source
  icon via `@capacitor/assets`.
- A debug APK was built and verified locally (correct package name, label, and all
  four permissions present) using the local Android SDK + Gradle toolchain — not
  yet signed for Play Store release, which needs a separate signing key.

## File map

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `style.css` | All styling, animations, responsive layout |
| `data.js` | Station names, line order, real coordinates |
| `router.js` | Graph model + Dijkstra route finding |
| `geo.js` | Live GPS tracking, proximity alerts, wrong-direction detection |
| `map.js` | Nearest-station finder + Leaflet map |
| `timings.js` | BMRC operating-hours data + lookup helpers |
| `app.js` | UI wiring — pickers, itinerary rendering, install prompt, wake lock |
| `sw.js` | Service worker (offline caching) |
| `manifest.json` | PWA manifest |
| `icons/` | Generated app icons |
| `vendor/leaflet/` | Self-hosted Leaflet library (no CDN) |
| `capacitor.config.json`, `android/`, `www/` | Android app wrapper |
