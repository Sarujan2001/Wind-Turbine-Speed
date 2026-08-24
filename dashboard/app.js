const config = window.WIND_DASHBOARD_CONFIG;
const $ = (id) => document.getElementById(id);
const history = [];
let windChart;

$("site-name").textContent = config.siteName;

function setStatus(kind, label) {
  $("status-dot").className = `status-dot ${kind}`;
  $("connection-label").textContent = label;
}

function renderReading(reading) {
  history.push(reading);
  if (history.length > 60) history.shift();

  const gust = Math.max(...history.map((item) => item.kmh));
  $("wind-speed").textContent = reading.kmh.toFixed(1);
  $("wind-ms").textContent = `${reading.ms.toFixed(2)} m/s`;
  $("gust-speed").textContent = gust.toFixed(1);
  $("adc-voltage").textContent = reading.adc.toFixed(3);
  $("sensor-voltage").textContent = reading.sensor.toFixed(3);
  $("last-updated").textContent = reading.time.toLocaleString();

  windChart.data.labels = history.map((item) =>
    item.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  windChart.data.datasets[0].data = history.map((item) => item.kmh);
  windChart.update("none");
}

// Chart styling is kept in step with styles.css by hand: Chart.js draws to a
// canvas and cannot read CSS custom properties.
const INK = "#000000";
const INK_MUTED = "#525252";
const HAIRLINE = "#e5e5e5";
const MONO = "'JetBrains Mono', ui-monospace, Consolas, monospace";

function createChart() {
  windChart = new Chart($("wind-chart"), {
    type: "line",
    data: { labels: [], datasets: [{
      data: [], borderColor: INK, backgroundColor: "rgba(0,0,0,.06)",
      borderWidth: 2, fill: true,
      // Zero tension: straight segments, not a soft curve. The angular
      // profile is deliberate and matches the sharp geometry of the system.
      tension: 0, pointRadius: 0, pointHoverRadius: 4,
      pointHoverBackgroundColor: INK, pointHoverBorderColor: "#ffffff",
      pointHoverBorderWidth: 2
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: INK, titleColor: "#ffffff", bodyColor: "#ffffff",
          titleFont: { family: MONO, size: 10 },
          bodyFont: { family: MONO, size: 11 },
          cornerRadius: 0, displayColors: false, padding: 10
        }
      },
      scales: {
        x: {
          ticks: { color: INK_MUTED, maxTicksLimit: 7, font: { family: MONO, size: 10 } },
          grid: { display: false },
          border: { color: INK, width: 1 }
        },
        y: {
          beginAtZero: true,
          ticks: { color: INK_MUTED, font: { family: MONO, size: 10 } },
          grid: { color: HAIRLINE, drawTicks: false },
          border: { color: INK, width: 1 }
        }
      }
    }
  });
}

async function loadThingSpeak() {
  const id = config.thingSpeakChannelId;
  const response = await fetch(`https://api.thingspeak.com/channels/${id}/feeds.json?results=60`, { cache: "no-store" });
  if (!response.ok) throw new Error(`ThingSpeak returned ${response.status}`);
  const payload = await response.json();
  const readings = payload.feeds
    .filter((feed) => Number.isFinite(Number.parseFloat(feed.field2)))
    .map((feed) => ({
      ms: Number.parseFloat(feed.field1), kmh: Number.parseFloat(feed.field2),
      adc: Number.parseFloat(feed.field3), sensor: Number.parseFloat(feed.field4),
      time: new Date(feed.created_at)
    }));
  if (!readings.length) throw new Error("No sensor readings in the channel");
  history.length = 0;
  readings.forEach(renderReading);
  setStatus("", "Sensor online");
}

function runDemo() {
  setStatus("demo", "Demonstration data");
  let phase = 0;
  const tick = () => {
    phase += .28;
    const kmh = Math.max(0, 17 + Math.sin(phase) * 6 + (Math.random() - .5) * 3);
    const ms = kmh / 3.6;
    const sensor = ms / 6;
    renderReading({ kmh, ms, sensor, adc: sensor / 3, time: new Date() });
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
  // A bordered square rather than Leaflet's circle marker, echoing the
  // punctuation mark under the hero. Markers sit in the overlay pane, so the
  // grayscale filter on the tile pane leaves it untouched.
  L.marker([config.latitude, config.longitude], {
    icon: L.divIcon({
      className: "site-marker", html: "",
      iconSize: [14, 14], iconAnchor: [7, 7]
    }),
    keyboard: false, title: config.siteName
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

if (config.thingSpeakChannelId) {
  const refresh = async () => {
    try { await loadThingSpeak(); }
    catch (error) { setStatus("error", "Cloud feed unavailable"); console.error(error); }
  };
  refresh();
  setInterval(refresh, Math.max(15, config.refreshSeconds) * 1000);
} else {
  runDemo();
}
