// /api/data.js — Vercel serverless function
// Fetches the public Metabase CSV, parses to JSON.
// - Robust URL parsing (no more "string did not match pattern" errors)
// - Edge/CDN caching via s-maxage + stale-while-revalidate (instant repeat loads)
// - In-memory cache per warm lambda (TTL 1h)
// - ?refresh=1 forces a fresh pull and bypasses both caches
// - ?fields=a,b,c returns only those columns (smaller payload)

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv";

let cache = { data: null, fetchedAt: 0 };
const TTL_MS = 60 * 60 * 1000;          // memory cache: 1 hour
const CDN_FRESH_SEC = 600;              // CDN serves fresh for 10 minutes
const CDN_STALE_SEC = 3600;             // ...and serves stale up to 1 hour while revalidating

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

async function fetchCSV() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 55_000);
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

// Safe query-string parsing — does NOT use `new URL()`, which was the crash source.
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
    let usedCache = false;

    if (!forceRefresh && cache.data && (now - cache.fetchedAt) < TTL_MS) {
      usedCache = true;
    } else {
      const parsed = await fetchCSV();
      cache = { data: parsed, fetchedAt: now };
    }

    let outRecords = cache.data.records;
    let outHeaders = cache.data.headers;
    if (wantedFields && wantedFields.length) {
      const keep = wantedFields.filter(f => cache.data.headers.includes(f));
      if (keep.length) {
        outHeaders = keep;
        outRecords = cache.data.records.map(r => {
          const o = {};
          for (const f of keep) o[f] = r[f];
          return o;
        });
      }
    }

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
      ttlMs: TTL_MS,
      rowCount: outRecords.length,
      headers: outHeaders,
      records: outRecords,
    });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
