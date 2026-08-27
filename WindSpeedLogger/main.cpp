#include <Arduino.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WiFi.h>

#include "cloud_config.h"
#include "web_page.h"
#include "wifi_config.h"

#if CLOUD_CONFIGURED
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#endif

#if WIFI_JOIN_NETWORK || CLOUD_CONFIGURED
#include "secrets.h"
#endif

// SPL Wind Speed Logger
// Seeed Studio XIAO ESP32-C3
// SEN0170 signal -> 20k/10k divider -> D1 / GPIO3 / ADC1_CH3
//
// Serves its own dashboard over Wi-Fi. Serial output is retained, so the USB
// bench monitor still works at the same time.

constexpr uint8_t WIND_ADC_PIN = D1;  // D1 is GPIO3 (analog-capable)
constexpr float DIVIDER_MULTIPLIER = 3.0f;
constexpr float METRES_PER_SECOND_PER_SENSOR_VOLT = 6.0f;
constexpr float MAX_SENSOR_VOLTAGE = 5.0f;
constexpr float WIND_ZERO_DEADBAND_MS = 0.15f;

// The ADC is sampled little and often rather than in one blocking burst, so
// HTTP requests are never left waiting. Roughly 50 samples land in each publish
// window, which matches the averaging the previous blocking version did.
constexpr uint32_t SAMPLE_INTERVAL_MS = 2;
constexpr uint32_t PUBLISH_INTERVAL_MS = 100;

// The trace and the gust window are declared as durations and turned into
// sample counts here, so changing the publish rate above cannot quietly shorten
// either of them - which is what happened when the rate moved to 100 ms with
// the counts left at the values chosen for 500 ms.
constexpr uint32_t HISTORY_SPAN_MS = 60000;  // one minute of trace
constexpr uint32_t GUST_SPAN_MS = 3000;      // three-second gust, as labelled
constexpr uint16_t HISTORY_LEN = HISTORY_SPAN_MS / PUBLISH_INTERVAL_MS;
constexpr uint16_t GUST_SPAN = GUST_SPAN_MS / PUBLISH_INTERVAL_MS;

WebServer server(80);

struct Reading {
  float raw = 0;
  float adc = 0;
  float sensor = 0;
  float ms = 0;
  float kmh = 0;
};

Reading current;
float gustKmh = 0;

float historyKmh[HISTORY_LEN];
float historySensor[HISTORY_LEN];
uint16_t historyCount = 0;
uint16_t historyHead = 0;

uint32_t accumulatedRaw = 0;
uint32_t accumulatedMillivolts = 0;
uint32_t accumulatedSamples = 0;

uint32_t lastSampleAt = 0;
uint32_t lastPublishAt = 0;

String networkMode = "hotspot";
String networkAddress = "192.168.4.1";

// ---------------------------------------------------------------------------
// Rolling history
// ---------------------------------------------------------------------------

void pushHistory(float kmh, float sensor) {
  historyKmh[historyHead] = kmh;
  historySensor[historyHead] = sensor;
  historyHead = (historyHead + 1) % HISTORY_LEN;
  if (historyCount < HISTORY_LEN) historyCount++;
}

