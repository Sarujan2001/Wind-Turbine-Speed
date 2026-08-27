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
Normal dashboard viewing needs no key because reads are public. The destructive
administrator control asks for the Web API key and account credentials at
runtime and does not save them.

## What the page reads

| Path | Cadence | Used for |
|---|---|---|
| `/live` | every 2 s, streamed | the speed, gust, and voltage tiles |
| `/history` | read once at load | the first hour of the trend chart |

The current database ring retains one hour. Longer chart controls are visibly
disabled until the backend retains enough data to support them.

## History controls

- **Clear today** requires Firebase administrator sign-in, counts today's
  retained records, asks for confirmation, and permanently deletes only those
  `/history` slots. `/live` is not deleted, so new sensor readings continue.
- **Export CSV** accepts an inclusive start and end date and exports every
  retained reading available in that range. With the current one-hour Firebase
  ring, the export cannot include readings that have already been overwritten
  by the station.

### Administrator deletion

The administrator dialog asks for the Firebase Web API key, email, and password
at runtime. They remain only in page memory: the password and API key fields are
cleared after sign-in, the ID token is not persisted, and all session state is
lost when the page closes. No credential is committed to GitHub.

The signed-in account's UID must be authorized by the deployed Realtime
Database rules. The existing board account works immediately. For stronger
separation, create a second Email/Password user and add this value in the
Realtime Database **Data** tab:

```text
/admins/ADMIN_USER_UID = true
```

Then deploy [../firebase/database.rules.json](../firebase/database.rules.json).
Those rules allow the ESP32 account to write measurements, but allow an entry
under `/admins` to delete history only. An administrator cannot create or alter
sensor readings.

If the browser cannot hold the stream open — a proxy that buffers responses, for
instance — the page falls back to polling `/live` every `refreshSeconds` and
returns to streaming as soon as it can.

The station is marked offline when its Firebase timestamp is older than
`offlineAfterSeconds`. The last known values remain visible while offline.

## Remote access

Deploy the contents of `dashboard/` to a static host. The resulting HTTPS URL
can be opened from any phone or computer. The ESP32 must have Wi-Fi internet
access to publish readings.
