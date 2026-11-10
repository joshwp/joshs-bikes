// Logic checks for app.js. Run: node tests/logic.test.js
const assert = require('assert/strict');

// Minimal localStorage shim (the app wraps all access in try/catch anyway).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const A = require('../app.js');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

test('haversine: known distances', () => {
  assert.equal(A.haversineMi(40.7, -74, 40.7, -74), 0);
  // 1 degree of latitude ≈ 69.09 mi
  assert.ok(Math.abs(A.haversineMi(40, -74, 41, -74) - 69.09) < 0.05);
  // Home -> Office (Park Slope -> Union Sq area) ≈ 4.5 mi straight-line
  const [h, o] = A.DEFAULT_FAVORITES;
  const d = A.haversineMi(h.lat, h.lon, o.lat, o.lon);
  assert.ok(d > 4.3 && d < 4.7, `home->office ${d}`);
  // symmetric
  assert.equal(A.haversineMi(h.lat, h.lon, o.lat, o.lon), A.haversineMi(o.lat, o.lon, h.lat, h.lon));
});

test('closestStations: 5 closest, closest first, never more than 5', () => {
  const stations = [];
  for (let i = 0; i < 20; i++) stations.push({ id: 's' + i, name: 'S' + i, lat: 40.7 + (19 - i) * 0.001, lon: -74 });
  const got = A.closestStations(40.7, -74, stations);
  assert.deepEqual(got.map((s) => s.id), ['s19', 's18', 's17', 's16', 's15']);
  assert.equal(A.closestStations(40.7, -74, stations.slice(0, 3)).length, 3);
});

test('Auto rule at exactly 0.5 mile from my location', () => {
  const me = { lat: 40.7, lon: -74 };
  const dLat = (0.5 / A.EARTH_RADIUS_MI) * (180 / Math.PI); // exactly 0.5 mi north
  const at = { lat: me.lat + dLat, lon: me.lon };
  const d = A.haversineMi(me.lat, me.lon, at.lat, at.lon);
  assert.ok(Math.abs(d - 0.5) < 1e-9, `distance ${d}`);
  assert.equal(A.rowMode('auto', at, me), 'bikes'); // within = inclusive
  const justOut = { lat: me.lat + dLat * 1.001, lon: me.lon };
  assert.equal(A.rowMode('auto', justOut, me), 'docks');
  const justIn = { lat: me.lat + dLat * 0.999, lon: me.lon };
  assert.equal(A.rowMode('auto', justIn, me), 'bikes');
  // Manual modes ignore distance
  assert.equal(A.rowMode('bikes', justOut, me), 'bikes');
  assert.equal(A.rowMode('docks', justIn, me), 'docks');
});

test('Auto rule measures from MY location, not the looked-up address', () => {
  // A station right next to a looked-up address, but 3 mi from me -> docks.
  const me = { lat: 40.67, lon: -73.98 };
  const stationNearLookup = { lat: 40.7134, lon: -73.98 };
  assert.ok(A.haversineMi(me.lat, me.lon, stationNearLookup.lat, stationNearLookup.lon) > 2.9);
  assert.equal(A.rowMode('auto', stationNearLookup, me), 'docks');
});

test('color thresholds 0 / 4 / 5', () => {
  assert.equal(A.colorClass(0), 'c-none');
  assert.equal(A.colorClass(1), 'c-low');
  assert.equal(A.colorClass(4), 'c-low');
  assert.equal(A.colorClass(5), 'c-good');
  assert.equal(A.colorClass(23), 'c-good');
});

test('classic-count derivation (num_bikes_available includes e-bikes)', () => {
  assert.deepEqual(A.deriveCounts({ num_bikes_available: 10, num_ebikes_available: 7, num_docks_available: 3 }),
    { ebikes: 7, classic: 3, docks: 3 });
  assert.deepEqual(A.deriveCounts({ num_bikes_available: 0, num_ebikes_available: 0, num_docks_available: 0 }),
    { ebikes: 0, classic: 0, docks: 0 });
  // Defensive: never negative
  assert.deepEqual(A.deriveCounts({ num_bikes_available: 2, num_ebikes_available: 5, num_docks_available: 1 }),
    { ebikes: 2, classic: 0, docks: 1 });
});