float computeGust() {
  const uint16_t span = historyCount < GUST_SPAN ? historyCount : GUST_SPAN;
  float peak = 0;
  for (uint16_t i = 1; i <= span; ++i) {
    const uint16_t index = (historyHead + HISTORY_LEN - i) % HISTORY_LEN;
    if (historyKmh[index] > peak) peak = historyKmh[index];
  }
  return peak;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

void handleRoot() {
  server.send_P(200, "text/html", DASHBOARD_HTML);
}

void handleLive() {
  String json = "{";
  json += "\"raw\":" + String(current.raw, 0);
  json += ",\"adc\":" + String(current.adc, 4);
  json += ",\"sensor\":" + String(current.sensor, 4);
  json += ",\"ms\":" + String(current.ms, 3);
  json += ",\"kmh\":" + String(current.kmh, 2);
  json += ",\"gust\":" + String(gustKmh, 2);
  json += ",\"up\":" + String(millis());
  json += ",\"period\":" + String(PUBLISH_INTERVAL_MS);
  json += ",\"mode\":\"" + networkMode + "\"";
  json += ",\"ip\":\"" + networkAddress + "\"";
  json += "}";

  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

void handleHistory() {
  // One minute is HISTORY_LEN points per array, so the buffers are sized once
  // here rather than grown a few bytes at a time while a client waits.
  String speeds = "[";
  String sensors = "[";
  speeds.reserve(HISTORY_LEN * 8 + 2);
  sensors.reserve(HISTORY_LEN * 8 + 2);

  for (uint16_t i = 0; i < historyCount; ++i) {
    const uint16_t index =
        (historyHead + HISTORY_LEN - historyCount + i) % HISTORY_LEN;
    if (i) {
      speeds += ",";
      sensors += ",";
    }
    speeds += String(historyKmh[index], 2);
    sensors += String(historySensor[index], 4);
  }

  speeds += "]";
  sensors += "]";

  String json;
  json.reserve(speeds.length() + sensors.length() + 48);
  json = "{\"period\":" + String(PUBLISH_INTERVAL_MS);
  json += ",\"kmh\":" + speeds;
  json += ",\"sensor\":" + sensors + "}";

  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

void startHotspot() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);

  networkMode = "hotspot";
  networkAddress = WiFi.softAPIP().toString();

  Serial.println();
  Serial.println("Wi-Fi hotspot started.");
  Serial.println("  Network:  " AP_SSID);
  Serial.println("  Password: " AP_PASSWORD);
  Serial.print("  Dashboard: http://");
  Serial.println(networkAddress);
}

bool joinExistingNetwork() {
#if WIFI_JOIN_NETWORK
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Joining ");
  Serial.print(WIFI_SSID);

  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - startedAt < WIFI_JOIN_TIMEOUT_MS) {
    delay(400);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    networkMode = "on your network";
    networkAddress = WiFi.localIP().toString();
    Serial.print("Connected. Dashboard: http://");
    Serial.println(networkAddress);
    return true;
  }

  Serial.println("Could not join that network; starting own hotspot instead.");
#endif
  return false;
}

// ---------------------------------------------------------------------------
// Firebase Realtime Database upload
// (needs WIFI_JOIN_NETWORK = 1 - there is no internet in hotspot mode)
//
// Two REST calls are involved:
//
//   1. Sign in with the board's own Firebase Auth account, which returns an ID
//      token lasting an hour. The database rules accept writes only from that
//      account's UID, so the token is what keeps everyone else out of the feed.
//   2. PUT the latest reading to /live, and every CLOUD_HISTORY_INTERVAL_MS
//      also PUT one slot of the /history ring.
//
// The TLS session to the database is held open between writes, so only the
// first write after a reconnect pays the ~1-2 s handshake. Firebase stamps the
// readings itself (".sv": "timestamp"), which saves fetching the time over NTP
// and keeps every point on one clock.
// ---------------------------------------------------------------------------

#if CLOUD_CONFIGURED

WiFiClientSecure cloudTls;
HTTPClient cloudHttp;

String idToken;
String refreshToken;
uint32_t tokenObtainedAt = 0;
uint32_t tokenLifetimeMs = 0;
uint32_t lastAuthAttempt = 0;
bool authAttempted = false;

// A failed sign-in must not be retried at the 2 s live-upload rate. Apart from
// wasting bandwidth, repeated password verification can trigger Firebase Auth
// abuse protection or exhaust the project's verification quota.
constexpr uint32_t CLOUD_AUTH_RETRY_MS = 15UL * 60UL * 1000UL;

