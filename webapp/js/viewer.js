// HTML port of gui_version/viewer.py's ComboViewerWindow. Python-parity
// contract, note-for-note where Tk allows:
// - TAB_DEFINITIONS (:116-121), band sorting (_band_sort_key :69-83 +
//   _column_sort_key :86-99), filter re-sort sharing the same key (commit
//   5319687), apply_filter (:467-502, nospace fallback + count label strings),
//   SCS visibility rule (:261), zebra rows (:424-425), band-token coloring via
//   bandcolors with a memoized color map (:433-443), header-click sort with
//   ▲/▼ indicators (:407-411), selection (click/ctrl/shift, :627-644), the
//   three-item copy context menu (:655-660, :662-718), per-tab CSV export
//   (:720-753) and the info banner (:183-197).
// - Sorting/filtering run on the already-JSON table rows in the main thread;
//   nothing here re-parses. The renderer touches the DOM only through the
//   ComboViewer class, so the pure helpers stay unit-testable in Node.
import { BAND_COLUMN_HEADERS, bandSegments, bandColor } from "./lib/bandcolors.js";
import { pyCasefold } from "./lib/modern_parser.js";
import { toCsvText } from "./lib/analyzer.js";
import { csvFilename, download } from "./exporter.js";

export const TAB_DEFINITIONS = [
  ["LTE", "lte_ca"],
  ["NRCA", "nr_ca"],
  ["ENDC", "endc"],
  ["NRDC", "nrdc"],
];

export const EMPTY_COUNT_LABEL = "0 combos";

const BAND_COLUMN_SET = new Set(BAND_COLUMN_HEADERS);

// --- sort keys (viewer.py:69-99) ------------------------------------------------

// viewer.py's _PLAIN_BAND_RE: Python '$' matches before a single trailing \n
// and \d is Unicode Nd, exactly like bandcolors.js's ported regexes.
const PLAIN_BAND_RE = /^(\p{Nd}+)([A-Z])?(?=\n?$)/u;

// (0, ((num, letter), ...)) for fully band-parsable cells, (1, cell) otherwise.
export function bandSortKey(cell) {
  const pairs = [];
  for (const token of String(cell).split(" + ")) {
    const m = PLAIN_BAND_RE.exec(token);
    if (!m) return [1, cell];
    pairs.push([pyNdDigits(m[1]), m[2] || ""]);
  }
  return [0, pairs];
}

// int() over Nd digits (Python int() evaluates each Nd code point's value).
function pyNdDigits(digits) {
  let value = 0n;
  for (const ch of digits) {
    const cp = ch.codePointAt(0);
    const start = ND_RUN_STARTS.find((s) => cp >= s && cp <= s + 9);
    if (start === undefined) throw new RangeError(`not a Unicode decimal digit: U+${cp.toString(16)}`);
    value = value * 10n + BigInt(cp - start);
  }
  return Number(value);
}

// Band digits are small in practice; the Nd run-start table is shared with the
// int()-over-Nd semantics used elsewhere.
const ND_RUN_STARTS = [
  48, 1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430,
  3558, 3664, 3792, 3872, 4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800,
  6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472, 43504, 43600, 44016,
  65296, 66720, 68912, 68928, 69734, 69872, 69942, 70096, 70384, 70736,
  70864, 71248, 71360, 71376, 71386, 71472, 71904, 72016, 72688, 72784,
  73040, 73120, 73552, 90416, 92768, 92864, 93008, 93552, 118000, 120782,
  120792, 120802, 120812, 120822, 123200, 123632, 124144, 124401, 125264,
  130032,
];

const cmpScalar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Python tuple comparison over the key shapes: (kind, payload) where payload
// is a pair array (band columns), a number (numeric columns) or a string.
// Positional compare, prefix-equal tuples: the shorter one is smaller.
export function compareKeys(a, b) {
  if (a[0] !== b[0]) return cmpScalar(a[0], b[0]);
  if (a[0] === 1) return cmpScalar(a[1], b[1]);
  const va = a[1];
  const vb = b[1];
  if (typeof va === "number") return cmpScalar(va, vb);
  const len = Math.min(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const order = cmpScalar(va[i][0], vb[i][0]);
    if (order !== 0) return order;
    const letters = cmpScalar(va[i][1], vb[i][1]);
    if (letters !== 0) return letters;
  }
  return cmpScalar(va.length, vb.length);
}

