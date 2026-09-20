# Remote access — reading the logger from anywhere

**Status date:** 24 August 2026
**Project:** SPL Wind Speed Logger / Wind Turbine Site Test
**Cloud relay:** Firebase Realtime Database

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
ESP32  --(outbound HTTPS)-->  Firebase RTDB  --(server-sent events)-->  Pages dashboard
                                                                        (any browser, anywhere)
```

Three access routes coexist, and each suits a different situation:

| Route | Page | Needs | Latency | Use when |
|---|---|---|---|---|
| USB serial | `dashboard/bench-monitor.html` | Cable + Chrome/Edge | ~0.1 s | At the bench, calibrating |
| Board's own Wi-Fi | served by the ESP32 at `/` | Same network or its hotspot | ~0.1 s | On site, standing near the turbine |
| Cloud | `dashboard/index.html` on Pages | Board has internet | ~2 s | Anywhere in the world |

Firebase pushes each write straight out to every open dashboard, so the cloud
route is a live feed rather than a poll — see section 7 for what that costs.

## 3. Firebase setup (console work, done once)

### Step 1 — Create the project and the database

1. At <https://console.firebase.google.com> create a project. Analytics is not
   needed.
2. **Build → Realtime Database → Create database.** Pick the region nearest the
   site (`asia-southeast1` for Australia) and start in **locked mode** — the
   rules in step 3 open exactly what is needed and nothing more.
3. Note the URL shown above the data tree. It looks like
   `https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app`.

Realtime Database, not Firestore: the board writes one small document every
couple of seconds, which is what RTDB is cheap at, and its REST API streams to
the browser without a client library.

### Step 2 — Give the board its own account

1. **Build → Authentication → Get started → Email/Password → Enable.**
2. **Users → Add user.** Any address will do (`logger@spl.invalid`); it is never
   emailed. Use a long random password.
3. Copy the account's **User UID** from the users table.

The board signs in as this account and writes with the ID token it gets back.
That is what lets the rules accept writes from the logger and refuse everyone
else.

### Step 3 — Paste the rules

Open **Realtime Database → Rules**, paste the contents of
[firebase/database.rules.json](firebase/database.rules.json), replace
`DEVICE_UID` with the UID from step 2 and `OPERATOR_UID` with the UID from step
4, and publish. The shape of it:

```json
"live":    { ".read": true, ".write": "auth != null && auth.uid === 'DEVICE_UID'" },
"history": { ".read": true, ".write": "auth != null && (auth.uid === 'DEVICE_UID' || (auth.uid === 'OPERATOR_UID' && !newData.exists()))" }
```

World-readable, board-writable, everything else shut. Public reads are what let
the static dashboard work with no key in the page; read section 7 before
deciding that is acceptable.

The `!newData.exists()` clause is the whole reason the operator can be trusted
with a browser sign-in: it permits a write only when the new value is null. That
account can therefore delete `/history` and do nothing else — not one forged
reading, even if its password leaks.

### Step 4 — Give the operator an account

Only needed if someone should be able to wipe the record and start recording
afresh from the dashboard. Skip it to leave the page strictly read-only.

1. **Authentication → Users → Add user.** Use the real address of the person who
   will hold it, and a password only they know.
2. Copy that account's **User UID** — it is the `OPERATOR_UID` in step 3.

The board's account and the operator's account are deliberately separate. The
board can write readings but not delete them; the operator can delete the record
but not write readings.

### Step 5 — Collect the values

**Project settings → General** holds the **Web API key**. Together with the
database URL and the account details, that is everything `secrets.h` needs. The
same Web API key also goes into `dashboard/config.js` if step 4 was done.

## 4. Firmware setup

### Step 1 — Fill in the credentials

Edit `include/secrets.h` (already created, and excluded from Git):

```cpp
constexpr char WIFI_SSID[] = "your network";
constexpr char WIFI_PASSWORD[] = "your password";

constexpr char FIREBASE_WEB_API_KEY[] = "AIza...";
constexpr char FIREBASE_DATABASE_URL[] =
    "https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app";
constexpr char FIREBASE_DEVICE_EMAIL[] = "logger@spl.invalid";
constexpr char FIREBASE_DEVICE_PASSWORD[] = "the password from step 2";
```

The database URL must have no trailing slash, and the password is placed into a
JSON body as-is, so avoid double quotes and backslashes in it.

At a site with no Wi-Fi, a phone hotspot works — use its name and password.

### Step 2 — Check both switches are on

```cpp
// include/wifi_config.h
#define WIFI_JOIN_NETWORK 1    // the board needs internet to upload

