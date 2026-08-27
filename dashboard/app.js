import {
  $, configureStation, dateKey, metresPerSecond, readingsForToday,
  renderHistory, renderReading, setHistoryView, summarise, updateFreshness
} from "./ui.js?v=wind-station-3";
import { createCharts } from "./charts.js?v=wind-station-3";

const config = window.WIND_DASHBOARD_CONFIG;
const DB = config.firebaseDatabaseUrl?.replace(/\/+$/, "") || null;
const state = { readings: [], latest: null, selectedDate: dateKey(new Date()) };
const MAX_LOCAL_POINTS = 2200;
let charts;
let pollTimer = null;
let eventStream = null;
let adminSession = null;
let pendingAdminAction = null;

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

function visibleReadings() {
  return state.readings;
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

function adminSessionIsValid() {
  return adminSession && Date.now() < adminSession.expiresAt;
}

function updateAdminControls() {
  const signedIn = adminSessionIsValid();
  $("admin-login-button").hidden = signedIn;
  $("admin-signout-button").hidden = !signedIn;
  $("admin-session-label").textContent = signedIn
    ? `Administrator: ${adminSession.email}` : "Administrator signed out";
}

function signOutAdmin(message = "Administrator signed out.") {
  adminSession = null;
  pendingAdminAction = null;
  $("admin-password").value = "";
  updateAdminControls();
  setActionStatus(message);
}

function openAdminLogin(action = null) {
  if (!adminSessionIsValid()) {
    adminSession = null;
    updateAdminControls();
  }
  pendingAdminAction = action;
  $("admin-error").textContent = "";
  $("admin-api-key").value = config.firebaseWebApiKey || "";
  $("admin-dialog").showModal();
}

function friendlyAuthError(code) {
  const messages = {
    INVALID_LOGIN_CREDENTIALS: "The email or password is incorrect.",
    EMAIL_NOT_FOUND: "No Firebase user exists for that email.",
    INVALID_PASSWORD: "The password is incorrect.",
    USER_DISABLED: "This Firebase user has been disabled.",
    INVALID_EMAIL: "Enter a valid email address.",
    OPERATION_NOT_ALLOWED: "Enable Email/Password sign-in in Firebase Authentication."
  };
  if (code?.includes("API key not valid")) return "The Firebase Web API key is not valid.";
  return messages[code] || `Firebase sign-in failed (${code || "unknown error"}).`;
}

async function signInAdmin(event) {
  event.preventDefault();
  const apiKey = $("admin-api-key").value.trim();
  const email = $("admin-email").value.trim();
  const password = $("admin-password").value;
  const error = $("admin-error");
  error.textContent = "";
  if (!apiKey || !email || !password) {
    error.textContent = "Enter the API key, administrator email, and password.";
    return;
  }

  $("admin-submit").disabled = true;
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );
    const result = await response.json();
    if (!response.ok || !result.idToken) {
      throw new Error(friendlyAuthError(result.error?.message));
    }

    adminSession = {
      email: result.email || email,
      idToken: result.idToken,
      uid: result.localId,
      expiresAt: Date.now() + Math.max(60, Number(result.expiresIn) || 3600) * 1000 - 60000
    };
    $("admin-password").value = "";
    $("admin-api-key").value = "";
    $("admin-dialog").close();
    updateAdminControls();
    setActionStatus(`Administrator ${adminSession.email} signed in.`);

    const action = pendingAdminAction;
    pendingAdminAction = null;
    if (action === "clearToday") await deleteTodayFromFirebase();
  } catch (signInError) {
    error.textContent = signInError.message;
  } finally {
    $("admin-submit").disabled = false;
  }
}

async function authenticatedHistoryPatch(patch) {
  if (!adminSessionIsValid()) throw new Error("The administrator session expired. Sign in again.");
  const response = await fetch(
    `${DB}/history.json?auth=${encodeURIComponent(adminSession.idToken)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }
  );
  if (response.status === 401 || response.status === 403) {
    signOutAdmin("Administrator permission was rejected by Firebase.");
    throw new Error("This account is not permitted to delete history. Check its UID in the database rules.");
  }
  if (!response.ok) throw new Error(`Firebase deletion failed (HTTP ${response.status}).`);
}

async function deleteTodayFromFirebase() {
  if (!adminSessionIsValid()) {
    openAdminLogin("clearToday");
    return;
  }

  const today = dateKey(new Date());
  $("clear-today-button").disabled = true;
  try {
    const history = await fetchJson("/history");
    const matching = Object.entries(history || {}).filter(([, node]) =>
      Number.isFinite(node?.ts) && dateKey(new Date(node.ts)) === today);
    if (!matching.length) {
      setActionStatus("No stored readings are available to delete for today.");
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to permanently delete ${matching.length} stored readings for ${today}?\n\n` +
      "This deletes them from Firebase and cannot be undone. The live sensor reading will continue."
    );
    if (!confirmed) return;

    setActionStatus("Deleting today's Firebase history...");
    const removals = Object.fromEntries(matching.map(([slot]) => [slot, null]));
    await authenticatedHistoryPatch(removals);
    state.readings = state.readings.filter((point) => dateKey(point.time) !== today);
    state.selectedDate = today;
    $("history-date").value = today;
    if (state.latest) renderReading(state.latest, null);
    charts.updateMain(state.readings);
    renderHistorySelection();
    setActionStatus(`Deleted ${matching.length} Firebase readings for ${today}.`);
  } catch (error) {
    setActionStatus(error.message, true);
  } finally {
    $("clear-today-button").disabled = false;
  }
}

function requestClearToday() {
  if (adminSessionIsValid()) deleteTodayFromFirebase();
  else openAdminLogin("clearToday");
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
  $("clear-today-button").addEventListener("click", requestClearToday);
  $("export-button").addEventListener("click", openExportDialog);
  $("export-form").addEventListener("submit", exportDateRange);
  $("admin-login-button").addEventListener("click", () => openAdminLogin());
  $("admin-signout-button").addEventListener("click", () => signOutAdmin());
  $("admin-form").addEventListener("submit", signInAdmin);
  $("admin-cancel").addEventListener("click", () => {
    pendingAdminAction = null;
    $("admin-dialog").close();
  });
  $("admin-dialog").addEventListener("close", () => {
    $("admin-password").value = "";
    if (!adminSessionIsValid()) pendingAdminAction = null;
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
