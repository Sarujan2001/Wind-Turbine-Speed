import {
  $, configureStation, dateKey, metresPerSecond, readingsForToday,
  renderHistory, renderReading, setHistoryView, summarise, updateFreshness
} from "./ui.js?v=wind-station-6";
import { createCharts } from "./charts.js?v=wind-station-6";

const config = window.WIND_DASHBOARD_CONFIG;
const DB = config.firebaseDatabaseUrl?.replace(/\/+$/, "") || null;
const RESET_STORAGE_KEY = `wind-dashboard:${config.stationId || "station"}:day-reset`;
const PIN_SECURITY_KEY = `wind-dashboard:${config.stationId || "station"}:pin-security`;
const PIN_SIGNATURE = 537185439;
const MAX_PIN_ATTEMPTS = 3;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;
const state = {
  readings: [],
  latest: null,
  selectedDate: dateKey(new Date()),
  dayReset: loadDayReset()
};
const MAX_LOCAL_POINTS = 2200;
let charts;
let pollTimer = null;
let eventStream = null;
let adminUnlocked = false;

function number(value, fallback = NaN) {
  return Number.isFinite(value) ? value : fallback;
}

function loadDayReset() {
  try {
    const reset = JSON.parse(window.localStorage.getItem(RESET_STORAGE_KEY));
    if (reset?.date === dateKey(new Date()) && Number.isFinite(reset.after)) return reset;
  } catch (error) {
    console.warn("Could not load the dashboard reset time", error);
  }
  return null;
}

function saveDayReset(reset) {
  try {
    window.localStorage.setItem(RESET_STORAGE_KEY, JSON.stringify(reset));
  } catch (error) {
    console.warn("Could not save the dashboard reset time", error);
  }
}

function loadPinSecurity() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PIN_SECURITY_KEY));
    return {
      attempts: Math.max(0, Number(saved?.attempts) || 0),
      lockedUntil: Math.max(0, Number(saved?.lockedUntil) || 0)
    };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

function savePinSecurity(security) {
  try {
    window.localStorage.setItem(PIN_SECURITY_KEY, JSON.stringify(security));
  } catch (error) {
    console.warn("Could not save PIN attempt state", error);
  }
}

function pinSignature(pin) {
  let signature = 17;
  for (const digit of pin) signature = (signature * 31 + digit.charCodeAt(0)) >>> 0;
  return signature;
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

function visibleReadings() {
  return state.readings.filter((point) => !state.dayReset ||
    dateKey(point.time) !== state.dayReset.date ||
    point.time.getTime() >= state.dayReset.after);
}

function selectedHistory() {
  return visibleReadings().filter((point) => dateKey(point.time) === state.selectedDate);
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
  const visible = visibleReadings();
  const today = readingsForToday(visible);
  renderReading(reading, summarise(today));
  updateFreshness(reading, config.offlineAfterSeconds);
  charts.updateMain(visible);
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
  charts.updateMain(visibleReadings());
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
    charts.setRange(button.dataset.range, visibleReadings());
  });
}