// Exchanging a refresh token is neither abuse-protected nor quota-limited, so a
// failed renewal only needs enough of a pause to stay off the upload rate.
constexpr uint32_t CLOUD_REFRESH_RETRY_MS = 60UL * 1000UL;

uint32_t lastLivePush = 0;
uint32_t lastHistoryPush = 0;
uint32_t historyWrites = 0;
float windowPeakKmh = 0;  // highest reading since the last history slot

// Pulls one string field out of a JSON response. The token endpoints answer
// with a handful of flat string fields, which is not worth a parser library.
String jsonField(const String &body, const char *key) {
  const String needle = String("\"") + key + "\"";
  const int at = body.indexOf(needle);
  if (at < 0) return String();

  const int colon = body.indexOf(':', at + needle.length());
  if (colon < 0) return String();

  int value = colon + 1;
  while (value < static_cast<int>(body.length()) &&
         (body[value] == ' ' || body[value] == '\t' || body[value] == '\r' ||
          body[value] == '\n')) {
    value++;
  }
  if (value >= static_cast<int>(body.length()) || body[value] != '"') {
    return String();
  }

  const int from = value + 1;
  const int to = body.indexOf('"', from);
  if (to < 0) return String();
  return body.substring(from, to);
}

// Both endpoints return the same three fields, under camelCase names when
// signing in and snake_case names when refreshing.
bool storeTokens(const String &body, bool snakeCase) {
  const String id = jsonField(body, snakeCase ? "id_token" : "idToken");
  const String refresh =
      jsonField(body, snakeCase ? "refresh_token" : "refreshToken");
  const String expires = jsonField(body, snakeCase ? "expires_in" : "expiresIn");
  if (id.isEmpty() || refresh.isEmpty()) return false;

  idToken = id;
  refreshToken = refresh;
  tokenObtainedAt = millis();

  const long seconds = expires.toInt();
  const uint32_t lifetime =
      seconds > 0 ? static_cast<uint32_t>(seconds) * 1000 : 3600000;
  tokenLifetimeMs = lifetime > CLOUD_TOKEN_MARGIN_MS
                        ? lifetime - CLOUD_TOKEN_MARGIN_MS
                        : lifetime / 2;
  return true;
}

// Calls a Google identity endpoint. The database's TLS session is dropped
// first, so only one is ever allocated at a time - two would be tight on RAM.
bool requestTokens(const String &url, const char *contentType,
                   const String &body, bool snakeCase) {
  // Stamped for every kind of token request, not just sign-in, so haveToken()
  // can hold off a failing renewal as well as a failing password check.
  authAttempted = true;
  lastAuthAttempt = millis();

  cloudHttp.end();
  cloudTls.stop();

  WiFiClientSecure tls;
  tls.setInsecure();
  HTTPClient http;
  if (!http.begin(tls, url)) {
    Serial.println("CLOUD auth transport setup failed.");
    return false;
  }
  http.addHeader("Content-Type", contentType);

  const int code = http.POST(body);
  const String response = code > 0 ? http.getString() : String();
  http.end();

  if (code != 200) {
    Serial.print("CLOUD auth failed: HTTP ");
    Serial.println(code);

    Serial.println("----- FIREBASE ERROR -----");
    Serial.println(response);
    Serial.println("--------------------------");

    return false;
  }

  if (!storeTokens(response, snakeCase)) {
    // Do not print an HTTP 200 body here: it may contain valid ID and refresh
    // tokens. This message distinguishes parsing from a Firebase auth error.
    Serial.println("CLOUD auth response received, but tokens could not be parsed.");
    return false;
  }
  return true;
}

bool signIn() {
  const String body = String("{\"email\":\"") + FIREBASE_DEVICE_EMAIL +
                      "\",\"password\":\"" + FIREBASE_DEVICE_PASSWORD +
                      "\",\"returnSecureToken\":true}";
  const bool ok = requestTokens(
      String("https://identitytoolkit.googleapis.com/v1/accounts:"
             "signInWithPassword?key=") +
          FIREBASE_WEB_API_KEY,
      "application/json", body, false);

  if (ok) {
    Serial.println("CLOUD signed in.");
  } else {
    Serial.println("CLOUD sign-in failed - check the Firebase error above.");
    Serial.println("CLOUD auth retry paused for 15 minutes.");
  }
  return ok;
}