// (0, int(v)) when int() parses, (1, v) otherwise — v is the untrimmed string.
// int() strips surrounding whitespace and accepts PEP 515 digit separators
// (underscores strictly between digits: "1_0" parses, "_1"/"1_"/"1__0" don't).
function numericElseStringKey(v) {
  const s = String(v).trim();
  const m = /^[+-]?(\p{Nd}+(?:_\p{Nd}+)*)$/u.exec(s);
  if (m) {
    const value = pyNdDigits(m[1].replaceAll("_", ""));
    return [0, s.startsWith("-") ? -value : value];
  }
  return [1, v];
}

export function columnSortKey(col) {
  const bandCol = BAND_COLUMN_SET.has(col);
  return (row) => {
    const v = String(row && row[col] !== undefined && row[col] !== null ? row[col] : "");
    return bandCol ? bandSortKey(v) : numericElseStringKey(v);
  };
}

// filtered.sort(key=..., reverse=reverse) with Python's stable sort: reverse
// flips the comparison, equal keys keep their original relative order.
// Decorate-sort-undecorate: each row's key is computed exactly once (O(n))
// instead of twice per comparison (O(n log n) regex + Nd parses). Comparator
// and stability semantics are unchanged (modern engines sort stably; ties keep
// input order in both directions).
export function sortRows(rows, col, reverse = false) {
  const key = columnSortKey(col);
  const decorated = rows.map((row) => ({ row, k: key(row) }));
  decorated.sort(reverse ? (a, b) => compareKeys(b.k, a.k) : (a, b) => compareKeys(a.k, b.k));
  return decorated.map((d) => d.row);
}

// --- filter + count label (viewer.py:467-502) ------------------------------------

export function filterRows(rows, rawQuery) {
  const query = String(rawQuery ?? "").trim();
  const q = pyCasefold(query);
  if (!q) return [...rows];
  const qNospace = q.replaceAll(" ", "");
  const filtered = [];
  for (const row of rows) {
    const rowText = pyCasefold(Object.values(row).map((v) => String(v)).join(" "));
    const rowNospace = rowText.replaceAll(" ", "");
    if (rowText.includes(q) || rowNospace.includes(qNospace)) filtered.push(row);
  }
  return filtered;
}

// Per-column search (second header row): same matching as filterRows, but per
// single cell. Empty (or whitespace-only) queries pass everything.
export function matchColumn(cellText, rawQuery) {
  const q = pyCasefold(String(rawQuery ?? "").trim());
  if (!q) return true;
  const cell = pyCasefold(String(cellText ?? ""));
  const qNospace = q.replaceAll(" ", "");
  return cell.includes(q) || cell.replaceAll(" ", "").includes(qNospace);
}

// AND-combines every non-empty column filter over pre-globally-filtered rows.
// Order of composition with filterRows is irrelevant: every predicate ANDs.
export function applyColumnFilters(rows, colFilters) {
  const active = [];
  for (const [col, raw] of Object.entries(colFilters ?? {})) {
    const q = String(raw ?? "").trim();
    if (q) active.push([col, q]);
  }
  if (!active.length) return [...rows];
  return rows.filter((row) => active.every(([col, q]) => matchColumn(row[col], q)));
}

export function countLabelText(rawQuery, shown, total, hasColumnFilters = false) {
  const fmt = (n) => n.toLocaleString("en-US");
  const filtered = String(rawQuery ?? "").trim() !== "" || hasColumnFilters;
  return filtered ? `Showing ${fmt(shown)} of ${fmt(total)} combos` : `Total: ${fmt(total)} combos`;
}

// --- columns + banner (viewer.py:261, :183-197) -----------------------------------

export function visibleColumns(columns, showScs) {
  return columns.filter((c) => showScs || !c.includes("SCS"));
}

