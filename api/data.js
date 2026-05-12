// /api/data.js — Vercel serverless function (long-poll pattern, JSON endpoint)
//
// IMPORTANT CHANGE: we now hit Metabase's .json endpoint instead of .csv.
// For large result sets, Metabase's CSV export can hang indefinitely (it has
// to serialize and escape every cell). The JSON endpoint streams results
// faster and is more reliable for big questions.
//
// Architecture:
//   - Shared module-level `inflight` promise that outlives any single request.
//   - Each /api/data call waits up to 50s for it, then returns
//     status=loading or status=ready. Browser long-polls.
//   - Memory cache: 1h. Edge cache: 10min fresh + 1h stale-while-revalidate.
//
// Query params:
//   ?refresh=1     — abandon current cache and start a fresh fetch
//   ?fields=a,b,c  — return only those columns (smaller payload)

// We try JSON first; if that fails for any reason we fall back to CSV.
const METABASE_BASE =
  "https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e";
 
const METABASE_JSON_URL = METABASE_BASE + ".json";
const METABASE_CSV_URL  = METABASE_BASE + ".csv";

module.exports.config = { maxDuration: 60 };

const TTL_MS                 = 60 * 60 * 1000;
const PER_REQUEST_WAIT_MS    = 50_000;
const FETCH_HARD_TIMEOUT_MS  = 600_000; // 10 min total (some Metabase exports really are this slow)
const CDN_FRESH_SEC          = 600;
const CDN_STALE_SEC          = 3600;

let cache = { data: null, fetchedAt: 0, lastError: null };
let inflight = null;

// ---- Parsers ----
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  const len = text.length;
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

// Metabase JSON shape: array of objects, keys = column names.
function parseMetabaseJSON(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error("Metabase JSON: expected array");
  if (arr.length === 0) return { headers: [], records: [] };
  const headers = Object.keys(arr[0]);
  // Coerce values to strings so the rest of the pipeline behaves like the CSV path.
  const records = arr.map(row => {
    const o = {};
    for (const k of headers) {
      const v = row[k];
      o[k] = v === null || v === undefined ? "" : (typeof v === "string" ? v : String(v));
    }
    return o;
  });
  return { headers, records };
}

async function tryFetch(url, accept, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "spyne-dashboard/1.0",
        "Accept": accept,
        "Accept-Encoding": "gzip, deflate, br",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Metabase ${url.endsWith(".json") ? "JSON" : "CSV"} responded ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function startFetch() {
  if (inflight) return inflight;

  const startedAt = Date.now();

  const promise = (async () => {
    let parsed;
    let usedFallback = false;
    try {
      // Prefer JSON for large datasets.
      const text = await tryFetch(METABASE_JSON_URL, "application/json", FETCH_HARD_TIMEOUT_MS);
      parsed = parseMetabaseJSON(text);
    } catch (jsonErr) {
      // Fall back to CSV
      try {
        const text = await tryFetch(METABASE_CSV_URL, "text/csv", FETCH_HARD_TIMEOUT_MS);
        parsed = parseCSV(text);
        usedFallback = true;
      } catch (csvErr) {
        const msg = `JSON: ${jsonErr.message} | CSV: ${csvErr.message}`;
        cache.lastError = msg;
        inflight = null;
        throw new Error(msg);
      }
    }
    cache = {
      data: parsed,
      fetchedAt: Date.now(),
      lastError: null,
      source: usedFallback ? "csv" : "json",
      fetchDurationMs: Date.now() - startedAt,
    };
    inflight = null;
    return parsed;
  })();

  inflight = { promise, startedAt };
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

    if (forceRefresh) {
      inflight = null;
      cache.lastError = null;
      startFetch();
    } else if (fresh && !inflight) {
      // good, just serve cache
    } else if (!haveCache && !inflight) {
      startFetch();
    } else if (haveCache && !fresh && !inflight) {
      startFetch();
    }

    if (inflight) {
      const inflightStartedAt = inflight.startedAt;
      const waitMs = haveCache && !forceRefresh ? 2_000 : PER_REQUEST_WAIT_MS;
      const result = await waitUpTo(inflight.promise, waitMs);
      const elapsedMs = Date.now() - inflightStartedAt;

      if (result.settled && result.error) {
        if (haveCache && !forceRefresh) {
          // serve stale + error note
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
      } else if (!result.settled) {
        // still loading
        if (haveCache && !forceRefresh) {
          // fall through, serve stale
        } else {
          res.setHeader("Cache-Control", "no-store");
          res.status(200).json({
            ok: true,
            status: "loading",
            elapsedMs,
            message: "Metabase export still running.",
          });
          return;
        }
      }
    }

    if (!cache.data) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true, status: "loading", elapsedMs: 0 });
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
      source: cache.source || "unknown",
      fetchDurationMs: cache.fetchDurationMs || null,
      backgroundRefreshing: !!inflight,
      lastError: cache.lastError,
      rowCount: out.records.length,
      headers: out.headers,
      records: out.records,
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ ok: false, status: "error", error: String(err && err.message || err) });
  }
};
