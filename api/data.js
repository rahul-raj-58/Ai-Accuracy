// /api/data.js — Vercel serverless function
//
// Strategy:
//   1. Cold start (no cache yet): just wait. Metabase CSV exports can take
//      30-60s for large public questions; that's normal. We have up to 60s
//      of function time, so we use it. No fake "warming up" responses.
//   2. Warm cache + fresh (<1h old): return instantly from memory.
//   3. Warm cache + stale: return the stale copy immediately AND refresh
//      in the background. User never waits.
//   4. ?refresh=1 (Sync button): always wait for a real fresh fetch.
//   5. Edge cache (s-maxage) makes most hits a 10-50ms CDN response.
//   6. ?fields=a,b,c projects columns to shrink the payload.

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv";

// Vercel function config: give us the maximum time to fetch a slow CSV.
module.exports.config = { maxDuration: 60 };

const TTL_MS         = 60 * 60 * 1000;   // memory cache freshness: 1 hour
const CDN_FRESH_SEC  = 600;              // CDN serves fresh for 10 min
const CDN_STALE_SEC  = 3600;             // CDN serves stale up to 1h while revalidating
const FETCH_TIMEOUT_MS = 58_000;         // just under maxDuration

// Shared module state (warm lambda only)
let cache = { data: null, fetchedAt: 0 };
let inflight = null; // Promise of an in-progress fetchCSV(), dedupes concurrent calls

// ---- RFC-4180-ish CSV parser ----
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const len = text.length;
  let i = 0;

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map(h => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue;
    const obj = {};
    for (let k = 0; k < headers.length; k++) obj[headers[k]] = cells[k] ?? "";
    records.push(obj);
  }
  return { headers, records };
}

async function fetchCSVOnce() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(METABASE_URL, {
      headers: {
        "User-Agent": "spyne-dashboard/1.0",
        "Accept-Encoding": "gzip, deflate, br",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Metabase responded ${res.status} ${res.statusText}`);
    const text = await res.text();
    return parseCSV(text);
  } finally {
    clearTimeout(t);
  }
}

// Dedup concurrent fetches: many simultaneous dashboard loads = one Metabase hit.
function fetchCSV() {
  if (inflight) return inflight;
  inflight = fetchCSVOnce()
    .then(parsed => {
      cache = { data: parsed, fetchedAt: Date.now() };
      return parsed;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Safe query-string parsing — no `new URL()`.
function parseQuery(reqUrl) {
  const out = {};
  if (!reqUrl || typeof reqUrl !== "string") return out;
  const qIdx = reqUrl.indexOf("?");
  if (qIdx === -1) return out;
  const qs = reqUrl.slice(qIdx + 1);
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? "" : pair.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " ")); }
    catch { out[k] = v; }
  }
  return out;
}

function project(data, wantedFields) {
  if (!wantedFields || !wantedFields.length) {
    return { headers: data.headers, records: data.records };
  }
  const keep = wantedFields.filter(f => data.headers.includes(f));
  if (!keep.length) return { headers: data.headers, records: data.records };
  const records = data.records.map(r => {
    const o = {};
    for (const f of keep) o[f] = r[f];
    return o;
  });
  return { headers: keep, records };
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const startedAt = Date.now();
  try {
    const q = parseQuery(req.url);
    const forceRefresh = q.refresh === "1" || q.refresh === "true";
    const fieldsParam  = (q.fields || "").trim();
    const wantedFields = fieldsParam ? fieldsParam.split(",").map(s => s.trim()).filter(Boolean) : null;

    const now = Date.now();
    const haveCache = !!cache.data;
    const fresh = haveCache && (now - cache.fetchedAt) < TTL_MS;

    let usedCache = false;
    let staleServed = false;

    if (forceRefresh) {
      // Sync button: actually wait for a fresh pull.
      try {
        await fetchCSV();
      } catch (err) {
        // Sync failed; if we have stale, serve that, otherwise error out.
        if (haveCache) {
          staleServed = true;
        } else {
          throw err;
        }
      }
    } else if (fresh) {
      usedCache = true;
    } else if (haveCache) {
      // Stale-while-refresh: instant response, refresh in background.
      staleServed = true;
      fetchCSV().catch(() => { /* will retry next hit */ });
    } else {
      // Cold start, no cache. Wait for the real fetch — this is normal and
      // expected on the very first request. We have up to ~58s, Metabase
      // usually finishes in 30-60s for large exports.
      await fetchCSV();
    }

    const source = cache.data || { headers: [], records: [] };
    const out = project(source, wantedFields);
    const elapsedMs = Date.now() - startedAt;

    res.setHeader("Content-Type", "application/json");
    if (forceRefresh) {
      res.setHeader("Cache-Control", "no-store");
    } else {
      res.setHeader(
        "Cache-Control",
        `public, max-age=0, s-maxage=${CDN_FRESH_SEC}, stale-while-revalidate=${CDN_STALE_SEC}`
      );
    }

    res.status(200).json({
      ok: true,
      fetchedAt: cache.fetchedAt,
      cached: usedCache,
      stale: staleServed,
      elapsedMs,
      ttlMs: TTL_MS,
      rowCount: out.records.length,
      headers: out.headers,
      records: out.records,
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    const msg = String(err && err.message || err);
    // Friendlier message for the common aborted/timeout case
    const friendly = /abort|timeout/i.test(msg)
      ? "Metabase took too long to respond (CSV export can be slow for large queries). Try the Sync button again."
      : msg;
    res.status(503).json({ ok: false, error: friendly, elapsedMs: Date.now() - startedAt });
  }
};
