# SPL Wind Monitoring Dashboard UI

This document describes the user interface for the hosted wind-monitoring
dashboard in `dashboard/`. The interface displays live readings from Firebase,
retained wind history, sensor health information, CSV export controls, and an
operator-only reset of the recorded history.

## Public dashboard

The production dashboard is hosted with GitHub Pages:

<https://sarujan2001.github.io/Wind-Turbine-Speed/>

The page is designed for desktop, tablet, and mobile browsers. Normal viewing
does not require an account or Firebase credentials.

## Page structure

### Navigation

The fixed navigation bar links to:

- Dashboard
- Live Data
- History
- Station
- About

The connection indicator shows whether the latest Firebase reading is recent
enough for the station to be considered online.

### Current wind panel

The main panel displays:

- Current wind speed in metres per second
- Current wind speed in kilometres per hour
- Wind classification
- A 0–30 m/s gauge

### Summary cards

The summary strip contains:

- Current wind speed
- Current three-second gust
- Maximum available today
- Average available today
- Sensor status
- Age of the latest reading

Statistics are calculated from the history currently available to the browser.

### Live chart

The live chart compares wind speed and gust speed. Available ranges include:

- Live
- 15 minutes
- 1 hour

Longer ranges remain disabled while Firebase retains only a one-hour history
ring.

### Daily summary and sensor status

The daily summary shows maximum, minimum, average, maximum gust, sample count,
and station runtime. The sensor panel shows connection state, voltage, ADC
voltage, raw ADC value, and device type.

### Wind history

History can be viewed as either a graph or a table. The date controls select the
day shown in this section. A selected date may be empty when its readings are
no longer present in Firebase's rolling history.

## History controls

### Export CSV

`Export CSV` opens a date-range dialog. The start and end dates are inclusive.
The downloaded file includes:

- ISO timestamp
- Local date and time
- Wind speed in m/s and km/h
- Gust speed in m/s and km/h
- Sensor voltage
- ADC voltage
- Raw ADC reading
- Station network mode

Only readings currently loaded and visible in the dashboard can be exported.

### Unlock controls

`Unlock controls` opens a sign-in dialog for the Firebase operator account and
asks for its email and password.

- The password is sent to Firebase Auth, which verifies it. The page never sees,
  stores, or ships any credential of its own.
- The returned ID token is held in memory for the current page session only.
  Reloading or closing the tab signs the operator out.
- `Clear recorded history` stays hidden until sign-in succeeds.
- `Lock controls` discards the token immediately.
- Repeated wrong passwords are rate-limited by Firebase, per account.
- If `firebaseWebApiKey` is empty in `config.js`, the unlock button is disabled
  and the dashboard is strictly read-only.

The security boundary is `firebase/database.rules.json`, not this interface.

### Clear recorded history

After sign-in, `Clear recorded history` asks for confirmation and then sends
`DELETE /history.json` to Firebase with the operator's token.

- Every retained reading is removed from the database, for every viewer.
- The dashboard then drops its own loaded copy, keeping only the newest live
  reading so the tiles do not blank out. Charts, statistics, the history table
  and CSV exports all restart from that moment.
- Recording continues immediately: the station keeps writing `/live` every two
  seconds and adds a new `/history` point every fifteen.
- This cannot be undone.

The database rules allow this account to write only `null` at `/history`, so it
can reset the record but cannot create or alter a reading. `/live` is untouched
and is rewritten by the station within two seconds.

Viewers with the page already open keep the points their browser accumulated
during the session until they reload.

## Firebase data flow

The UI reads two Realtime Database paths:

| Path | Purpose |
|---|---|
| `/live` | Current sensor reading and connection status |
| `/history` | Rolling history used by charts, summaries, tables, and exports |

The dashboard first loads stored history, then subscribes to `/live` with a
server-sent event stream. If streaming is unavailable, it falls back to regular
HTTP polling.

The Firebase security rules keep public access read-only. Only the ESP32 device
account is permitted to write sensor data.

## Main UI files

| File | Responsibility |
|---|---|
| `index.html` | Page structure, controls, dialogs, and third-party resources |
| `styles.css` | Colours, layout, responsive rules, tables, buttons, and dialogs |
| `app.js` | Firebase loading, live updates, operator sign-in, history deletion, and CSV export |
| `ui.js` | Formatting, summaries, status rendering, and history table rendering |
| `charts.js` | Chart.js setup and chart range updates |
| `config.js` | Station name, location, coordinates, Firebase URL and Web API key, operator email, and timeouts |

## Customising the interface

Station-specific text and settings should normally be changed in `config.js`.
Structural changes belong in `index.html`, while visual changes belong in
`styles.css`.

When changing JavaScript or CSS, update the `wind-station-N` query version in
`index.html` and the module imports in `app.js`. This prevents browsers and
GitHub Pages from continuing to use an older cached asset.

Never place Wi-Fi passwords, Firebase account passwords, device tokens, or
other private credentials in any dashboard file because GitHub Pages publishes
the entire `dashboard/` directory.

## Local preview

From the project root, run:

```powershell
python -m http.server 8080 --directory dashboard
```

Then open:

<http://localhost:8080>

Check both desktop and mobile widths after changing the interface. Also verify
that the browser console has no JavaScript errors, the station reports live,
the operator sign-in dialog opens, and `Clear recorded history` stays hidden
before sign-in.
