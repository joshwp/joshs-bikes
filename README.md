# Josh's Bikes

A single-user Android PWA showing live Citi Bike availability near five favorite places.
Plain HTML/CSS/JS, no build step. Data: Citi Bike GBFS (via gbfs.citibikenyc.com discovery)
and NYC Planning Labs GeoSearch, both fetched directly from the browser (both allow CORS).

- `node tests/logic.test.js` — logic checks
- `node tests/live-feeds.js` — parse the live feeds for the 25 favorite stations
- `node tools/make-icons.js` — regenerate icons
