import {
  $, configureStation, dateKey, metresPerSecond, readingsForToday,
  renderHistory, renderReading, setHistoryView, summarise, updateFreshness
} from "./ui.js?v=wind-station-1";
import { createCharts } from "./charts.js?v=wind-station-1";

const config = window.WIND_DASHBOARD_CONFIG;
const DB = config.firebaseDatabaseUrl?.replace(/\/+$/, "") || null;
const state = { readings: [], latest: null, selectedDate: dateKey(new Date()) };
const MAX_LOCAL_POINTS = 2200;
let charts;
let pollTimer = null;
let eventStream = null;

function number(value, fallback = NaN) {
  return Number.isFinite(value) ? value : fallback;
}

// All unit conversion enters through this adapter. The dashboard itself works
// in m/s, while the Firebase document continues to retain both units.
function toReading(node) {
  if (!node || !Number.isFinite(node.kmh)) return null;
  const ms = number(node.ms, metresPerSecond(node.kmh));
  const gustKmh = number(node.gust, node.kmh);
  return {
    kmh: node.kmh,
    ms,
    gustKmh,
    gustMs: metresPerSecond(gustKmh),
    adc: number(node.adc),
    sensor: number(node.sensor),
    raw: number(node.raw),
    up: number(node.up),
    mode: typeof node.mode === "string" ? node.mode : "--",
    time: Number.isFinite(node.ts) ? new Date(node.ts) : new Date()
  };
}

function historyReading(node) {
  if (!node || !Number.isFinite(node.kmh) || !Number.isFinite(node.ts)) return null;
  return toReading({ ...node, raw: NaN, up: NaN, adc: number(node.sensor) / 3 });
}

function mergeReading(reading) {
  const timestamp = reading.time.getTime();
  const index = state.readings.findIndex((point) => point.time.getTime() === timestamp);
  if (index >= 0) state.readings[index] = { ...state.readings[index], ...reading };
  else state.readings.push(reading);
  state.readings.sort((first, second) => first.time - second.time);
  if (state.readings.length > MAX_LOCAL_POINTS) {
    state.readings.splice(0, state.readings.length - MAX_LOCAL_POINTS);
  }
}

function selectedHistory() {
  return state.readings.filter((point) => dateKey(point.time) === state.selectedDate);
}

function renderHistorySelection() {
  const points = selectedHistory();
  renderHistory(points);
  charts.updateHistory(points);
  $("next-day").disabled = state.selectedDate >= dateKey(new Date());
}

function acceptReading(reading) {
  if (!reading) return;
  state.latest = reading;
  mergeReading(reading);
  const today = readingsForToday(state.readings);
  renderReading(reading, summarise(today));
  updateFreshness(reading, config.offlineAfterSeconds);
  charts.updateMain(state.readings);
  if (dateKey(reading.time) === state.selectedDate) renderHistorySelection();
}

async function fetchJson(path) {
  const response = await fetch(`${DB}${path}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Firebase returned HTTP ${response.status}`);
  return response.json();
}

async function loadStoredHistory() {
  const slots = await fetchJson("/history");
  if (!slots) return;
  Object.values(slots).map(historyReading).filter(Boolean).forEach(mergeReading);
  charts.updateMain(state.readings);
  renderHistorySelection();
}

async function pollLive() {
  try {
    acceptReading(toReading(await fetchJson("/live")));
  } catch (error) {
    console.error("Live Firebase poll failed", error);
    updateFreshness(state.latest, config.offlineAfterSeconds);
  }
}

function startPolling() {
  if (pollTimer || !DB) return;
  pollLive();
  pollTimer = window.setInterval(pollLive, Math.max(2, config.refreshSeconds) * 1000);
}

function stopPolling() {
  if (!pollTimer) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

function startStream() {
  startPolling();
  if (!window.EventSource || !DB) return;
  eventStream = new EventSource(`${DB}/live.json`);
  let liveNode = {};

  const apply = (event) => {
    let payload;
    try { payload = JSON.parse(event.data); }
    catch { return; }
    if (!payload || payload.data === null || payload.data === undefined) return;
    if (payload.path === "/") {
      liveNode = event.type === "put" ? payload.data : { ...liveNode, ...payload.data };
    } else {
      liveNode = { ...liveNode, [payload.path.replace(/^\//, "")]: payload.data };
    }
    acceptReading(toReading(liveNode));
  };

  eventStream.addEventListener("put", apply);
  eventStream.addEventListener("patch", apply);
  eventStream.addEventListener("open", stopPolling);
  eventStream.addEventListener("error", startPolling);
}

function bindRangeControls() {
  $("range-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range]:not(:disabled)");
    if (!button) return;
    $("range-tabs").querySelectorAll("button").forEach((item) => item.classList.toggle("is-active", item === button));
    charts.setRange(button.dataset.range, state.readings);
  });
}

function moveSelectedDate(days) {
  const date = new Date(`${state.selectedDate}T12:00:00`);
  date.setDate(date.getDate() + days);
  state.selectedDate = dateKey(date);
  $("history-date").value = state.selectedDate;
  renderHistorySelection();
}

function bindHistoryControls() {
  $("history-date").addEventListener("change", (event) => {
    state.selectedDate = event.target.value || dateKey(new Date());
    renderHistorySelection();
  });
  $("previous-day").addEventListener("click", () => moveSelectedDate(-1));
  $("next-day").addEventListener("click", () => moveSelectedDate(1));
  $("graph-tab").addEventListener("click", () => { setHistoryView("graph"); charts.resizeHistory(); });
  $("table-tab").addEventListener("click", () => setHistoryView("table"));
}

function bindPageControls() {
  $("settings-button").addEventListener("click", () => $("settings-dialog").showModal());
  document.querySelectorAll(".nav__link").forEach((link) => link.addEventListener("click", () => {
    document.querySelectorAll(".nav__link").forEach((item) => item.classList.toggle("is-active", item === link));
  }));
  bindRangeControls();
  bindHistoryControls();
}

async function initialiseRadar() {
  if (!window.L) {
    $("radar-time").textContent = "Map unavailable";
    return;
  }
  const map = window.L.map("radar-map", { zoomControl: true }).setView(
    [config.latitude, config.longitude], config.mapZoom);
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap"
  }).addTo(map);
  window.L.circleMarker([config.latitude, config.longitude], {
    radius: 7, color: "#fff", weight: 2, fillColor: "#0879b9", fillOpacity: 1
  }).addTo(map).bindTooltip(config.stationName || config.siteName);

  try {
    const response = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    const data = await response.json();
    const frame = data.radar?.past?.at(-1);
    if (!frame) throw new Error("No radar frame");
    window.L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: .62, maxNativeZoom: 7, maxZoom: 19, attribution: "Radar © RainViewer"
    }).addTo(map);
    $("radar-time").textContent = new Date(frame.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (error) {
    $("radar-time").textContent = "Radar unavailable";
    console.error("Radar failed", error);
  }
}

function initialise() {
  configureStation(config);
  charts = createCharts($("wind-chart"), $("history-chart"));
  bindPageControls();
  renderHistorySelection();
  window.setInterval(() => updateFreshness(state.latest, config.offlineAfterSeconds), 1000);

  if (DB) {
    loadStoredHistory().catch((error) => console.error("History load failed", error));
    startStream();
  } else {
    updateFreshness(null, config.offlineAfterSeconds);
    console.error("firebaseDatabaseUrl is not configured");
  }
  initialiseRadar();
}

initialise();
