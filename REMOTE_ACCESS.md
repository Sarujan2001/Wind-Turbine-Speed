# Remote access — reading the logger from anywhere

**Status date:** 24 August 2026
**Project:** SPL Wind Speed Logger / Wind Turbine Site Test

---

## 1. Why the page cannot talk to the board directly

A dashboard hosted on GitHub Pages cannot fetch data straight from the ESP32,
no matter how the code is written. Three separate things block it:

| Blocker | Detail |
|---|---|
| **No route** | `192.168.4.1` (and any `192.168.x.x` address) is private. A browser elsewhere in the world has no path to it, and NAT on the router refuses inbound connections. |
| **Mixed content** | GitHub Pages is HTTPS-only. The ESP32 serves plain HTTP. Browsers hard-block an HTTPS page from fetching `http://`. There is no flag or setting that permits it. Fixing it properly needs a TLS certificate on the board, which needs a public domain name. |
| **CORS** | The ESP32 sends no cross-origin headers, so even a same-scheme request would be refused. |

Port-forwarding the board to the public internet would defeat the first two but
is a poor idea: it exposes an unauthenticated device with no TLS directly to the
internet, and most site connections are behind carrier-grade NAT where inbound
forwarding is impossible anyway.

## 2. The architecture that does work

The board makes an **outbound** connection to a cloud service. Outbound crosses
NAT and firewalls without any configuration. The hosted page then reads from
that service, not from the board.

```text
ESP32  --(outbound HTTPS)-->  ThingSpeak  <--(HTTPS)--  GitHub Pages dashboard
                                                          (any browser, anywhere)
```

This is what `dashboard/` was already written to do. Three access routes now
coexist, and each suits a different situation:

| Route | Page | Needs | Latency | Use when |
|---|---|---|---|---|
| USB serial | `dashboard/bench-monitor.html` | Cable + Chrome/Edge | ~0.5 s | At the bench, calibrating |
| Board's own Wi-Fi | served by the ESP32 at `/` | Same network or its hotspot | ~0.5 s | On site, standing near the turbine |
| Cloud | `dashboard/index.html` on Pages | Board has internet | ~20 s | Anywhere in the world |

The cloud route is the slowest by a wide margin, and that is a deliberate
constraint, not a bug — see section 5.

## 3. Firmware setup

### Step 1 — Fill in the credentials

Edit `include/secrets.h` (already created, and excluded from Git):

```cpp
constexpr char WIFI_SSID[] = "your network";
constexpr char WIFI_PASSWORD[] = "your password";
constexpr char THINGSPEAK_WRITE_API_KEY[] = "your write key";
```

At a site with no Wi-Fi, a phone hotspot works — use its name and password.

### Step 2 — Create the ThingSpeak channel

Sign up at thingspeak.com, create a channel, and enable these fields in order:

| Field | Contents |
|---|---|
| 1 | Wind speed, m/s |
| 2 | Wind speed, km/h |
| 3 | WIND_ADC voltage |
| 4 | Sensor voltage |
| 5 | Raw ADC count |

Set the channel to **public** under Sharing, so the dashboard can read it
without a key. Copy the **Write API Key** into `secrets.h` and note the numeric
**Channel ID**.

### Step 3 — Turn both switches on

```cpp
// include/wifi_config.h
#define WIFI_JOIN_NETWORK 1    // was 0 - the board needs internet to upload

// include/cloud_config.h
#define CLOUD_CONFIGURED 1     // was 0
```

`WIFI_JOIN_NETWORK 1` still serves the local dashboard on the network it joins,
so you keep the fast local view as well as the cloud feed. If it cannot join,
it falls back to its own hotspot after 15 seconds — but note that in hotspot
mode there is no internet, so cloud uploads stop until it can reach a network
again.

### Step 4 — Rebuild and upload

```powershell
~/.platformio/penv/Scripts/pio.exe run -t upload
```

Close any serial monitor and disconnect the browser bench monitor first — only
one program can hold the COM port.

## 4. Publishing the dashboard

### Step 1 — Point the dashboard at the channel

Edit `dashboard/config.js`:

```js
thingSpeakChannelId: 1234567,   // your numeric channel ID
siteName: "SPL Wind Turbine Test Site",
latitude: -27.4698,             // set these to the real site
longitude: 153.0251,
```

While `thingSpeakChannelId` stays `null` the page runs a clearly-labelled
demonstration feed, so it is obvious when it is not showing real data.

### Step 2 — Create the GitHub repository

`gh` is not installed on this machine, so create it through the website:
new repository under the **Sarujan2001** account, no README, no `.gitignore`
(this project already has one).

### Step 3 — Push

```powershell
git remote add origin https://github.com/Sarujan2001/wind-turbine-testing.git
git branch -M main
git push -u origin main
```

### Step 4 — Enable Pages

In the repository: **Settings → Pages → Build and deployment → Source →
GitHub Actions**. The workflow at `.github/workflows/pages.yml` deploys only
the `dashboard/` folder, so the firmware and project notes are not served.

The site appears at:

```text
https://sarujan2001.github.io/wind-turbine-testing/
```

Every later push that touches `dashboard/` redeploys it automatically.

## 5. Things to know before relying on it

**The cloud feed is slow, by design.** The free ThingSpeak tier enforces a
15-second minimum between updates; the firmware uses 20 s. So the worldwide view
lags reality by up to 20 seconds and cannot show gusts. Gust capture needs the
local routes, which run at 0.5 s. Do not use the cloud feed for anything where
short-term peaks matter.

**Each upload briefly stalls the local dashboard.** The HTTPS POST blocks for a
second or two while it completes. At 20-second intervals that is a visible
hiccup on the local page, not a fault.

**A public ThingSpeak channel is genuinely public.** Anyone with the channel
number can read your wind data. Making it private instead requires a Read API
key, which would then have to sit in the static page where anyone can view the
source — so it is effectively public either way. If the data is sensitive, the
cloud route is the wrong choice.

**The Write API Key must stay on the board.** It lives only in
`include/secrets.h`, which `.gitignore` excludes. Never put it in
`dashboard/config.js` — that file is published to the world. Anyone holding the
write key can inject false readings into your channel.

**The board needs mains-grade uptime for continuous logging.** Nothing is
buffered while offline: readings taken with no internet are lost from the cloud
record, though the board's own dashboard still shows the last 60 seconds.