const fmtKb = (size) => `${(size / 1024).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;

export function infoBannerParts(info) {
  const parts = [];
  if (info) {
    if (info.identity) parts.push(`HWID_FSID_BID: ${info.identity}`);
    if (info.generation) parts.push(`Format: ${info.generation}`);
    if (info.size) parts.push(`Size: ${fmtKb(info.size)}`);
    if (info.inner_path) parts.push(`Path: ${info.inner_path}`);
  }
  return parts;
}

// --- memoized band colors (viewer.py:433-437, one color per canonical band) -------

const BAND_COLOR_MEMO = new Map();

export function memoBandColor(canonical) {
  let color = BAND_COLOR_MEMO.get(canonical);
  if (color === undefined) {
    color = bandColor(canonical);
    BAND_COLOR_MEMO.set(canonical, color);
  }
  return color;
}

// --- renderer ----------------------------------------------------------------------

const CELL_FONT_CSS = "13px ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const MIN_COL_PX = 40;
const MAX_COL_PX = 2400;
// Typing on a large tab (3,906+ rows) must not re-filter + re-render per
// keystroke; applyFilter is debounced by this much. The count label updates
// with the debounced render (documented tradeoff: computing the filtered count
// immediately would run the same O(n) pass the debounce exists to skip).
const SEARCH_DEBOUNCE_MS = 150;

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function bandCellHtml(cell, header) {
  const segments = bandSegments(cell, header);
  if (!segments.length) return esc(cell);
  return segments
    .map((seg) => (seg.canonical ? `<span class="cv-band" style="color:${memoBandColor(seg.canonical)}">${esc(seg.text)}</span>` : esc(seg.text)))
    .join(" + ");
}

// Code-point count (String iterator == [...s].length) without the array
// allocation; layoutColumns runs this over every cell of every table.
export const charCount = (s) => {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
};

function measureCharWidth() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = CELL_FONT_CSS;
  return Math.max(1, ctx.measureText("0").width);
}

export class ComboViewer {
  // tables: {lte_ca, nr_ca, endc, nrdc} raw JSON rows; info: {identity, name,
  // generation, size, inner_path} for the banner + CSV default filename.
  constructor(host, tables, info = {}) {
    this.host = host;
    this.info = info;
    this.showScs = false;
    this.filterTimer = null;
    this.filterRowEl = null;
    this.filterRowSignature = null;
    this.tabs = new Map();
    this.activeKey = null;
    this.charW = measureCharWidth();
    this.pendingResize = null;

    const root = document.createElement("div");
    root.className = "cv";
    root.innerHTML = `
      <div class="cv-header"></div>
      <div class="cv-search">
        <label class="cv-search-label" for="cv-search-input">Search:</label>
        <input id="cv-search-input" class="cv-search-entry" type="text" autocomplete="off" spellcheck="false">
        <button class="cv-clear-btn" title="Clear search" type="button">✕</button>
        <label class="cv-scs-label"><input type="checkbox" class="cv-scs-check"> Show SCS</label>
        <button class="cv-export-btn" type="button">Export CSV</button>
        <span class="cv-count"></span>
        <span class="cv-status" hidden></span>
      </div>
      <div class="cv-tabs" role="tablist"></div>
      <div class="cv-empty" hidden>No combinations found for this RF card.</div>
      <div class="cv-tablewrap" hidden><table><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
      <div class="cv-contextmenu" hidden></div>
    `;
    this.root = root;
    this.bannerEl = root.querySelector(".cv-header");
    this.searchEl = root.querySelector(".cv-search-entry");
    this.clearBtn = root.querySelector(".cv-clear-btn");
    this.scsCheck = root.querySelector(".cv-scs-check");
    this.exportBtn = root.querySelector(".cv-export-btn");
    this.countEl = root.querySelector(".cv-count");
    this.statusEl = root.querySelector(".cv-status");
    this.tabsEl = root.querySelector(".cv-tabs");
    this.emptyEl = root.querySelector(".cv-empty");
    this.tableWrapEl = root.querySelector(".cv-tablewrap");
    this.colgroupEl = root.querySelector("colgroup");
    this.theadEl = root.querySelector("thead");
    this.tbodyEl = root.querySelector("tbody");
    this.menuEl = root.querySelector(".cv-contextmenu");
    this.host.appendChild(root);

    const bannerParts = infoBannerParts(info);
    this.bannerEl.textContent = bannerParts.length ? bannerParts.join("  |  ") : "RF Card Combination Viewer";

    for (const [label, tblKey] of TAB_DEFINITIONS) {
      const rows = tables && Array.isArray(tables[tblKey]) ? tables[tblKey] : [];
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      this.tabs.set(tblKey, {
        label,
        columns,
        rows,
        filtered: [...rows],
        visible: [],
        widths: [],
        overrides: {},
        sortCol: null,
        sortReverse: false,
        colFilters: {},
        selected: new Set(),
        anchor: null,
      });
    }

    this.bindEvents();

    if (this.tabs.size === 0) {
      this.tabsEl.innerHTML = `<button class="cv-tab active" type="button" disabled>Empty</button>`;
      this.emptyEl.hidden = false;
      this.countEl.textContent = EMPTY_COUNT_LABEL;
    } else {
      this.activeKey = this.tabs.keys().next().value;
      this.renderTabs();
      this.applyFilter();
    }
    this.searchEl.focus();
  }

  tab() {
    return this.tabs.get(this.activeKey);
  }

  renderTabs() {
    this.tabsEl.innerHTML = "";
    for (const [tblKey, info] of this.tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `cv-tab${tblKey === this.activeKey ? " active" : ""}`;
      btn.textContent = `${info.label} (${info.rows.length.toLocaleString("en-US")})`;
      btn.addEventListener("click", () => {
        this.activeKey = tblKey;
        this.renderTabs();
        this.applyFilter(); // viewer.py _on_tab_changed -> apply_filter
      });
      this.tabsEl.appendChild(btn);
    }
  }

  layoutColumns(state) {
    const visible = visibleColumns(state.columns, this.showScs);
    const padChars = Math.max(2, Math.round(16 / this.charW));
    const minChars = Math.max(4, Math.round(45 / this.charW));
    const widths = [];
    for (const col of visible) {
      const override = state.overrides[col];
      if (override !== undefined) {
        widths.push(Math.max(1, override)); // pixel override from a drag
        continue;
      }
      // Reserve room for the sort indicator like viewer.py _layout_columns;
      // Tk measures characters, the HTML colgroup needs pixels.
      const headerLen = charCount(col) + 2;
      let contentLen = 0;
      for (const r of state.rows) {
        const len = charCount(String(r[col] ?? ""));
        if (len > contentLen) contentLen = len;
      }
      widths.push(Math.ceil((Math.max(minChars, headerLen, contentLen) + padChars) * this.charW));
    }
    state.visible = visible;
    state.widths = widths;
  }

  applyFilter() {
    const state = this.tab();
    if (!state) return;
    const query = this.searchEl.value;
    state.filtered = applyColumnFilters(filterRows(state.rows, query), state.colFilters);
    state.selected = new Set();
    state.anchor = null;
    if (state.sortCol) {
      // Same key function as header-click sort (viewer 5319687 fix).
      state.filtered = sortRows(state.filtered, state.sortCol, state.sortReverse);
    }
    this.layoutColumns(state);
    this.renderTable(state);
    const hasColumnFilters = Object.values(state.colFilters).some((v) => String(v ?? "").trim() !== "");
    this.countEl.textContent = countLabelText(query, state.filtered.length, state.rows.length, hasColumnFilters);
  }

  // The filter row is persistent DOM (one <input> per visible column of the
  // active tab). renderTable rewrites thead.innerHTML, which detaches it, so
  // the element is re-attached after each render; inputs keep their values,
  // and the focused input keeps focus + caret across the swap. Rebuilt only
  // when the (tab x visible columns) signature changes — tab switch or SCS
  // toggle — never on filter/sort re-renders, so typing never loses focus.
  syncFilterRow(state) {
    const signature = `${this.activeKey}\u0000${state.visible.join("\u0001")}`;
    if (this.filterRowEl && this.filterRowSignature === signature) return;
    this.filterRowSignature = signature;
    const tr = document.createElement("tr");
    tr.className = "cv-filterrow";
    for (const col of state.visible) {
      const th = document.createElement("th");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cv-colfilter";
      input.dataset.col = col;
      input.value = state.colFilters[col] ?? "";
      input.autocomplete = "off";
      input.spellcheck = false;
      th.appendChild(input);
      tr.appendChild(th);
    }
    this.filterRowEl = tr;
  }

  attachFilterRow() {
    if (!this.filterRowEl) return;
    this.theadEl.appendChild(this.filterRowEl);
  }

  restoreFilterFocus(saved) {
    if (!saved || !this.filterRowEl || !this.filterRowEl.contains(saved.el) || !saved.el.isConnected) return;
    saved.el.focus();
    try {
      saved.el.setSelectionRange(saved.start, saved.end);
    } catch {
      // setSelectionRange throws on non-text inputs; all inputs here are text.
    }
  }

  sortBy(col) {
    const state = this.tab();
    if (!state) return;
    if (state.sortCol === col) state.sortReverse = !state.sortReverse;
    else {
      state.sortCol = col;
      state.sortReverse = false;
    }
    // viewer.py sort_column sorts the existing filtered list in place; the
    // deterministic filter makes re-filter-then-sort an equivalent path that
    // keeps the shared key function.
    state.filtered = sortRows(state.filtered, col, state.sortReverse);
    state.selected = new Set();
    state.anchor = null;
    this.layoutColumns(state);
    this.renderTable(state);
  }

  renderTable(state) {
    this.tableWrapEl.hidden = false;
    this.emptyEl.hidden = true;
    this.colgroupEl.innerHTML = state.widths.map((w) => `<col style="width:${Math.round(w)}px">`).join("");

    // Preserve focus/caret: the debounced applyFilter can fire while the user
    // is still focused in a column filter input.
    const activeInput = document.activeElement;
    const saved =
      activeInput && this.filterRowEl && this.filterRowEl.contains(activeInput) && activeInput.tagName === "INPUT"
        ? { el: activeInput, start: activeInput.selectionStart, end: activeInput.selectionEnd }
        : null;

    const arrow = state.sortReverse ? " ▼" : " ▲";
    let headerHtml = "<tr>";
    for (const col of state.visible) {
      const label = col === state.sortCol ? `${col}${arrow}` : col;
      headerHtml += `<th data-col="${esc(col)}"><div class="cv-th-inner">${esc(label)}<div class="cv-colhandle" data-col="${esc(col)}"></div></div></th>`;
    }
    headerHtml += "</tr>";
    this.theadEl.innerHTML = headerHtml;
    this.syncFilterRow(state);
    this.attachFilterRow();
    this.restoreFilterFocus(saved);

    const rowsHtml = [];
    for (const row of state.filtered) {
      let tr = "<tr>";
      for (const col of state.visible) {
        const cell = String(row[col] ?? "");
        tr += `<td>${BAND_COLUMN_SET.has(col) ? bandCellHtml(cell, col) : esc(cell)}</td>`;
      }
      tr += "</tr>";
      rowsHtml.push(tr);
    }
    this.tbodyEl.innerHTML = rowsHtml.join("");
    this.applySelection();
  }

  applySelection() {
    const state = this.tab();
    if (!state) return;
    let i = 0;
    for (const tr of this.tbodyEl.children) {
      tr.classList.toggle("sel", state.selected.has(i));
      i++;
    }
  }

  rowFromEvent(event) {
    const tr = event.target.closest("tbody tr");
    if (!tr) return -1;
    return Array.prototype.indexOf.call(this.tbodyEl.children, tr);
  }

  onRowClick(event) {
    const state = this.tab();
    if (!state) return;
    const row = this.rowFromEvent(event);
    if (row < 0) return;
    if (event.ctrlKey || event.metaKey) {
      if (state.selected.has(row)) state.selected.delete(row);
      else state.selected.add(row);
      state.anchor = row;
    } else if (event.shiftKey) {
      const anchor = state.anchor ?? (state.selected.size ? Math.min(...state.selected) : row);
      for (let i = Math.min(anchor, row); i <= Math.max(anchor, row); i++) state.selected.add(i);
      state.anchor = row;
    } else {
      state.selected = new Set([row]);
      state.anchor = row;
    }
    this.applySelection();
  }

  // --- copy actions (viewer.py:662-718, full column list like Tk) --------------

  copyText(text) {
    navigator.clipboard.writeText(text).catch(() => this.flash("Copy failed: clipboard unavailable"));
  }

  selectedRows(state) {
    return [...state.selected].sort((a, b) => a - b).map((i) => state.filtered[i]);
  }

  copySelected() {
    const state = this.tab();
    if (!state || !state.selected.size) return;
    const lines = [state.columns.join("\t")];
    for (const row of this.selectedRows(state)) lines.push(state.columns.map((c) => String(row[c] ?? "")).join("\t"));
    this.copyText(lines.join("\n"));
  }

  copyComboOnly() {
    const state = this.tab();
    if (!state || !state.selected.size) return;
    let dlColIdx = 0;
    for (let idx = 0; idx < state.columns.length; idx++) {
      if (state.columns[idx].includes("DL")) {
        dlColIdx = idx;
        break;
      }
    }
    const combos = this.selectedRows(state).map((row) => String(row[state.columns[dlColIdx]] ?? ""));
    this.copyText(combos.join("\n"));
  }

  copyAllVisible() {
    const state = this.tab();
    if (!state) return;
    const lines = [state.columns.join("\t")];
    for (const row of state.filtered) lines.push(state.columns.map((c) => String(row[c] ?? "")).join("\t"));
    this.copyText(lines.join("\n"));
  }

  // --- context menu (viewer.py:646-660) -----------------------------------------

  showContextMenu(event) {
    const state = this.tab();
    if (!state) return;
    const row = this.rowFromEvent(event);
    if (row >= 0 && !state.selected.has(row)) {
      state.selected = new Set([row]);
      state.anchor = row;
      this.applySelection();
    }
    event.preventDefault();
    this.menuEl.innerHTML = `
      <button type="button" data-action="selected">Copy Selected Row(s)</button>
      <button type="button" data-action="combo">Copy Carrier Combo Only</button>
      <hr>
      <button type="button" data-action="all">Copy All Filtered Rows</button>
    `;
    this.menuEl.hidden = false;
    const wrap = this.host.getBoundingClientRect();
    this.menuEl.style.left = `${event.clientX - wrap.left}px`;
    this.menuEl.style.top = `${event.clientY - wrap.top}px`;
  }

  hideContextMenu() {
    this.menuEl.hidden = true;
  }

  flash(message) {
    this.statusEl.textContent = message;
    this.statusEl.hidden = false;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusEl.hidden = true;
    }, 4000);
  }

  // ✕ / Escape reset path: clear the top search AND every tab's column
  // filters (hidden tabs included); their inputs are rebuilt empty on next
  // activation because syncFilterRow reads state.colFilters.
  clearColumnFilters() {
    for (const state of this.tabs.values()) state.colFilters = {};
    if (this.filterRowEl) {
      for (const input of this.filterRowEl.querySelectorAll(".cv-colfilter")) input.value = "";
    }
  }

  // --- CSV export (viewer.py:720-753 via exporter.js) ----------------------------

  exportCurrentTabCsv() {
    const state = this.tab();
    if (!state) return;
    const rows = state.filtered;
    if (!rows.length) {
      this.flash("No rows to export.");
      return;
    }
    const text = toCsvText(rows);
    if (text === null) {
      this.flash("No rows to export.");
      return;
    }
    download(csvFilename(this.info.identity, state.label), text);
    this.flash(`Exported ${rows.length.toLocaleString("en-US")} rows.`);
  }

  // --- events ---------------------------------------------------------------------

  bindEvents() {
    this.searchEl.addEventListener("input", () => {
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.filterTimer = null;
        this.applyFilter();
      }, SEARCH_DEBOUNCE_MS);
    });
    // Column filter inputs: delegated on thead (survives filter-row rebuilds);
    // input events bubble. Same debounce as the top search bar.
    this.theadEl.addEventListener("input", (event) => {
      const input = event.target.closest(".cv-colfilter");
      if (!input) return;
      const state = this.tab();
      if (!state || !state.visible.includes(input.dataset.col)) return;
      state.colFilters[input.dataset.col] = input.value;
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.filterTimer = null;
        this.applyFilter();
      }, SEARCH_DEBOUNCE_MS);
    });
    this.clearBtn.addEventListener("click", () => {
      clearTimeout(this.filterTimer);
      this.filterTimer = null;
      this.searchEl.value = "";
      this.clearColumnFilters();
      this.applyFilter();
      this.searchEl.focus();
    });
    this.scsCheck.addEventListener("change", () => {
      this.showScs = this.scsCheck.checked;
      // viewer.py _on_scs_toggle: re-layout + re-render every tab, keep selection.
      for (const state of this.tabs.values()) {
        this.layoutColumns(state);
        if (state === this.tab()) {
          this.renderTable(state);
          this.applySelection();
        }
      }
    });
    this.exportBtn.addEventListener("click", () => this.exportCurrentTabCsv());
    this.theadEl.addEventListener("click", (event) => {
      if (event.target.closest(".cv-filterrow")) return;
      const th = event.target.closest("th");
      if (th && !event.target.closest(".cv-colhandle")) this.sortBy(th.dataset.col);
    });
    this.tbodyEl.addEventListener("click", (event) => this.onRowClick(event));
    this.tbodyEl.addEventListener("contextmenu", (event) => this.showContextMenu(event));
    this.menuEl.addEventListener("click", (event) => {
      const btn = event.target.closest("button[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "selected") this.copySelected();
      else if (btn.dataset.action === "combo") this.copyComboOnly();
      else this.copyAllVisible();
      this.hideContextMenu();
    });
    this.tableWrapEl.addEventListener("mousedown", (event) => {
      const handle = event.target.closest(".cv-colhandle");
      if (!handle) return;
      event.preventDefault();
      event.stopPropagation();
      const col = handle.dataset.col;
      const state = this.tab();
      const idx = state.visible.indexOf(col);
      const startWidth = Math.round(state.widths[idx]);
      const startX = event.clientX;
      const colEl = this.colgroupEl.children[idx];
      const onMove = (moveEvent) => {
        const width = Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, startWidth + (moveEvent.clientX - startX)));
        state.overrides[col] = width;
        state.widths[idx] = width;
        colEl.style.width = `${width}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Keyboard shortcuts (viewer.py:171-173).
    this.onKeydown = (event) => {
      if (event.key === "Escape") {
        this.hideContextMenu();
        const hasColFilters = [...this.tabs.values()].some((s) =>
          Object.values(s.colFilters).some((v) => String(v ?? "").trim() !== ""),
        );
        if (this.searchEl.value || hasColFilters) {
          clearTimeout(this.filterTimer);
          this.filterTimer = null;
          this.searchEl.value = "";
          this.clearColumnFilters();
          this.applyFilter();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        this.searchEl.focus();
        this.searchEl.select();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        const state = this.tab();
        if (state && state.selected.size) {
          event.preventDefault();
          this.copySelected();
        }
      }
    };
    this.onDocumentClick = (event) => {
      if (!this.menuEl.hidden && !this.menuEl.contains(event.target)) this.hideContextMenu();
    };
    document.addEventListener("keydown", this.onKeydown);
    document.addEventListener("click", this.onDocumentClick);
  }

  destroy() {
    clearTimeout(this.statusTimer);
    clearTimeout(this.filterTimer);
    document.removeEventListener("keydown", this.onKeydown);
    document.removeEventListener("click", this.onDocumentClick);
    this.root.remove();
  }
}
