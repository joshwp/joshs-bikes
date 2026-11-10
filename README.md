# Josh's Bikes

A single-user Android PWA showing live Citi Bike availability near five favorite places.
Plain HTML/CSS/JS, no build step, no backend.

- **Data:** Citi Bike GBFS via the gbfs.citibikenyc.com discovery file.
- **Search:** NYC Planning Labs GeoSearch for addresses and Photon (OpenStreetMap) for businesses and places.
  All of them allow direct browser requests, so there is no relay.
- **Reading a tile:** solid = bikes to take (⚡ e-bikes large, classic small); dashed = docks to fill.
  Green 5+, yellow 1–4, red 0.
- **Renaming:** hold any place or station name to rename it; Edit favorites for address, order and replace.
- **Map:** tap a station name to open it in Google Maps (the Maps app on Android).

Dev:
- `node tests/logic.test.js` — logic checks
- `node tests/live-feeds.js` — parse the live feeds for the 25 favorite stations
- `node tools/make-icons.js` — regenerate icons
