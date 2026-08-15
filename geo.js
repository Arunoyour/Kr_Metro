// Live GPS tracking: matches the rider's position to progress along the
// boarded itinerary. Deliberately conservative — it only ever moves forward,
// and reports "signal lost" rather than guessing when GPS drops (e.g. underground).

const ARRIVAL_RADIUS_METERS = 150; // within this distance of a stop, consider it reached
const PROXIMITY_ALERT_METERS = 200; // within this distance of the next stop, fire the alert
const ACCURACY_THRESHOLD_METERS = 100; // ignore fixes worse than this
const SIGNAL_LOST_TIMEOUT_MS = 25000; // no usable fix for this long -> signal lost
const LOOKAHEAD_STOPS = 3; // only ever match against the next few stops, never the whole trip

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Flattens itinerary segments into one ordered stop list so progress can be
// tracked as a single forward-moving pointer across switches. The station
// shared between two segments (an interchange) appears only once.
function flattenItinerary(segments) {
  const stops = [];
  segments.forEach((seg, segIndex) => {
    seg.stations.forEach((station, i) => {
      if (segIndex > 0 && i === 0) return;
      stops.push({ station, segIndex, line: seg.line });
    });
  });
  return stops;
}

class JourneyTracker {
  constructor(segments, onUpdate) {
    this.stops = flattenItinerary(segments);
    this.onUpdate = onUpdate;
    this.currentIndex = 0; // last confirmed stop reached; 0 = still at origin
    this.watchId = null;
    this.signalStatus = "searching"; // "searching" | "ok" | "lost" | "error"
    this.lostTimer = null;
    this.alertedStations = new Set(); // stops we've already fired a proximity alert for

    // A stop needs the rider's attention (switch or get off) if the line
    // changes right after it, or it's the very last stop of the trip.
    // Everything else is just a pass-through stop on the way there.
    this.actionStopIndices = new Set();
    this.stops.forEach((stop, i) => {
      const isLast = i === this.stops.length - 1;
      const switchesNext = !isLast && this.stops[i + 1].segIndex !== stop.segIndex;
      if (isLast || switchesNext) this.actionStopIndices.add(i);
    });
  }

  start() {
    if (!("geolocation" in navigator)) {
      this.signalStatus = "error";
      this.emit("Geolocation isn't supported in this browser.");
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handlePosition(pos),
      () => this.handleError(),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    this.armLostTimer();
    this.emit();
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.lostTimer) clearTimeout(this.lostTimer);
  }

  armLostTimer() {
    if (this.lostTimer) clearTimeout(this.lostTimer);
    this.lostTimer = setTimeout(() => {
      this.signalStatus = "lost";
      this.emit();
    }, SIGNAL_LOST_TIMEOUT_MS);
  }

  handleError() {
    this.signalStatus = "lost";
    this.emit();
  }

  handlePosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy > ACCURACY_THRESHOLD_METERS) return; // too imprecise to trust

    this.signalStatus = "ok";
    this.armLostTimer();

    // Check the proximity alert against the CURRENT next stop before any
    // advancement below. A single sparse GPS fix can land close enough to
    // satisfy the (smaller) arrival radius in the same tick it first comes
    // into alert range — if we checked after advancing, the "next" pointer
    // would have already moved past the very stop we meant to warn about.
    let approachingAlert = null;
    const nextIndex = this.currentIndex + 1;
    const nextStop = this.stops[nextIndex];
    if (nextStop && !this.alertedStations.has(nextStop.station)) {
      const coords = STATION_COORDS[nextStop.station];
      if (coords) {
        const d = haversineMeters(latitude, longitude, coords.lat, coords.lon);
        if (d <= PROXIMITY_ALERT_METERS) {
          this.alertedStations.add(nextStop.station);
          approachingAlert = {
            station: nextStop.station,
            distance: Math.round(d),
            type: this.actionStopIndices.has(nextIndex)
              ? nextIndex === this.stops.length - 1
                ? "arrival"
                : "switch"
              : "stop"
          };
        }
      }
    }

    const window = this.stops.slice(this.currentIndex, this.currentIndex + LOOKAHEAD_STOPS);
    let bestOffset = -1;
    let bestDist = Infinity;
    window.forEach((stop, offset) => {
      const coords = STATION_COORDS[stop.station];
      if (!coords) return;
      const d = haversineMeters(latitude, longitude, coords.lat, coords.lon);
      if (d < bestDist) {
        bestDist = d;
        bestOffset = offset;
      }
    });

    if (bestOffset > 0 && bestDist <= ARRIVAL_RADIUS_METERS) {
      this.currentIndex += bestOffset;
    }

    this.emit(undefined, approachingAlert);

    if (this.currentIndex >= this.stops.length - 1) {
      this.stop();
    }
  }

  emit(errorMessage, approachingAlert) {
    const next = this.stops[this.currentIndex + 1] || null;
    this.onUpdate({
      signalStatus: this.signalStatus,
      passedStations: this.stops.slice(0, this.currentIndex + 1).map((s) => s.station),
      currentStation: this.stops[this.currentIndex].station,
      nextStation: next ? next.station : null,
      arrived: !next,
      errorMessage,
      approachingAlert: approachingAlert || null
    });
  }
}