bool renewToken() {
  if (refreshToken.isEmpty()) return signIn();

  const String body = "grant_type=refresh_token&refresh_token=" + refreshToken;
  if (requestTokens(String("https://securetoken.googleapis.com/v1/token?key=") +
                        FIREBASE_WEB_API_KEY,
                    "application/x-www-form-urlencoded", body, true)) {
    return true;
  }

  refreshToken = "";  // refresh token itself is bad; start over
  return signIn();
}

bool haveToken() {
  const uint32_t now = millis();

  // An expired token is no better than none, and clearing it here is what keeps
  // the backoff below in charge. Left in place, it sent every publish straight
  // back into renewToken() at the upload rate as soon as renewal started
  // failing, which is the retry storm the backoff exists to prevent.
  if (!idToken.isEmpty() && now - tokenObtainedAt >= tokenLifetimeMs) {
    idToken = "";
  }
  if (!idToken.isEmpty()) return true;

  const bool refreshable = !refreshToken.isEmpty();
  const uint32_t backoff =
      refreshable ? CLOUD_REFRESH_RETRY_MS : CLOUD_AUTH_RETRY_MS;
  if (authAttempted && now - lastAuthAttempt < backoff) return false;

  return refreshable ? renewToken() : signIn();
}

// PUT one JSON document to a database path. print=silent makes Firebase answer
// 204 with no body, so nothing has to be read back or drained.
bool putJson(const String &path, const String &json) {
  const String url = String(FIREBASE_DATABASE_URL) + path +
                     ".json?print=silent&auth=" + idToken;

  if (!cloudHttp.begin(cloudTls, url)) return false;
  cloudHttp.addHeader("Content-Type", "application/json");

  const int code = cloudHttp.PUT(json);
  cloudHttp.end();

  if (code == 200 || code == 204) return true;

  Serial.print("CLOUD write failed: HTTP ");
  Serial.println(code);
  // A negative code is a transport failure rather than an answer from Firebase,
  // so the kept-alive TLS socket is finished. Drop it, or every later write
  // reuses the same dead connection and fails the same way.
  if (code < 0) cloudTls.stop();
  if (code == 401 || code == 403) idToken = "";  // expired or revoked
  return false;
}

String liveJson() {
  String json = "{\"ts\":{\".sv\":\"timestamp\"}";
  json += ",\"ms\":" + String(current.ms, 2);
  json += ",\"kmh\":" + String(current.kmh, 1);
  json += ",\"gust\":" + String(gustKmh, 1);
  json += ",\"adc\":" + String(current.adc, 3);
  json += ",\"sensor\":" + String(current.sensor, 3);
  json += ",\"raw\":" + String(current.raw, 0);
  json += ",\"up\":" + String(millis() / 1000);
  json += ",\"mode\":\"" + networkMode + "\"";
  json += "}";
  return json;
}

String historyJson() {
  String json = "{\"ts\":{\".sv\":\"timestamp\"}";
  json += ",\"kmh\":" + String(current.kmh, 1);
  json += ",\"ms\":" + String(current.ms, 2);
  json += ",\"gust\":" + String(windowPeakKmh, 1);
  json += ",\"sensor\":" + String(current.sensor, 3);
  json += "}";
  return json;
}

void cloudBegin() {
  cloudTls.setInsecure();   // no root certificate store on the board
  cloudHttp.setReuse(true); // keep the TLS session between writes

  Serial.print("Cloud relay: ");
  Serial.println(FIREBASE_DATABASE_URL);

  if (WiFi.status() == WL_CONNECTED) {
    signIn();
  } else {
    Serial.println("  No internet in hotspot mode; uploads start once the "
                   "board joins a network.");
  }
}

