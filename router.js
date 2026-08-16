// Builds a graph of (station, line) nodes and finds the route that minimizes
// line switches first, then total stops.
//
// Why (station, line) pairs instead of plain stations: an interchange station
// belongs to two lines, so "cost to continue" vs "cost to switch" depends on
// which line you arrived on, not just which station you're at.

const SWITCH_PENALTY = 1000;

function buildGraph(lines) {
  const graph = {};          // "station|line" -> [{ to, weight }]
  const stationLines = {};   // station -> Set(line keys)

  for (const [lineKey, lineData] of Object.entries(lines)) {
    const stops = lineData.stations;
    stops.forEach((station, i) => {
      if (!stationLines[station]) stationLines[station] = new Set();
      stationLines[station].add(lineKey);

      const nodeId = `${station}|${lineKey}`;
      if (!graph[nodeId]) graph[nodeId] = [];
      if (i > 0) {
        graph[nodeId].push({ to: `${stops[i - 1]}|${lineKey}`, weight: 1 });
      }
      if (i < stops.length - 1) {
        graph[nodeId].push({ to: `${stops[i + 1]}|${lineKey}`, weight: 1 });
      }
    });
  }

  // Switch edges: at any station served by multiple lines, hopping from
  // one line's node to another's costs a large penalty so the search
  // avoids extra switches unless there's no shorter-switch-count route.
  for (const [station, lineSet] of Object.entries(stationLines)) {
    const linesHere = [...lineSet];
    for (const fromLine of linesHere) {
      for (const toLine of linesHere) {
        if (fromLine === toLine) continue;
        graph[`${station}|${fromLine}`].push({
          to: `${station}|${toLine}`,
          weight: SWITCH_PENALTY
        });
      }
    }
  }

  return { graph, stationLines };
}

// Populated by initRouterData() once a network's data has been fetched --
// this used to run as a top-level side effect against a script-tag-loaded
// METRO_LINES, but data now arrives asynchronously (fetched JSON per
// city+service), so building the graph has to wait for that.
let GRAPH = null;
let STATION_LINES = null;

function initRouterData(lines) {
  const built = buildGraph(lines);
  GRAPH = built.graph;
  STATION_LINES = built.stationLines;
}

function dijkstra(originId, destId) {
  if (!STATION_LINES[originId] || !STATION_LINES[destId]) return null;
  if (originId === destId) return [];

  const dist = {};
  const prev = {};
  const visited = new Set();
  const nodeIds = Object.keys(GRAPH);
  nodeIds.forEach((n) => (dist[n] = Infinity));
  [...STATION_LINES[originId]].forEach((line) => {
    dist[`${originId}|${line}`] = 0;
  });

  while (true) {
    let current = null;
    let best = Infinity;
    for (const n of nodeIds) {
      if (!visited.has(n) && dist[n] < best) {
        best = dist[n];
        current = n;
      }
    }
    if (current === null) break;
    visited.add(current);

    for (const edge of GRAPH[current]) {
      const alt = dist[current] + edge.weight;
      if (alt < dist[edge.to]) {
        dist[edge.to] = alt;
        prev[edge.to] = current;
      }
    }
  }

  let bestEnd = null;
  let bestDist = Infinity;
  [...STATION_LINES[destId]].forEach((line) => {
    const n = `${destId}|${line}`;
    if (dist[n] < bestDist) {
      bestDist = dist[n];
      bestEnd = n;
    }
  });
  if (bestEnd === null || bestDist === Infinity) return null;

  const path = [];
  let cur = bestEnd;
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev[cur];
  }
  return path;
}

// A line runs through a station in one of two directions; the platform/train
// board identifies it by the terminal station at the far end, not the line
// name alone. This figures out which terminal a segment is headed toward.
function directionTerminal(lineKey, segStations) {
  const fullStops = METRO_LINES[lineKey].stations;
  const firstIdx = fullStops.indexOf(segStations[0]);
  const lastIdx = fullStops.indexOf(segStations[segStations.length - 1]);
  return lastIdx > firstIdx ? fullStops[fullStops.length - 1] : fullStops[0];
}

// Groups a raw (station|line) path into ride segments, splitting wherever
// the line changes (i.e. wherever a switch happened).
function buildItinerary(path) {
  if (!path || path.length === 0) return [];

  const rawSegments = [];
  let segLine = null;
  let segStations = [];

  for (const node of path) {
    const [station, line] = node.split("|");
    if (segLine === null) {
      segLine = line;
      segStations = [station];
    } else if (line === segLine) {
      segStations.push(station);
    } else {
      rawSegments.push({ line: segLine, stations: segStations });
      segLine = line;
      segStations = [station];
    }
  }
  rawSegments.push({ line: segLine, stations: segStations });

  return rawSegments.map((seg) => ({
    ...seg,
    towards: directionTerminal(seg.line, seg.stations)
  }));
}

function findRoute(originId, destId) {
  const path = dijkstra(originId, destId);
  if (path === null) return { error: "no-route" };
  if (path.length === 0) return { error: "same-station" };
  return { segments: buildItinerary(path) };
}
