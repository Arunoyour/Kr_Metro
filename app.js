// UI wiring: searchable station pickers, swap button, and itinerary rendering.

const ALL_STATION_IDS = Object.keys(STATION_NAMES).sort((a, b) =>
  STATION_NAMES[a].localeCompare(STATION_NAMES[b])
);

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

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorEl.textContent = "";

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

    html += `<ol class="itinerary">`;
    segments.forEach((seg, i) => {
      const line = METRO_LINES[seg.line];
      const first = seg.stations[0];
      const last = seg.stations[seg.stations.length - 1];
      const stops = seg.stations.length - 1;
      const stopDetailId = `stop-detail-${i}`;
      // Every station after the boarding one, in travel order — what the rider
      // will actually see go by, ending at the switch/alight point.
      const passedStations = seg.stations.slice(1);

      html += `<li class="itinerary-step" style="--line-color:${line.color}">
        <div class="step-marker"></div>
        <div class="step-body">
          <div class="step-action">
            ${i === 0 ? "Board" : "Switch to"} <strong>${line.name}</strong>
            towards <strong>${STATION_NAMES[seg.towards]}</strong> at ${STATION_NAMES[first]}
          </div>
          <button type="button" class="step-ride-toggle" aria-expanded="false" aria-controls="${stopDetailId}">
            <span class="toggle-caret">&#9656;</span>
            Ride ${stops} stop${stops === 1 ? "" : "s"} to ${STATION_NAMES[last]}
          </button>
          <ol class="stop-detail" id="${stopDetailId}">
            ${passedStations
              .map(
                (st, idx) => `<li${idx === passedStations.length - 1 ? ' class="stop-final"' : ""}>${STATION_NAMES[st]}</li>`
              )
              .join("")}
          </ol>
        </div>
      </li>`;
    });
    html += `</ol>`;
    html += `<div class="arrive">You arrive at <strong>${STATION_NAMES[toId]}</strong></div>`;

    resultsEl.innerHTML = html;

    resultsEl.querySelectorAll(".step-ride-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!expanded));
        document.getElementById(btn.getAttribute("aria-controls")).classList.toggle("open", !expanded);
      });
    });
  }
});