test('vehicle_types_available fallback (if the feed ever switches)', () => {
  const types = A.parseVehicleTypes({ data: { vehicle_types: [
    { vehicle_type_id: '1', form_factor: 'bicycle', propulsion_type: 'human' },
    { vehicle_type_id: '2', form_factor: 'bicycle', propulsion_type: 'electric_assist' },
    { vehicle_type_id: '3', form_factor: 'scooter', propulsion_type: 'electric' },
  ] } });
  const s = { num_bikes_available: 9, num_docks_available: 4,
    vehicle_types_available: [{ vehicle_type_id: '1', count: 3 }, { vehicle_type_id: '2', count: 6 }, { vehicle_type_id: '3', count: 2 }] };
  assert.deepEqual(A.deriveCounts(s, types), { ebikes: 6, classic: 3, docks: 4 });
  // No vehicle_types feed: guess from ids
  const s2 = { num_docks_available: 1, vehicle_types_available: [{ vehicle_type_id: 'ebike', count: 2 }, { vehicle_type_id: 'classic', count: 5 }] };
  assert.deepEqual(A.deriveCounts(s2, null), { ebikes: 2, classic: 5, docks: 1 });
  // num_ebikes_available present -> subtraction rule wins
  assert.deepEqual(A.deriveCounts({ ...s, num_ebikes_available: 7 }, types), { ebikes: 7, classic: 2, docks: 4 });
});

test('discovery: GBFS 1.x/2.x and 3.x shapes', () => {
  const v1 = { data: { en: { feeds: [{ name: 'station_status', url: 'a' }, { name: 'station_information', url: 'b' }] } } };
  const v3 = { data: { feeds: [{ name: 'station_status', url: 'c' }, { name: 'station_information', url: 'd' }, { name: 'vehicle_types', url: 'e' }] } };
  assert.deepEqual(A.feedsFromDiscovery(v1), { station_status: 'a', station_information: 'b' });
  assert.deepEqual(A.feedsFromDiscovery(v3), { station_status: 'c', station_information: 'd', vehicle_types: 'e' });
});

test('station notes', () => {
  const ok = { installed: true, renting: true, returning: true };
  assert.equal(A.stationNote(ok), null);
  assert.equal(A.stationNote({ ...ok, installed: false }), 'Closed');
  assert.equal(A.stationNote({ ...ok, renting: false }), 'Not renting');
  assert.equal(A.stationNote({ ...ok, returning: false }), 'No returns');
  assert.equal(A.stationNote(undefined), 'Closed');
});

test('recents: capped at 3, newest first, de-duplicated, old entries migrated', () => {
  let r = [];
  for (const a of ['A st', 'B st', 'C st', 'D st']) r = A.addRecent(r, { name: a, sub: 'Brooklyn', lat: 1, lon: 1 });
  assert.deepEqual(r.map((x) => x.name), ['D st', 'C st', 'B st']); // oldest (A) dropped
  r = A.addRecent(r, { name: 'b ST', sub: 'brooklyn', lat: 1, lon: 1 });
  assert.deepEqual(r.map((x) => x.name), ['b ST', 'D st', 'C st']);
  assert.equal(r.length, A.MAX_RECENTS);
  // Same name, different place (chain restaurants) are distinct
  r = A.addRecent([], { name: "Joe's Pizza", sub: '7 Carmine St', lat: 1, lon: 1 });
  r = A.addRecent(r, { name: "Joe's Pizza", sub: '150 E 14th St', lat: 2, lon: 2 });
  assert.equal(r.length, 2);
  localStorage.setItem(A.STORAGE_KEYS.recents, JSON.stringify([{ address: '1 Main St', lat: 1, lon: 2 }]));
  assert.deepEqual(A.loadRecents(), [{ name: '1 Main St', sub: '', lat: 1, lon: 2 }]);
  localStorage.removeItem(A.STORAGE_KEYS.recents);
});

