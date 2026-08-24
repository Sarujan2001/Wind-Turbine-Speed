# SPL WindWatch dashboard

This dashboard combines the SPL wind sensor feed with RainViewer radar. It can
be hosted as a static site on GitHub Pages, Cloudflare Pages, Netlify, or any
ordinary web server.

## Preview locally

From the project root:

```powershell
python -m http.server 8080 -d dashboard
```

Open `http://localhost:8080`. Without a ThingSpeak channel ID, the page uses a
clearly labelled demonstration feed while the radar remains live.

## Connect the ESP32 cloud feed

1. Create a ThingSpeak channel with these fields:
   - Field 1: Wind speed m/s
   - Field 2: Wind speed km/h
   - Field 3: WIND_ADC voltage
   - Field 4: Sensor voltage
   - Field 5: Raw ADC
2. Make the channel public if the public dashboard should read it without a key.
3. Copy `include/secrets.h.example` to `include/secrets.h`, then enter the Wi-Fi
   credentials and ThingSpeak Write API Key.
4. Change `CLOUD_CONFIGURED` to `1` in `include/cloud_config.h`.
5. Put the channel number in `dashboard/config.js` as `thingSpeakChannelId`.
6. Rebuild and upload the PlatformIO firmware.

The Write API Key remains only on the ESP32 and is excluded from Git. Never put
the Write API Key in the dashboard.

## Remote access

Deploy the contents of `dashboard/` to a static host. The resulting HTTPS URL
can be opened from any phone or computer. The ESP32 must have Wi-Fi internet
access to publish readings.