// include/cloud_config.h
#define CLOUD_CONFIGURED 1
```

`WIFI_JOIN_NETWORK 1` still serves the local dashboard on the network it joins,
so you keep the fast local view as well as the cloud feed. If it cannot join, it
falls back to its own hotspot after 15 seconds — but in hotspot mode there is no
internet, so uploads stop until it can reach a network again.

`include/cloud_config.h` also holds the cadences: `CLOUD_LIVE_INTERVAL_MS`
(2000), `CLOUD_HISTORY_INTERVAL_MS` (15000) and `CLOUD_HISTORY_SLOTS` (240).

### Step 3 — Rebuild and upload

```powershell
~/.platformio/penv/Scripts/pio.exe run -t upload
```

Close any serial monitor and disconnect the browser bench monitor first — only
one program can hold the COM port.

### Step 4 — Confirm it is publishing

On the serial monitor, a healthy start looks like:

```text
Connected. Dashboard: http://192.168.1.42
Dashboard ready.
Cloud relay: https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app
CLOUD signed in.
```

Failures are printed too. `CLOUD sign-in failed` points at the four Firebase
values in `secrets.h`; `CLOUD write failed: HTTP 401` points at the UID in the
rules. In the console, the data tree should show `/live` changing every two
seconds.

## 5. Publishing the dashboard

### Step 1 — Point the dashboard at the database

Edit `dashboard/config.js`:

```js
firebaseDatabaseUrl: "https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app",
siteName: "SPL Wind Turbine Test Site",
latitude: -38.33920835101432,
longitude: 144.7383156116512,

// Only needed for the operator reset control; leave empty to stay read-only.
firebaseWebApiKey: "",
operatorEmail: "",
```

With no `firebaseDatabaseUrl` the page shows no readings at all and says so — it
never substitutes invented values.

**No password belongs in this file**, and none is needed. Reads are anonymous,
which is why the rules allow public reads of those two paths. The Web API key is
not a password: it names the project and grants nothing on its own, which is why
Firebase publishes it in every web app's config. It only lets the page ask
Firebase to verify the operator's email and password, and what that account may
then do is decided entirely by the rules in step 3.

### Step 2 — Push

```powershell
git push
```

Pages is already configured: `.github/workflows/pages.yml` deploys the
`dashboard/` folder on every push that touches it, and nothing else is served.
The site is at:

```text
https://sarujan2001.github.io/Wind-Turbine-Speed/
```

## 6. What is stored

```text
/live                        the latest reading, overwritten every 2 s
  ts       1756000000000     server timestamp, ms
  kmh      18.4
  ms       5.11
  gust     21.2              peak over the last 3 s, measured on the board
  adc      0.284             volts at D1 / GPIO3
  sensor   0.852             volts before the divider
  raw      352               mean ADC count
  up       1843              seconds since boot
  mode     "on your network"

/history/0 .. /history/239   one point every 15 s, a ring covering one hour
  ts, kmh, ms, sensor
  gust                       peak across that whole 15 s gap
