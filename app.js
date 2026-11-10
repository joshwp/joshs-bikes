/* Josh's Bikes — live Citi Bike availability for my favorite places.
 * Plain browser JavaScript, no build step. Pure logic is exported for
 * Node-based checks at the bottom of the file; the UI only boots in a browser.
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
const GEOSEARCH_URL = 'https://geosearch.planninglabs.nyc/v2/search';

const AUTO_RADIUS_MI = 0.5;
const STATIONS_PER_PLACE = 5;
const MAX_FAVORITES = 5;
const MAX_RECENTS = 3;
const EARTH_RADIUS_MI = 3958.7613;

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
async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
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
 * Geocoding (NYC Planning Labs GeoSearch, no key)
 * ===================================================================== */
async function geocode(text) {
  const q = String(text || '').trim();
  if (!q) throw new Error('empty');
  const url = `${GEOSEARCH_URL}?text=${encodeURIComponent(q)}&size=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const f = json && json.features && json.features[0];
  if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) throw new Error('not found');
  const [lon, lat] = f.geometry.coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('not found');
  return { lat, lon, label: (f.properties && f.properties.label) || q };
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

/* =====================================================================
 * State: favorites, recents, toggle, location
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

function loadRecents() {
  const saved = loadJSON(STORAGE_KEYS.recents, []);
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((r) => r && typeof r.address === 'string' && Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .slice(0, MAX_RECENTS);
}

function normAddress(a) { return String(a).trim().toLowerCase().replace(/\s+/g, ' '); }

/** Newest first, de-duplicated, capped at 3 (a new lookup drops the oldest). */
function addRecent(recents, entry) {
  const key = normAddress(entry.address);
  const rest = recents.filter((r) => normAddress(r.address) !== key);
  return [{ address: entry.address, lat: entry.lat, lon: entry.lon }, ...rest].slice(0, MAX_RECENTS);
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

/** Creates the per-open, in-memory app state. Toggle and location override are never stored. */
function createState() {
  return {
    favorites: loadFavorites(),
    recents: loadRecents(),
    mode: 'auto',                 // 'auto' | 'bikes' | 'docks' — memory only
    gps: { status: 'pending', lat: null, lon: null }, // 'pending' | 'ok' | 'unavailable'
    override: null,               // {kind: 'favorite'|'address', label, lat, lon} — memory only
    stations: [],
    status: new Map(),
    lastLoad: 0,
    lastAttempt: 0,
    refreshFailed: false,
    loading: false,
    lookup: null,                 // {address, lat, lon}
    editing: false,
    draft: null,
    saving: false,
    locOpen: false,
  };
}

/** Where "my location" is right now, and what to call it in the header. */
function myLocation(st) {
  if (st.override) return { lat: st.override.lat, lon: st.override.lon, source: st.override.label };
  if (st.gps.status === 'ok') return { lat: st.gps.lat, lon: st.gps.lon, source: 'GPS' };
  const home = homeCoords(st.favorites);
  const hf = homeFavorite(st.favorites);
  return { ...home, source: st.gps.status === 'pending' ? 'GPS…' : `${hf ? hf.label : 'Home'} (no GPS)` };
}

function formatUpdated(lastLoad, now) {
  if (!lastLoad) return '';
  const min = Math.floor((now - lastLoad) / 60000);
  if (min < 1) return 'Updated just now';
  return `Updated ${min} min ago`;
}

/* =====================================================================
 * Browser app
 * ===================================================================== */
function bootApp() {
  const state = createState();
  globalThis.__jb = state; // handy for debugging in DevTools

  const $ = (sel) => document.querySelector(sel);
  const els = {
    updated: $('#updated'),
    toggle: $('.toggle'),
    locBtn: $('#locBtn'),
    locLabel: $('#locLabel'),
    locPanel: $('#locPanel'),
    locChoices: $('#locChoices'),
    locForm: $('#locForm'),
    locInput: $('#locInput'),
    locMsg: $('#locMsg'),
    editBtn: $('#editBtn'),
    favList: $('#favList'),
    lookupForm: $('#lookupForm'),
    lookupInput: $('#lookupInput'),
    lookupMsg: $('#lookupMsg'),
    recents: $('#recents'),
    recentList: $('#recentList'),
    lookupResults: $('#lookupResults'),
    ptr: $('#ptr'),
  };

  /** Tiny element builder; all text goes through textContent. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  /* ---------------- Data loading ---------------- */
  let feedsPromise = null;

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

  let vehicleTypes = null; // only fetched if the feed ever switches to vehicle_types_available

  /** On open: station_information + station_status. On pull-down: status only. */
  async function refresh({ withInfo = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    state.lastAttempt = Date.now();
    renderUpdated();
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
    renderUpdated();
    renderToggle();
    renderLocation();
    if (!state.editing) renderFavorites();
    renderRecents();
    renderLookup();
  }

  function renderUpdated() {
    const parts = [];
    if (state.lastLoad) parts.push(formatUpdated(state.lastLoad, Date.now()));
    else if (state.loading) parts.push('Loading…');
    if (state.loading && state.lastLoad) parts.push('· Refreshing…');
    els.updated.replaceChildren(parts.join(' '));
    if (state.refreshFailed && !state.loading) {
      if (parts.length) els.updated.append(' · ');
      els.updated.append(h('span', { class: 'fail', text: "Couldn't refresh" }));
    }
  }

  function renderToggle() {
    for (const b of els.toggle.querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
    }
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

  function stationRow(station, me) {
    const st = state.status.get(station.id);
    const name = h('span', { class: 'name', text: station.name });
    if (!state.lastLoad && !state.status.size) {
      return h('li', { class: 'row' }, name, h('span', { class: 'pending', text: '…' }));
    }
    const note = stationNote(st);
    if (note) {
      return h('li', { class: 'row off' }, name, h('span', { class: 'note', text: note }));
    }
    const mode = rowMode(state.mode, station, me);
    let val;
    if (mode === 'bikes') {
      val = h('span', { class: 'val', 'aria-label': `${st.ebikes} e-bikes, ${st.classic} classic bikes` },
        h('span', { class: 'unit', text: 'Bikes' }),
        h('span', { class: `big ${colorClass(st.ebikes)}`, text: String(st.ebikes) }),
        h('span', { class: `small ${colorClass(st.classic)}`, text: `(${st.classic})` }));
    } else {
      val = h('span', { class: 'val', 'aria-label': `${st.docks} open docks` },
        h('span', { class: 'unit', text: 'Docks' }),
        h('span', { class: `big ${colorClass(st.docks)}`, text: String(st.docks) }));
    }
    return h('li', { class: 'row' }, name, val);
  }

  function placeBlock(title, lat, lon, me) {
    const block = h('div', { class: 'place' }, h('h3', { class: 'place-head', text: title }));
    if (!state.stations.length) {
      block.append(h('p', { class: 'empty', text: state.loading ? 'Loading stations…' : "Couldn't load stations." }));
      return block;
    }
    const rows = h('ul', { class: 'rows' });
    for (const s of closestStations(lat, lon, state.stations)) rows.append(stationRow(s, me));
    block.append(rows);
    return block;
  }

  function renderFavorites() {
    els.editBtn.textContent = 'Edit';
    els.editBtn.hidden = false;
    const me = myLocation(state);
    if (!state.favorites.length) {
      els.favList.replaceChildren(h('p', { class: 'empty', text: 'No favorites. Tap Edit to add one.' }));
      return;
    }
    els.favList.replaceChildren(...state.favorites.map((f) => placeBlock(f.label, f.lat, f.lon, me)));
  }

  function renderRecents() {
    els.recents.hidden = !state.recents.length;
    els.recentList.replaceChildren(...state.recents.map((r) => h('li', null,
      h('button', { type: 'button', onclick: () => showLookup(r) }, r.address))));
  }

  function renderLookup() {
    if (!state.lookup) { els.lookupResults.replaceChildren(); return; }
    const me = myLocation(state);
    els.lookupResults.replaceChildren(placeBlock(state.lookup.address, state.lookup.lat, state.lookup.lon, me));
  }

  /* ---------------- Toggle and location controls ---------------- */
  els.toggle.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    render();
  });

  els.locBtn.addEventListener('click', () => {
    state.locOpen = !state.locOpen;
    els.locMsg.textContent = '';
    render();
  });

  function setOverride(ov) {
    state.override = ov;
    state.locOpen = false;
    els.locInput.value = '';
    els.locMsg.textContent = '';
    if (!ov && state.gps.status !== 'ok') requestGps();
    render();
  }

  els.locForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.locInput.value.trim();
    if (!text) return;
    const btn = els.locForm.querySelector('button');
    btn.disabled = true;
    els.locMsg.textContent = '';
    try {
      const g = await geocode(text);
      setOverride({ kind: 'address', label: text, lat: g.lat, lon: g.lon });
    } catch (err) {
      els.locMsg.textContent = "Couldn't find that address.";
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------- Address lookup ---------------- */
  function showLookup(entry) {
    state.lookup = { address: entry.address, lat: entry.lat, lon: entry.lon };
    state.recents = addRecent(state.recents, entry);
    saveJSON(STORAGE_KEYS.recents, state.recents);
    els.lookupMsg.textContent = '';
    render();
    els.lookupResults.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  els.lookupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.lookupInput.value.trim();
    if (!text) return;
    const btn = els.lookupForm.querySelector('button');
    btn.disabled = true;
    els.lookupMsg.textContent = '';
    try {
      const g = await geocode(text);
      els.lookupInput.value = '';
      els.lookupInput.blur();
      showLookup({ address: text, lat: g.lat, lon: g.lon });
    } catch (err) {
      els.lookupMsg.textContent = "Couldn't find that address.";
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------- Edit mode ---------------- */
  els.editBtn.addEventListener('click', () => {
    if (state.editing) return;
    state.editing = true;
    state.draft = state.favorites.map((f) => ({ ...f, origAddress: f.address, error: '' }));
    renderEditor();
  });

  function renderEditor() {
    els.editBtn.hidden = true;
    const wrap = h('div', { class: 'editor' },
      h('p', { class: 'hint', text: 'Drag ≡ to reorder. Addresses are looked up when you save.' }));
    const list = h('div', { class: 'edit-list' });
    for (const f of state.draft) list.append(editCard(f, list));
    wrap.append(list);
    // Always exactly the favorites I have (max 5): no add/remove, only edit, reorder, replace.
    const foot = h('div', { class: 'editor-foot' });
    foot.append(h('div', { class: 'right' },
      h('button', { type: 'button', class: 'btn secondary', onclick: cancelEdit, disabled: state.saving }, 'Cancel'),
      h('button', { type: 'button', class: 'btn', onclick: () => saveEdits(list), disabled: state.saving },
        state.saving ? 'Saving…' : 'Save')));
    wrap.append(foot);
    els.favList.replaceChildren(wrap);
  }

  function editCard(f, list) {
    const label = h('input', {
      class: 'lbl', type: 'text', value: f.label, placeholder: 'Label', 'aria-label': 'Label', maxlength: '40',
      oninput: (e) => { f.label = e.target.value; },
    });
    const addr = h('input', {
      type: 'text', value: f.address, placeholder: 'Street address', 'aria-label': 'Address',
      oninput: (e) => { f.address = e.target.value; },
    });
    const err = h('p', { class: 'card-err', role: 'alert', text: f.error || '' });
    const card = h('div', { class: 'edit-card', 'data-id': f.id },
      h('button', { type: 'button', class: 'drag', 'aria-label': `Drag to reorder ${f.label || 'favorite'}` }, '≡'),
      h('div', { class: 'edit-fields' }, label, addr, err),
      h('div', { class: 'edit-actions' },
        h('button', {
          type: 'button', class: 'btn secondary',
          onclick: () => {
            f.label = ''; f.address = ''; f.lat = NaN; f.lon = NaN; f.error = '';
            label.value = ''; addr.value = ''; err.textContent = '';
            label.placeholder = 'New label'; addr.placeholder = 'New address';
            label.focus();
          },
        }, 'Replace')));
    makeDraggable(card, list);
    return card;
  }

  /** Pointer-based drag on the ≡ handle; works with touch, mouse and pen. */
  function makeDraggable(card, list) {
    const handle = card.querySelector('.drag');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      let shift = 0; // how far the card's layout position moved due to DOM swaps
      card.classList.add('dragging');

      const onMove = (ev) => {
        card.style.transform = `translateY(${ev.clientY - startY - shift}px)`;
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
            card.style.transform = `translateY(${ev.clientY - startY - shift}px)`;
            return;
          }
        }
        if (prev) {
          const pr = prev.getBoundingClientRect();
          if (mid < pr.top + pr.height / 2) {
            const before = card.offsetTop;
            list.insertBefore(card, prev);
            shift += card.offsetTop - before;
            card.style.transform = `translateY(${ev.clientY - startY - shift}px)`;
          }
        }
      };
      const onEnd = () => {
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
      f.error = !f.label && !f.address ? 'Enter a label and an address.'
        : !f.label ? 'Enter a label.' : !f.address ? 'Enter an address.' : '';
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
        f.error = "Couldn't find that address.";
        bad = true;
      }
    }));
    state.saving = false;
    if (bad) { renderEditor(); return; }

    state.favorites = draft.map(({ id, label, address, lat, lon }) => ({ id, label, address, lat, lon }));
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
      if (state.editing || state.loading || e.touches.length !== 1 || window.scrollY > 0 ||
          e.target.closest('input, .drag')) {
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
  setInterval(renderUpdated, 15000);

  // Android keeps PWAs alive in the background; returning to the app counts as opening it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderUpdated();
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
    AUTO_RADIUS_MI, EARTH_RADIUS_MI, DEFAULT_FAVORITES, MAX_RECENTS, STORAGE_KEYS,
    haversineMi, closestStations, rowMode, colorClass, stationNote, deriveCounts,
    parseStationInfo, parseStationStatus, parseVehicleTypes, feedsFromDiscovery,
    addRecent, createState, myLocation, formatUpdated, loadFavorites, loadRecents, homeCoords,
  };
}