function setActionStatus(message, isError = false) {
  const status = $("history-action-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function updateAdminControls() {
  $("admin-login-button").hidden = adminUnlocked;
  $("admin-signout-button").hidden = !adminUnlocked;
  $("clear-today-button").hidden = !adminUnlocked;
  $("admin-session-label").textContent = adminUnlocked
    ? "Dashboard controls unlocked" : "Dashboard controls locked";
}

function lockAdminControls(message = "Dashboard controls locked.") {
  adminUnlocked = false;
  $("admin-pin").value = "";
  updateAdminControls();
  setActionStatus(message);
}

function lockoutRemaining(security, now = Date.now()) {
  return Math.max(0, security.lockedUntil - now);
}

function updatePinDialog() {
  const security = loadPinSecurity();
  const remaining = lockoutRemaining(security);
  const submit = $("admin-submit");
  if (remaining > 0) {
    const minutes = Math.ceil(remaining / 60000);
    $("admin-error").textContent = `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    $("pin-attempts").textContent = "PIN entry is temporarily locked on this browser.";
    submit.disabled = true;
    return false;
  }

  if (security.lockedUntil) savePinSecurity({ attempts: 0, lockedUntil: 0 });
  const attempts = security.lockedUntil ? 0 : security.attempts;
  $("pin-attempts").textContent = `${MAX_PIN_ATTEMPTS - attempts} attempts remaining.`;
  submit.disabled = false;
  return true;
}

function openAdminLogin() {
  $("admin-error").textContent = "";
  $("admin-pin").value = "";
  updatePinDialog();
  $("admin-dialog").showModal();
  $("admin-pin").focus();
}

function unlockAdminControls(event) {
  event.preventDefault();
  if (!updatePinDialog()) return;

  const pin = $("admin-pin").value.trim();
  if (!/^\d{5}$/.test(pin)) {
    $("admin-error").textContent = "Enter the five-digit PIN.";
    return;
  }

  if (pinSignature(pin) === PIN_SIGNATURE) {
    adminUnlocked = true;
    savePinSecurity({ attempts: 0, lockedUntil: 0 });
    $("admin-pin").value = "";
    $("admin-dialog").close();
    updateAdminControls();
    setActionStatus("Dashboard controls unlocked for this browser session.");
    return;
  }

  const security = loadPinSecurity();
  const attempts = security.attempts + 1;
  $("admin-pin").value = "";
  if (attempts >= MAX_PIN_ATTEMPTS) {
    savePinSecurity({ attempts: 0, lockedUntil: Date.now() + PIN_LOCKOUT_MS });
    updatePinDialog();
  } else {
    savePinSecurity({ attempts, lockedUntil: 0 });
    $("admin-error").textContent = "Incorrect PIN.";
    $("pin-attempts").textContent = `${MAX_PIN_ATTEMPTS - attempts} attempts remaining.`;
  }
}

function clearToday() {
  if (!adminUnlocked) return;
  const confirmed = window.confirm(
    "Are you sure you want to clear today's dashboard results?\n\n" +
    "This resets only this browser's charts and statistics. Firebase records will not be deleted."
  );
  if (!confirmed) return;

  const now = Date.now();
  state.dayReset = { date: dateKey(new Date(now)), after: now };
  saveDayReset(state.dayReset);
  state.selectedDate = state.dayReset.date;
  $("history-date").value = state.selectedDate;
  const visible = visibleReadings();
  if (state.latest) renderReading(state.latest, summarise(readingsForToday(visible)));
  charts.updateMain(visible);
  renderHistorySelection();
  setActionStatus(`Dashboard results restarted at ${new Date(now).toLocaleTimeString()}. Firebase was not changed.`);
}

function csvCell(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadCsv(points, from, to) {
  const headings = [
    "timestamp_iso", "local_date", "local_time", "wind_ms", "wind_kmh",
    "gust_ms", "gust_kmh", "sensor_voltage", "adc_voltage", "adc_raw", "station_mode"
  ];
  const rows = points.map((point) => [
    point.time.toISOString(), dateKey(point.time), point.time.toLocaleTimeString(),
    point.ms, point.kmh, point.gustMs, point.gustKmh, point.sensor,
    point.adc, point.raw, point.mode
  ].map(csvCell).join(","));
  const csv = [headings.join(","), ...rows].join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `wind-history-${from}-to-${to}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openExportDialog() {
  const available = visibleReadings();
  const firstDate = available.length ? dateKey(available[0].time) : dateKey(new Date());
  const lastDate = available.length ? dateKey(available.at(-1).time) : dateKey(new Date());
  $("export-from").value = firstDate;
  $("export-to").value = lastDate;
  $("export-from").max = dateKey(new Date());
  $("export-to").max = dateKey(new Date());
  $("export-error").textContent = "";
  $("export-dialog").showModal();
}

function exportDateRange(event) {
  event.preventDefault();
  const from = $("export-from").value;
  const to = $("export-to").value;
  const error = $("export-error");
  if (!from || !to || from > to) {
    error.textContent = "Choose a valid start and end date.";
    return;
  }

  const points = visibleReadings().filter((point) => {
    const key = dateKey(point.time);
    return key >= from && key <= to;
  });
  if (!points.length) {
    error.textContent = "No retained readings are available in that date range.";
    return;
  }

  downloadCsv(points, from, to);
  $("export-dialog").close();
  setActionStatus(`Exported ${points.length} readings from ${from} to ${to}.`);
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
  $("clear-today-button").addEventListener("click", clearToday);
  $("export-button").addEventListener("click", openExportDialog);
  $("export-form").addEventListener("submit", exportDateRange);
  $("admin-login-button").addEventListener("click", () => openAdminLogin());
  $("admin-signout-button").addEventListener("click", () => lockAdminControls());
  $("admin-form").addEventListener("submit", unlockAdminControls);
  $("admin-cancel").addEventListener("click", () => {
    $("admin-dialog").close();
  });
  $("admin-dialog").addEventListener("close", () => {
    $("admin-pin").value = "";
  });
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
  updateAdminControls();
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