test('station nicknames: set, clear, reset to official, display', () => {
  let n = A.setNickname({}, 's1', '  Corner of 6th ', '5 St & 6 Ave');
  assert.deepEqual(n, { s1: 'Corner of 6th' });
  assert.equal(A.displayName({ id: 's1', name: '5 St & 6 Ave' }, n), 'Corner of 6th');
  assert.equal(A.displayName({ id: 's2', name: '6 St & 7 Ave' }, n), '6 St & 7 Ave');
  assert.deepEqual(A.setNickname(n, 's1', '', '5 St & 6 Ave'), {});
  assert.deepEqual(A.setNickname(n, 's1', '5 St & 6 Ave', '5 St & 6 Ave'), {}); // same as official = reset
  localStorage.setItem(A.STORAGE_KEYS.nicknames, JSON.stringify({ a: 'Mine', b: 5, c: '  ' }));
  assert.deepEqual(A.loadNicknames(), { a: 'Mine' });
  localStorage.setItem(A.STORAGE_KEYS.nicknames, '[1,2]');
  assert.deepEqual(A.loadNicknames(), {});
  localStorage.removeItem(A.STORAGE_KEYS.nicknames);
});

test('per-card modes default to Auto; first card expanded on phones, all on wide screens', () => {
  const s = A.createState({ wide: false });
  assert.equal(A.cardMode(s, s.favorites[1].id), 'auto');
  assert.deepEqual([...s.expanded], [s.favorites[0].id]);
  const w = A.createState({ wide: true });
  assert.equal(w.expanded.size, 5);
  s.modes.set(s.favorites[1].id, 'docks');
  assert.equal(A.cardMode(s, s.favorites[1].id), 'docks');
  assert.equal(A.cardMode(s, s.favorites[0].id), 'auto'); // independent per card
});

test('address prettifying', () => {
  assert.equal(A.prettyStreet('413 6 STREET'), '413 6th St');
  assert.equal(A.prettyStreet('540 EAST 71 STREET'), '540 E 71st St');
  assert.equal(A.prettyStreet('39 CLAREMONT AVENUE'), '39 Claremont Ave');
  assert.equal(A.prettyStreet('7 Carmine Street'), '7 Carmine St');
  assert.equal(A.prettyStreet('100 WEST 112 STREET'), '100 W 112th St');
  assert.equal(A.prettyStreet('1 EAST 161 STREET'), '1 E 161st St');
  assert.equal(A.prettyStreet('5 EAST 13 STREET'), '5 E 13th St');
});

test('Photon places parsing (businesses), filters non-places', () => {
  const json = { features: [
    { geometry: { coordinates: [-74.0045, 40.733] }, properties: { name: 'Via Carota', osm_key: 'amenity', osm_value: 'restaurant', type: 'house', housenumber: '51', street: 'Grove Street', district: 'Manhattan', city: 'New York' } },
    { geometry: { coordinates: [-73.97, 40.67] }, properties: { name: 'Crunch Fitness', osm_key: 'leisure', osm_value: 'fitness_centre', housenumber: '314', street: 'Flatbush Avenue', city: 'Brooklyn' } },
    { geometry: { coordinates: [-73.9, 40.7] }, properties: { name: 'Grove Street', osm_key: 'highway', osm_value: 'residential' } },
    { geometry: { coordinates: [-73.9, 40.7] }, properties: { osm_key: 'building', type: 'house', housenumber: '5' } },
    { geometry: { coordinates: [-73.9, 40.7] }, properties: { name: 'Main Street', osm_key: 'place', osm_value: 'city' } },
    { geometry: { coordinates: [-74.0045, 40.733] }, properties: { name: 'Via Carota', osm_key: 'amenity', osm_value: 'restaurant', housenumber: '51', street: 'Grove Street', district: 'Manhattan' } },
  ] };
  const r = A.parsePhoton(json);
  assert.deepEqual(r, [
    { kind: 'place', name: 'Via Carota', sub: '51 Grove St, Manhattan', category: 'Restaurant', lat: 40.733, lon: -74.0045 },
    { kind: 'place', name: 'Crunch Fitness', sub: '314 Flatbush Ave, Brooklyn', category: 'Gym', lat: 40.67, lon: -73.97 },
  ]);
});

test('GeoSearch address parsing keeps addresses only', () => {
  const json = { features: [
    { geometry: { coordinates: [-73.981835, 40.669765] }, properties: { label: '413 6 STREET, Brooklyn, NY, USA', layer: 'venue' } },
    { geometry: { coordinates: [-73.95, 40.76] }, properties: { label: 'HOSPITAL FOR SPECIAL SURGERY, New York, NY, USA', layer: 'venue' } },
  ] };
  assert.deepEqual(A.parseGeoSearch(json), [{ kind: 'address', name: '413 6th St', sub: 'Brooklyn', lat: 40.669765, lon: -73.981835 }]);
});