```

The history slots are a ring — slot `n % 240` is overwritten — so storage is
bounded at roughly 30 KB and nothing ever needs pruning. The dashboard reads the
ring once on load and then follows `/live`, adding a chart point every 15 s.

Timestamps use Firebase's `{".sv": "timestamp"}` server value, so the board
never needs to know the time and every point shares one clock. A reboot restarts
the ring at slot 0, so slots it has not come back round to can still hold
readings from a previous run; the dashboard drops anything more than an hour
older than the newest point it finds.

## 7. Things to know before relying on it

**The cloud feed is a live feed now.** Firebase has no minimum write interval,
so the board publishes every 2 seconds and each change is pushed to the
dashboard over server-sent events rather than polled for. Gusts survive the trip
too: `/live` carries the board's 3-second peak, and each history point carries
the peak across its 15-second gap. The 0.1 s local routes are still the ones to
use for calibration work.

**Each upload briefly stalls the local dashboard.** The HTTPS PUT blocks the
loop for 80-250 ms once the TLS session is up, and 1-2 s for the first write
after a reconnect or the hourly token renewal. At a 2-second cadence that is a
visible flicker on the board's own page, not a fault. Raising
`CLOUD_LIVE_INTERVAL_MS` trades feed latency back for a smoother local page.

**Public read means genuinely public.** Anyone with the database URL can read
the wind data, exactly as with the old public ThingSpeak channel. Locking reads
down means putting a key or an auth step into the static page, where anyone can
read it — so it is effectively public either way. If the data is sensitive, the
cloud route is the wrong choice.

**The device password must stay on the board.** It lives only in
`include/secrets.h`, which `.gitignore` excludes. Never put it in
`dashboard/config.js` — that file is published to the world. Anyone holding it
can inject false readings; to revoke, change that account's password under
**Authentication → Users** and reflash.

**The operator reset deletes for everyone, and it is not undoable.** A signed-in
operator pressing *Clear recorded history* removes the whole `/history` ring from
the database. There is no copy: anything not already exported to CSV is gone, for
every viewer, not just the browser that pressed the button. Recording resumes on
the next reading. Export first if the record matters.

**The operator password is the only secret in that path, and it is never in the
page.** The dashboard sends the typed email and password to Firebase Auth and
keeps the returned token in memory for that page session alone. What the token
can do is fixed by the rules, which permit that account to write only `null` at
`/history` — so a leaked operator password costs you the stored history, never a
forged reading. To revoke, change or delete the account under **Authentication →
Users**; nothing needs reflashing and nothing needs redeploying. Removing
`firebaseWebApiKey` from `dashboard/config.js` disables the control outright.

**The board does not verify Firebase's certificate.** `setInsecure()` is used
because the ESP32 carries no root store, so traffic is encrypted but the server
identity is unchecked. That is a reasonable trade for wind readings on a test
rig and the wrong one for anything confidential.

**Nothing is buffered while offline.** Readings taken with no internet are lost
from the cloud record, though the board's own dashboard still shows the last 60
seconds.

**Free Spark plan headroom.** 1 GB stored (the ring uses ~30 KB), 10 GB a month
of downloads, and 100 simultaneous connections. A dashboard tab left open
continuously streams roughly 250 MB a month, so the practical limit is a few
dozen permanently-open tabs rather than the write rate. No card is required, and
a Spark project cannot run up a bill.

## 8. Over-the-air firmware updates

Once a board is out at a turbine site, plugging in a USB cable to change
`main.cpp` is not always practical. `/firmware` in the same Realtime Database
solves that: the board polls it every `OTA_CHECK_INTERVAL_MS` (30 minutes) for
a manifest naming a newer build, and if it finds one, downloads and flashes it
itself over the same Wi-Fi connection it already uses to publish readings -
see `checkForOta()` in `main.cpp`.

```text
GitHub Release (the .bin)  <--HTTPS-- ESP32  --reads manifest-->  /firmware in Firebase RTDB
```

### Publishing a new version

1. **Bump the version.** In `main.cpp`, increase `FIRMWARE_VERSION` (currently
   an integer starting at 1). The board only ever installs a manifest version
   strictly greater than its own, so this is what stops it reinstalling the
   same build forever.
2. **Build.**
   ```powershell
   ~/.platformio/penv/Scripts/pio.exe run
   ```
   This produces `.pio/build/seeed_xiao_esp32c3/firmware.bin` - the file that
   gets flashed, without needing to touch a board yet.
3. **Publish the .bin as a GitHub Release asset.** Create a release (tag it
   e.g. `v2`), attach `firmware.bin` to it. Its asset URL looks like:
   ```text
   https://github.com/<owner>/<repo>/releases/download/v2/firmware.bin
   ```
   That URL redirects to the actual file; `checkForOta()` follows the
   redirect, so this works without any extra setup.
4. **Edit `/firmware` in the Firebase console** (Realtime Database -> Data),
   at the root next to `live` and `history`:
   ```json
   { "version": 2, "url": "https://github.com/<owner>/<repo>/releases/download/v2/firmware.bin" }
   ```
   This is a manual step on purpose - nothing in this codebase or the
   dashboard can write here (see `firebase/database.rules.json`), so a leaked
   Firebase Web API key or a compromised dashboard cannot push firmware to the
   board.
5. **Wait.** Every board that is online checks within 30 minutes, downloads
   the new `.bin`, flashes it, and reboots on its own. Watching the serial
   monitor of a board that is still on USB shows the same progress this
   describes, but nothing needs to stay plugged in for the update to happen in
   the field.

### The one way this can still cost you a site visit

**Never publish a build you have not run on a board over USB first.** A
download that fails is harmless, but a build that downloads perfectly and then
crashes during `setup()` is not: there is no automatic rollback here, and a
board that cannot finish booting cannot check for the next update either. At
that point only the cable can recover it. Flash it, watch it come up on the
serial monitor, *then* publish the same `.bin` as a release.

Confirm an update actually landed by checking `fw` in `/live` (the board
reports its running `FIRMWARE_VERSION` with every reading). If it still shows
the old number a day after publishing, the board never took the update.

### What keeps this safe to leave running unattended

- **A bad manifest cannot brick the board.** The new image is only committed
  to flash once it has downloaded completely and passed the check the
  `Update` library runs on it; a dropped connection, a truncated file, or a
  manifest pointing at nothing simply leaves the current firmware running.
- **The board has two firmware slots** (the default partition table for this
  4 MB board already reserves two ~1.25 MB app partitions), so the new image
  never overwrites the one that is currently running until it is confirmed
  good.
- **Nobody but you can point `/firmware` at anything**, because the database
  rule grants `/firmware` read access only - there is no `.write` rule for it
  at all, so it is edited exclusively through the Firebase console, which
  bypasses these rules for whoever is signed in there.
- **The download is not certificate-checked**, the same trade-off already
  made everywhere else in this codebase (`setInsecure()` - see section 7).
  That is a reasonable trade for a wind-speed logger; it would not be for
  firmware with higher stakes riding on it.
