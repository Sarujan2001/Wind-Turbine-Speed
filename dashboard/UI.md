# SPL Wind Monitoring Dashboard UI

This document describes the user interface for the hosted wind-monitoring
dashboard in `dashboard/`. The interface displays live readings from Firebase,
retained wind history, sensor health information, CSV export controls, and a
PIN-gated local reset.

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

`Unlock controls` opens a five-digit PIN dialog. The PIN value is intentionally
not documented here.

- Three incorrect entries trigger a 15-minute lockout.
- Attempt and lockout state are stored in that browser.
- A successful unlock lasts only for the current page session.
- `Clear today` remains hidden until the controls are unlocked.
- `Lock controls` immediately hides the protected control again.

This PIN is a convenience gate for the public static interface. It is not
Firebase authentication and does not grant database write access.

### Clear today

After PIN unlock, `Clear today` asks for confirmation and establishes a local
cutoff timestamp for the current date. Readings before that timestamp disappear
from the browser's daily statistics, charts, history table, and CSV exports.

The cutoff survives a page refresh on the same browser. It expires when the
calendar date changes.

`Clear today` does **not** delete `/live`, `/history`, or any other Firebase
data. Other browsers are unaffected.

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
| `app.js` | Firebase loading, live updates, PIN gate, local reset, and CSV export |
| `ui.js` | Formatting, summaries, status rendering, and history table rendering |
| `charts.js` | Chart.js setup and chart range updates |
| `config.js` | Station name, location, coordinates, Firebase URL, and timeouts |

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
the PIN dialog opens, and `Clear today` stays hidden before unlock.
