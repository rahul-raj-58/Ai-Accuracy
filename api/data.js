// /api/metrics.js  — Vercel serverless function
// One job: fetch the Metabase CSV, return a small JSON payload of *only the
// columns the dashboard needs*, plus the filter option lists. The client
// caches this in localStorage and does all filtering in-browser, so the
// only slow path is the very first load (or an explicit Sync).
//
// Query params:
//   refresh=1   bypass the 1-hour in-memory server cache

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
  // Return YYYY-MM-DD for filtering. Metabase typically gives "YYYY-MM-DD HH:mm:ss".
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function buildPayload() {
  const res = await fetch(METABASE_CSV_URL, { headers: { 'Accept': 'text/csv' } });
  if (!res.ok) throw new Error(`Metabase fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const { headers, data } = parseCSV(text);

  const I = {
    image_id:        findIndex(headers, ['b.image_id', 'image_id']),
    sku_id:          findIndex(headers, ['sku_id']),
    created:         findIndex(headers, ['createdDate', 'created_date', 'created']),
    image_action:    findIndex(headers, ['image_action']),
    enterprise_name: findIndex(headers, ['enterprise_name']),
    account_type:    findIndex(headers, ['account_type']),
  };

  // Slim each row to an array of 6 values, in a known order — keeps payload small.
  // [image_id, sku_id, date(YYYY-MM-DD), hasAction(0|1), enterprise_name, account_type]
  const slim = new Array(data.length);
  const enterpriseSet = new Set();
  const accountTypeSet = new Set();
  let kept = 0;

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    if (!row || (row.length === 1 && row[0] === '')) continue;

    const imageId   = I.image_id        >= 0 ? row[I.image_id]        : '';
    const skuId     = I.sku_id          >= 0 ? row[I.sku_id]          : '';
    const date      = I.created         >= 0 ? normalizeDate(row[I.created]) : null;
    const action    = I.image_action    >= 0 ? row[I.image_action]    : '';
    const ent       = I.enterprise_name >= 0 ? row[I.enterprise_name] : '';
    const acc       = I.account_type    >= 0 ? row[I.account_type]    : '';

    slim[kept++] = [
      isBlank(imageId) ? '' : String(imageId).trim(),
      isBlank(skuId) ? '' : String(skuId).trim(),
      date,
      isBlank(action) ? 0 : 1,
      isBlank(ent) ? '' : String(ent).trim(),
      isBlank(acc) ? '' : String(acc).trim(),
    ];

    if (!isBlank(ent)) enterpriseSet.add(String(ent).trim());
    if (!isBlank(acc)) accountTypeSet.add(String(acc).trim());
  }
  slim.length = kept;

  return {
    ok: true,
    version: Date.now(),
    fetchedAt: new Date().toISOString(),
    totalRows: kept,
    columns: ['image_id', 'sku_id', 'date', 'action', 'enterprise', 'account_type'],
    rows: slim,
    filterOptions: {
      enterprise_name: Array.from(enterpriseSet).sort((a, b) => a.localeCompare(b)),
      account_type:    Array.from(accountTypeSet).sort((a, b) => a.localeCompare(b)),
    },
  };
}

async function getPayload(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cache.payload && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return { ...cache.payload, fromCache: true };
  }
  const payload = await buildPayload();
  cache = { fetchedAt: now, payload };
  return { ...payload, fromCache: false };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const forceRefresh = url.searchParams.get('refresh') === '1';

    const payload = await getPayload(forceRefresh);

    // Compress repetition: gzip via Vercel's default compression is automatic.
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
