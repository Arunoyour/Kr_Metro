// Operating-hours lookup helpers. The actual timing data (METRO_TIMINGS)
// now comes from each network's own JSON file (see app.js's
// loadNetworkData()) rather than being hardcoded here — this file just
// holds the generic logic that works against whatever data was loaded.

function metroDayTypeKey(date) {
  const day = date.getDay(); // 0=Sun, 1=Mon, 2-5=Tue-Fri, 6=Sat
  if (day === 0) return "sunday";
  if (day === 1) return "monday";
  if (day === 6) return "saturday";
  return "tuesdayToFriday";
}

// Looks up the timing entry for a line + the direction a segment is headed
// (its `towards` terminus). Returns null if nothing's on file for it.
function getLineTiming(lineKey, towardsStationId, date) {
  const d = date || new Date();
  const dayData = METRO_TIMINGS[lineKey] && METRO_TIMINGS[lineKey][metroDayTypeKey(d)];
  return (dayData && dayData[towardsStationId]) || null;
}

// Compares the current time of day against first/last train to say whether
// service should be running right now.
function getServiceStatus(timing, date) {
  if (!timing) return null;
  const d = date || new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  const [fh, fm] = timing.firstTrain.split(":").map(Number);
  const [lh, lm] = timing.lastTrain.split(":").map(Number);
  if (mins < fh * 60 + fm) return "before-open";
  if (mins > lh * 60 + lm) return "after-close";
  return "open";
}
