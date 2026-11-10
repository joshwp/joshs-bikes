/* Josh's Bikes — live Citi Bike availability for my favorite places.
 * Plain browser JavaScript, no build step. Pure logic is exported for
 * Node-based checks at the bottom of the file; the UI only boots in a browser.
 *
 * Sections: Config · Storage · Data fetching · Geocoding and search ·
 * Distance and ranking · State · Browser app (rendering, search UI, rename,
 * edit mode, pull-to-refresh, boot) · Exports
 */
'use strict';

/* =====================================================================
 * Config
 * ===================================================================== */
const DISCOVERY_URL = 'https://gbfs.citibikenyc.com/gbfs/gbfs.json';
// Confirmed live 2026-11-10: the discovery file points at Lyft's GBFS 1.1 feeds.
const DEFAULT_FEEDS = {
  station_information: 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json',
  station_status: 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json',
};
const GEOSEARCH_URL = 'https://geosearch.planninglabs.nyc/v2';   // NYC addresses (no key)
const PHOTON_URL = 'https://photon.komoot.io/api/';               // OpenStreetMap places (no key)
const NYC_BBOX = '-74.27,40.48,-73.68,40.93';                     // minLon,minLat,maxLon,maxLat

const AUTO_RADIUS_MI = 0.5;
const STATIONS_PER_PLACE = 5;
const MAX_FAVORITES = 5;
const MAX_RECENTS = 3;
const EARTH_RADIUS_MI = 3958.7613;
const WIDE_QUERY = '(min-width: 760px)'; // desktop/tablet: grid layout, everything expanded

// Geocoded at build time with NYC Planning Labs GeoSearch (top result).
const DEFAULT_FAVORITES = [
  { label: 'Home',   address: '413 6th St, Brooklyn, NY 11215',     lat: 40.669765, lon: -73.981835 },
  { label: 'Office', address: '44 E 12th St, New York, NY 10003',   lat: 40.733309, lon: -73.991826 },
  { label: 'Crunch', address: '314 Flatbush Ave, Brooklyn, NY 11238', lat: 40.677115, lon: -73.972718 },
  { label: "Dad's",  address: '39 Claremont Ave, New York, NY 10027', lat: 40.809896, lon: -73.964093 },
  { label: 'HSS',    address: '540 E 71st St, New York, NY 10021',  lat: 40.765055, lon: -73.952546 },
];

const HOME_ID = 'home';

const STORAGE_KEYS = {
  favorites: 'jb.favorites.v1',
  recents: 'jb.recents.v1',
  nicknames: 'jb.nicknames.v1',   // { station_id: "My name" }
  stationInfo: 'jb.stationInfo.v1',
  lastStatus: 'jb.lastStatus.v1', // last good station_status, shown if a fetch fails
  feeds: 'jb.feeds.v1',
};

/* =====================================================================
 * Storage (every access wrapped: private mode / quota / disabled storage)
 * ===================================================================== */
function loadJSON(key, fallback) {
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

/* =====================================================================
 * Data fetching (GBFS)
 * ===================================================================== */
async function fetchJSON(url, signal) {
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Feed list from a discovery file: GBFS 1.x/2.x (data.en.feeds) or 3.x (data.feeds). */
function feedsFromDiscovery(d) {
  const data = (d && d.data) || {};
  const list = Array.isArray(data.feeds) ? data.feeds : (data.en && data.en.feeds) || [];
  const out = {};
  for (const f of list) {
    if (['station_information', 'station_status', 'vehicle_types'].includes(f.name)) out[f.name] = f.url;
  }
  return out;
}

/** Follow the auto-discovery file to the English feeds; fall back to the last known URLs. */
async function discoverFeeds() {
  try {
    const out = feedsFromDiscovery(await fetchJSON(DISCOVERY_URL));
    if (out.station_information && out.station_status) {
      saveJSON(STORAGE_KEYS.feeds, out);
      return out;
    }
  } catch (e) { /* fall through */ }
  const cached = loadJSON(STORAGE_KEYS.feeds, null);
  return cached && cached.station_information && cached.station_status ? cached : DEFAULT_FEEDS;
}

/** station_information -> [{id, name, lat, lon}] */
function parseStationInfo(json) {
  const list = (json && json.data && json.data.stations) || [];
  const out = [];
  for (const s of list) {
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!s.station_id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ id: String(s.station_id), name: String(s.name || 'Unnamed station'), lat, lon });
  }
  return out;
}

/** vehicle_types feed -> Map(vehicle_type_id -> {form, propulsion}) */
function parseVehicleTypes(json) {
  const list = (json && json.data && json.data.vehicle_types) || [];
  return new Map(list.map((t) => [String(t.vehicle_type_id), {
    form: String(t.form_factor || ''), propulsion: String(t.propulsion_type || ''),
  }]));
}

function isBicycleType(id, types) {
  const t = types && types.get(String(id));
  if (t) return !t.form || t.form === 'bicycle';
  return !/scooter|moped|car/i.test(String(id));
}

function isElectricType(id, types) {
  const t = types && types.get(String(id));
  if (t) return t.propulsion.startsWith('electric');
  return /e-?bike|electric|pedelec/i.test(String(id)); // no type info: best guess from the id
}

/**
 * Counts for one station_status record. In the live Citi Bike feed (GBFS 1.1,
 * confirmed 2026-11-10) num_bikes_available INCLUDES e-bikes, so
 * classic = bikes − ebikes. If a future feed drops num_ebikes_available in favor
 * of vehicle_types_available, the counts are derived from that instead.
 */
function deriveCounts(s, vehicleTypes) {
  const docks = Math.max(0, Number(s.num_docks_available) || 0);
  if (s.num_ebikes_available == null && Array.isArray(s.vehicle_types_available)) {
    let ebikes = 0, classic = 0;
    for (const v of s.vehicle_types_available) {
      const n = Math.max(0, Number(v.count) || 0);
      if (!isBicycleType(v.vehicle_type_id, vehicleTypes)) continue;
      if (isElectricType(v.vehicle_type_id, vehicleTypes)) ebikes += n; else classic += n;
    }
    return { ebikes, classic, docks };
  }
  const bikes = Math.max(0, Number(s.num_bikes_available) || 0);
  const ebikes = Math.min(bikes, Math.max(0, Number(s.num_ebikes_available) || 0));
  return { ebikes, classic: bikes - ebikes, docks };
}

function statusUsesVehicleTypes(json) {
  const list = (json && json.data && json.data.stations) || [];
  return list.some((s) => s.num_ebikes_available == null && Array.isArray(s.vehicle_types_available));
}

