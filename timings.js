// Metro operating hours, transcribed from BMRC's official timetable images
// (https://www.bmrc.co.in/metro-timings/ — each day-type/line combination is
// published as a scanned image, not structured data, so this was read by hand).
//
// Scoped to what a rider actually needs in the moment: first train, last
// train, and the frequency range across the day — not the full operational
// schedule (which also includes short-turning services and specific-time
// morning/evening loop trains between arbitrary station pairs).
//
// Keyed by [line][dayType][towardsStationId] since that matches how a
// boarded segment already identifies itself (see router.js's `towards`).
const METRO_TIMINGS = {
  purple: {
    monday: {
      whitefield_kadugodi: { firstTrain: "04:15", lastTrain: "23:05", frequency: "8-20 min" },
      challaghatta: { firstTrain: "04:15", lastTrain: "22:45", frequency: "8-20 min" }
    },
    tuesdayToFriday: {
      whitefield_kadugodi: { firstTrain: "05:00", lastTrain: "23:05", frequency: "8-20 min" },
      challaghatta: { firstTrain: "05:00", lastTrain: "22:45", frequency: "8-20 min" }
    },
    saturday: {
      whitefield_kadugodi: { firstTrain: "05:00", lastTrain: "23:05", frequency: "8-20 min" },
      challaghatta: { firstTrain: "05:00", lastTrain: "22:45", frequency: "8-20 min" }
    },
    sunday: {
      whitefield_kadugodi: { firstTrain: "07:00", lastTrain: "23:05", frequency: "8-15 min" },
      challaghatta: { firstTrain: "07:00", lastTrain: "22:45", frequency: "8-14 min" }
    }
  },
  green: {
    monday: {
      madavara: { firstTrain: "04:15", lastTrain: "23:05", frequency: "8-20 min" },
      silk_institute: { firstTrain: "04:15", lastTrain: "22:57", frequency: "7-25 min" }
    },
    tuesdayToFriday: {
      madavara: { firstTrain: "05:00", lastTrain: "23:05", frequency: "8-15 min" },
      silk_institute: { firstTrain: "05:00", lastTrain: "22:57", frequency: "7-15 min" }
    },
    saturday: {
      madavara: { firstTrain: "05:00", lastTrain: "23:05", frequency: "8-15 min" },
      silk_institute: { firstTrain: "05:00", lastTrain: "23:00", frequency: "5.5-15 min" }
    },
    sunday: {
      madavara: { firstTrain: "07:00", lastTrain: "23:05", frequency: "8-15 min" },
      silk_institute: { firstTrain: "07:00", lastTrain: "23:00", frequency: "8-15 min" }
    }
  },
  yellow: {
    monday: {
      rv_road: { firstTrain: "05:05", lastTrain: "22:42", frequency: "6-30 min" },
      delta_electronics_bommasandra: { firstTrain: "05:05", lastTrain: "23:55", frequency: "6-30 min" }
    },
    tuesdayToFriday: {
      rv_road: { firstTrain: "06:00", lastTrain: "22:42", frequency: "6-20 min" },
      delta_electronics_bommasandra: { firstTrain: "06:00", lastTrain: "23:55", frequency: "6-25 min" }
    },
    saturday: {
      rv_road: { firstTrain: "06:00", lastTrain: "22:42", frequency: "10-20 min" },
      delta_electronics_bommasandra: { firstTrain: "06:00", lastTrain: "23:55", frequency: "10-25 min" }
    },
    sunday: {
      rv_road: { firstTrain: "07:00", lastTrain: "22:42", frequency: "10-18 min" },
      delta_electronics_bommasandra: { firstTrain: "07:00", lastTrain: "23:55", frequency: "10-25 min" }
    }
  }
};

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
