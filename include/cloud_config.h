#pragma once

// ---------------------------------------------------------------------------
// Cloud relay - Firebase Realtime Database.
//
// The board makes an outbound HTTPS connection to Firebase and writes its
// readings there; the hosted dashboard reads them back. Outbound crosses NAT
// and mobile networks without any port forwarding, which is the only reason
// this works from a site with no fixed IP.
//
// Keep this at 0 for local USB / Wi-Fi logging only.
// Change it to 1 after creating include/secrets.h from secrets.h.example.
// ---------------------------------------------------------------------------

#define CLOUD_CONFIGURED 1

// How often the latest reading is written to /live. Firebase imposes no
// minimum interval, unlike the 15 s floor on ThingSpeak's free tier, so this
// is limited only by how long the board can afford to spend on each request.
// Every write blocks the local dashboard for the length of the round trip
// (roughly 80-250 ms once the TLS session is up), so do not drop this below
// about 1000 ms.
#define CLOUD_LIVE_INTERVAL_MS 2000

// How often a point is added to the stored history trace, and how many points
// are kept. HISTORY_SLOTS x CLOUD_HISTORY_INTERVAL_MS is the span the
// dashboard can draw on load: 240 x 15 s = one hour.
//
// The slots form a ring - slot (n % HISTORY_SLOTS) is overwritten - so storage
// is bounded and nothing ever has to be pruned.
#define CLOUD_HISTORY_INTERVAL_MS 15000
#define CLOUD_HISTORY_SLOTS 240

// Database paths written by the board. These must match the paths named in
// firebase/database.rules.json and read by dashboard/app.js.
#define CLOUD_LIVE_PATH "/live"
#define CLOUD_HISTORY_PATH "/history"

// An ID token from Firebase Auth lasts one hour. Renew a little early so a
// write is never attempted with a token that expired in transit.
#define CLOUD_TOKEN_MARGIN_MS 300000