/** station_status -> Map(id -> {ebikes, classic, docks, installed, renting, returning}) */
function parseStationStatus(json, vehicleTypes) {
  const list = (json && json.data && json.data.stations) || [];
  const map = new Map();
  for (const s of list) {
    if (!s.station_id) continue;
    map.set(String(s.station_id), {
      ...deriveCounts(s, vehicleTypes),
      installed: !!s.is_installed,
      renting: !!s.is_renting,
      returning: !!s.is_returning,
    });
  }
  return map;
}

/* =====================================================================
 * Geocoding and search
 *   Addresses: NYC Planning Labs GeoSearch. Places/businesses: Photon (OSM).
 * ===================================================================== */
const STREET_ABBR = [
  [/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bBoulevard\b/g, 'Blvd'], [/\bPlace\b/g, 'Pl'],
  [/\bRoad\b/g, 'Rd'], [/\bParkway\b/g, 'Pkwy'], [/\bDrive\b/g, 'Dr'], [/\bTerrace\b/g, 'Ter'],
  [/\bEast (?=\d)/g, 'E '], [/\bWest (?=\d)/g, 'W '], [/\bNorth (?=\d)/g, 'N '], [/\bSouth (?=\d)/g, 'S '],
];

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

/** "540 EAST 71 STREET" -> "540 E 71st St"; "6th Street" -> "6th St". */
function prettyStreet(s) {
  let out = /[a-z]/.test(s) ? String(s) : titleCase(s);
  for (const [re, to] of STREET_ABBR) out = out.replace(re, to);
  // Bare street numbers get ordinals: "413 6 St" -> "413 6th St" (house number untouched).
  out = out.replace(/(\s)(\d+)(?= (St|Ave|Pl|Rd|Dr|Ter|Blvd)\b)/g, (m, sp, n) => sp + ordinal(Number(n)));
  return out.trim();
}

const CATEGORY_NAMES = {
  restaurant: 'Restaurant', fast_food: 'Fast food', cafe: 'Café', bar: 'Bar', pub: 'Pub',
  biergarten: 'Beer garden', ice_cream: 'Ice cream', bakery: 'Bakery', fitness_centre: 'Gym',
  sports_centre: 'Sports center', hospital: 'Hospital', clinic: 'Clinic', doctors: 'Doctor',
  dentist: 'Dentist', pharmacy: 'Pharmacy', supermarket: 'Supermarket', convenience: 'Shop',
  park: 'Park', museum: 'Museum', theatre: 'Theater', cinema: 'Cinema', school: 'School',
  university: 'University', college: 'College', hotel: 'Hotel', library: 'Library',
  place_of_worship: 'Place of worship', station: 'Station', attraction: 'Attraction',
  marketplace: 'Market', stadium: 'Stadium', arts_centre: 'Arts center', nightclub: 'Club',
};

