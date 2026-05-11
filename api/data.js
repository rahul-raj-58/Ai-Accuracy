// api.js — Vercel Serverless Function
// Place this file at: /api/data.js  (so it's reachable at https://<your-app>.vercel.app/api/data)
//
// Fetches the public Metabase CSV, parses it, applies filters (date range,
// enterprise name, account_type), and returns three aggregations:
//   1) distinct SKU count per day
//   2) distinct image count per day
//   3) edited-image count per day (rows where image_action is not null/empty)
//
// It also returns the unique filter option lists so the UI can populate dropdowns.

const METABASE_CSV_URL =
  "https://metabase.spyne.ai/public/question/8870098d-e121-4caa-9e9f-69c31ce9c50e.csv";

// ---------- tiny CSV parser (handles quoted fields, commas, escaped quotes) ----------
function parseCSV(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        cur.push(field);
        field = "";
      } else if (c === "\n") {
        cur.push(field);
        rows.push(cur);
        cur = [];
        field = "";
      } else if (c === "\r") {
        // ignore — handled with \n
      } else {
        field += c;
      }
    }
  }
  // last field
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }

  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  const records = rows
    .slice(1)
    .filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = r[idx] !== undefined ? r[idx] : "";
      });
      return obj;
    });

  return { headers, records };
}