test('same-name branches sorted nearest first; other places keep relevance order', () => {
  const near = { lat: 40.67, lon: -73.98 };
  const list = [
    { name: "Joe's Pizza", lat: 40.73, lon: -74.0 },   // far
    { name: 'Joes Bar', lat: 40.80, lon: -73.95 },
    { name: "joe's pizza", lat: 40.671, lon: -73.98 }, // near
  ];
  assert.deepEqual(A.sortBranches(list, near).map((p) => `${p.name}@${p.lat}`), ["joe's pizza@40.671", "Joe's Pizza@40.73", 'Joes Bar@40.8']);
});

test('distance formatting for search suggestions', () => {
  assert.equal(A.formatMiles(0.04), '<0.1 mi');
  assert.equal(A.formatMiles(3.14159), '3.1 mi');
  assert.equal(A.formatMiles(12.6), '13 mi');
});

test('modes, expansion and location override reset on a fresh state (reload)', () => {
  const s1 = A.createState();
  s1.modes.set(s1.favorites[0].id, 'docks');
  s1.expanded.add(s1.favorites[3].id);
  s1.override = { kind: 'place', label: '1 Main St', lat: 40.7, lon: -74 };
  assert.equal(A.myLocation(s1).source, '1 Main St');
  // None of these are persisted anywhere
  for (const v of store.values()) assert.ok(!v.includes('docks') && !v.includes('1 Main St'));
  const s2 = A.createState();
  assert.equal(A.cardMode(s2, s2.favorites[0].id), 'auto');
  assert.deepEqual([...s2.expanded], [s2.favorites[0].id]);
  assert.equal(s2.override, null);
});

test('GPS denied -> Home coordinates', () => {
  const s = A.createState();
  s.gps = { status: 'unavailable', lat: null, lon: null };
  const me = A.myLocation(s);
  assert.equal(me.lat, A.DEFAULT_FAVORITES[0].lat);
  assert.equal(me.lon, A.DEFAULT_FAVORITES[0].lon);
  assert.equal(me.source, 'Home (no GPS)');
  // Renamed and moved Home is still Home (tracked by id)
  const home = s.favorites[0];
  s.favorites = [s.favorites[1], { ...home, label: 'Casa', lat: 40.6, lon: -73.9 }, ...s.favorites.slice(2)];
  assert.deepEqual(A.myLocation(s), { lat: 40.6, lon: -73.9, source: 'Casa (no GPS)' });
  s.gps = { status: 'ok', lat: 40.8, lon: -73.9 };
  assert.deepEqual(A.myLocation(s), { lat: 40.8, lon: -73.9, source: 'GPS' });
});

test('favorites: defaults in fixed order; storage round-trip; bad storage ignored', () => {
  store.clear();
  assert.deepEqual(A.loadFavorites().map((f) => f.label), ['Home', 'Office', 'Crunch', "Dad's", 'HSS']);
  const custom = [{ id: 'x', label: 'Gym', address: '1 A St', lat: 40.7, lon: -74 }];
  localStorage.setItem(A.STORAGE_KEYS.favorites, JSON.stringify(custom));
  assert.deepEqual(A.loadFavorites(), custom);
  localStorage.setItem(A.STORAGE_KEYS.favorites, '{not json');
  assert.equal(A.loadFavorites().length, 5);
  const throwing = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(A.loadFavorites().length, 5);
  assert.deepEqual(A.loadRecents(), []);
  globalThis.localStorage = throwing;
});

test('formatUpdated', () => {
  const t = 1_000_000_000;
  assert.equal(A.formatUpdated(t, t + 30_000), 'Updated just now');
  assert.equal(A.formatUpdated(t, t + 60_000), 'Updated 1 min ago');
  assert.equal(A.formatUpdated(t, t + 7 * 60_000 + 5), 'Updated 7 min ago');
});

test('mapsUrl: Google Maps search link to the exact point', () => {
  assert.equal(A.mapsUrl(40.669765, -73.981835),
    'https://www.google.com/maps/search/?api=1&query=40.669765,-73.981835');
  assert.equal(A.mapsUrl(40.7, -74), 'https://www.google.com/maps/search/?api=1&query=40.700000,-74.000000');
});

console.log(`\n${passed} checks passed`);
