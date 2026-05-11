// /api/metrics.js  — Vercel serverless function
// Fetches CSV from the Metabase public link, parses it, applies filters,
// and returns distinct sku_id count, distinct image_id count, and edited image count.
//
// Query params (all optional):
//   from           ISO date (inclusive)        e.g. 2025-05-01
//   to             ISO date (inclusive)        e.g. 2025-05-11
//   enterprise     enterprise_name to filter by (repeat param for multiple values)
//   account_type   account_type to filter by   (repeat param for multiple values)
//   refresh        "1" to bypass the 1-hour server cache
//
// Response: { metrics, filterOptions, lastFetched, rowsConsidered, fromCache }

const METABASE_CSV_URL =
  'https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv';

// ---------- In-memory cache (per warm lambda) ----------
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache = { fetchedAt: 0, rows: null, headers: null };

// ---------- CSV parsing (RFC 4180-ish, handles quoted fields with commas) ----------
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
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cur.push(field); field = '';
      } else if (ch === '\n') {
        cur.push(field); rows.push(cur); cur = []; field = '';
      } else if (ch === '\r') {
        // skip; \n handles row break
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0].map(h => h.trim());
  const data = rows.slice(1)
    .filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
      return obj;
    });
  return { headers, data };
}

// ---------- Helpers ----------
function isBlank(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === 'null' || s === 'na' || s === 'n/a';
}

function parseDate(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function findHeader(headers, candidates) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {};
  headers.forEach(h => { map[norm(h)] = h; });
  for (const c of candidates) {
    const key = norm(c);
    if (map[key]) return map[key];
  }
  return null;
}

async function fetchCSV() {
  const res = await fetch(METABASE_CSV_URL, { headers: { 'Accept': 'text/csv' } });
  if (!res.ok) throw new Error(`Metabase fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  return parseCSV(text);
}

async function getRows(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cache.rows && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return { ...cache, fromCache: true };
  }
  const { headers, data } = await fetchCSV();
  cache = { fetchedAt: now, rows: data, headers };
  return { ...cache, fromCache: false };
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = Object.fromEntries(url.searchParams.entries());
    const forceRefresh = q.refresh === '1' || q.refresh === 'true';

    // Multi-valued params: repeat the param or pipe-separate (?enterprise=A|B).
    // Commas are NOT separators — enterprise names may contain commas.
    function multi(name) {
      const all = url.searchParams.getAll(name);
      if (all.length === 0) return null;
      const parts = [];
      for (const v of all) {
        if (v.includes('|')) parts.push(...v.split('|'));
        else parts.push(v);
      }
      const cleaned = parts.map(s => s.trim()).filter(Boolean);
      return cleaned.length ? cleaned : null;
    }

    const { rows, headers, fetchedAt, fromCache } = await getRows(forceRefresh);

    // Resolve actual header names from the schema
    const H = {
      image_id:        findHeader(headers, ['b.image_id', 'image_id']),
      sku_id:          findHeader(headers, ['sku_id']),
      created:         findHeader(headers, ['createdDate', 'created_date', 'created']),
      edited:          findHeader(headers, ['editedDate', 'edited_date', 'edited']),
      image_action:    findHeader(headers, ['image_action']),
      enterprise_name: findHeader(headers, ['enterprise_name']),
      account_type:    findHeader(headers, ['account_type']),
    };

    const fromD = q.from ? parseDate(q.from) : null;
    let toD = q.to ? parseDate(q.to) : null;
    if (toD && q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      toD = new Date(toD.getTime() + (24 * 60 * 60 * 1000) - 1);
    }
    const enterprises = multi('enterprise');
    const accountTypes = multi('account_type');

    // Build filter option lists from the full dataset
    const enterpriseSet = new Set();
    const accountTypeSet = new Set();
    for (const r of rows) {
      if (H.enterprise_name) {
        const v = r[H.enterprise_name];
        if (!isBlank(v)) enterpriseSet.add(String(v).trim());
      }
      if (H.account_type) {
        const v = r[H.account_type];
        if (!isBlank(v)) accountTypeSet.add(String(v).trim());
      }
    }

    // Apply filters
    const filtered = rows.filter(r => {
      if (fromD || toD) {
        const cd = H.created ? parseDate(r[H.created]) : null;
        if (!cd) return false;
        if (fromD && cd < fromD) return false;
        if (toD && cd > toD) return false;
      }
      if (enterprises && H.enterprise_name) {
        const v = String(r[H.enterprise_name] || '').trim();
        if (!enterprises.includes(v)) return false;
      }
      if (accountTypes && H.account_type) {
        const v = String(r[H.account_type] || '').trim();
        if (!accountTypes.includes(v)) return false;
      }
      return true;
    });

    // Aggregate
    const distinctSku = new Set();
    const distinctImage = new Set();
    let editedCount = 0;
    const editedImageIds = new Set();

    for (const r of filtered) {
      if (H.sku_id) {
        const s = r[H.sku_id];
        if (!isBlank(s)) distinctSku.add(String(s).trim());
      }
      if (H.image_id) {
        const i = r[H.image_id];
        if (!isBlank(i)) distinctImage.add(String(i).trim());
      }
      if (H.image_action && !isBlank(r[H.image_action])) {
        editedCount++;
        if (H.image_id && !isBlank(r[H.image_id])) {
          editedImageIds.add(String(r[H.image_id]).trim());
        }
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.status(200).json({
      ok: true,
      fromCache,
      lastFetched: new Date(fetchedAt).toISOString(),
      cacheTtlSeconds: CACHE_TTL_MS / 1000,
      rowsConsidered: filtered.length,
      totalRows: rows.length,
      metrics: {
        distinctSkuCount: distinctSku.size,
        distinctImageCount: distinctImage.size,
        editedImageCount: editedCount,
        distinctEditedImageCount: editedImageIds.size,
      },
      filterOptions: {
        enterprise_name: Array.from(enterpriseSet).sort((a, b) => a.localeCompare(b)),
        account_type:    Array.from(accountTypeSet).sort((a, b) => a.localeCompare(b)),
      },
      appliedFilters: {
        from: q.from || null,
        to: q.to || null,
        enterprise: enterprises,
        account_type: accountTypes,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
