# Josh's Bikes

A single-user Android PWA showing live Citi Bike availability near up to ten favorite places.
Plain HTML/CSS/JS, no build step; one small Vercel Function for shared station names.

- **Data:** Citi Bike GBFS via the gbfs.citibikenyc.com discovery file.
- **Search:** NYC Planning Labs GeoSearch for addresses and Photon (OpenStreetMap) for businesses and places.
  All of them allow direct browser requests, so there is no relay.
- **Reading a tile:** solid = bikes to take (⚡ e-bikes large, classic small); dashed = docks to fill.
  Green 5+, yellow 1–4, red 0 (the key at the bottom of the page).
- **Favorites:** start with five, up to ten. "Save as favorite" on a search adds one (or replaces one when full);
  Edit favorites adds, removes, reorders and replaces.
- **Renaming:** tap the ✎ beside a station name (or hold any place or station name) to rename it right in
  the row (Save, Cancel, Use official name).
  Renamed stations show their official name underneath.
- **Map:** tap a station name to open it in Google Maps (the Maps app on Android).
- **Shared names:** station nicknames sync across browsers through `api/nicknames.js`, a Vercel Function
  backed by an Upstash Redis store (`joshs-bikes-names`, free plan, via the Vercel Marketplace).
  Each browser keeps a local copy and queues offline changes. No login — single user.

Dev:
- `vercel dev` — run the app and the names API locally (needs `vercel env pull` once)
- `node tests/logic.test.js` — logic checks
- `node tests/live-feeds.js` — parse the live feeds for the 25 favorite stations
- `node tools/make-icons.js` — regenerate icons
