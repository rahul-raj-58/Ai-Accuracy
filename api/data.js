// /api/data.js — Vercel serverless function (long-poll pattern)
//
// Why this design:
//   Vercel functions have a 60s execution limit per request. Metabase CSV
//   exports for large public questions can exceed that. We can't make any
//   single request wait long enough on a cold start.
//
//   Solution: a single shared in-memory fetch promise (`inflight`) that
//   outlives any individual HTTP request. Each /api/data call waits up to
//   ~50s for it, then returns whatever state we have. The browser polls
//   every few seconds, so consecutive polls keep the same warm lambda
//   alive while the background fetch makes progress.
//
// States returned to the client:
//   - { status: "loading", elapsedMs }  — fetch in progress
//   - { status: "ready", records, ... } — data available
//   - { status: "error", error }        — fetch failed; client can retry
//
// Query params:
//   ?refresh=1     — abandon current cache and start a fresh fetch
//   ?fields=a,b,c  — return only those columns (smaller payload)

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv";

module.exports.config = { maxDuration: 60 };

const TTL_MS                 = 60 * 60 * 1000;  // memory cache freshness: 1h
const PER_REQUEST_WAIT_MS    = 50_000;          // each request waits up to 50s for inflight
const FETCH_HARD_TIMEOUT_MS  = 300_000;         // total fetch timeout (5 min — generous)
const CDN_FRESH_SEC          = 600;
const CDN_STALE_SEC          = 3600;

// Shared module state — persists across requests on a warm lambda.
let cache = { data: null, fetchedAt: 0, lastError: null };
let inflight = null;        // { promise, startedAt }

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

function startFetch() {
  if (inflight) return inflight;

  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_HARD_TIMEOUT_MS);

  const promise = (async () => {
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
      const parsed = parseCSV(text);
      cache = { data: parsed, fetchedAt: Date.now(), lastError: null };
      return parsed;
    } catch (err) {
      cache.lastError = String(err && err.message || err);
      throw err;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  inflight = { promise, startedAt };
  // Swallow unhandled rejection — callers handle errors explicitly via cache.lastError.
  promise.catch(() => {});
  return inflight;
}

function parseQuery(reqUrl) {
  const out = {};
  if (!reqUrl || typeof reqUrl !== "string") return out;
  const qIdx = reqUrl.indexOf("?");
  if (qIdx === -1) return out;
  for (const pair of reqUrl.slice(qIdx + 1).split("&")) {
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
  if (!wantedFields || !wantedFields.length) return data;
  const keep = wantedFields.filter(f => data.headers.includes(f));
  if (!keep.length) return data;
  return {
    headers: keep,
    records: data.records.map(r => {
      const o = {};
      for (const f of keep) o[f] = r[f];
      return o;
    }),
  };
}

// Wait up to `ms` for the inflight promise to settle. Never throws.
function waitUpTo(promise, ms) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ settled: false }); } }, ms);
    promise.then(
      val => { if (!done) { done = true; clearTimeout(t); resolve({ settled: true, value: val }); } },
      err => { if (!done) { done = true; clearTimeout(t); resolve({ settled: true, error: err }); } }
    );
  });
}

module.exports = async (req, res) => {
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

    // ---- Decide what to do ----
    if (forceRefresh) {
      // Sync button: start a NEW fetch (don't reuse a stale inflight from before refresh).
      inflight = null;
      cache.lastError = null;
      startFetch();
    } else if (fresh && !inflight) {
      // Cache is good and nothing in flight — just return cached data.
    } else if (!haveCache && !inflight) {
      // Cold start, nothing in flight — kick off the fetch.
      startFetch();
    } else if (haveCache && !fresh && !inflight) {
      // Stale cache, no fetch in flight — refresh in background.
      startFetch();
    }

    // ---- If a fetch is in flight, wait up to PER_REQUEST_WAIT_MS for it ----
    if (inflight) {
      const inflightStartedAt = inflight.startedAt;
      // On a fresh-cache hit we won't even enter this branch. Otherwise: wait.
      // If we have stale cache, only wait a few seconds (we have something to return).
      const waitMs = haveCache ? 3_000 : PER_REQUEST_WAIT_MS;
      const result = await waitUpTo(inflight.promise, waitMs);

      // If forced refresh and we just started, treat haveCache as false for response purposes
      const elapsedMs = Date.now() - inflightStartedAt;

      if (result.settled && !result.error) {
        // Fetch completed — fall through to send fresh data
      } else if (result.settled && result.error) {
        // Fetch failed
        if (haveCache && !forceRefresh) {
          // Serve stale + note error
        } else {
          res.setHeader("Cache-Control", "no-store");
          res.status(200).json({
            ok: true,
            status: "error",
            error: cache.lastError || String(result.error.message || result.error),
            elapsedMs,
          });
          return;
        }
      } else {
        // Still loading after our wait window.
        if (haveCache && !forceRefresh) {
          // Serve the stale data immediately; client will poll again to pick up fresh.
        } else {
          res.setHeader("Cache-Control", "no-store");
          res.status(200).json({
            ok: true,
            status: "loading",
            elapsedMs,
            message: "Metabase export is still running. Keep polling.",
          });
          return;
        }
      }
    }

    // ---- We have data to send ----
    if (!cache.data) {
      // Should be rare — defensive fallback
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        ok: true,
        status: "loading",
        elapsedMs: 0,
      });
      return;
    }

    const out = project(cache.data, wantedFields);

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
      status: "ready",
      fetchedAt: cache.fetchedAt,
      backgroundRefreshing: !!inflight,
      lastError: cache.lastError,
      rowCount: out.records.length,
      headers: out.headers,
      records: out.records,
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({
      ok: false,
      status: "error",
      error: String(err && err.message || err),
    });
  }
};
