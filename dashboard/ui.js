export const $ = (id) => document.getElementById(id);

const fixed = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "--";
const sameDay = (first, second) => first.getFullYear() === second.getFullYear()
  && first.getMonth() === second.getMonth() && first.getDate() === second.getDate();

export function metresPerSecond(kmh) {
  return Number.isFinite(kmh) ? kmh / 3.6 : NaN;
}

export function summarise(points) {
  if (!points.length) return null;
  const winds = points.map((point) => point.ms).filter(Number.isFinite);
  const gusts = points.map((point) => point.gustMs).filter(Number.isFinite);
  if (!winds.length) return null;
  return {
    maximum: Math.max(...winds),
    minimum: Math.min(...winds),
    average: winds.reduce((sum, value) => sum + value, 0) / winds.length,
    gustMaximum: gusts.length ? Math.max(...gusts) : NaN,
    gustMinimum: gusts.length ? Math.min(...gusts) : NaN,
    gustAverage: gusts.length
      ? gusts.reduce((sum, value) => sum + value, 0) / gusts.length : NaN,
    samples: winds.length
  };
}

export function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function relativeAge(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Waiting for data";
  const seconds = Math.max(0, Math.round((now - date) / 1000));
  if (seconds < 2) return "Just now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min ago`;
}

function coordinate(value, positive, negative) {
  if (!Number.isFinite(value)) return "--";
  return `${Math.abs(value).toFixed(5)}° ${value >= 0 ? positive : negative}`;
}

export function configureStation(config) {
  $("station-name").textContent = config.stationName || config.siteName;
  $("station-location").textContent = config.stationLocation || "Location not configured";
  $("station-id").textContent = `Station ID: ${config.stationId || "--"}`;
  $("station-coordinates").textContent = `Coordinates: ${coordinate(config.latitude, "N", "S")}, ${coordinate(config.longitude, "E", "W")}`;
  $("station-elevation").textContent = `Elevation: ${Number.isFinite(config.elevationMeters) ? `${config.elevationMeters} m` : "--"}`;
  $("sensor-device").textContent = config.deviceName || "ESP32-C3";
  $("setting-refresh").textContent = `${config.refreshSeconds} seconds`;
  $("setting-timeout").textContent = `${config.offlineAfterSeconds} seconds`;
  $("history-date").value = dateKey(new Date());
  $("history-date").max = dateKey(new Date());
}

function categoryFor(ms) {
  if (!Number.isFinite(ms)) return "Waiting for measurement";
  if (ms < 2) return "Calm";
  if (ms < 5) return "Light wind";
  if (ms < 10) return "Moderate wind";
  if (ms < 15) return "Strong wind";
  if (ms < 20) return "Very strong wind";
  return "High wind";
}

function updateGauge(ms) {
  const bounded = Math.min(30, Math.max(0, Number.isFinite(ms) ? ms : 0));
  const ratio = bounded / 30;
  $("gauge-progress").style.strokeDasharray = `${(ratio * 100).toFixed(1)} 100`;
  $("gauge-needle").style.transform = `rotate(${-90 + ratio * 180}deg)`;
  $("gauge-value").textContent = fixed(ms, 2);
  $("gauge-category").textContent = categoryFor(ms);
  $("wind-category").textContent = categoryFor(ms);
}

function setStatusElement(element, online, text) {
  element.classList.toggle("is-online", online);
  element.classList.toggle("is-offline", !online);
  // The label is the LAST text node, not the first. Markup written across
  // several lines puts a whitespace text node before the status dot, and
  // writing into that one left the literal label from the file sitting beside
  // the value just set - "Offline" and "Online" showing at once.
  const textNodes = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE);
  const label = textNodes.at(-1);
  if (label) label.nodeValue = text;
  else element.append(document.createTextNode(text));
}

