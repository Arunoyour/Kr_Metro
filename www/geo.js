// Live GPS tracking: matches the rider's position to progress along the
// boarded itinerary. Deliberately conservative — it only ever moves forward,
// and reports "signal lost" rather than guessing when GPS drops (e.g. underground).

const ARRIVAL_RADIUS_METERS = 150; // within this distance of a stop, consider it reached
const PROXIMITY_ALERT_METERS = 200; // within this distance of the next stop, fire the alert
const ACCURACY_THRESHOLD_METERS = 100; // ignore fixes worse than this
const SIGNAL_LOST_TIMEOUT_MS = 25000; // no usable fix for this long -> signal lost
const LOOKAHEAD_STOPS = 3; // only ever match against the next few stops, never the whole trip
const WRONG_DIRECTION_STREAK = 3; // consecutive fixes needed to confirm "moving away", not just GPS jitter
const WRONG_DIRECTION_MARGIN_METERS = 25; // each fix must be at least this much farther than the last

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
    this.signalStatus = "searching"; // "searching" | "ok" | "no-fix" | "lost" | "error"
    this.hasEverFixed = false; // distinguishes "never got a first fix" from "had one, lost it"
    this.lostTimer = null;
    this.alertedStations = new Set(); // stops we've already fired a proximity alert for
    this.recentNextDistances = []; // rolling window of distance-to-next-stop, for wrong-direction detection
    this.wrongDirectionWarned = false; // true while an unacknowledged wrong-direction warning is active

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
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
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
      this.signalStatus = this.hasEverFixed ? "lost" : "no-fix";
      this.emit();
    }, SIGNAL_LOST_TIMEOUT_MS);
  }

  handleError() {
    // The browser retries watchPosition on its own and keeps calling this on
    // each failure, so no need to re-arm anything here.
    this.signalStatus = this.hasEverFixed ? "lost" : "no-fix";
    this.emit();
  }

  handlePosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy > ACCURACY_THRESHOLD_METERS) return; // too imprecise to trust

    this.hasEverFixed = true;
    this.signalStatus = "ok";
    this.armLostTimer();

    // Distance to the CURRENT next stop, before any advancement below. A
    // single sparse GPS fix can land close enough to satisfy the (smaller)
    // arrival radius in the same tick it first comes into alert range — if
    // this were computed after advancing, the "next" pointer would have
    // already moved past the very stop being checked against.
    const nextIndex = this.currentIndex + 1;
    const nextStop = this.stops[nextIndex];
    let distanceToNext = null;
    if (nextStop) {
      const coords = STATION_COORDS[nextStop.station];
      if (coords) distanceToNext = haversineMeters(latitude, longitude, coords.lat, coords.lon);
    }

    // Proximity alert — only for stops that actually need the rider to do
    // something (switch lines or get off). Plain pass-through stops don't
    // get a sound/vibration alert, just the visual next-stop highlight.
    let approachingAlert = null;
    const nextIsActionStop = nextStop && this.actionStopIndices.has(nextIndex);
    if (nextIsActionStop && distanceToNext !== null && !this.alertedStations.has(nextStop.station)) {
      if (distanceToNext <= PROXIMITY_ALERT_METERS) {
        this.alertedStations.add(nextStop.station);
        approachingAlert = {
          station: nextStop.station,
          distance: Math.round(distanceToNext),
          type: nextIndex === this.stops.length - 1 ? "arrival" : "switch"
        };
      }
    }

    // Wrong-direction detection — if distance to the next stop has been
    // strictly increasing (beyond GPS noise) for several fixes in a row,
    // the rider is very likely moving away from it: e.g. boarded a train
    // heading the opposite way. Edge-triggered (only set the tick it's
    // newly confirmed) so the UI shows a one-time warning, not a repeat.
    let wrongDirectionAlert = null;
    let wrongDirectionCleared = false;
    if (distanceToNext !== null) {
      this.recentNextDistances.push(distanceToNext);
      if (this.recentNextDistances.length > WRONG_DIRECTION_STREAK) {
        this.recentNextDistances.shift();
      }
      if (this.recentNextDistances.length === WRONG_DIRECTION_STREAK) {
        let movingAway = true;
        for (let i = 1; i < this.recentNextDistances.length; i++) {
          if (this.recentNextDistances[i] <= this.recentNextDistances[i - 1] + WRONG_DIRECTION_MARGIN_METERS) {
            movingAway = false;
            break;
          }
        }
        if (movingAway && !this.wrongDirectionWarned) {
          this.wrongDirectionWarned = true;
          wrongDirectionAlert = { nextStation: nextStop.station };
        } else if (!movingAway && this.wrongDirectionWarned) {
          // Trend reversed — rider corrected course. Reset so a future
          // wrong turn can trigger a fresh warning, and tell the UI so it
          // can auto-clear the banner without waiting for a manual dismiss.
          this.wrongDirectionWarned = false;
          this.recentNextDistances = [];
          wrongDirectionCleared = true;
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
      // The "next" target just changed, so old distance readings no longer
      // mean anything relative to it.
      this.recentNextDistances = [];
      this.wrongDirectionWarned = false;
    }

    this.emit(undefined, approachingAlert, wrongDirectionAlert, wrongDirectionCleared);

    if (this.currentIndex >= this.stops.length - 1) {
      this.stop();
    }
  }

  emit(errorMessage, approachingAlert, wrongDirectionAlert, wrongDirectionCleared) {
    const next = this.stops[this.currentIndex + 1] || null;
    this.onUpdate({
      signalStatus: this.signalStatus,
      passedStations: this.stops.slice(0, this.currentIndex + 1).map((s) => s.station),
      currentStation: this.stops[this.currentIndex].station,
      nextStation: next ? next.station : null,
      arrived: !next,
      errorMessage,
      wrongDirectionCleared: !!wrongDirectionCleared,
      approachingAlert: approachingAlert || null,
      wrongDirectionAlert: wrongDirectionAlert || null
    });
  }
}