// ---------- helpers ----------
// Try to find the column name that matches a logical field, regardless of casing
function findCol(headers, candidates) {
  const lower = headers.map((h) => h.toLowerCase());
  for (const cand of candidates) {
    const idx = lower.indexOf(cand.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  // partial match fallback
  for (const cand of candidates) {
    const idx = lower.findIndex((h) => h.includes(cand.toLowerCase()));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

// Normalize any date-ish value to YYYY-MM-DD; return null if unparseable
function toDayKey(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // common case: already starts with YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function isNonEmpty(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s !== "" && s !== "null" && s !== "na" && s !== "n/a";
}

// ---------- main handler ----------
export default async function handler(req, res) {
  // CORS so the UI (even on a different origin) can call this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const { from, to, enterprise, account_type } = req.query || {};

    const resp = await fetch(METABASE_CSV_URL);
    if (!resp.ok) {
      res.status(502).json({
        error: `Metabase fetch failed: ${resp.status} ${resp.statusText}`,
      });
      return;
    }
    const csvText = await resp.text();
    const { headers, records } = parseCSV(csvText);

    if (records.length === 0) {
      res.status(200).json({
        headers,
        filters: { enterprises: [], account_types: [], minDate: null, maxDate: null },
        skuByDay: [],
        imageByDay: [],
        editedByDay: [],
        totals: { sku: 0, image: 0, edited: 0 },
      });
      return;
    }

    // Resolve actual column names from headers (defensive — Metabase columns may vary in case)
    const dateCol =
      findCol(headers, ["date", "created_at", "day", "created_date", "event_date"]) ||
      headers[0];
    const enterpriseCol = findCol(headers, [
      "enterprise_name",
      "enterprise",
      "client_name",
      "company_name",
    ]);
    const accountTypeCol = findCol(headers, ["account_type", "accounttype", "type"]);
    const skuCol = findCol(headers, ["sku", "sku_id", "sku_name"]);
    const imageCol = findCol(headers, ["image", "image_id", "image_url", "image_name"]);
    const imageActionCol = findCol(headers, ["image_action", "action", "edit_action"]);

    // Build unique filter options BEFORE filtering, so the dropdowns are stable
    const enterpriseSet = new Set();
    const accountTypeSet = new Set();
    let minDate = null;
    let maxDate = null;

    for (const r of records) {
      if (enterpriseCol && isNonEmpty(r[enterpriseCol])) enterpriseSet.add(String(r[enterpriseCol]).trim());
      if (accountTypeCol && isNonEmpty(r[accountTypeCol])) accountTypeSet.add(String(r[accountTypeCol]).trim());
      const dk = toDayKey(r[dateCol]);
      if (dk) {
        if (!minDate || dk < minDate) minDate = dk;
        if (!maxDate || dk > maxDate) maxDate = dk;
      }
    }

    // Apply filters
    const fromKey = from ? toDayKey(from) : null;
    const toKey = to ? toDayKey(to) : null;

    const filtered = records.filter((r) => {
      const dk = toDayKey(r[dateCol]);
      if (!dk) return false;
      if (fromKey && dk < fromKey) return false;
      if (toKey && dk > toKey) return false;
      if (enterprise && enterpriseCol) {
        if (String(r[enterpriseCol]).trim() !== String(enterprise).trim()) return false;
      }
      if (account_type && accountTypeCol) {
        if (String(r[accountTypeCol]).trim() !== String(account_type).trim()) return false;
      }
      return true;
    });

    // Day-wise aggregation
    // For distinct counts we accumulate Sets per day, then convert to counts.
    const skuByDayMap = new Map();      // day -> Set of sku
    const imageByDayMap = new Map();    // day -> Set of image
    const editedByDayMap = new Map();   // day -> count (or Set of edited images for distinctness)

    for (const r of filtered) {
      const dk = toDayKey(r[dateCol]);
      if (!dk) continue;

      if (skuCol && isNonEmpty(r[skuCol])) {
        if (!skuByDayMap.has(dk)) skuByDayMap.set(dk, new Set());
        skuByDayMap.get(dk).add(String(r[skuCol]).trim());
      }
      if (imageCol && isNonEmpty(r[imageCol])) {
        if (!imageByDayMap.has(dk)) imageByDayMap.set(dk, new Set());
        imageByDayMap.get(dk).add(String(r[imageCol]).trim());
      }
      if (imageActionCol && isNonEmpty(r[imageActionCol])) {
        // count edited rows; if there's an image col, count distinct edited images instead
        if (imageCol && isNonEmpty(r[imageCol])) {
          if (!editedByDayMap.has(dk)) editedByDayMap.set(dk, new Set());
          editedByDayMap.get(dk).add(String(r[imageCol]).trim());
        } else {
          editedByDayMap.set(dk, (editedByDayMap.get(dk) || 0) + 1);
        }
      }
    }

    const allDays = new Set([
      ...skuByDayMap.keys(),
      ...imageByDayMap.keys(),
      ...editedByDayMap.keys(),
    ]);
    const sortedDays = Array.from(allDays).sort();

    const skuByDay = sortedDays.map((d) => ({
      date: d,
      count: skuByDayMap.has(d) ? skuByDayMap.get(d).size : 0,
    }));
    const imageByDay = sortedDays.map((d) => ({
      date: d,
      count: imageByDayMap.has(d) ? imageByDayMap.get(d).size : 0,
    }));
    const editedByDay = sortedDays.map((d) => {
      const v = editedByDayMap.get(d);
      return {
        date: d,
        count: v instanceof Set ? v.size : v || 0,
      };
    });

    // Totals across the filtered range (distinct, not summed)
    const totalSku = new Set();
    const totalImage = new Set();
    let totalEdited = 0;
    const totalEditedSet = new Set();

    for (const r of filtered) {
      if (skuCol && isNonEmpty(r[skuCol])) totalSku.add(String(r[skuCol]).trim());
      if (imageCol && isNonEmpty(r[imageCol])) totalImage.add(String(r[imageCol]).trim());
      if (imageActionCol && isNonEmpty(r[imageActionCol])) {
        if (imageCol && isNonEmpty(r[imageCol])) totalEditedSet.add(String(r[imageCol]).trim());
        else totalEdited++;
      }
    }
    const totals = {
      sku: totalSku.size,
      image: totalImage.size,
      edited: totalEditedSet.size > 0 ? totalEditedSet.size : totalEdited,
    };

    // Cache for 5 min on Vercel's edge — CSV is public, so this is safe and saves Metabase load
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    res.status(200).json({
      filters: {
        enterprises: Array.from(enterpriseSet).sort(),
        account_types: Array.from(accountTypeSet).sort(),
        minDate,
        maxDate,
      },
      columnsDetected: {
        date: dateCol,
        enterprise: enterpriseCol,
        account_type: accountTypeCol,
        sku: skuCol,
        image: imageCol,
        image_action: imageActionCol,
      },
      skuByDay,
      imageByDay,
      editedByDay,
      totals,
      rowCount: filtered.length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
