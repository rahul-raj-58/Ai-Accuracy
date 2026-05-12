// /api/metrics.js  — Vercel serverless function
//
// Strategy: aggregate the entire CSV into a compact "cube" indexed by
// (date, enterprise, account_type) on the server, ship just the cube
// to the browser. Even on a dataset with hundreds of thousands of rows,
// the cube collapses to a few thousand cells. The browser sums cells to
// produce the three KPIs under any filter combination — instantly.
//
// First request from a Vercel region pays the CSV parse cost once;
// subsequent requests in the same hour are served from Vercel's edge
// CDN (s-maxage) without invoking the function at all.
//
// Trade-off: distinct counts (SKU / image) are computed at cube-build
// time per (date, enterprise, account_type) bucket and summed across
// matched buckets. This is exact when an image_id or sku_id only ever
// appears in one bucket (true for this schema — each row is one image
// at one moment).
//
// Query params:
//   refresh=1   bypass the in-memory server cache + CDN cache
//   ping=1      health check

const METABASE_CSV_URL =
  'https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache = { fetchedAt: 0, payload: null };

// ---------- CSV parsing (RFC 4180-ish, handles quoted fields) ----------
function parseCSV(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else { field += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cur.push(field); field = ''; }
      else if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  if (rows.length === 0) return { headers: [], data: [] };
  return { headers: rows[0].map(h => h.trim()), data: rows.slice(1) };
}

function findIndex(headers, candidates) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {};
  headers.forEach((h, i) => { map[norm(h)] = i; });
  for (const c of candidates) {
    const i = map[norm(c)];
    if (i !== undefined) return i;
  }
  return -1;
}

function isBlank(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === 'null' || s === 'na' || s === 'n/a';
}

function normalizeDate(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ---------- Build the aggregation cube ----------
async function buildPayload() {
  const t0 = Date.now();
  const res = await fetch(METABASE_CSV_URL, { headers: { 'Accept': 'text/csv' } });
  if (!res.ok) throw new Error(`Metabase fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const tFetch = Date.now() - t0;

  const tParse0 = Date.now();
  const { headers, data } = parseCSV(text);
  const tParse = Date.now() - tParse0;

  const I = {
    image_id:        findIndex(headers, ['b.image_id', 'image_id']),
    sku_id:          findIndex(headers, ['sku_id']),
    created:         findIndex(headers, ['createdDate', 'created_date', 'created']),
    image_action:    findIndex(headers, ['image_action']),
    enterprise_name: findIndex(headers, ['enterprise_name']),
    account_type:    findIndex(headers, ['account_type']),
  };

  const tAgg0 = Date.now();
  const cube = new Map();
  const enterpriseSet = new Set();
  const accountTypeSet = new Set();
  let totalRows = 0;
  let datedRows = 0;
  let minDate = null, maxDate = null;

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    if (!row || (row.length === 1 && row[0] === '')) continue;

    const imageId = I.image_id        >= 0 ? row[I.image_id]        : '';
    const skuId   = I.sku_id          >= 0 ? row[I.sku_id]          : '';
    const date    = I.created         >= 0 ? normalizeDate(row[I.created]) : null;
    const action  = I.image_action    >= 0 ? row[I.image_action]    : '';
    const ent     = I.enterprise_name >= 0 ? row[I.enterprise_name] : '';
    const acc     = I.account_type    >= 0 ? row[I.account_type]    : '';

    totalRows++;
    const entStr = isBlank(ent) ? '' : String(ent).trim();
    const accStr = isBlank(acc) ? '' : String(acc).trim();
    if (entStr) enterpriseSet.add(entStr);
    if (accStr) accountTypeSet.add(accStr);

    if (!date) continue;
    datedRows++;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;

    const key = `${date}|${entStr}|${accStr}`;
    let cell = cube.get(key);
    if (!cell) {
      cell = { rows: 0, sku: new Set(), img: new Set(), edited: 0, editedImg: new Set() };
      cube.set(key, cell);
    }
    cell.rows++;
    const imgStr = isBlank(imageId) ? '' : String(imageId).trim();
    const skuStr = isBlank(skuId) ? '' : String(skuId).trim();
    if (skuStr) cell.sku.add(skuStr);
    if (imgStr) cell.img.add(imgStr);
    if (!isBlank(action)) {
      cell.edited++;
      if (imgStr) cell.editedImg.add(imgStr);
    }
  }

  // Flatten cube into compact array form
  const cells = new Array(cube.size);
  let i = 0;
  for (const [key, c] of cube) {
    const parts = key.split('|');
    cells[i++] = [
      parts[0],         // 0: date
      parts[1],         // 1: enterprise
      parts[2],         // 2: account_type
      c.rows,           // 3: rows
      c.sku.size,       // 4: distinct sku count (within cell)
      c.img.size,       // 5: distinct image count (within cell)
      c.edited,         // 6: edited row count
      c.editedImg.size, // 7: distinct edited image count (within cell)
    ];
  }
  const tAgg = Date.now() - tAgg0;

  return {
    ok: true,
    version: Date.now(),
    fetchedAt: new Date().toISOString(),
    totalRows,
    datedRows,
    cellCount: cells.length,
    dateRange: { min: minDate, max: maxDate },
    columns: ['date', 'enterprise', 'account_type', 'rows', 'skuCount', 'imgCount', 'editedRows', 'editedImgCount'],
    cells,
    filterOptions: {
      enterprise_name: Array.from(enterpriseSet).sort((a, b) => a.localeCompare(b)),
      account_type:    Array.from(accountTypeSet).sort((a, b) => a.localeCompare(b)),
    },
    timings: { fetchMs: tFetch, parseMs: tParse, aggregateMs: tAgg, totalMs: Date.now() - t0 },
  };
}

async function getPayload(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cache.payload && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return { ...cache.payload, fromMemoryCache: true };
  }
  const payload = await buildPayload();
  cache = { fetchedAt: now, payload };
  return { ...payload, fromMemoryCache: false };
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.searchParams.get('ping') === '1') {
      res.status(200).json({
        ok: true, ping: 'pong',
        nodeVersion: process.version,
        time: new Date().toISOString(),
      });
      return;
    }

    const forceRefresh = url.searchParams.get('refresh') === '1';
    const payload = await getPayload(forceRefresh);

    if (forceRefresh) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      // Vercel CDN holds the response for 1h, serves stale for 5min while revalidating
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=300');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json(payload);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
module.exports.default = handler;
