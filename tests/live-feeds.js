// Fetches the live feeds (via discovery) and prints the 25 favorite rows as the app parses them.
// Run: node tests/live-feeds.js
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const A = require('../app.js');
(async () => {
  const disc = await (await fetch('https://gbfs.citibikenyc.com/gbfs/gbfs.json')).json();
  const feeds = Object.fromEntries(disc.data.en.feeds.map((f) => [f.name, f.url]));
  console.log('info:', feeds.station_information, '\nstatus:', feeds.station_status);
  const info = A.parseStationInfo(await (await fetch(feeds.station_information)).json());
  const status = A.parseStationStatus(await (await fetch(feeds.station_status)).json());
  console.log(`stations: ${info.length} info, ${status.size} status`);
  let n = 0, bad = 0;
  for (const f of A.DEFAULT_FAVORITES) {
    console.log(`\n${f.label}`);
    for (const s of A.closestStations(f.lat, f.lon, info)) {
      const st = status.get(s.id); n++;
      const note = A.stationNote(st);
      const d = A.haversineMi(f.lat, f.lon, s.lat, s.lon).toFixed(2);
      if (st && (st.ebikes < 0 || st.classic < 0 || st.docks < 0)) bad++;
      console.log(`  ${s.name.padEnd(36)} ${d}mi  ${note || `ebikes ${st.ebikes} (classic ${st.classic})  docks ${st.docks}`}`);
    }
  }
  console.log(`\n${n} rows, ${bad} with bad counts`);
})();
