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
// HTTP requests are never left waiting. ~62 samples land in each 500 ms window,
// which matches the averaging the previous blocking version did.
constexpr uint32_t SAMPLE_INTERVAL_MS = 8;
constexpr uint32_t PUBLISH_INTERVAL_MS = 500;

constexpr uint8_t HISTORY_LEN = 120;  // 120 x 500 ms = one minute of trace
constexpr uint8_t GUST_SPAN = 6;      // 6 x 500 ms = three-second gust window
constexpr uint32_t CLOUD_INTERVAL_MS = 20000;

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
uint8_t historyCount = 0;
uint8_t historyHead = 0;

uint32_t accumulatedRaw = 0;
uint32_t accumulatedMillivolts = 0;
uint16_t accumulatedSamples = 0;

uint32_t lastSampleAt = 0;
uint32_t lastPublishAt = 0;
uint32_t lastCloudUpdate = 0;

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
  const uint8_t span = historyCount < GUST_SPAN ? historyCount : GUST_SPAN;
  float peak = 0;
  for (uint8_t i = 1; i <= span; ++i) {
    const int index = (historyHead + HISTORY_LEN - i) % HISTORY_LEN;
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
  String speeds = "[";
  String sensors = "[";

  for (uint8_t i = 0; i < historyCount; ++i) {
    const int index =
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

  String json = "{\"period\":" + String(PUBLISH_INTERVAL_MS);
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
// Optional ThingSpeak upload (needs WIFI_JOIN_NETWORK = 1 for internet access)
// ---------------------------------------------------------------------------

#if CLOUD_CONFIGURED
void publishToCloud() {
  if (millis() - lastCloudUpdate < CLOUD_INTERVAL_MS) return;
  if (WiFi.status() != WL_CONNECTED) return;
  lastCloudUpdate = millis();

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient request;

  if (!request.begin(client, "https://api.thingspeak.com/update.json")) return;
  request.addHeader("Content-Type", "application/x-www-form-urlencoded");

  String body = "api_key=" + String(THINGSPEAK_WRITE_API_KEY);
  body += "&field1=" + String(current.ms, 2);
  body += "&field2=" + String(current.kmh, 1);
  body += "&field3=" + String(current.adc, 3);
  body += "&field4=" + String(current.sensor, 3);
  body += "&field5=" + String(current.raw, 0);

  const int responseCode = request.POST(body);
  Serial.print("CLOUD=");
  Serial.println(responseCode == 200 ? "OK" : String(responseCode));
  request.end();
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

#if !CLOUD_CONFIGURED
  Serial.println("ThingSpeak upload disabled (CLOUD_CONFIGURED is 0).");
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