export function renderReading(reading, summary) {
  const oldValue = $("wind-ms").textContent;
  $("wind-ms").textContent = fixed(reading.ms, 2);
  $("wind-kmh").textContent = fixed(reading.kmh, 1);
  $("metric-wind").textContent = fixed(reading.ms, 2);
  $("metric-gust").textContent = fixed(reading.gustMs, 2);
  $("sensor-voltage").textContent = fixed(reading.sensor, 3);
  $("adc-voltage").textContent = fixed(reading.adc, 3);
  $("adc-reading").textContent = Number.isFinite(reading.raw) ? Math.round(reading.raw).toLocaleString() : "--";
  $("sensor-connection").textContent = reading.mode === "on your network" ? "Wi-Fi" : (reading.mode || "--");
  $("station-update-time").textContent = reading.time.toLocaleString();
  updateGauge(reading.ms);

  if (oldValue !== $("wind-ms").textContent) {
    $("primary-reading").classList.remove("is-changing");
    requestAnimationFrame(() => $("primary-reading").classList.add("is-changing"));
    window.setTimeout(() => $("primary-reading").classList.remove("is-changing"), 280);
  }

  if (summary) {
    $("metric-max").textContent = fixed(summary.maximum, 2);
    $("metric-average").textContent = fixed(summary.average, 2);
    $("summary-max").textContent = fixed(summary.maximum, 2);
    $("summary-min").textContent = fixed(summary.minimum, 2);
    $("summary-average").textContent = fixed(summary.average, 2);
    $("summary-gust").textContent = fixed(summary.gustMaximum, 2);
    $("summary-samples").textContent = summary.samples.toLocaleString();
  } else {
    $("metric-max").textContent = "--";
    $("metric-average").textContent = "--";
    $("summary-max").textContent = "--";
    $("summary-min").textContent = "--";
    $("summary-average").textContent = "--";
    $("summary-gust").textContent = "--";
    $("summary-samples").textContent = "0";
  }
  $("summary-runtime").textContent = formatRuntime(reading.up);
}

export function updateFreshness(reading, offlineAfterSeconds) {
  const ageSeconds = reading ? Math.max(0, (Date.now() - reading.time.getTime()) / 1000) : Infinity;
  const online = ageSeconds <= offlineAfterSeconds;
  const age = reading ? relativeAge(reading.time) : "Waiting for data";

  $("live-state").className = `live-state ${online ? "is-online" : "is-offline"}`;
  $("connection-label").textContent = online ? "Live" : "Connection lost";
  $("station-badge").className = `station-badge ${online ? "is-online" : "is-offline"}`;
  $("station-badge").querySelector("span").textContent = online ? "Online" : "Offline";
  setStatusElement($("metric-sensor"), online, online ? "Online" : "Offline");
  setStatusElement($("sensor-status"), online, online ? "Online" : "Offline");
  $("metric-age").textContent = age;
  $("station-last-update").textContent = age;
  $("sensor-last-reading").textContent = age;
  return online;
}

export function renderHistory(points) {
  const summary = summarise(points);
  $("history-wind-max").textContent = summary ? `${fixed(summary.maximum)} m/s` : "--";
  $("history-wind-min").textContent = summary ? `${fixed(summary.minimum)} m/s` : "--";
  $("history-wind-average").textContent = summary ? `${fixed(summary.average)} m/s` : "--";
  $("history-gust-max").textContent = summary ? `${fixed(summary.gustMaximum)} m/s` : "--";
  $("history-gust-min").textContent = summary ? `${fixed(summary.gustMinimum)} m/s` : "--";
  $("history-gust-average").textContent = summary ? `${fixed(summary.gustAverage)} m/s` : "--";

  const body = $("history-table-body");
  body.replaceChildren();
  const fragment = document.createDocumentFragment();
  [...points].reverse().forEach((point) => {
    const row = document.createElement("tr");
    const cells = [
      point.time.toLocaleTimeString(), fixed(point.ms), fixed(point.kmh, 1),
      fixed(point.gustMs), fixed(point.sensor, 3), "Received"
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (index === 5) cell.className = "table-status";
      row.append(cell);
    });
    fragment.append(row);
  });
  body.append(fragment);
  $("history-empty").hidden = points.length > 0;
  return summary;
}

export function readingsForToday(points) {
  const today = new Date();
  return points.filter((point) => sameDay(point.time, today));
}

export function setHistoryView(view) {
  const graph = view === "graph";
  $("graph-tab").classList.toggle("is-active", graph);
  $("table-tab").classList.toggle("is-active", !graph);
  $("graph-tab").setAttribute("aria-selected", graph);
  $("table-tab").setAttribute("aria-selected", !graph);
  $("history-graph-view").hidden = !graph;
  $("history-table-view").hidden = graph;
}

export function formatRuntime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}
