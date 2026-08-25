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

The board's account password stays only on the ESP32 and is excluded from Git.
Never put it in `dashboard/config.js` — that file is published to the world.
The dashboard needs no key at all, because it only reads.

## What the page reads

| Path | Cadence | Used for |
|---|---|---|
| `/live` | every 2 s, streamed | the speed, gust, and voltage tiles |
| `/history` | read once at load | the first hour of the trend chart |

The current database ring retains one hour. Longer chart controls are visibly
disabled until the backend retains enough data to support them.

If the browser cannot hold the stream open — a proxy that buffers responses, for
instance — the page falls back to polling `/live` every `refreshSeconds` and
returns to streaming as soon as it can.

The station is marked offline when its Firebase timestamp is older than
`offlineAfterSeconds`. The last known values remain visible while offline.

## Remote access

Deploy the contents of `dashboard/` to a static host. The resulting HTTPS URL
can be opened from any phone or computer. The ESP32 must have Wi-Fi internet
access to publish readings.
