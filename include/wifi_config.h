#pragma once

// ---------------------------------------------------------------------------
// How the logger puts its dashboard on the network.
//
//   0 = ACCESS POINT. The board makes its own Wi-Fi hotspot. Nothing else is
//       needed - no router, no credentials, no internet. Connect a phone or
//       laptop to the hotspot below and open http://192.168.4.1
//       This is the mode to use out at a turbine site.
//
//   1 = JOIN AN EXISTING NETWORK. The board connects to the Wi-Fi named in
//       include/secrets.h and prints the IP address it was given on the serial
//       monitor. Use this on the bench so your computer keeps its internet.
//       Requires include/secrets.h (copy it from secrets.h.example).
//
// If mode 1 fails to connect within WIFI_JOIN_TIMEOUT_MS, the logger falls
// back to its own hotspot automatically so the dashboard is never unreachable.
// ---------------------------------------------------------------------------

#define WIFI_JOIN_NETWORK 0

// Hotspot details used in access-point mode (and as the fallback).
// The password must be at least 8 characters, or the hotspot will be open.
#define AP_SSID "SPL-WindLogger"
#define AP_PASSWORD "windspeed"

// How long to wait when joining an existing network before falling back.
#define WIFI_JOIN_TIMEOUT_MS 15000

// Hostname advertised over mDNS: http://windlogger.local
#define MDNS_HOSTNAME "windlogger"
