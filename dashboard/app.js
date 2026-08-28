import {
  $, configureStation, dateKey, metresPerSecond, readingsForToday,
  renderHistory, renderReading, setHistoryView, summarise, updateFreshness
} from "./ui.js?v=wind-station-9";
import { createCharts } from "./charts.js?v=wind-station-9";

const config = window.WIND_DASHBOARD_CONFIG;
const DB = config.firebaseDatabaseUrl?.replace(/\/+$/, "") || null;
// --- Operator access -------------------------------------------------------
// This page is public and static, so it can hold no secret of its own: whatever
// ships here is readable by anyone who views source. The security boundary is
// Firebase instead. The operator signs in to a Firebase Auth account, and
// firebase/database.rules.json grants that account's UID exactly one power -
// deleting /history, and only deleting it. The ID token that comes back is held
// in memory for this page session only: never stored, never reused elsewhere.
const AUTH_ENDPOINT =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const operatorConfigured = Boolean(config.firebaseWebApiKey && DB);

// Firebase answers a failed sign-in with a machine-readable reason. Mapping the
// ones an operator can actually act on beats showing them a raw error code.
const SIGN_IN_MESSAGES = {
  INVALID_LOGIN_CREDENTIALS: "Incorrect email or password.",
  INVALID_PASSWORD: "Incorrect email or password.",
  EMAIL_NOT_FOUND: "Incorrect email or password.",
  INVALID_EMAIL: "That is not a valid email address.",
  MISSING_PASSWORD: "Enter the operator password.",
  USER_DISABLED: "That account is disabled in the Firebase console.",
  OPERATION_NOT_ALLOWED:
    "Email/password sign-in is not enabled on this Firebase project.",
  TOO_MANY_ATTEMPTS_TRY_LATER:
    "Firebase has paused sign-in for this account after repeated failures. Try again shortly."
};

const state = {
  readings: [],
  latest: null,
  selectedDate: dateKey(new Date())
};
const MAX_LOCAL_POINTS = 2200;
// The board's history ring restarts at slot 0 after a reboot, so slots it has
// not come back round to still hold readings from a previous run. Anything
// older than the span the ring is meant to cover is dropped instead of being
// charted and counted in today's statistics as though it had just arrived.
const HISTORY_RETENTION_MS = 60 * 60 * 1000;
let charts;
let pollTimer = null;
let eventStream = null;
let operatorToken = null;
let operatorEmail = "";

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
  const visible = state.readings;
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
  const points = Object.values(slots).map(historyReading).filter(Boolean);
  const newest = points.reduce(
    (highest, point) => Math.max(highest, point.time.getTime()), 0);
  points
    .filter((point) => newest - point.time.getTime() <= HISTORY_RETENTION_MS)
    .forEach(mergeReading);
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

