// UI wiring: searchable station pickers, swap button, and itinerary rendering.

// Registers the offline cache. Requires a secure context (https, or
// localhost for local testing) — silently no-ops on plain http/file://.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// Install prompt: Chrome/Edge/Android fire beforeinstallprompt when the PWA
// criteria are met (manifest + service worker + installability heuristics).
// The browser's own prompt only fires once and is easy to miss, so this
// captures it and shows a persistent bottom bar the user can trigger anytime
// until they install or dismiss it. iOS Safari never fires this event, so
// the bar simply never appears there — that's expected, not a bug.
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (localStorage.getItem("installPromptDismissed") !== "1") {
    showInstallBanner();
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  hideInstallBanner();
});

function showInstallBanner() {
  if (document.getElementById("install-banner")) return;

  const banner = document.createElement("div");
  banner.id = "install-banner";
  banner.className = "install-banner";
  banner.innerHTML = `
    <span class="install-banner-text">Install this app for quick, offline access.</span>
    <div class="install-banner-actions">
      <button type="button" class="install-btn" id="install-btn">Install</button>
      <button type="button" class="install-dismiss" id="install-dismiss" aria-label="Dismiss">&times;</button>
    </div>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add("visible"), 10);

  document.getElementById("install-btn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    hideInstallBanner();
  });

  document.getElementById("install-dismiss").addEventListener("click", () => {
    localStorage.setItem("installPromptDismissed", "1");
    hideInstallBanner();
  });
}

function hideInstallBanner() {
  const banner = document.getElementById("install-banner");
  if (!banner) return;
  banner.classList.remove("visible");
  setTimeout(() => banner.remove(), 300);
}

// Populated once loadNetworkData() has fetched this instance's data — every
// other place that reads STATION_NAMES/METRO_LINES/etc. already does so
// lazily (inside a function, at call time), not at parse time, so this is
// the only piece of app.js that genuinely needed restructuring to work with
// data arriving asynchronously instead of via a <script> tag.
let ALL_STATION_IDS = [];

// Fetches this page's network data (?data=<path from networks.json>),
// populates the same globals data.js/timings.js used to define directly,
// and applies this network's branding (name, tagline, line legend, theme
// color) to the shared page shell. Returns false (and shows an error) if
// there's no network to load or the fetch fails, so the caller knows not to
// start the rest of the app against missing data.
async function loadNetworkData() {
  const params = new URLSearchParams(location.search);
  const dataPath = params.get("data");
  const resultsEl = document.getElementById("results");

  if (!dataPath) {
    if (resultsEl) {
      resultsEl.innerHTML = `<p class="empty-state">No network selected. <a href="index.html">Choose a city and service</a>.</p>`;
    }
    return false;
  }

  let json;
  try {
    const res = await fetch(dataPath);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    if (resultsEl) {
      resultsEl.innerHTML = `<p class="empty-state">Couldn't load this network's data. Check your connection and try again.</p>`;
    }
    return false;
  }

  window.METRO_LINES = json.lines || {};
  window.STATION_NAMES = json.stationNames || {};
  window.STATION_COORDS = json.stationCoords || {};
  window.METRO_TIMINGS = json.timings || {};

  applyNetworkBranding(json.meta, json.lines);
  initRouterData(window.METRO_LINES);
  ALL_STATION_IDS = Object.keys(STATION_NAMES).sort((a, b) =>
    STATION_NAMES[a].localeCompare(STATION_NAMES[b])
  );

  return true;
}

// The page shell (title, header, line-color legend, theme color) is generic
// — this is what makes it a "Namma Metro" page or a future "Kochi Metro"
// page purely from data, with no per-network code branch anywhere.
function applyNetworkBranding(meta, lines) {
  if (meta && meta.name) {
    document.title = meta.name;
    const h1 = document.querySelector(".site-header h1");
    if (h1) h1.textContent = meta.name;
  }
  if (meta && meta.tagline) {
    const tagline = document.querySelector(".site-header p");
    if (tagline) tagline.textContent = meta.tagline;
  }
  if (meta && meta.themeColor) {
    document.documentElement.style.setProperty("--accent", meta.themeColor);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute("content", meta.themeColor);
  }

  const legendEl = document.querySelector(".legend");
  if (legendEl && lines) {
    legendEl.innerHTML = Object.values(lines)
      .map(
        (line) =>
          `<span class="legend-item"><span class="legend-swatch" style="background:${line.color}"></span>${line.name}</span>`
      )
      .join("");
  }
}

// Proximity alert: a short two-tone chime + a vibration pulse when the next
// stop is within range. Generated with the Web Audio API rather than an
// audio file, so there's nothing extra for the service worker to cache.
let audioCtx = null;

// Browsers block audio until it's started from a real user gesture, so this
// must be called from inside the "Track my journey live" click handler.
function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}

function playChime() {
  if (!audioCtx) return;
  // iOS in particular can auto-suspend the context again after the tab is
  // backgrounded, even though it was unlocked once at the start — resume
  // defensively before every chime rather than relying on the one-time unlock.
  if (audioCtx.state === "suspended") audioCtx.resume();
  const now = audioCtx.currentTime;
  [
    { start: 0, freq: 784 },
    { start: 0.16, freq: 988 }
  ].forEach(({ start, freq }) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.3, now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + start);
    osc.stop(now + start + 0.2);
  });
}

function vibrateAlert() {
  if ("vibrate" in navigator) navigator.vibrate([120, 60, 120]);
}

// Keeping the screen on while tracking matters most on iOS, where there's no
// Vibration API at all and background tabs get suspended quickly — a locked
// or backgrounded screen means sound and GPS updates can silently stop. This
// trades battery for reliability, and only helps if the phone is actually
// out and visible, not in a pocket.
let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    wakeLock = null; // denied, page hidden, unsupported, etc. — fail silently
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// A wake lock is automatically released when the page is hidden and does
// not come back on its own — re-request it if tracking is still running
// when the rider looks at their phone again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && window.__krMetroTrackingActive && !wakeLock) {
    requestWakeLock();
  }
});

// A short operating-hours note for one ride segment, based on the BMRC
// timing data in timings.js. Returns "" if nothing's on file for that
// line/direction, so a segment quietly gets no note rather than a broken one.
function timingNoteHtml(lineKey, towardsId) {
  const timing = getLineTiming(lineKey, towardsId);
  if (!timing) return "";

  const status = getServiceStatus(timing);
  if (status === "before-open") {
    return `<div class="timing-note timing-closed">🕐 Not running yet today — first train ${timing.firstTrain}</div>`;
  }
  if (status === "after-close") {
    return `<div class="timing-note timing-closed">🕐 Done for the day — last train was ${timing.lastTrain}, first train tomorrow ${timing.firstTrain}</div>`;
  }
  return `<div class="timing-note">🕐 Trains every ${timing.frequency} · last train ${timing.lastTrain}</div>`;
}

function lineDotsHtml(stationId) {
  const lines = [...(STATION_LINES[stationId] || [])];
  return lines
    .map((l) => `<span class="line-dot" style="background:${METRO_LINES[l].color}"></span>`)
    .join("");
}

// A small combobox: text input + filtered dropdown list, backed by a hidden
// station id. Built from scratch (no libraries) so it stays lightweight and
// fully styleable on mobile.
class StationPicker {
  constructor(rootEl) {
    this.root = rootEl;
    this.input = rootEl.querySelector(".picker-input");
    this.list = rootEl.querySelector(".picker-list");
    this.stationId = null;
    this.activeIndex = -1;
    this.filtered = [];

    this.input.addEventListener("input", () => this.onType());
    this.input.addEventListener("focus", () => this.onType());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    document.addEventListener("click", (e) => {
      if (!this.root.contains(e.target)) this.closeList();
    });
  }

  onType() {
    const q = this.input.value.trim().toLowerCase();
    this.stationId = null;
    this.filtered = ALL_STATION_IDS.filter((id) =>
      STATION_NAMES[id].toLowerCase().includes(q)
    ).slice(0, 40);
    this.renderList();
  }

  renderList() {
    if (this.filtered.length === 0) {
      this.closeList();
      return;
    }
    this.activeIndex = -1;
    this.list.innerHTML = this.filtered
      .map(
        (id, i) => `
        <li class="picker-option" role="option" data-id="${id}" data-index="${i}">
          <span class="picker-dots">${lineDotsHtml(id)}</span>
          <span>${STATION_NAMES[id]}</span>
        </li>`
      )
      .join("");
    this.list.classList.add("open");

    this.list.querySelectorAll(".picker-option").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.select(el.dataset.id);
      });
    });
  }

  onKeyDown(e) {
    if (!this.list.classList.contains("open")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.activeIndex >= 0) this.select(this.filtered[this.activeIndex]);
    } else if (e.key === "Escape") {
      this.closeList();
    }
  }

  moveActive(delta) {
    const options = [...this.list.querySelectorAll(".picker-option")];
    if (options.length === 0) return;
    this.activeIndex = (this.activeIndex + delta + options.length) % options.length;
    options.forEach((o) => o.classList.remove("active"));
    options[this.activeIndex].classList.add("active");
    options[this.activeIndex].scrollIntoView({ block: "nearest" });
  }

  select(stationId) {
    this.stationId = stationId;
    this.input.value = STATION_NAMES[stationId];
    this.closeList();
    this.root.dispatchEvent(new CustomEvent("station-selected"));
  }

  setStation(stationId) {
    this.stationId = stationId;
    this.input.value = stationId ? STATION_NAMES[stationId] : "";
  }

  closeList() {
    this.list.classList.remove("open");
    this.list.innerHTML = "";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const ready = await loadNetworkData();
  if (!ready) return;
  startApp();
});

function startApp() {
  document.getElementById("from-input").disabled = false;
  document.getElementById("to-input").disabled = false;

  const fromPicker = new StationPicker(document.getElementById("from-picker"));
  const toPicker = new StationPicker(document.getElementById("to-picker"));
  const form = document.getElementById("route-form");
  const resultsEl = document.getElementById("results");
  const swapBtn = document.getElementById("swap-btn");
  const errorEl = document.getElementById("form-error");

  let tracker = null;
  let alertRepeatTimer = null;
  let activeAlert = null; // { station, type } while an alert is unacknowledged
  let wrongDirectionActive = null; // { nextStation } while a wrong-direction warning is showing
  let lastTrackState = null; // most recent onTrackUpdate state, replayed after Acknowledge

  function stopTrackingIfActive() {
    if (!tracker) return;
    tracker.stop();
    tracker = null;
    stopAlertRepeat();
    wrongDirectionActive = null;
    releaseWakeLock();
    window.__krMetroTrackingActive = false;
    lastTrackState = null;
  }

  function runRouteSearch() {
    errorEl.textContent = "";
    stopTrackingIfActive();

    if (!fromPicker.stationId || !toPicker.stationId) {
      errorEl.textContent = "Pick a valid station for both From and To.";
      resultsEl.innerHTML = "";
      return;
    }

    localStorage.setItem("lastFromStation", fromPicker.stationId);
    localStorage.setItem("lastToStation", toPicker.stationId);

    const result = findRoute(fromPicker.stationId, toPicker.stationId);
    renderResult(result, fromPicker.stationId, toPicker.stationId);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runRouteSearch();
  });

  swapBtn.addEventListener("click", () => {
    const a = fromPicker.stationId;
    const b = toPicker.stationId;
    fromPicker.setStation(b);
    toPicker.setStation(a);
    // Only auto-refresh if there's an actual route to recompute — otherwise
    // just swap whatever's in the fields without triggering the error state.
    if (fromPicker.stationId && toPicker.stationId) {
      runRouteSearch();
    }
  });

  // Restore the last route on reopen (PWA relaunch, page reload, etc.) so a
  // daily commute doesn't need re-entering every time.
  const savedFrom = localStorage.getItem("lastFromStation");
  const savedTo = localStorage.getItem("lastToStation");
  if (savedFrom && STATION_NAMES[savedFrom] && savedTo && STATION_NAMES[savedTo]) {
    fromPicker.setStation(savedFrom);
    toPicker.setStation(savedTo);
    runRouteSearch();
  } else {
    // No saved route — replace the static "Loading network data…" placeholder
    // with the real empty-state prompt now that data has actually arrived.
    resultsEl.innerHTML = `<p class="empty-state">Choose a From and To station to see your route.</p>`;
  }

  function renderResult(result, fromId, toId) {
    if (result.error === "same-station") {
      resultsEl.innerHTML = `<p class="empty-state">You're already there — ${STATION_NAMES[fromId]} is both ends.</p>`;
      return;
    }
    if (result.error === "no-route") {
      resultsEl.innerHTML = `<p class="empty-state">No route found between those stations.</p>`;
      return;
    }

    const segments = result.segments;
    const switchCount = segments.length - 1;
    const totalStops = segments.reduce((sum, s) => sum + (s.stations.length - 1), 0);

    let html = `<div class="summary">
      <span>${totalStops} stop${totalStops === 1 ? "" : "s"}</span>
      <span class="dot-sep">&middot;</span>
      <span>${switchCount === 0 ? "No line change" : switchCount + " line change" + (switchCount === 1 ? "" : "s")}</span>
    </div>`;

    html += `<div class="live-status" id="live-status" hidden></div>`;
    html += `<button type="button" class="track-btn" id="track-btn">&#128205; Track my journey live</button>`;
    html += `<p class="track-hint">Keeps your screen on while tracking, for reliable sound and location — uses more battery.</p>`;

    html += `<ol class="itinerary">`;
    segments.forEach((seg, i) => {
      const line = METRO_LINES[seg.line];
      const first = seg.stations[0];
      const last = seg.stations[seg.stations.length - 1];
      const stops = seg.stations.length - 1;
      const stopDetailId = `stop-detail-${i}`;
      // Every station after the boarding one, in travel order — what the rider
      // will actually see go by, ending at the switch/alight point.
      const rideStops = seg.stations.slice(1);

      html += `<li class="itinerary-step" style="--line-color:${line.color}">
        <div class="step-marker" data-station="${first}"></div>
        <div class="step-body">
          <div class="step-action" data-station="${first}">
            ${i === 0 ? "Board" : "Switch to"} <strong>${line.name}</strong>
            towards <strong>${STATION_NAMES[seg.towards]}</strong> at ${STATION_NAMES[first]}
          </div>
          ${timingNoteHtml(seg.line, seg.towards)}
          <button type="button" class="step-ride-toggle" aria-expanded="false" aria-controls="${stopDetailId}">
            <span class="toggle-caret">&#9656;</span>
            Ride ${stops} stop${stops === 1 ? "" : "s"} to ${STATION_NAMES[last]}
          </button>
          <ol class="stop-detail" id="${stopDetailId}">
            ${rideStops
              .map(
                (st, idx) =>
                  `<li data-station="${st}"${idx === rideStops.length - 1 ? ' class="stop-final"' : ""}>${STATION_NAMES[st]}</li>`
              )
              .join("")}
          </ol>
        </div>
      </li>`;
    });
    html += `</ol>`;

    resultsEl.innerHTML = html;

    resultsEl.querySelectorAll(".step-ride-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!expanded));
        document.getElementById(btn.getAttribute("aria-controls")).classList.toggle("open", !expanded);
      });
    });

    wireTracking(segments, toId);
  }

  function wireTracking(segments, toId) {
    const trackBtn = document.getElementById("track-btn");
    const statusEl = document.getElementById("live-status");

    trackBtn.addEventListener("click", () => {
      if (tracker) {
        stopTrackingIfActive();
        trackBtn.textContent = "\u{1F4CD} Track my journey live";
        trackBtn.classList.remove("active");
        statusEl.hidden = true;
        resultsEl.querySelectorAll("[data-station]").forEach((el) => {
          el.classList.remove("passed", "next-station");
        });
        return;
      }

      trackBtn.textContent = "⏹ Stop tracking";
      trackBtn.classList.add("active");
      statusEl.hidden = false;

      unlockAudio(); // must happen inside this click handler, not later
      requestWakeLock(); // also needs the click's user-gesture context
      window.__krMetroTrackingActive = true;

      tracker = new JourneyTracker(segments, (state) => onTrackUpdate(state, toId));
      tracker.start();
    });
  }

  function onTrackUpdate(state, toId) {
    const statusEl = document.getElementById("live-status");
    if (!statusEl) return;

    lastTrackState = state;

    resultsEl.querySelectorAll("[data-station]").forEach((el) => {
      el.classList.toggle("passed", state.passedStations && state.passedStations.includes(el.dataset.station));
      el.classList.toggle("next-station", state.nextStation === el.dataset.station);
    });

    // Auto-expand whichever ride segment contains the upcoming stop, so the
    // rider doesn't have to manually tap to see it.
    if (state.nextStation) {
      const nextEl = resultsEl.querySelector(`.stop-detail li[data-station="${state.nextStation}"]`);
      if (nextEl) {
        const list = nextEl.closest(".stop-detail");
        list.classList.add("open");
        const toggle = resultsEl.querySelector(`.step-ride-toggle[aria-controls="${list.id}"]`);
        if (toggle) toggle.setAttribute("aria-expanded", "true");
      }
    }

    // Errors and arrival are terminal — they always win, even over an
    // in-progress alert. This matters because a single sparse GPS fix can
    // cross the 200m alert threshold and the 150m arrival threshold in the
    // same update (e.g. a big jump); tracking stops right after an arrival
    // is detected, so if an "approaching" alert were allowed to win here
    // instead, there'd be no later update left to correct it — the rider
    // would be stuck looking at "still approaching" forever.
    if (state.errorMessage) {
      stopAlertRepeat();
      releaseWakeLock();
      window.__krMetroTrackingActive = false;
      statusEl.className = "live-status status-error";
      statusEl.textContent = state.errorMessage;
      return;
    }
    if (state.arrived) {
      stopAlertRepeat();
      releaseWakeLock();
      window.__krMetroTrackingActive = false;
      statusEl.className = "live-status status-arrived arrive-pop";
      statusEl.textContent = `\u{1F3C1} You've arrived at ${STATION_NAMES[toId]}!`;
      return;
    }

    // Wrong-direction takes priority over a normal approach alert — being on
    // the wrong train entirely matters more than an upcoming-stop reminder,
    // and in practice they won't usually coincide anyway (moving away from
    // the planned route means the forward-looking approach alert wouldn't
    // be triggering at the same time).
    if (state.wrongDirectionAlert) {
      stopAlertRepeat(); // don't let the two alerts overlap
      wrongDirectionActive = state.wrongDirectionAlert;
      playChime();
      vibrateAlert();
      renderWrongDirectionBanner(wrongDirectionActive, statusEl);
      return;
    }
    if (state.wrongDirectionCleared) {
      wrongDirectionActive = null;
      // fall through to normal status rendering below
    }
    if (wrongDirectionActive) {
      // Stays up until the rider dismisses it or the trend reverses above —
      // deliberately not a repeating alarm like the approach alert.
      return;
    }

    // A fresh alert takes over the status area immediately.
    if (state.approachingAlert) {
      startAlertRepeat(state.approachingAlert, toId);
      return;
    }

    // An alert already showing owns the status area until the rider taps
    // Acknowledge — nothing below should silently replace it.
    if (activeAlert) {
      return;
    }

    renderNormalStatus(state, statusEl);
  }

  function renderWrongDirectionBanner(alert, statusEl) {
    statusEl.className = "live-status status-wrong-direction";
    statusEl.innerHTML = `
      <span class="alert-text">\u{26A0}\u{FE0F} You seem to be moving away from <strong>${STATION_NAMES[alert.nextStation]}</strong> — you may be on the wrong train. Consider getting off at the next stop and crossing to the opposite platform.</span>
      <button type="button" class="acknowledge-btn" id="wrong-direction-dismiss">Dismiss</button>
    `;
    document.getElementById("wrong-direction-dismiss").addEventListener("click", () => {
      wrongDirectionActive = null;
      if (lastTrackState) {
        renderNormalStatus(lastTrackState, statusEl);
      } else {
        statusEl.className = "live-status status-ok";
        statusEl.textContent = "\u{1F7E2} Tracking live";
      }
    });
  }

  function renderNormalStatus(state, statusEl) {
    if (state.signalStatus === "lost") {
      statusEl.className = "live-status status-lost";
      statusEl.textContent = `⚠️ GPS signal lost — last confirmed at ${STATION_NAMES[state.currentStation]}`;
      return;
    }
    if (state.signalStatus === "no-fix") {
      statusEl.className = "live-status status-searching";
      statusEl.textContent = "Still trying to get a GPS fix — this can take longer indoors or underground.";
      return;
    }
    if (state.signalStatus === "searching") {
      statusEl.className = "live-status status-searching";
      statusEl.textContent = "Getting your location…";
      return;
    }
    statusEl.className = "live-status status-ok";
    statusEl.textContent = state.nextStation
      ? `\u{1F7E2} Tracking live — next stop: ${STATION_NAMES[state.nextStation]}`
      : `\u{1F7E2} Tracking live`;
  }

  // Keeps chiming + vibrating every few seconds until the rider explicitly
  // taps Acknowledge — a single alert is too easy to miss (phone in a
  // pocket, earbuds in, etc.), and per design this never auto-stops on its
  // own, even after the stop has actually been passed.
  function startAlertRepeat(alert, toId) {
    activeAlert = alert;
    if (alertRepeatTimer) clearInterval(alertRepeatTimer);

    playChime();
    vibrateAlert();
    alertRepeatTimer = setInterval(() => {
      playChime();
      vibrateAlert();
    }, 2500);

    renderAlertBanner(alert, toId);
  }

  function stopAlertRepeat() {
    if (alertRepeatTimer) {
      clearInterval(alertRepeatTimer);
      alertRepeatTimer = null;
    }
    activeAlert = null;
  }

  function renderAlertBanner(alert, toId) {
    const statusEl = document.getElementById("live-status");
    if (!statusEl) return;

    const verb =
      alert.type === "switch" ? "get ready to switch lines" : alert.type === "arrival" ? "get ready to get off" : "coming up";

    statusEl.className = "live-status status-approaching alert-active";
    statusEl.innerHTML = `
      <span class="alert-text">\u{1F514} Approaching <strong>${STATION_NAMES[alert.station]}</strong> (~${alert.distance}m) — ${verb}</span>
      <button type="button" class="acknowledge-btn" id="acknowledge-btn">Acknowledge</button>
    `;

    document.getElementById("acknowledge-btn").addEventListener("click", () => {
      stopAlertRepeat();
      if (lastTrackState) {
        renderNormalStatus(lastTrackState, statusEl);
      } else {
        statusEl.className = "live-status status-ok";
        statusEl.textContent = "\u{1F7E2} Tracking live";
      }
    });
  }
}
