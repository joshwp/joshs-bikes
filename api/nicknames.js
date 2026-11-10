/* Josh's Bikes — station nicknames shared across browsers.
 *
 *   GET  /api/nicknames                                  -> { nicknames: { station_id: "My name" } }
 *   POST /api/nicknames  { set: {id: name}, clear: [id] } -> same shape, after applying the changes
 *
 * Stored in one Upstash Redis hash (one field per station, so changes to different
 * stations never overwrite each other). Talks to Upstash's REST API with fetch,
 * so there are no dependencies. No login: this is a single-user app, and the
 * input checks below limit what a stranger who found the URL could do.
 */
'use strict';

const KEY = 'jb:nicknames';
const MAX_NAME = 48;          // same as the rename field's maxlength
const MAX_CHANGES = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class BadRequest extends Error {}

function cleanName(v) {
  // eslint-disable-next-line no-control-regex
  return String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** Request body -> { set: {id: name}, clear: [id] }. Throws BadRequest on anything unexpected. */
function validateChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Expected a JSON object.');
  const rawSet = body.set == null ? {} : body.set;
  const rawClear = body.clear == null ? [] : body.clear;
  if (typeof rawSet !== 'object' || Array.isArray(rawSet)) throw new BadRequest('"set" must be an object.');
  if (!Array.isArray(rawClear)) throw new BadRequest('"clear" must be an array.');
  const set = {};
  const clear = [];
  for (const [id, v] of Object.entries(rawSet)) {
    if (!ID_RE.test(id)) throw new BadRequest('Bad station id.');
    if (typeof v !== 'string') throw new BadRequest('Names must be strings.');
    const name = cleanName(v);
    if (name.length > MAX_NAME) throw new BadRequest(`Names are at most ${MAX_NAME} characters.`);
    if (name) set[id] = name; else clear.push(id); // an empty name means "back to the official name"
  }
  for (const id of rawClear) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new BadRequest('Bad station id.');
    if (!(id in set) && !clear.includes(id)) clear.push(id);
  }
  if (Object.keys(set).length + clear.length > MAX_CHANGES) throw new BadRequest('Too many changes at once.');
  return { set, clear };
}

/** Redis HGETALL reply ([field, value, ...]) -> object. */
function hashToObject(flat) {
  const out = {};
  if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1]);
  return out;
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not configured (missing KV_REST_API_URL / KV_REST_API_TOKEN).');
  return { url: url.replace(/\/+$/, ''), token };
}

/** Run commands atomically (MULTI/EXEC) and return each command's result. */
async function redis(commands) {
  const { url, token } = redisConfig();
  const res = await fetch(`${url}/multi-exec`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(json)) throw new Error(`Redis HTTP ${res.status}`);
  return json.map((r) => {
    if (r && r.error) throw new Error(`Redis: ${r.error}`);
    return r ? r.result : null;
  });
}

async function readBody(req) {
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!text && typeof req.on === 'function') {
    text = await new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > 64 * 1024) reject(new BadRequest('Body too large.')); });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  }
  try { return JSON.parse(text || '{}'); } catch (e) { throw new BadRequest('Body is not valid JSON.'); }
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const [all] = await redis([['HGETALL', KEY]]);
      return send(res, 200, { nicknames: hashToObject(all) });
    }
    if (req.method === 'POST') {
      const { set, clear } = validateChanges(await readBody(req));
      const cmds = [];
      const pairs = Object.entries(set).flat();
      if (pairs.length) cmds.push(['HSET', KEY, ...pairs]);
      if (clear.length) cmds.push(['HDEL', KEY, ...clear]);
      cmds.push(['HGETALL', KEY]);
      const results = await redis(cmds);
      return send(res, 200, { nicknames: hashToObject(results[results.length - 1]) });
    }
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Use GET or POST.' });
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { error: e.message });
    console.error('nicknames:', e);
    return send(res, 500, { error: "Couldn't reach the name store." });
  }
}

module.exports = handler;
module.exports.validateChanges = validateChanges;
module.exports.hashToObject = hashToObject;
module.exports.BadRequest = BadRequest;