void publishToCloud() {
  if (WiFi.status() != WL_CONNECTED) return;

  const uint32_t now = millis();
  if (now - lastLivePush < CLOUD_LIVE_INTERVAL_MS) return;
  lastLivePush = now;

  if (!haveToken()) return;
  if (!putJson(CLOUD_LIVE_PATH, liveJson())) return;

  if (now - lastHistoryPush >= CLOUD_HISTORY_INTERVAL_MS) {
    lastHistoryPush = now;
    const uint32_t slot = historyWrites % CLOUD_HISTORY_SLOTS;
    if (putJson(String(CLOUD_HISTORY_PATH) + "/" + String(slot),
                historyJson())) {
      historyWrites++;
      windowPeakKmh = 0;  // only start a new window once the peak is stored
    }
  }
}
#endif

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(1500);

  analogReadResolution(12);
  // ESP32-C3 11 dB attenuation covers the expected 0-1.667 V ADC signal.
  analogSetPinAttenuation(WIND_ADC_PIN, ADC_11db);

  Serial.println();
  Serial.println("SPL Wind Speed Logger");
  Serial.println("XIAO ESP32-C3 | ADC: D1 / GPIO3");

  if (!joinExistingNetwork()) startHotspot();

  if (MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("  Also at:   http://" MDNS_HOSTNAME ".local");
  }

  server.on("/", handleRoot);
  server.on("/api/live", handleLive);
  server.on("/api/history", handleHistory);
  server.onNotFound([]() {
    server.sendHeader("Location", "/", true);
    server.send(302, "text/plain", "");
  });
  server.begin();

  Serial.println("Dashboard ready.");

#if CLOUD_CONFIGURED
  cloudBegin();
#else
  Serial.println("Cloud upload disabled (CLOUD_CONFIGURED is 0).");
#endif
}

void loop() {
  const uint32_t now = millis();

  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    accumulatedRaw += analogRead(WIND_ADC_PIN);
    accumulatedMillivolts += analogReadMilliVolts(WIND_ADC_PIN);
    accumulatedSamples++;
  }

  if (now - lastPublishAt >= PUBLISH_INTERVAL_MS && accumulatedSamples > 0) {
    lastPublishAt = now;

    current.raw = static_cast<float>(accumulatedRaw) / accumulatedSamples;
    current.adc =
        (static_cast<float>(accumulatedMillivolts) / accumulatedSamples) /
        1000.0f;

    accumulatedRaw = 0;
    accumulatedMillivolts = 0;
    accumulatedSamples = 0;

    current.sensor =
        constrain(current.adc * DIVIDER_MULTIPLIER, 0.0f, MAX_SENSOR_VOLTAGE);
    current.ms = current.sensor * METRES_PER_SECOND_PER_SENSOR_VOLT;
    if (current.ms < WIND_ZERO_DEADBAND_MS) current.ms = 0.0f;
    current.kmh = current.ms * 3.6f;

    pushHistory(current.kmh, current.sensor);
    gustKmh = computeGust();

#if CLOUD_CONFIGURED
    // Peak across the whole gap between history slots, so the stored trace
    // shows the gusts that fall between two 15 s samples.
    if (current.kmh > windowPeakKmh) windowPeakKmh = current.kmh;
#endif

    Serial.print("ADC=");
    Serial.print(current.raw, 0);
    Serial.print(" | WIND_ADC=");
    Serial.print(current.adc, 3);
    Serial.print(" V | SENSOR=");
    Serial.print(current.sensor, 3);
    Serial.print(" V | WIND=");
    Serial.print(current.ms, 2);
    Serial.print(" m/s | ");
    Serial.print(current.kmh, 1);
    Serial.println(" km/h");
  }

  server.handleClient();

#if CLOUD_CONFIGURED
  publishToCloud();
#endif
}