function categoryLabel(key, value) {
  if (key === 'place') return 'Neighborhood';
  if (CATEGORY_NAMES[value]) return CATEGORY_NAMES[value];
  const v = String(value || key || 'Place').replace(/_/g, ' ');
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/** Photon GeoJSON -> [{kind:'place', name, sub, category, lat, lon}] */
function parsePhoton(json) {
  const out = [];
  const seen = new Set();
  for (const f of (json && json.features) || []) {
    const p = f.properties || {};
    const c = f.geometry && f.geometry.coordinates;
    if (!p.name || !Array.isArray(c)) continue;
    // Named businesses come back as type "house" (they sit at an address); streets and areas don't count.
    if (['highway', 'boundary', 'landuse', 'railway'].includes(p.osm_key) || p.type === 'street') continue;
    if (p.osm_key === 'place' && ['city', 'state', 'country', 'county'].includes(p.osm_value)) continue;
    if (p.state && p.state !== 'New York') continue; // the search box covers NYC; the bbox also catches NJ
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const area = p.district || p.locality || (p.city !== 'New York' ? p.city : '') || '';
    const sub = [street && prettyStreet(street), area].filter(Boolean).join(', ');
    const key = `${p.name}|${sub}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'place', name: p.name, sub, category: categoryLabel(p.osm_key, p.osm_value), lat: c[1], lon: c[0] });
  }
  return out;
}

/** GeoSearch autocomplete/search GeoJSON -> [{kind:'address', name, sub, lat, lon}] (addresses only) */
function parseGeoSearch(json) {
  const out = [];
  for (const f of (json && json.features) || []) {
    const p = f.properties || {};
    const c = f.geometry && f.geometry.coordinates;
    if (!Array.isArray(c)) continue;
    const parts = String(p.label || p.name || '').split(',').map((x) => x.trim()).filter(Boolean);
    // GeoSearch tags plain addresses as "venue" too; an address starts with a house number.
    // Named places are left to Photon, which has better business coverage.
    if (!parts.length || !/^\d/.test(parts[0])) continue;
    out.push({ kind: 'address', name: prettyStreet(parts[0]), sub: parts[1] || '', lat: c[1], lon: c[0] });
  }
  return out;
}

/** Keep the search's relevance order between different places, but list branches of the same name nearest first. */
function sortBranches(places, near) {
  if (!near) return places;
  const firstSeen = new Map();
  places.forEach((p, i) => { const k = norm(p.name); if (!firstSeen.has(k)) firstSeen.set(k, i); });
  const d = (p) => haversineMi(near.lat, near.lon, p.lat, p.lon);
  return [...places].sort((a, b) => (firstSeen.get(norm(a.name)) - firstSeen.get(norm(b.name))) || (d(a) - d(b)));
}

async function searchAddresses(q, signal) {
  const url = `${GEOSEARCH_URL}/autocomplete?text=${encodeURIComponent(q)}`;
  return parseGeoSearch(await fetchJSON(url, signal)).slice(0, 3);
}

async function searchPlaces(q, near, signal) {
  // Ask for plenty: Photon ranks by relevance, so the nearest branch of a chain can sit well down the list.
  const params = new URLSearchParams({ q, limit: '40', lang: 'en', bbox: NYC_BBOX });
  if (near) { params.set('lat', near.lat.toFixed(4)); params.set('lon', near.lon.toFixed(4)); }
  return sortBranches(parsePhoton(await fetchJSON(`${PHOTON_URL}?${params}`, signal)), near).slice(0, 5);
}

/** Typed text -> one point (used when an address is typed but no suggestion was picked). */
async function geocode(text) {
  const q = String(text || '').trim();
  if (!q) throw new Error('empty');
  const address = async () => {
    const res = parseGeoSearch(await fetchJSON(`${GEOSEARCH_URL}/search?text=${encodeURIComponent(q)}&size=1`));
    if (!res.length) throw new Error('not found');
    return res[0];
  };
  const place = async () => {
    const res = await searchPlaces(q, null);
    if (!res.length) throw new Error('not found');
    return res[0];
  };
  // "413 6th St" is an address; "Via Carota" is a place (GeoSearch would fuzzy-match a street).
  const [first, second] = /^\d/.test(q) ? [address, place] : [place, address];
  try { return await first(); } catch (e) { return second(); }
}

/* =====================================================================
 * Distance and ranking
 * ===================================================================== */
function haversineMi(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The k stations closest to (lat, lon), closest first. */
function closestStations(lat, lon, stations, k = STATIONS_PER_PLACE) {
  return stations
    .map((s) => ({ s, d: haversineMi(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => x.s);
}

/** Auto rule: within 0.5 mi (inclusive) of MY location -> bikes, else docks. */
function rowMode(toggle, station, me) {
  if (toggle === 'bikes' || toggle === 'docks') return toggle;
  const d = haversineMi(me.lat, me.lon, station.lat, station.lon);
  return d <= AUTO_RADIUS_MI + 1e-9 ? 'bikes' : 'docks';
}

/** 5+ green, 1–4 yellow, 0 red. */
function colorClass(n) {
  if (n >= 5) return 'c-good';
  if (n >= 1) return 'c-low';
  return 'c-none';
}

/** Short note for a station that can't be used normally, or null. */
function stationNote(st) {
  if (!st || !st.installed) return 'Closed';
  if (!st.renting) return 'Not renting';
  if (!st.returning) return 'No returns';
  return null;
}

/** Google Maps link to a point. On Android this opens the Maps app when it's installed. */
function mapsUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

function formatMiles(d) {
  if (!Number.isFinite(d)) return '';
  if (d < 0.1) return '<0.1 mi';
  return d < 10 ? `${d.toFixed(1)} mi` : `${Math.round(d)} mi`;
}

/* =====================================================================
 * State: favorites, recents, nicknames, per-card modes, location
 * ===================================================================== */
let idCounter = 0;
function newId() { idCounter += 1; return `f${Date.now().toString(36)}${idCounter}`; }

function isPlace(p) {
  return p && typeof p.label === 'string' && p.label.trim() &&
    typeof p.address === 'string' && p.address.trim() &&
    Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

function loadFavorites() {
  const saved = loadJSON(STORAGE_KEYS.favorites, null);
  const list = Array.isArray(saved) && saved.length >= 1 && saved.length <= MAX_FAVORITES && saved.every(isPlace)
    ? saved : DEFAULT_FAVORITES;
  return list.map((f, i) => ({
    id: f.id || (list === DEFAULT_FAVORITES && i === 0 ? HOME_ID : newId()),
    label: f.label, address: f.address, lat: f.lat, lon: f.lon,
  }));
}

/** Recents: [{name, sub, lat, lon}], newest first. Older {address} entries are migrated. */
function loadRecents() {
  const saved = loadJSON(STORAGE_KEYS.recents, []);
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((r) => r && (typeof r.name === 'string' || typeof r.address === 'string') &&
      Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .map((r) => ({ name: r.name || r.address, sub: r.sub || '', lat: r.lat, lon: r.lon }))
    .slice(0, MAX_RECENTS);
}

function loadNicknames() {
  const saved = loadJSON(STORAGE_KEYS.nicknames, {});
  const out = {};
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const [k, v] of Object.entries(saved)) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Set (or clear, with an empty name) a station nickname. Returns a new map. */
function setNickname(nicknames, stationId, name, officialName) {
  const out = { ...nicknames };
  const v = String(name || '').trim();
  if (!v || v === officialName) delete out[stationId]; else out[stationId] = v;
  return out;
}

function displayName(station, nicknames) {
  return (nicknames && nicknames[station.id]) || station.name;
}

function norm(s) { return String(s).trim().toLowerCase().replace(/\s+/g, ' '); }

/** Newest first, de-duplicated, capped at 3 (a new lookup drops the oldest). */
function addRecent(recents, entry) {
  const key = norm(`${entry.name}|${entry.sub || ''}`);
  const rest = recents.filter((r) => norm(`${r.name}|${r.sub || ''}`) !== key);
  return [{ name: entry.name, sub: entry.sub || '', lat: entry.lat, lon: entry.lon }, ...rest].slice(0, MAX_RECENTS);
}

/** The Home favorite (tracked by id, so renaming or moving it keeps it Home). */
function homeFavorite(favorites) {
  return favorites.find((f) => f.id === HOME_ID) ||
    favorites.find((f) => f.label.trim().toLowerCase() === 'home') || null;
}

function homeCoords(favorites) {
  const home = homeFavorite(favorites);
  return home ? { lat: home.lat, lon: home.lon } : { lat: DEFAULT_FAVORITES[0].lat, lon: DEFAULT_FAVORITES[0].lon };
}

/** Which cards start expanded: phones show the first; wide screens show all. */
function initialExpanded(favorites, wide) {
  return new Set(wide ? favorites.map((f) => f.id) : favorites.slice(0, 1).map((f) => f.id));
}

/** Creates the per-open, in-memory app state. Modes, expansion and location override are never stored. */
function createState({ wide = false } = {}) {
  const favorites = loadFavorites();
  return {
    favorites,
    recents: loadRecents(),
    nicknames: loadNicknames(),
    modes: new Map(),             // card key -> 'auto' | 'bikes' | 'docks' (missing = auto) — memory only
    expanded: initialExpanded(favorites, wide), // memory only
    gps: { status: 'pending', lat: null, lon: null }, // 'pending' | 'ok' | 'unavailable'
    override: null,               // {kind: 'favorite'|'place', id?, label, lat, lon} — memory only
    stations: [],
    status: new Map(),
    lastLoad: 0,
    lastAttempt: 0,
    refreshFailed: false,
    loading: false,
    lookup: null,                 // {name, sub, lat, lon}
    picking: false,               // "Save as favorite" chooser open
    editing: false,
    renaming: false,
    draft: null,
    saving: false,
    locOpen: false,
  };
}

function cardMode(st, key) { return st.modes.get(key) || 'auto'; }

/** Where "my location" is right now, and what to call it in the header. */
function myLocation(st) {
  if (st.override) return { lat: st.override.lat, lon: st.override.lon, source: st.override.label };
  if (st.gps.status === 'ok') return { lat: st.gps.lat, lon: st.gps.lon, source: 'GPS' };
  const home = homeCoords(st.favorites);
  const hf = homeFavorite(st.favorites);
  return { ...home, source: st.gps.status === 'pending' ? 'GPS…' : `${hf ? hf.label : 'Home'} (no GPS)` };
}

function minutesAgo(t, now) { return Math.max(0, Math.floor((now - t) / 60000)); }

function formatUpdated(lastLoad, now) {
  if (!lastLoad) return '';
  const min = minutesAgo(lastLoad, now);
  return min < 1 ? 'Updated just now' : `Updated ${min} min ago`;
}

/* =====================================================================
 * Browser app
 * ===================================================================== */
const ICONS = {
  bike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 9h6.5l3 7.5M12 16.5 9 9M8 6h3M15.5 9l-1.2-3H17"/></svg>',
  dock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="4"/><path d="M10 17V7.5h3.2a2.8 2.8 0 0 1 0 5.6H10"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13.5 2 4.5 13.5h6L9.5 22l9-11.5h-6z"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  pinOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s7-6.1 7-12a7 7 0 0 0-14 0c0 5.9 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h16M5 10l1.2-5h11.6L19 10M6 10v10h12V10M10 20v-5h4v5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
};

function bootApp() {
  const wideMq = window.matchMedia(WIDE_QUERY);
  const state = createState({ wide: wideMq.matches });
  globalThis.__jb = state; // handy for debugging in DevTools

  const $ = (sel) => document.querySelector(sel);
  const els = {
    updated: $('#updated'),
    failLine: $('#failLine'),
    locBtn: $('#locBtn'),
    locLabel: $('#locLabel'),
    locPanel: $('#locPanel'),
    locChoices: $('#locChoices'),
    locInput: $('#locInput'),
    locSuggest: $('#locSuggest'),
    allBtn: $('#allBtn'),
    q: $('#q'),
    qClear: $('#qClear'),
    suggest: $('#suggest'),
    cards: $('#cards'),
    editBtn: $('#editBtn'),
    ptr: $('#ptr'),
  };

  /** Tiny element builder; all text goes through textContent. `icon` inserts a trusted ICONS svg. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'icon') el.innerHTML = ICONS[v];
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }
  const icon = (name, cls = 'ic') => h('span', { class: cls, icon: name, 'aria-hidden': 'true' });

  /* ---------------- Data loading ---------------- */
  let feedsPromise = null;
  let vehicleTypes = null; // only fetched if the feed ever switches to vehicle_types_available

  function restoreStationCache() {
    const cached = loadJSON(STORAGE_KEYS.stationInfo, null);
    if (cached && Array.isArray(cached.stations)) {
      state.stations = cached.stations
        .filter((a) => Array.isArray(a) && a.length === 4)
        .map(([id, name, lat, lon]) => ({ id, name, lat, lon }));
    }
  }

  function storeStationCache(stations) {
    saveJSON(STORAGE_KEYS.stationInfo, {
      savedAt: Date.now(),
      stations: stations.map((s) => [s.id, s.name, s.lat, s.lon]),
    });
  }

  /** Last good status, so an offline open still shows numbers (with "Couldn't refresh"). */
  function restoreStatusCache() {
    const cached = loadJSON(STORAGE_KEYS.lastStatus, null);
    if (!cached || !Array.isArray(cached.rows) || !Number.isFinite(cached.savedAt)) return;
    const map = new Map();
    for (const r of cached.rows) {
      if (!Array.isArray(r) || r.length !== 5) continue;
      const [id, ebikes, classic, docks, flags] = r;
      map.set(id, { ebikes, classic, docks, installed: !!(flags & 1), renting: !!(flags & 2), returning: !!(flags & 4) });
    }
    if (map.size) { state.status = map; state.lastLoad = cached.savedAt; }
  }

  function storeStatusCache(map, savedAt) {
    const rows = [];
    for (const [id, s] of map) {
      rows.push([id, s.ebikes, s.classic, s.docks, (s.installed ? 1 : 0) | (s.renting ? 2 : 0) | (s.returning ? 4 : 0)]);
    }
    saveJSON(STORAGE_KEYS.lastStatus, { savedAt, rows });
  }

  /** On open: station_information + station_status. On pull-down: status only. */
  async function refresh({ withInfo = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    state.lastAttempt = Date.now();
    renderStatus();
    try {
      if (!feedsPromise) feedsPromise = discoverFeeds();
      const feeds = await feedsPromise;
      const [infoRes, statusRes] = await Promise.allSettled([
        withInfo || !state.stations.length ? fetchJSON(feeds.station_information) : Promise.resolve(null),
        fetchJSON(feeds.station_status),
      ]);
      if (infoRes.status === 'fulfilled' && infoRes.value) {
        const stations = parseStationInfo(infoRes.value);
        if (stations.length) {
          state.stations = stations;
          storeStationCache(stations);
        }
      }
      if (statusRes.status !== 'fulfilled') throw statusRes.reason;
      if (!state.stations.length) throw new Error('no station information');
      if (!vehicleTypes && feeds.vehicle_types && statusUsesVehicleTypes(statusRes.value)) {
        try { vehicleTypes = parseVehicleTypes(await fetchJSON(feeds.vehicle_types)); } catch (e) { /* id heuristic */ }
      }
      state.status = parseStationStatus(statusRes.value, vehicleTypes);
      state.lastLoad = Date.now();
      state.refreshFailed = false;
      storeStatusCache(state.status, state.lastLoad);
    } catch (e) {
      console.warn('Refresh failed:', e);
      state.refreshFailed = true;
      feedsPromise = null; // retry discovery next time
    } finally {
      state.loading = false;
      render();
    }
  }

  /* ---------------- GPS ---------------- */
  function requestGps() {
    if (!('geolocation' in navigator)) {
      state.gps = { status: 'unavailable', lat: null, lon: null };
      render();
      return;
    }
    if (state.gps.status !== 'ok') state.gps = { ...state.gps, status: 'pending' };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.gps = { status: 'ok', lat: pos.coords.latitude, lon: pos.coords.longitude };
        render();
      },
      () => {
        // Keep a previous fix if we had one; otherwise fall back to Home.
        if (state.gps.status !== 'ok') state.gps = { status: 'unavailable', lat: null, lon: null };
        render();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  /* ---------------- Rendering ---------------- */
  function render() {
    renderStatus();
    renderLocation();
    if (!state.editing && !state.renaming) renderCards();
  }

  function renderStatus() {
    const now = Date.now();
    let text = state.lastLoad ? formatUpdated(state.lastLoad, now) : (state.loading ? 'Loading…' : '');
    if (state.loading && state.lastLoad) text = 'Refreshing…';
    els.updated.textContent = text;

    const showFail = state.refreshFailed && !state.loading;
    els.failLine.hidden = !showFail;
    if (showFail) {
      if (!state.lastLoad) els.failLine.textContent = "Couldn't load stations. Pull down to try again.";
      else {
        els.failLine.textContent = "Couldn't refresh · showing the last data. Pull down to try again.";
      }
    }

    const all = state.favorites.length > 0 && state.favorites.every((f) => state.expanded.has(f.id));
    els.allBtn.textContent = all ? 'Collapse all' : 'Expand all';
    els.allBtn.hidden = state.editing;
    document.body.classList.toggle('is-editing', state.editing);
  }

  function renderLocation() {
    const me = myLocation(state);
    els.locLabel.textContent = me.source;
    els.locBtn.setAttribute('aria-label', `My location: ${me.source}. Change`);
    els.locBtn.setAttribute('aria-expanded', String(state.locOpen));
    els.locPanel.hidden = !state.locOpen;
    if (!state.locOpen) return;
    const chips = [
      h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(!state.override),
        onclick: () => setOverride(null),
      }, 'GPS'),
      ...state.favorites.map((f) => h('button', {
        type: 'button', class: 'chip',
        'aria-pressed': String(!!state.override && state.override.kind === 'favorite' && state.override.id === f.id),
        onclick: () => setOverride({ kind: 'favorite', id: f.id, label: f.label, lat: f.lat, lon: f.lon }),
      }, f.label)),
    ];
    els.locChoices.replaceChildren(...chips);
  }

  /** The big availability tile. Bikes = solid fill (e-bikes ⚡ + classic); docks = dashed outline. */
  function tile(st, mode) {
    if (mode === 'bikes') {
      return h('span', { class: 'tile bikes', role: 'img', 'aria-label': `${st.ebikes} e-bikes, ${st.classic} classic bikes` },
        h('span', { class: `seg main ${colorClass(st.ebikes)}` }, icon('bolt', 'ic bolt'), h('span', { class: 'n', text: String(st.ebikes) })),
        h('span', { class: `seg classic ${colorClass(st.classic)}`, text: String(st.classic) }));
    }
    return h('span', { class: `tile docks ${colorClass(st.docks)}`, role: 'img', 'aria-label': `${st.docks} open docks` },
      icon('dock', 'ic dockic'), h('span', { class: 'n', text: String(st.docks) }));
  }

  function miniTile(st, mode) {
    if (!st || stationNote(st)) return h('span', { class: 'mini off', 'aria-hidden': 'true', text: '–' });
    if (mode === 'bikes') {
      return h('span', { class: 'mini bikes split' },
        h('span', { class: `mseg ${colorClass(st.ebikes)}`, text: String(st.ebikes) }),
        h('span', { class: `mseg sm ${colorClass(st.classic)}`, text: String(st.classic) }));
    }
    return h('span', { class: `mini docks ${colorClass(st.docks)}`, text: String(st.docks) });
  }

  function stationRow(station, key, me) {
    const st = state.status.get(station.id);
    const nameText = displayName(station, state.nicknames);
    // Tap the name: open the station in Google Maps. Hold it: rename (handled on the row below).
    const link = h('a', {
      class: 'name-link', href: mapsUrl(station.lat, station.lon), target: '_blank', rel: 'noopener',
      draggable: 'false', 'aria-label': `${nameText}, open in Google Maps`,
      onclick: (e) => {
        // A long press that just opened the rename field must not also open the map.
        if (row.dataset.lp) { e.preventDefault(); delete row.dataset.lp; }
      },
    }, h('span', { class: 'name', text: nameText }));
    let right;
    let off = false;
    if (!state.status.size) right = h('span', { class: 'tile pending', text: '…' });
    else if (stationNote(st)) { off = true; right = h('span', { class: 'tile note', text: stationNote(st) }); }
    else right = tile(st, rowMode(cardMode(state, key), station, me));
    const row = h('li', { class: `row${off ? ' off' : ''}`, 'data-station': station.id }, link, right);
    // The rename field replaces the whole link, so typing in it can never follow the link.
    onLongPress(row, () => startRename(link, {
      value: state.nicknames[station.id] || '',
      placeholder: station.name,
      hint: `Official name: ${station.name} · clear to reset`,
      onCommit: (v) => {
        state.nicknames = setNickname(state.nicknames, station.id, v, station.name);
        saveJSON(STORAGE_KEYS.nicknames, state.nicknames);
      },
    }));
    return row;
  }

  function modeControl(key) {
    const cur = cardMode(state, key);
    const opt = (mode, content, label) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(cur === mode), 'aria-label': label,
      class: `mode-btn${cur === mode ? ' on' : ''}`,
      onclick: (e) => { e.stopPropagation(); state.modes.set(key, mode); render(); },
    }, h('span', { class: 'face' }, content));
    return h('div', { class: 'modes', role: 'radiogroup', 'aria-label': 'Show' },
      opt('auto', 'Auto', 'Auto'), opt('bikes', icon('bike'), 'Bikes'), opt('docks', icon('dock'), 'Docks'));
  }

  function stationList(lat, lon) {
    if (!state.stations.length) return null;
    return closestStations(lat, lon, state.stations);
  }

  function favoriteCard(f, me) {
    const open = state.expanded.has(f.id);
    const mode = cardMode(state, f.id);
    const stations = stationList(f.lat, f.lon);
    const nameEl = h('span', { class: 'card-name', text: f.label });
    const toggle = h('button', {
      type: 'button', class: 'card-toggle', 'aria-expanded': String(open),
      onclick: (e) => {
        if (toggle.dataset.lp) { delete toggle.dataset.lp; return; }
        if (state.expanded.has(f.id)) state.expanded.delete(f.id); else state.expanded.add(f.id);
        render();
      },
    }, icon('chevron', 'ic chev'), nameEl);
    if (!open && stations && state.status.size) {
      toggle.append(h('span', { class: 'minis' },
        stations.map((s) => miniTile(state.status.get(s.id), rowMode(mode, s, me)))));
    }
    onLongPress(toggle, () => startRename(toggle, {
      value: f.label, placeholder: f.label, hint: `${f.address} · Enter to save`,
      onCommit: (v) => {
        if (!v) return;
        f.label = v;
        saveJSON(STORAGE_KEYS.favorites, state.favorites);
        if (state.override && state.override.kind === 'favorite' && state.override.id === f.id) state.override.label = v;
      },
    }));
    const head = h('div', { class: 'card-head' }, toggle, open ? modeControl(f.id) : null);
    const card = h('section', { class: `card${open ? ' open' : ''}`, 'data-id': f.id }, head);
    if (open) {
      if (!stations) card.append(h('p', { class: 'empty', text: state.loading ? 'Loading stations…' : "Couldn't load stations." }));
      else card.append(h('ul', { class: 'rows' }, stations.map((s) => stationRow(s, f.id, me))));
    }
    return card;
  }

  function lookupCard(me) {
    const L = state.lookup;
    const stations = stationList(L.lat, L.lon);
    const card = h('section', { class: 'card open lookup', 'aria-label': `Stations near ${L.name}` },
      h('div', { class: 'card-head' },
        h('div', { class: 'lookup-title' },
          h('span', { class: 'card-name', text: L.name }),
          L.sub ? h('span', { class: 'card-sub', text: L.sub }) : null),
        modeControl('lookup'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', icon: 'x', onclick: closeLookup })));
    if (!stations) card.append(h('p', { class: 'empty', text: 'Loading stations…' }));
    else card.append(h('ul', { class: 'rows' }, stations.map((s) => stationRow(s, 'lookup', me))));

    if (state.picking) {
      card.append(h('div', { class: 'picker' },
        h('p', { class: 'picker-title', text: 'Replace which favorite?' }),
        h('div', { class: 'chips' },
          state.favorites.map((f) => h('button', { type: 'button', class: 'chip', onclick: () => saveLookupAsFavorite(f.id) }, f.label)),
          h('button', { type: 'button', class: 'chip ghost', onclick: () => { state.picking = false; render(); } }, 'Cancel'))));
    } else {
      card.append(h('div', { class: 'card-actions' },
        h('button', { type: 'button', class: 'text-btn', onclick: () => setOverride({ kind: 'place', label: L.name, lat: L.lat, lon: L.lon }) },
          icon('pin'), 'Set as my location'),
        h('button', { type: 'button', class: 'text-btn', onclick: () => { state.picking = true; render(); } },
          '★ Save as favorite')));
    }
    return card;
  }

  function renderCards() {
    els.editBtn.hidden = false;
    els.cards.classList.remove('editing');
    const me = myLocation(state);
    const cards = [];
    if (state.lookup) cards.push(lookupCard(me));
    for (const f of state.favorites) cards.push(favoriteCard(f, me));
    els.cards.replaceChildren(...cards);
  }

  /* ---------------- Location control ---------------- */
  els.locBtn.addEventListener('click', () => {
    state.locOpen = !state.locOpen;
    if (!state.locOpen) locSearch.close();
    render();
  });

  function setOverride(ov) {
    state.override = ov;
    state.locOpen = false;
    locSearch.close();
    if (!ov && state.gps.status !== 'ok') requestGps();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  els.allBtn.addEventListener('click', () => {
    const all = state.favorites.every((f) => state.expanded.has(f.id));
    state.expanded = all ? new Set() : new Set(state.favorites.map((f) => f.id));
    render();
  });

  /* ---------------- Search (addresses + places, with confirmation) ---------------- */
  function suggestionButton(item, me, onPick, iconName) {
    const d = me ? haversineMi(me.lat, me.lon, item.lat, item.lon) : NaN;
    const sub = [item.category, item.sub].filter(Boolean).join(' · ');
    return h('li', null, h('button', {
      type: 'button', class: 'sug',
      onclick: () => onPick(item),
    },
    icon(iconName || (item.kind === 'place' ? 'store' : 'pinOutline'), 'ic sug-ic'),
    h('span', { class: 'sug-text' },
      h('span', { class: 'sug-name', text: item.name }),
      sub ? h('span', { class: 'sug-sub', text: sub }) : null),
    item.recent ? null : h('span', { class: 'sug-dist', text: formatMiles(d) })));
  }

  /**
   * Type-ahead search. Shows places (Photon) and addresses (GeoSearch) as you type;
   * the user confirms by tapping one. Returns {close()}.
   */
  function attachSearch(input, box, { onPick, recents }) {
    let timer = null;
    let ctrl = null;
    let seq = 0;
    const wrap = input.closest('.search-wrap') || input.parentElement;

    const open = (sections) => {
      box.replaceChildren(...sections);
      box.hidden = !sections.length;
      wrap.classList.toggle('has-sug', !box.hidden);
    };
    const close = () => {
      clearTimeout(timer);
      seq += 1; // any in-flight search is now stale and must not reopen the box
      if (ctrl) ctrl.abort();
      box.hidden = true;
      box.replaceChildren();
      wrap.classList.remove('has-sug');
    };
    const pick = (item) => {
      close();
      input.value = '';
      input.dispatchEvent(new Event('change'));
      input.blur();
      onPick(item);
    };
    const section = (title, items, iconName) => h('div', { class: 'sug-sec' },
      h('p', { class: 'sug-title', text: title }),
      h('ul', { class: 'sug-list' }, items.map((it) => suggestionButton(it, myLocation(state), pick, iconName))));

    const showRecents = () => {
      const list = recents ? recents() : [];
      if (!list.length) { close(); return; }
      open([section('Recent', list.map((r) => ({ ...r, recent: true })), 'clock')]);
    };

    const run = async (q) => {
      clearTimeout(timer);
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      const mine = ++seq;
      open([h('p', { class: 'sug-note', text: 'Searching…' })]);
      const near = myLocation(state);
      const wantAddrs = /\d/.test(q);
      const [places, addrs] = await Promise.allSettled([
        searchPlaces(q, near, ctrl.signal),
        wantAddrs ? searchAddresses(q, ctrl.signal) : Promise.resolve([]),
      ]);
      if (mine !== seq) return; // a newer query is in flight
      const P = places.status === 'fulfilled' ? places.value : [];
      const A = addrs.status === 'fulfilled' ? addrs.value : [];
      const secs = [];
      if (A.length && /^\d/.test(q)) secs.push(section('Addresses', A));
      if (P.length) secs.push(section('Places', P));
      if (A.length && !/^\d/.test(q)) secs.push(section('Addresses', A));
      if (!secs.length) {
        const placesDown = places.status === 'rejected';
        const addrsDown = wantAddrs && addrs.status === 'rejected';
        const msg = placesDown && (addrsDown || !wantAddrs)
          ? (wantAddrs ? "Search isn't reachable right now." : "Place search isn't reachable right now. Try a street address.")
          : 'No matches. Try a street address or a place name.';
        secs.push(h('p', { class: 'sug-note', text: msg }));
      }
      open(secs);
    };

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 3) { if (!q) showRecents(); else close(); return; }
      timer = setTimeout(() => run(q), 280);
    });
    input.addEventListener('focus', () => { if (!input.value.trim()) showRecents(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); input.blur(); }
      if (e.key === 'Enter') { e.preventDefault(); const q = input.value.trim(); if (q) run(q); }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!box.hidden && !wrap.contains(e.target) && !box.contains(e.target)) close();
    });
    return { close };
  }

  const mainSearch = attachSearch(els.q, els.suggest, {
    onPick: (item) => showLookup(item),
    recents: () => state.recents,
  });
  const locSearch = attachSearch(els.locInput, els.locSuggest, {
    onPick: (item) => setOverride({ kind: 'place', label: item.name, lat: item.lat, lon: item.lon }),
  });
  const syncClear = () => { els.qClear.hidden = !els.q.value; };
  els.q.addEventListener('input', syncClear);
  els.q.addEventListener('change', syncClear);
  els.qClear.addEventListener('click', () => { els.q.value = ''; syncClear(); mainSearch.close(); els.q.focus(); });

  function showLookup(item) {
    state.lookup = { name: item.name, sub: item.sub || '', lat: item.lat, lon: item.lon };
    state.modes.delete('lookup');
    state.picking = false;
    state.recents = addRecent(state.recents, item);
    saveJSON(STORAGE_KEYS.recents, state.recents);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeLookup() {
    state.lookup = null;
    state.picking = false;
    render();
  }

  function saveLookupAsFavorite(slotId) {
    const L = state.lookup;
    const i = state.favorites.findIndex((f) => f.id === slotId);
    if (!L || i < 0) return;
    const id = newId();
    state.favorites[i] = { id, label: L.name, address: [L.name, L.sub].filter(Boolean).join(', '), lat: L.lat, lon: L.lon };
    saveJSON(STORAGE_KEYS.favorites, state.favorites);
    if (state.override && state.override.kind === 'favorite' && state.override.id === slotId) state.override = null;
    state.lookup = null;
    state.picking = false;
    state.expanded.add(id);
    render();
    const el = els.cards.querySelector(`[data-id="${id}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------------- Rename (long-press any place or station name) ---------------- */
  function onLongPress(el, cb) {
    let timer = null;
    let sx = 0, sy = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerdown', (e) => {
      if (state.editing || state.renaming || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (e.target.closest('input, .modes')) return;
      sx = e.clientX; sy = e.clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        el.dataset.lp = '1';
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) { /* ignore */ }
        cb();
      }, 500);
    });
    el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Swap `target` for an inline text field (placed beside it, never inside a button). */
  function startRename(target, { value, placeholder, hint, onCommit }) {
    state.renaming = true;
    const input = h('input', {
      class: 'rename', type: 'text', value, placeholder, maxlength: '48',
      enterkeyhint: 'done', 'aria-label': 'New name',
    });
    const block = h('span', { class: 'rename-block' }, input,
      h('span', { class: 'rename-hint', text: hint }));
    target.hidden = true;
    target.parentNode.insertBefore(block, target);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      state.renaming = false;
      if (save) onCommit(input.value.trim());
      render();
    };
    for (const ev of ['click', 'pointerdown', 'pointerup']) block.addEventListener(ev, (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    // The finger (or mouse button) is still down. Focus when it lifts: on Android that
    // release counts as a user gesture, which is what lets the keyboard open.
    window.addEventListener('pointerup', () => {
      if (!done) setTimeout(() => { input.focus(); input.select(); }, 0);
    }, { once: true, capture: true });
  }

  /* ---------------- Edit mode ---------------- */
  els.editBtn.addEventListener('click', () => {
    if (state.editing) return;
    mainSearch.close();
    state.editing = true;
    state.draft = state.favorites.map((f) => ({ ...f, origAddress: f.address, error: '', names: {} }));
    renderEditor();
  });

  function renderEditor() {
    els.editBtn.hidden = true;
    renderStatus();
    els.cards.classList.add('editing');
    const wrap = h('div', { class: 'editor' },
      h('p', { class: 'hint', text: 'Drag ⠿ to reorder. Pick an address or place from the suggestions, or type one.' }));
    const list = h('div', { class: 'edit-list' });
    for (const f of state.draft) list.append(editCard(f, list));
    wrap.append(list, h('div', { class: 'editor-foot' },
      h('button', { type: 'button', class: 'btn secondary', onclick: cancelEdit, disabled: state.saving }, 'Cancel'),
      h('button', { type: 'button', class: 'btn', onclick: () => saveEdits(list), disabled: state.saving },
        state.saving ? 'Saving…' : 'Save')));
    els.cards.replaceChildren(wrap);
  }

  function editCard(f, list) {
    const label = h('input', {
      class: 'lbl', type: 'text', value: f.label, placeholder: 'Name', 'aria-label': 'Name', maxlength: '40',
      oninput: (e) => { f.label = e.target.value; },
    });
    const addr = h('input', {
      type: 'search', value: f.address, placeholder: 'Address or place', 'aria-label': 'Address or place',
      oninput: (e) => { f.address = e.target.value; },
    });
    const sugBox = h('div', { class: 'suggest', hidden: true });
    const addrWrap = h('div', { class: 'search-wrap edit-addr' }, addr);
    const err = h('p', { class: 'card-err', role: 'alert', text: f.error || '' });
    attachSearch(addr, sugBox, {
      onPick: (item) => {
        f.address = [item.name, item.sub].filter(Boolean).join(', ');
        f.lat = item.lat; f.lon = item.lon; f.origAddress = f.address; f.error = '';
        if (!f.label.trim()) { f.label = item.name; label.value = item.name; }
        addr.value = f.address;
        err.textContent = '';
        renderStationNames();
      },
    });

    const namesList = h('div', { class: 'edit-stations' });
    const namesBox = h('details', { class: 'edit-names' }, h('summary', { text: 'Station names' }), namesList);
    const renderStationNames = () => {
      const stations = Number.isFinite(f.lat) && state.stations.length ? closestStations(f.lat, f.lon, state.stations) : [];
      namesBox.hidden = !stations.length;
      namesList.replaceChildren(...stations.map((s) => h('label', { class: 'st-field' },
        h('span', { class: 'st-official', text: s.name }),
        h('input', {
          type: 'text', class: 'st-name', maxlength: '48', 'aria-label': `Name for ${s.name}`,
          placeholder: 'Same as official', value: f.names[s.id] != null ? f.names[s.id] : (state.nicknames[s.id] || ''),
          oninput: (e) => { f.names[s.id] = e.target.value; },
        }))));
    };
    renderStationNames();

    const card = h('div', { class: 'edit-card', 'data-id': f.id },
      h('button', { type: 'button', class: 'drag', 'aria-label': `Drag to reorder ${f.label || 'favorite'}`, icon: 'grip' }),
      h('div', { class: 'edit-fields' },
        h('div', { class: 'edit-row' }, label,
          h('button', {
            type: 'button', class: 'btn secondary small',
            onclick: () => {
              f.label = ''; f.address = ''; f.lat = NaN; f.lon = NaN; f.error = ''; f.names = {};
              f.newId = newId(); // a replaced favorite is a new place
              label.value = ''; addr.value = ''; err.textContent = '';
              label.placeholder = 'New name'; addr.placeholder = 'New address or place';
              renderStationNames();
              label.focus();
            },
          }, 'Replace')),
        addrWrap, sugBox, err, namesBox));
    makeDraggable(card, list);
    return card;
  }

  /** Pointer-based drag on the ⠿ handle; works with touch, mouse and pen. */
  function makeDraggable(card, list) {
    const handle = card.querySelector('.drag');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY + window.scrollY; // page coordinates, so auto-scroll doesn't break the math
      let shift = 0; // how far the card's layout position moved due to DOM swaps
      let lastY = e.clientY;
      let scroller = null;
      card.classList.add('dragging');

      const onMove = (ev) => {
        lastY = ev.clientY;
        const y = ev.clientY + window.scrollY;
        card.style.transform = `translateY(${y - startY - shift}px)`;
        const r = card.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const next = card.nextElementSibling;
        const prev = card.previousElementSibling;
        if (next) {
          const nr = next.getBoundingClientRect();
          if (mid > nr.top + nr.height / 2) {
            const before = card.offsetTop;
            list.insertBefore(next, card);
            shift += card.offsetTop - before;
            card.style.transform = `translateY(${y - startY - shift}px)`;
            return;
          }
        }
        if (prev) {
          const pr = prev.getBoundingClientRect();
          if (mid < pr.top + pr.height / 2) {
            const before = card.offsetTop;
            list.insertBefore(card, prev);
            shift += card.offsetTop - before;
            card.style.transform = `translateY(${y - startY - shift}px)`;
          }
        }
      };
      // Scroll the page while the finger holds near the top or bottom edge.
      const edgeScroll = () => {
        const edge = 90;
        const vh = window.innerHeight;
        const v = lastY < edge ? -(edge - lastY) / 5 : lastY > vh - edge ? (lastY - (vh - edge)) / 5 : 0;
        if (v) { window.scrollBy(0, v); onMove({ clientY: lastY }); }
        scroller = requestAnimationFrame(edgeScroll);
      };
      scroller = requestAnimationFrame(edgeScroll);
      const onEnd = () => {
        cancelAnimationFrame(scroller);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        card.classList.remove('dragging');
        card.style.transform = '';
        syncDraftOrder(list);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    });
  }

  function syncDraftOrder(list) {
    const order = [...list.querySelectorAll('.edit-card')].map((c) => c.dataset.id);
    state.draft.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  function cancelEdit() {
    state.editing = false;
    state.draft = null;
    render();
  }

  async function saveEdits(list) {
    syncDraftOrder(list);
    const draft = state.draft;
    let bad = false;
    for (const f of draft) {
      f.label = f.label.trim();
      f.address = f.address.trim();
      f.error = !f.label && !f.address ? 'Enter a name and an address.'
        : !f.label ? 'Enter a name.' : !f.address ? 'Enter an address or place.' : '';
      if (f.error) bad = true;
    }
    if (bad) { renderEditor(); return; }

    state.saving = true;
    renderEditor();
    await Promise.all(draft.map(async (f) => {
      if (f.address === f.origAddress && Number.isFinite(f.lat) && Number.isFinite(f.lon)) return;
      try {
        const g = await geocode(f.address);
        f.lat = g.lat; f.lon = g.lon; f.origAddress = f.address;
      } catch (e) {
        f.error = "Couldn't find that address. Pick one from the suggestions.";
        bad = true;
      }
    }));
    state.saving = false;
    if (bad) { renderEditor(); return; }

    let nick = state.nicknames;
    for (const f of draft) {
      for (const [id, v] of Object.entries(f.names)) {
        const s = state.stations.find((x) => x.id === id);
        nick = setNickname(nick, id, v, s ? s.name : '');
      }
    }
    state.nicknames = nick;
    saveJSON(STORAGE_KEYS.nicknames, nick);
    state.favorites = draft.map(({ id, newId: nid, label, address, lat, lon }) => ({ id: nid || id, label, address, lat, lon }));
    saveJSON(STORAGE_KEYS.favorites, state.favorites);
    // Keep a favorite-based location override pointing at the edited favorite.
    if (state.override && state.override.kind === 'favorite') {
      const f = state.favorites.find((x) => x.id === state.override.id);
      state.override = f ? { kind: 'favorite', id: f.id, label: f.label, lat: f.lat, lon: f.lon } : null;
    }
    state.editing = false;
    state.draft = null;
    render();
  }

  /* ---------------- Pull to refresh ---------------- */
  function setupPullToRefresh() {
    const ptr = els.ptr;
    const text = ptr.querySelector('.ptr-text');
    const THRESHOLD = 70;
    const MAX_PULL = 120;
    let startY = null;
    let pull = 0;

    const show = (px) => {
      ptr.classList.remove('animate');
      ptr.style.opacity = String(Math.min(1, px / 40));
      ptr.style.transform = `translate(-50%, ${px - 50}px)`;
      const ready = px >= THRESHOLD;
      ptr.classList.toggle('ready', ready);
      text.textContent = ready ? 'Release to refresh' : 'Pull to refresh';
    };
    const hide = () => {
      ptr.classList.add('animate');
      ptr.classList.remove('ready', 'spinning');
      ptr.style.opacity = '0';
      ptr.style.transform = 'translate(-50%, -60px)';
    };

    window.addEventListener('touchstart', (e) => {
      if (state.editing || state.renaming || state.loading || e.touches.length !== 1 || window.scrollY > 0 ||
          e.target.closest('input, .drag, .suggest')) {
        startY = null;
        return;
      }
      startY = e.touches[0].clientY;
      pull = 0;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 0) {
        if (pull > 0) hide();
        pull = 0;
        if (dy < 0) startY = null; // user is scrolling the page up; let it go
        return;
      }
      pull = Math.min(MAX_PULL, dy * 0.5);
      if (e.cancelable) e.preventDefault();
      show(pull);
    }, { passive: false });

    const end = async () => {
      if (startY === null) return;
      startY = null;
      if (pull >= THRESHOLD) {
        pull = 0;
        ptr.classList.add('animate', 'spinning');
        ptr.classList.remove('ready');
        ptr.style.opacity = '1';
        ptr.style.transform = 'translate(-50%, 20px)';
        text.textContent = 'Refreshing…';
        if (!state.override) requestGps();
        await refresh();
        hide();
      } else {
        pull = 0;
        hide();
      }
    };
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', () => { startY = null; pull = 0; hide(); });
  }

  /* ---------------- Boot ---------------- */
  restoreStationCache();
  restoreStatusCache();
  render();
  requestGps();
  refresh({ withInfo: true });
  setupPullToRefresh();

  // Keep "Updated N min ago" current (display only — no data is fetched on a timer).
  setInterval(renderStatus, 15000);

  // Android keeps PWAs alive in the background; returning to the app refreshes the data.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderStatus();
    if (Date.now() - state.lastAttempt > 60000) {
      if (!state.override) requestGps();
      refresh({ withInfo: true });
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootApp();
}

/* =====================================================================
 * Exports for Node-based logic checks (ignored by the browser)
 * ===================================================================== */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AUTO_RADIUS_MI, EARTH_RADIUS_MI, DEFAULT_FAVORITES, MAX_RECENTS, STORAGE_KEYS, HOME_ID,
    haversineMi, closestStations, rowMode, colorClass, stationNote, deriveCounts, formatMiles, mapsUrl,
    parseStationInfo, parseStationStatus, parseVehicleTypes, feedsFromDiscovery,
    parsePhoton, parseGeoSearch, prettyStreet, categoryLabel, sortBranches,
    addRecent, setNickname, displayName, initialExpanded, cardMode,
    createState, myLocation, formatUpdated, loadFavorites, loadRecents, loadNicknames, homeCoords,
  };
}