function setActionStatus(message, isError = false) {
  const status = $("history-action-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function signedIn() {
  return Boolean(operatorToken);
}

function updateAdminControls() {
  const unlocked = signedIn();
  $("admin-login-button").hidden = unlocked;
  $("admin-login-button").disabled = !operatorConfigured;
  $("admin-signout-button").hidden = !unlocked;
  $("clear-history-button").hidden = !unlocked;
  $("admin-session-label").textContent = !operatorConfigured
    ? "Operator controls are not configured for this deployment."
    : unlocked
      ? `Signed in as ${operatorEmail} for this page session.`
      : "Operator controls locked.";
}

function lockAdminControls(message = "Operator controls locked.") {
  operatorToken = null;
  operatorEmail = "";
  $("admin-password").value = "";
  updateAdminControls();
  setActionStatus(message);
}

// Turns Firebase's error into something an operator can act on. The codes come
// back as "CODE : human sentence", so only the leading code is looked up.
function signInMessage(raw) {
  const code = String(raw).trim().split(/[\s:]+/)[0];
  return SIGN_IN_MESSAGES[code] || `Sign-in failed (${code}).`;
}

async function requestIdToken(email, password) {
  const response = await fetch(
    `${AUTH_ENDPOINT}?key=${encodeURIComponent(config.firebaseWebApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.idToken) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.idToken;
}

function openAdminLogin() {
  if (!operatorConfigured) {
    setActionStatus(
      "Operator controls need firebaseWebApiKey in dashboard/config.js.", true);
    return;
  }
  $("admin-error").textContent = "";
  $("admin-email").value = operatorEmail || config.operatorEmail || "";
  $("admin-password").value = "";
  $("admin-dialog").showModal();
  ($("admin-email").value ? $("admin-password") : $("admin-email")).focus();
}

async function unlockAdminControls(event) {
  event.preventDefault();
  if (!operatorConfigured) return;

  const email = $("admin-email").value.trim();
  const password = $("admin-password").value;
  const error = $("admin-error");
  if (!email || !password) {
    error.textContent = "Enter the operator email and password.";
    return;
  }

  const submit = $("admin-submit");
  submit.disabled = true;
  error.textContent = "Checking with Firebase...";
  try {
    operatorToken = await requestIdToken(email, password);
    operatorEmail = email;
    $("admin-password").value = "";
    error.textContent = "";
    $("admin-dialog").close();
    setActionStatus(`Operator controls unlocked for this page session (${email}).`);
  } catch (failure) {
    operatorToken = null;
    operatorEmail = "";
    $("admin-password").value = "";
    error.textContent = signInMessage(failure.message);
  } finally {
    submit.disabled = false;
    updateAdminControls();
  }
}

// Deletes the stored ring outright. The database rules let this account write
// nothing but null at /history, so a signed-in operator can reset the record and
// still cannot forge a reading.
async function clearRecordedHistory() {
  if (!signedIn()) return;
  const confirmed = window.confirm(
    "Delete the recorded wind history from Firebase?\n\n" +
    "Every retained reading is removed for everyone viewing this dashboard, not " +
    "just this browser, and the CSV export restarts from the next reading.\n\n" +
    "This cannot be undone."
  );
  if (!confirmed) return;

  const button = $("clear-history-button");
  button.disabled = true;
  setActionStatus("Deleting the recorded history...");
  try {
    const response = await fetch(
      `${DB}/history.json?auth=${encodeURIComponent(operatorToken)}`,
      { method: "DELETE" });

    if (!response.ok) {
      // The database answers 401 both for a token that has aged out and for a
      // rules refusal, so the body is what tells the two apart. They need
      // different things from the operator, hence two messages.
      const detail = await response.json().catch(() => null);
      const reason = String(detail?.error || `HTTP ${response.status}`);
      if (/permission denied/i.test(reason)) {
        throw new Error("Firebase refused the deletion. This account's UID is not "
          + "the OPERATOR_UID in firebase/database.rules.json.");
      }
      if (/expire|invalid|unauthor/i.test(reason)) {
        lockAdminControls();
        throw new Error("That sign-in has expired. Unlock the controls again.");
      }
      throw new Error(`Firebase refused the deletion (${reason}).`);
    }

    // The stored ring is gone, so drop what this page loaded from it. The newest
    // live reading is kept so the tiles and gauge do not blank out; the charts,
    // statistics and CSV all now start from this moment.
    state.readings = state.latest ? [state.latest] : [];
    state.selectedDate = dateKey(new Date());
    $("history-date").value = state.selectedDate;
    if (state.latest) {
      renderReading(state.latest, summarise(readingsForToday(state.readings)));
    }
    charts.updateMain(state.readings);
    renderHistorySelection();
    setActionStatus(`Recorded history deleted at ${new Date().toLocaleTimeString()}. `
      + "Recording restarts from the next reading.");
  } catch (failure) {
    setActionStatus(failure.message, true);
  } finally {
    button.disabled = false;
  }
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
  const available = state.readings;
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

  const points = state.readings.filter((point) => {
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
  $("clear-history-button").addEventListener("click", clearRecordedHistory);
  $("export-button").addEventListener("click", openExportDialog);
  $("export-form").addEventListener("submit", exportDateRange);
  $("export-cancel").addEventListener("click", () => $("export-dialog").close());
  $("admin-login-button").addEventListener("click", () => openAdminLogin());
  $("admin-signout-button").addEventListener("click", () => lockAdminControls());
  $("admin-form").addEventListener("submit", unlockAdminControls);
  $("admin-cancel").addEventListener("click", () => {
    $("admin-dialog").close();
  });
  $("admin-dialog").addEventListener("close", () => {
    $("admin-password").value = "";
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
