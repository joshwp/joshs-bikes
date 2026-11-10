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

test('recents: capped at 3, newest first, de-duplicated', () => {
  let r = [];
  for (const a of ['A st', 'B st', 'C st', 'D st']) r = A.addRecent(r, { address: a, lat: 1, lon: 1 });
  assert.deepEqual(r.map((x) => x.address), ['D st', 'C st', 'B st']); // oldest (A) dropped
  r = A.addRecent(r, { address: 'b ST', lat: 1, lon: 1 });
  assert.deepEqual(r.map((x) => x.address), ['b ST', 'D st', 'C st']);
  assert.equal(r.length, A.MAX_RECENTS);
});

test('toggle and location override reset on a fresh state (reload)', () => {
  const s1 = A.createState();
  assert.equal(s1.mode, 'auto');
  assert.equal(s1.override, null);
  s1.mode = 'docks';
  s1.override = { kind: 'address', label: '1 Main St', lat: 40.7, lon: -74 };
  assert.equal(A.myLocation(s1).source, '1 Main St');
  // Neither is persisted anywhere
  for (const v of store.values()) assert.ok(!v.includes('docks') && !v.includes('1 Main St'));
  const s2 = A.createState();
  assert.equal(s2.mode, 'auto');
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

console.log(`\n${passed} checks passed`);
