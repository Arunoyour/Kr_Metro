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

const ALL_STATION_IDS = Object.keys(STATION_NAMES).sort((a, b) =>
  STATION_NAMES[a].localeCompare(STATION_NAMES[b])
);

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

document.addEventListener("DOMContentLoaded", () => {
  const fromPicker = new StationPicker(document.getElementById("from-picker"));
  const toPicker = new StationPicker(document.getElementById("to-picker"));
  const form = document.getElementById("route-form");
  const resultsEl = document.getElementById("results");
  const swapBtn = document.getElementById("swap-btn");
  const errorEl = document.getElementById("form-error");

  swapBtn.addEventListener("click", () => {
    const a = fromPicker.stationId;
    const b = toPicker.stationId;
    fromPicker.setStation(b);
    toPicker.setStation(a);
  });

  let tracker = null;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    if (tracker) {
      tracker.stop();
      tracker = null;
    }

    if (!fromPicker.stationId || !toPicker.stationId) {
      errorEl.textContent = "Pick a valid station for both From and To.";
      resultsEl.innerHTML = "";
      return;
    }

    const result = findRoute(fromPicker.stationId, toPicker.stationId);
    renderResult(result, fromPicker.stationId, toPicker.stationId);
  });

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
    html += `<div class="arrive" data-station="${toId}">You arrive at <strong>${STATION_NAMES[toId]}</strong></div>`;

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
        tracker.stop();
        tracker = null;
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

      tracker = new JourneyTracker(segments, (state) => onTrackUpdate(state, toId));
      tracker.start();
    });
  }

  function onTrackUpdate(state, toId) {
    const statusEl = document.getElementById("live-status");
    if (!statusEl) return;

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

    if (state.approachingAlert) {
      playChime();
      vibrateAlert();
    }

    if (state.errorMessage) {
      statusEl.className = "live-status status-error";
      statusEl.textContent = state.errorMessage;
      return;
    }
    if (state.arrived) {
      statusEl.className = "live-status status-arrived";
      statusEl.textContent = `\u{1F3C1} You've arrived at ${STATION_NAMES[toId]}!`;
      return;
    }
    if (state.approachingAlert) {
      const a = state.approachingAlert;
      const verb =
        a.type === "switch" ? "get ready to switch lines" : a.type === "arrival" ? "get ready to get off" : "coming up";
      statusEl.className = "live-status status-approaching";
      statusEl.textContent = `\u{1F514} Approaching ${STATION_NAMES[a.station]} (~${a.distance}m) — ${verb}`;
      return;
    }
    if (state.signalStatus === "lost") {
      statusEl.className = "live-status status-lost";
      statusEl.textContent = `⚠️ GPS signal lost — last confirmed at ${STATION_NAMES[state.currentStation]}`;
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
});
