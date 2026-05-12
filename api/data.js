// /api/data.js — Vercel serverless function
//
// Strategy to keep the dashboard fast even when Metabase is slow:
//   1. Memory cache + edge cache: most requests never touch Metabase.
//   2. STALE-WHILE-REFRESH in the lambda: if cache exists but is expired,
//      return the stale copy immediately and refresh in the background.
//   3. Cold-start safety: if the very first fetch is taking too long,
//      return an "ok-but-empty" response so the dashboard renders rather
//      than showing a hard error; the next sync (or auto-refresh) picks
//      up the data.
//   4. Robust query parsing (no `new URL()`).
//   5. ?refresh=1 forces fresh (used by the Sync button) and waits longer.
//   6. ?fields=a,b,c projects columns to shrink the payload.

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv";

// Vercel config — give the function up to 60s to finish a slow Metabase pull.
module.exports.config = { maxDuration: 60 };

const TTL_MS         = 60 * 60 * 1000;   // memory cache freshness: 1 hour
const CDN_FRESH_SEC  = 600;              // CDN serves fresh for 10 min
const CDN_STALE_SEC  = 3600;             // CDN serves stale up to 1h while revalidating
const FETCH_TIMEOUT_NORMAL_MS = 8_000;   // normal request: don't make the user wait long
const FETCH_TIMEOUT_FORCE_MS  = 55_000;  // ?refresh=1 (Sync button): give Metabase plenty of time

// Shared module state (warm lambda only)
let cache = { data: null, fetchedAt: 0 };
let inflight = null; // Promise of an in-progress fetchCSV(), so concurrent calls dedupe

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

async function fetchCSVOnce(timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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

// Dedup concurrent fetches so a burst of dashboard loads = one Metabase hit
function fetchCSV(timeoutMs) {
  if (inflight) return inflight;
  inflight = fetchCSVOnce(timeoutMs)
    .then(parsed => {
      cache = { data: parsed, fetchedAt: Date.now() };
      return parsed;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Safe query-string parsing — does NOT use `new URL()`.
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
    let warmingUp = false;

    if (forceRefresh) {
      // Sync button: actually wait for a new fetch.
      try {
        await fetchCSV(FETCH_TIMEOUT_FORCE_MS);
      } catch (err) {
        // If forced refresh failed but we have stale data, serve that with a note.
        if (haveCache) {
          staleServed = true;
        } else {
          throw err;
        }
      }
    } else if (fresh) {
      // Cache is fresh — instant.
      usedCache = true;
    } else if (haveCache) {
      // STALE-WHILE-REFRESH: return stale immediately, kick off background fetch.
      staleServed = true;
      // Fire-and-forget; errors won't crash the response.
      fetchCSV(FETCH_TIMEOUT_NORMAL_MS).catch(() => { /* will retry next hit */ });
    } else {
      // Cold start, no cache. Try a short fetch; if it times out, return empty-ok.
      try {
        await fetchCSV(FETCH_TIMEOUT_NORMAL_MS);
      } catch (err) {
        // Don't block the dashboard. Return ok with empty records.
        // A background fetch with the long timeout takes over so a follow-up
        // request (auto every minute via the dashboard's retry) succeeds.
        warmingUp = true;
        fetchCSV(FETCH_TIMEOUT_FORCE_MS).catch(() => { /* try again next time */ });
      }
    }

    const source = cache.data || { headers: [], records: [] };
    const out = project(source, wantedFields);

    res.setHeader("Content-Type", "application/json");
    if (forceRefresh || warmingUp) {
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
      warmingUp,
      ttlMs: TTL_MS,
      rowCount: out.records.length,
      headers: out.headers,
      records: out.records,
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
