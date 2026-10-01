// Shared golden-transform helpers; mirrors tools/generate_goldens.py
// (truncate_parse): group the flat combination rows by table in
// first-appearance order ("nr_unknown" fallback), keep the first 5 rows of
// each table plus every 20th, keep components in full, and truncate every
// *raw_hex string to 64 chars recursively. deepEqualOrdered is order-sensitive,
// so consumers must emit keys in the Python dict insertion order.
export const RAW_HEX_LIMIT = 64;

export function sampleIndices(n) {
  const idx = new Set();
  for (let i = 0; i < Math.min(5, n); i++) idx.add(i);
  for (let i = 0; i < n; i += 20) idx.add(i);
  return [...idx].sort((a, b) => a - b);
}

export function truncateRow(row) {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === "string") {
      if (k.endsWith("raw_hex") && v.length > RAW_HEX_LIMIT) row[k] = v.slice(0, RAW_HEX_LIMIT);
    } else if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) {
        for (const item of v) if (item !== null && typeof item === "object" && !Array.isArray(item)) truncateRow(item);
      } else {
        truncateRow(v);
      }
    }
  }
}

export function truncateParse(parsed) {
  const byTable = new Map();
  for (const row of parsed.combinations) {
    const table = row.table ?? "nr_unknown";
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(row);
  }
  const out = { combinations: {}, components: [...parsed.components] };
  for (const [tbl, rows] of byTable) {
    out.combinations[tbl] = sampleIndices(rows.length).map((i) => ({ ...rows[i] }));
  }
  truncateRow(out);
  return out;
}
