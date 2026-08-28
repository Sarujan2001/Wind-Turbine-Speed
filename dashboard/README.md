# SPL Wind Monitoring dashboard

This dashboard combines the SPL wind sensor feed with RainViewer radar. It can
be hosted as a static site on GitHub Pages, Cloudflare Pages, Netlify, or any
ordinary web server. There is no build step and no bundled SDK: the Firebase
feed is read over its REST API, and live updates arrive as server-sent events.

## Preview locally

From the project root:

```powershell
python -m http.server 8080 -d dashboard
```

Open `http://localhost:8080`. A configured Firebase database URL is required
for live readings; the production dashboard never substitutes mock values.

## Connect the ESP32 cloud feed

Full walkthrough, including the Firebase console steps, is in
[REMOTE_ACCESS.md](../REMOTE_ACCESS.md). In short:

1. Create a Firebase project with a **Realtime Database** in the region nearest
   the site.
2. Under **Authentication → Email/Password**, add one user for the board and
   note its UID.
3. Paste [../firebase/database.rules.json](../firebase/database.rules.json) into
   **Realtime Database → Rules**, with `DEVICE_UID` replaced by that UID. This
   makes `/live` and `/history` world-readable and board-writable.
4. Copy `include/secrets.h.example` to `include/secrets.h` and enter the Wi-Fi
   credentials, the Web API key, the database URL, and the board's account
   email and password.
5. Check `CLOUD_CONFIGURED` is `1` in `include/cloud_config.h`, then rebuild and
   upload the PlatformIO firmware.
6. Put the database URL in `dashboard/config.js` as `firebaseDatabaseUrl`.
7. To enable the operator controls, add a second Authentication user for the
   person who may reset the record, paste its UID into
   `firebase/database.rules.json` in place of `OPERATOR_UID`, and put the
   project's Web API key in `dashboard/config.js` as `firebaseWebApiKey`.
   Leave that key empty to keep the dashboard strictly read-only.

The board's account password stays only on the ESP32 and is excluded from Git.
Never put any password in `dashboard/config.js` — that file is published to the
world. Dashboard viewing needs no key because reads are public.

## What the page reads

| Path | Cadence | Used for |
|---|---|---|
| `/live` | every 2 s, streamed | the speed, gust, and voltage tiles |
| `/history` | read once at load | the first hour of the trend chart |

The current database ring retains one hour. Longer chart controls are visibly
disabled until the backend retains enough data to support them.

## History controls

- **Clear recorded history** is hidden until the operator signs in. After
  confirmation it deletes `/history` from Firebase, so the record is cleared for
  every viewer and the CSV export starts fresh from the next reading. It cannot
  be undone.
- **Export CSV** accepts an inclusive start and end date and exports every
  retained reading available in that range. With the current one-hour Firebase
  ring, the export cannot include readings already overwritten by the station.

### Operator access

The dashboard is a public static page, so it holds no secret of its own —
anything shipped in it can be read by anyone who views source. The security
boundary is Firebase:

- **Unlock controls** asks for the operator account's email and password and
  sends them to Firebase Auth. Firebase verifies the password; the page never
  sees or stores it.
- The ID token that comes back is kept in memory for that page session only. It
  is not written to `localStorage`, and closing or reloading the tab ends the
  session.
- `firebase/database.rules.json` decides what that token can do. The operator
  rule carries `!newData.exists()`, which means the account may only *delete*
  `/history`. A write carrying any value is refused, so even a leaked operator
  password cannot be used to inject false readings.
- The Web API key in `config.js` is safe to publish. It identifies the project
  and grants nothing; it only lets the page ask Firebase to check a password.
- Firebase rate-limits repeated failed sign-ins for an account by itself, so the
  page does not need a lockout of its own.

Only the ESP32's account may write readings. That has not changed.

If the browser cannot hold the stream open — a proxy that buffers responses, for
instance — the page falls back to polling `/live` every `refreshSeconds` and
returns to streaming as soon as it can.

The station is marked offline when its Firebase timestamp is older than
`offlineAfterSeconds`. The last known values remain visible while offline.

## Remote access

Deploy the contents of `dashboard/` to a static host. The resulting HTTPS URL
can be opened from any phone or computer. The ESP32 must have Wi-Fi internet
access to publish readings.
