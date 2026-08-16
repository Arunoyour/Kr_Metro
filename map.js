// Nearest-station finder with a live Leaflet map. The map tiles need
// internet access (OpenStreetMap tile servers) — everything else here
// (position watching, nearest-station calculation) works the same offline,
// same as the rest of the app. Leaflet itself is bundled locally
// (vendor/leaflet/), not loaded from a CDN, so it's precached like everything
// else and works inside the Capacitor-wrapped app too.

let nearestMap = null;
let userMarker = null;
let nearestLine = null;
let locateWatchId = null;
let hasZoomedOnce = false;

// Formats a distance in meters for display: plain meters when close by,
// km with just enough precision to be useful once it's far enough that
// individual meters stop mattering.
function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)}m`;
  const km = meters / 1000;
  const decimals = km < 10 ? 1 : 0;
  return `${km.toFixed(decimals)}km`;
}

// Reuses the same haversine formula as geo.js (loaded earlier) rather than
// duplicating it.
function findNearestStation(lat, lon) {
  let bestId = null;
  let bestDist = Infinity;
  Object.keys(STATION_COORDS).forEach((id) => {
    const c = STATION_COORDS[id];
    const d = haversineMeters(lat, lon, c.lat, c.lon);
    if (d < bestDist) {
      bestDist = d;
      bestId = id;
    }
  });
  return { stationId: bestId, distance: bestDist };
}

function ensureMap() {
  if (nearestMap) return nearestMap;

  const mapEl = document.getElementById("locate-map");
  nearestMap = L.map(mapEl, { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(nearestMap);

  // Every station, as a small dot in its own line color, for context.
  Object.keys(STATION_COORDS).forEach((id) => {
    const c = STATION_COORDS[id];
    const lines = [...(STATION_LINES[id] || [])];
    const color = lines.length ? METRO_LINES[lines[0]].color : "#666";
    L.circleMarker([c.lat, c.lon], {
      radius: 5,
      color: "#fff",
      weight: 1,
      fillColor: color,
      fillOpacity: 1
    })
      .addTo(nearestMap)
      .bindTooltip(STATION_NAMES[id]);
  });

  return nearestMap;
}

function updatePosition(lat, lon, nearestStationId) {
  const map = ensureMap();

  if (!userMarker) {
    const icon = L.divIcon({ className: "you-are-here-icon", iconSize: [18, 18] });
    userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lon]);
  }

  const nc = STATION_COORDS[nearestStationId];
  if (nc) {
    const linePoints = [
      [lat, lon],
      [nc.lat, nc.lon]
    ];
    if (nearestLine) {
      nearestLine.setLatLngs(linePoints);
    } else {
      nearestLine = L.polyline(linePoints, { color: "#e63946", weight: 2, dashArray: "4,6" }).addTo(map);
    }
  }

  // Auto-zoom happens once, on the first fix — after that the rider is free
  // to pan/zoom the map themselves while the marker keeps updating in place,
  // rather than yanking their view back every few seconds.
  if (!hasZoomedOnce) {
    hasZoomedOnce = true;
    map.setView([lat, lon], 16);
    setTimeout(() => map.invalidateSize(), 50);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("locate-btn");
  const panel = document.getElementById("locate-panel");
  const resultEl = document.getElementById("locate-result");
  const mapEl = document.getElementById("locate-map");
  if (!btn) return;

  btn.addEventListener("click", () => {
    if (locateWatchId !== null) {
      navigator.geolocation.clearWatch(locateWatchId);
      locateWatchId = null;
      hasZoomedOnce = false;
      btn.textContent = "\u{1F4CD} Find Nearest Station";
      btn.classList.remove("active");
      panel.hidden = true;
      mapEl.hidden = true;
      return;
    }

    if (!("geolocation" in navigator)) {
      panel.hidden = false;
      resultEl.className = "locate-result status-error";
      resultEl.textContent = "Geolocation isn't supported in this browser.";
      return;
    }

    panel.hidden = false;
    mapEl.hidden = false;
    resultEl.className = "locate-result status-searching";
    resultEl.textContent = "Getting your location…";
    btn.textContent = "⏹ Stop";
    btn.classList.add("active");

    locateWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const { stationId, distance } = findNearestStation(latitude, longitude);
        resultEl.className = "locate-result status-ok";
        if (distance > 50000) {
          // This far out, "nearest station" isn't a useful answer — the
          // rider almost certainly isn't near this network at all.
          resultEl.innerHTML = `You're quite far from ${document.title} — nearest station is <strong>${STATION_NAMES[stationId]}</strong>, about ${formatDistance(distance)} away`;
        } else {
          resultEl.innerHTML = `Nearest station: <strong>${STATION_NAMES[stationId]}</strong> — about ${formatDistance(distance)} away`;
        }
        updatePosition(latitude, longitude, stationId);
      },
      () => {
        resultEl.className = "locate-result status-lost";
        resultEl.textContent = "Couldn't get your location. Check permissions and try again.";
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  });
});
