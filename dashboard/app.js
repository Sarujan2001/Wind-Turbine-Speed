const config = window.WIND_DASHBOARD_CONFIG;
const $ = (id) => document.getElementById(id);
const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

// The database URL without its trailing slash, or null to run the demo feed.
const DB = config.firebaseDatabaseUrl
  ? config.firebaseDatabaseUrl.replace(/\/+$/, "")
  : null;

// The chart holds one point per chartPointSeconds, so the trace loaded from the
// database and the points added from the live stream share one spacing.
const chartPoints = [];
const CHART_CAP = Math.max(
  2, Math.round((config.chartMinutes * 60) / config.chartPointSeconds));

let windChart;
let lastChartAt = 0;

$("site-name").textContent = config.siteName;

function setStatus(kind, label) {
  $("status-dot").className = `status-dot ${kind}`;
  $("connection-label").textContent = label;
}

function pushChartPoint(kmh, time) {
  chartPoints.push({ kmh, time });
  if (chartPoints.length > CHART_CAP) {
    chartPoints.splice(0, chartPoints.length - CHART_CAP);
  }
}

function drawChart() {
  windChart.data.labels = chartPoints.map((point) =>
    point.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  windChart.data.datasets[0].data = chartPoints.map((point) => point.kmh);
  windChart.update("none");
}

// The board sends its own three-second gust peak, so the browser formats the
// numbers and works nothing out for itself.
function renderReading(reading) {
  $("wind-speed").textContent = reading.kmh.toFixed(1);
  $("wind-ms").textContent = `${reading.ms.toFixed(2)} m/s`;
  $("gust-speed").textContent = reading.gust.toFixed(1);
  $("adc-voltage").textContent = reading.adc.toFixed(3);
  $("sensor-voltage").textContent = reading.sensor.toFixed(3);
  $("last-updated").textContent = reading.time.toLocaleString();

  if (reading.time - lastChartAt >= config.chartPointSeconds * 1000) {
    lastChartAt = reading.time.getTime();
    pushChartPoint(reading.kmh, reading.time);
    drawChart();
  }
}

// Chart.js draws to a canvas and cannot read CSS custom properties, so these
// are kept in step with the tokens in styles.css by hand.
const ACCENT = "#1565c0";
const TEXT_MUTED = "#5d6b7a";
const GRID = "#e3e8ee";

function createChart() {
  windChart = new Chart($("wind-chart"), {
    type: "line",
    data: { labels: [], datasets: [{
      data: [], borderColor: ACCENT, backgroundColor: "rgba(21,101,192,.08)",
      borderWidth: 2, fill: true, tension: .3, pointRadius: 0,
      pointHoverRadius: 4, pointHoverBackgroundColor: ACCENT,
      pointHoverBorderColor: "#fff", pointHoverBorderWidth: 2
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#17222e", padding: 10, displayColors: false,
          titleFont: { size: 11 }, bodyFont: { size: 12 }
        }
      },
      scales: {
        x: {
          ticks: { color: TEXT_MUTED, maxTicksLimit: 7, font: { size: 11 } },
          grid: { display: false }, border: { color: GRID }
        },
        y: {
          beginAtZero: true,
          ticks: { color: TEXT_MUTED, font: { size: 11 } },
          grid: { color: GRID }, border: { display: false }
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Firebase Realtime Database feed
// ---------------------------------------------------------------------------

// Timestamps are written by Firebase itself, so every point sits on one clock
// regardless of what the board or the viewing device thinks the time is.
function toReading(node) {
  if (!node || !Number.isFinite(node.kmh)) return null;
  return {
    kmh: node.kmh,
    ms: num(node.ms, node.kmh / 3.6),
    gust: num(node.gust, node.kmh),
    adc: num(node.adc),
    sensor: num(node.sensor),
    time: Number.isFinite(node.ts) ? new Date(node.ts) : new Date()
  };
}

// One read of the stored ring at load, so the chart starts with the last hour
// instead of filling in from empty.
async function loadStoredHistory() {
  const response = await fetch(`${DB}/history.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Database returned ${response.status}`);

  const slots = await response.json();
  if (!slots) return;

  const points = Object.values(slots)
    .filter((slot) => slot && Number.isFinite(slot.kmh) && Number.isFinite(slot.ts))
    .sort((first, second) => first.ts - second.ts);
  if (!points.length) return;

  // A reboot restarts the ring at slot 0, so slots it has not come back round
  // to can still hold readings from a previous run. Keep only the window
  // ending at the newest point, measured on the timestamps in the data rather
  // than on the browser clock.
  const newest = points[points.length - 1].ts;
  const windowMs = config.chartMinutes * 60 * 1000;

  points
    .filter((point) => newest - point.ts <= windowMs)
    .forEach((point) => pushChartPoint(point.kmh, new Date(point.ts)));

  lastChartAt = newest;
  drawChart();
}

// Fallback for when the stream cannot be held open - a proxy that buffers
// responses, for instance. Cancelled as soon as the stream comes back.
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;

  const poll = async () => {
    try {
      const response = await fetch(`${DB}/live.json`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Database returned ${response.status}`);
      const reading = toReading(await response.json());
      if (!reading) throw new Error("No reading at /live yet");
      renderReading(reading);
      setStatus("", "Sensor online");
    } catch (error) {
      setStatus("error", "Cloud feed unavailable");
      console.error(error);
    }
  };

  poll();
  pollTimer = setInterval(poll, Math.max(2, config.refreshSeconds) * 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// The Firebase REST API answers with server-sent events when the request asks
// for text/event-stream, which EventSource does on its own. That gives a push
// feed with no SDK to load and no API key in the page.
function streamLive() {
  if (!window.EventSource) {
    startPolling();
    return;
  }

  const stream = new EventSource(`${DB}/live.json`);
  let latest = {};

  const apply = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (payload === null || payload.data === null || payload.data === undefined) return;

    if (payload.path === "/") {
      // A put at the root replaces the node; a patch merges into it.
      latest = event.type === "put"
        ? payload.data
        : { ...latest, ...payload.data };
    } else {
      latest = { ...latest, [payload.path.replace(/^\//, "")]: payload.data };
    }

    const reading = toReading(latest);
    if (reading) renderReading(reading);
  };

  stream.addEventListener("put", apply);
  stream.addEventListener("patch", apply);

  stream.addEventListener("open", () => {
    stopPolling();
    setStatus("", "Sensor online");
  });

  // EventSource retries by itself; polling covers the gap until it succeeds.
  stream.addEventListener("error", () => {
    setStatus("error", "Cloud feed unavailable");
    startPolling();
  });
}

// ---------------------------------------------------------------------------

function runDemo() {
  setStatus("demo", "Demonstration data");

  const spacing = config.chartPointSeconds * 1000;
  const recent = [];
  let phase = 0;

  const synthesise = () => {
    phase += .28;
    const kmh = Math.max(0, 17 + Math.sin(phase) * 6 + (Math.random() - .5) * 3);
    recent.push(kmh);
    if (recent.length > 3) recent.shift();
    return kmh;
  };

  // Backfill the trace so the demonstration page is not an empty panel for its
  // first hour.
  const now = Date.now();
  for (let index = Math.min(CHART_CAP, 60); index > 0; index -= 1) {
    pushChartPoint(synthesise(), new Date(now - index * spacing));
  }
  lastChartAt = now;
  drawChart();

  const tick = () => {
    const kmh = synthesise();
    const ms = kmh / 3.6;
    const sensor = ms / 6;
    renderReading({
      kmh, ms, sensor, adc: sensor / 3,
      gust: Math.max(...recent), time: new Date()
    });
  };

  tick();
  setInterval(tick, 2500);
}

async function initialiseRadar() {
  const map = L.map("radar-map", { zoomControl: true }).setView(
    [config.latitude, config.longitude], config.mapZoom);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap"
  }).addTo(map);
  L.circleMarker([config.latitude, config.longitude], {
    radius: 7, color: "#fff", weight: 2, fillColor: ACCENT, fillOpacity: 1
  }).addTo(map).bindTooltip(config.siteName);

  try {
    const response = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    const data = await response.json();
    const frame = data.radar.past.at(-1);
    L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: .68, maxNativeZoom: 7, maxZoom: 19, attribution: "Radar © RainViewer"
    }).addTo(map);
    $("radar-time").textContent = new Date(frame.time * 1000).toLocaleString();
  } catch (error) {
    $("radar-time").textContent = "Radar temporarily unavailable";
    console.error(error);
  }
}

createChart();
initialiseRadar();

if (DB) {
  setStatus("", "Connecting");
  // Not fatal if this fails - the live stream still fills the chart from now
  // on. A 401 here means the rules do not allow public reads of /history.
  loadStoredHistory().catch((error) => console.error(error));
  streamLive();
} else {
  runDemo();
}
