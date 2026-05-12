// /api/data.js — Vercel serverless function
// Fetches the public Metabase CSV, parses it, returns JSON.
// Supports ?refresh=1 to bypass the in-memory cache.

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv";

// In-memory cache (per warm lambda). TTL: 1 hour.
let cache = { data: null, fetchedAt: 0 };
const TTL_MS = 60 * 60 * 1000;

// ---- CSV parser (RFC 4180-ish; handles quoted fields with commas and escaped quotes) ----
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
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
  // flush last field/row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map(h => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // skip blank trailing rows
    if (cells.length === 1 && cells[0] === "") continue;
    const obj = {};
    for (let k = 0; k < headers.length; k++) {
      obj[headers[k]] = cells[k] !== undefined ? cells[k] : "";
    }
    records.push(obj);
  }
  return { headers, records };
}

async function fetchCSV() {
  const res = await fetch(METABASE_URL, {
    headers: { "User-Agent": "spyne-dashboard/1.0" },
    // node fetch defaults are fine; Metabase public links don't need auth
  });
  if (!res.ok) {
    throw new Error(`Metabase responded ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const parsed = parseCSV(text);
  return parsed;
}

module.exports = async (req, res) => {
  // CORS — allow the dashboard (or anywhere) to call this API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const now = Date.now();

    let usedCache = false;
    if (!forceRefresh && cache.data && (now - cache.fetchedAt) < TTL_MS) {
      usedCache = true;
    } else {
      const parsed = await fetchCSV();
      cache = { data: parsed, fetchedAt: now };
    }

    res.setHeader("Content-Type", "application/json");
    // Tell browsers/CDN not to cache — we manage freshness ourselves
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      fetchedAt: cache.fetchedAt,
      cached: usedCache,
      ttlMs: TTL_MS,
      rowCount: cache.data.records.length,
      headers: cache.data.headers,
      records: cache.data.records,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
