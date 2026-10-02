// Workbench UI (Task 11 Step 5): drag-drop + file picker import, progress bar
// bound to worker "progress" messages, cancel, record list (name, HWID
// identity, generation, LTE/NR counts), detect-and-warn warnings panel and the
// IndexedDB card-table cache (sha256-keyed). All parsing lives in worker.js;
// this module only handles JSON rows, exactly like the viewer contract.
import { ComboViewer } from "./viewer.js";
import { compareCards } from "./compare.js";
import { download, downloadBytes } from "./exporter.js";
import {
  buildExportJobs,
  decodeExportBytes,
  deliveryMode,
  dedupeFilenames,
} from "./exportplan.js";
import { zipSync } from "../lib/vendor/fflate.js";
import { createCardCache, idbBackend, memoryBackend } from "./cardcache.js";
import { uniqueFileNames } from "./loadedfiles.js";
import {
  MIN_CARD_PANE_PX,
  SPLITTER_STORAGE_KEY,
  STACKED_MEDIA_QUERY,
  applyStackedState,
  clampSplitterWidth,
  maxCardPaneWidth,
  parseStoredWidth,
  shouldDrag,
} from "./splitter.js";
import { recordIdentity, normalizeInnerPath } from "./lib/analyzer.js";

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

// IndexedDB may be unavailable (private mode etc.); fall back to per-page memory.
const cardCache = createCardCache(
  typeof indexedDB !== "undefined"
    ? idbBackend()
    : memoryBackend(),
);

const els = {
  dropzone: document.getElementById("dropzone"),
  pickBtn: document.getElementById("pick-btn"),
  clearBtn: document.getElementById("clear-btn"),
  fileInput: document.getElementById("file-input"),
  progressWrap: document.getElementById("progresswrap"),
  progress: document.getElementById("progress"),
  progressLabel: document.getElementById("progress-label"),
  cancelBtn: document.getElementById("cancel-btn"),
  compareBtn: document.getElementById("compare-btn"),
  warnings: document.getElementById("warnings"),
  loadedFiles: document.getElementById("loadedfiles"),
  loadedFilesLabel: document.getElementById("loadedfiles-label"),
  loadedFilesChips: document.getElementById("loadedfiles-chips"),
  cardBody: document.getElementById("cardlist-body"),
  cardsEmpty: document.getElementById("cards-empty"),
  viewerHost: document.getElementById("viewerhost"),
  viewerPlaceholder: document.getElementById("viewer-placeholder"),
  workbench: document.getElementById("workbench"),
  cardPane: document.getElementById("cardpane"),
  splitter: document.getElementById("splitter"),
  exportbar: document.getElementById("exportbar"),
  selectAllBtn: document.getElementById("select-all-btn"),
  deselectAllBtn: document.getElementById("deselect-all-btn"),
  exportTickedBtn: document.getElementById("export-ticked-btn"),
  exportStatus: document.getElementById("export-status"),
};

// --- state ---------------------------------------------------------------------

const GENERATION_DISPLAY = { "DAT/protobuf": "XML DAT" }; // gui_version/main.py:480

const cards = []; // { record, file, fileIndex, key }; file is THE source File
const cardKeys = new Set(); // name\0sha256 dedupe across imports (main.py:249-254)
const checked = new Set(); // card keys (compare selection)
const loadedFiles = []; // distinct source-file names, first appearance first (chips)
let scanFiles = []; // FileList snapshot of the scan in flight/last completed
let sessionEpoch = 0; // bumped by Clear; worker replies from an earlier epoch are dropped
let scanEpoch = 0; // epoch of the scan whose replies are currently arriving
let currentScanId = 0;
let nextMessageId = 1;
let selectedCard = null;
let viewer = null;
let pendingView = null; // { cardKey }
let pendingCompare = null; // { want, have: [{label, tables}], missing: Set }
// Worker request id -> card. Correlates tables/exportBlob/error replies by the
// echoed id instead of (fileIndex, record name): names collide across imports
// and a card's fileIndex alone can point at a different file after a later
// scan. Entries are removed when the reply (or an error with that id) arrives.
const pendingReplies = new Map();
// Worker request id -> { resolve, reject } for batch-export requests; a batch
// awaits each reply before sending the next (sequential, per-card progress).
const exportWaiters = new Map();
let exporting = false; // batch export in flight (blocks re-entry)
let progressHideTimer = null; // post-completion hide timer (Rec-2)
let exportStatusTimer = null; // export bar flash hide timer

// --- helpers ---------------------------------------------------------------------

function cardKeyOf(record) {
  return `${record.name}\u0000${record.sha256 ?? ""}`;
}

function cardByKey(key) {
  return cards.find((c) => c.key === key) ?? null;
}

function addWarning(tool, message, source) {
  els.warnings.hidden = false;
  const div = document.createElement("div");
  div.className = "warning";
  const prefix = source ? `${tool} (${source})` : tool;
  const b = document.createElement("strong");
  b.textContent = `[${prefix}] `;
  div.appendChild(b);
  div.appendChild(document.createTextNode(message));
  els.warnings.appendChild(div);
}

function setProgress(done, total, currentFile) {
  // A new scan (or any per-file progress) must cancel a pending post-completion
  // hide timer, or the bar vanishes mid-scan (Rec-2).
  if (progressHideTimer !== null) {
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
  els.progressWrap.hidden = false;
  els.progress.max = Math.max(1, total);
  els.progress.value = done;
  els.progressLabel.textContent = currentFile
    ? `Scanning ${currentFile} — ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")}`
    : `Scan complete — ${total.toLocaleString("en-US")} file(s)`;
  els.cancelBtn.hidden = currentFile === "";
  if (currentFile === "") {
    progressHideTimer = setTimeout(() => {
      progressHideTimer = null;
      els.progressWrap.hidden = true;
    }, 2500);
  }
}

// Export bar status (same flash pattern as the viewer's status line). Progress
// updates pass sticky: true so the message survives a slow parse mid-batch;
// the final message auto-hides.
function exportStatus(message, { sticky = false } = {}) {
  clearTimeout(exportStatusTimer);
  exportStatusTimer = null;
  els.exportStatus.textContent = message;
  els.exportStatus.hidden = false;
  if (!sticky) {
    exportStatusTimer = setTimeout(() => {
      exportStatusTimer = null;
      els.exportStatus.hidden = true;
    }, 4000);
  }
}

function renderLoadedFiles() {
  els.loadedFilesChips.replaceChildren();
  els.loadedFiles.hidden = loadedFiles.length === 0;
  if (!loadedFiles.length) return;
  // Count when >1: "Loaded files (3):" — muted like the other bar labels.
  els.loadedFilesLabel.textContent =
    loadedFiles.length > 1 ? `Loaded files (${loadedFiles.length}):` : "Loaded files:";
  for (const name of loadedFiles) {
    const chip = document.createElement("span");
    chip.className = "loadedfile-chip";
    chip.textContent = name;
    els.loadedFilesChips.appendChild(chip);
  }
}

function renderCardList() {
  els.cardBody.innerHTML = "";
  els.cardsEmpty.hidden = cards.length > 0;
  for (const card of cards) {
    const record = card.record;
    const tr = document.createElement("tr");
    tr.className = card.key === (selectedCard && selectedCard.key) ? "selected" : "";
    tr.dataset.cardKey = card.key;
    const identity = recordIdentity(record.name);
    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked.has(card.key);
    checkbox.setAttribute("aria-label", `Select ${identity || record.name} (compare & export)`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) checked.add(card.key);
      else checked.delete(card.key);
      els.compareBtn.disabled = checked.size < 2;
    });
    tdCheck.appendChild(checkbox);
    tr.appendChild(tdCheck);

    for (const [value, cls] of [
      [record.name, "cell-name"],
      [identity, "cell-identity"],
      [GENERATION_DISPLAY[record.generation] ?? record.generation, "cell-generation"],
      [record.lte_combos >= 0 ? record.lte_combos.toLocaleString("en-US") : "—", "cell-lte"],
      [String(record.nr_combos ?? ""), "cell-nr"],
    ]) {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = value;
      tr.appendChild(td);
    }
    tr.addEventListener("click", (event) => {
      if (event.target === checkbox) return;
      // Row click opens the viewer only; ticking stays a checkbox-only action
      // (sole ownership in the change handler above).
      selectedCard = card;
      for (const other of els.cardBody.children) other.classList.remove("selected");
      tr.classList.add("selected");
      openCard(card);
    });
    els.cardBody.appendChild(tr);
  }
}

// Reflect the checked set into the listed rows' checkboxes + the compare button
// (Select all / Deselect all mutate the set in bulk; re-rendering the list
// would drop the viewer's selected-row state for no benefit).
function syncChecks() {
  for (const tr of els.cardBody.children) {
    const checkbox = tr.querySelector("input[type=checkbox]");
    if (checkbox && tr.dataset.cardKey) checkbox.checked = checked.has(tr.dataset.cardKey);
  }
  els.compareBtn.disabled = checked.size < 2;
}

// --- card view -------------------------------------------------------------------

function destroyViewer() {
  if (viewer) {
    viewer.destroy();
    viewer = null;
  }
}

function renderViewer(card, tables) {
  destroyViewer();
  const record = card.record;
  const identity = recordIdentity(record.name);
  // Exports live in the export bar above the workbench now (Python GUI model);
  // the per-card header buttons were superseded by "Export ticked".
  const head = document.createElement("div");
  head.className = "card-detail";
  const title = document.createElement("span");
  title.className = "card-detail-title";
  title.textContent = record.name;
  head.appendChild(title);
  els.viewerHost.replaceChildren(head);
  viewer = new ComboViewer(els.viewerHost, tables, {
    identity,
    name: record.name,
    generation: record.generation,
    size: record.size,
    // record_json-normalized path (scratch-dir tags are not user-meaningful).
    inner_path: normalizeInnerPath(record.inner_path),
  });
}

function openCard(card) {
  pendingView = { cardKey: card.key };
  const cached = cardCache.get(card.record).then((hit) => {
    if (!pendingView || pendingView.cardKey !== card.key) return;
    if (hit) {
      renderViewer(card, hit.tables);
      return;
    }
    const id = nextMessageId++;
    pendingReplies.set(id, card);
    worker.postMessage({ type: "parseCard", id, fileIndex: card.fileIndex, file: card.file, record: card.record });
  });
  return cached;
}

// --- compare view (compare.js) ----------------------------------------------------

async function openCompare() {
  const selected = cards.filter((c) => checked.has(c.key));
  if (selected.length < 2) return;
  const have = [];
  const missing = new Set();
  for (const card of selected) {
    const hit = await cardCache.get(card.record);
    if (hit) have.push({ label: recordIdentity(card.record.name) || card.record.name, tables: hit.tables });
    else missing.add(card.key);
  }
  if (!missing.size) {
    renderCompare(have);
    return;
  }
  pendingCompare = { want: selected.length, have, missing };
  for (const key of missing) {
    const card = cardByKey(key);
    if (!card) continue;
    const id = nextMessageId++;
    pendingReplies.set(id, card);
    worker.postMessage({ type: "parseCard", id, fileIndex: card.fileIndex, file: card.file, record: card.record });
  }
}

function renderCompare(entries) {
  destroyViewer();
  const sections = compareCards(entries);
  const wrap = document.createElement("div");
  wrap.className = "compare";
  const h = document.createElement("h2");
  h.textContent = `Comparing ${entries.length.toLocaleString("en-US")} cards`;
  wrap.appendChild(h);
  for (const section of sections) {
    const h3 = document.createElement("h3");
    h3.textContent = `${section.kind} band presence (${section.bandHeader})`;
    wrap.appendChild(h3);

    const stats = document.createElement("p");
    stats.className = "compare-stats";
    stats.textContent = section.stats.length
      ? section.stats
          .map((s) => `${s.a} vs ${s.b}: matched ${s.inter} CA combo(s), jaccard ${(s.jaccard * 100).toFixed(1)}%, recall ${(s.recall * 100).toFixed(1)}%, precision ${(s.precision * 100).toFixed(1)}%`)
          .join("  |  ")
      : "No CA combos to compare.";
    wrap.appendChild(stats);

    const table = document.createElement("table");
    table.className = "compare-table";
    const thead = document.createElement("thead");
    thead.innerHTML = `<tr><th>Band</th>${entries.map((e) => `<th></th>`).join("")}</tr>`;
    for (const [i, th] of thead.querySelectorAll("th:not(:first-child)").entries()) {
      th.textContent = entries[i].label;
    }
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const band of section.bands) {
      const tr = document.createElement("tr");
      const tdBand = document.createElement("td");
      tdBand.className = "compare-band";
      tdBand.textContent = band;
      tr.appendChild(tdBand);
      for (const present of section.presence[band]) {
        const td = document.createElement("td");
        td.className = present ? "present" : "absent";
        td.textContent = present ? "✓" : "—";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }
  els.viewerHost.replaceChildren(wrap);
}

// --- batch export (Python GUI model: ticked cards x enabled formats) ---------------

function bytesFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function enabledFormats() {
  return [...els.exportbar.querySelectorAll("input[type=checkbox][data-format]")]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.format);
}

// One worker request per (card, format), resolved when the complete exportBlob
// reply arrives. Requests run strictly sequentially (the worker chains them
// anyway) so a card parses exactly once via the per-File parse memo.
function requestExport(card, format) {
  return new Promise((resolve, reject) => {
    const id = nextMessageId++;
    pendingReplies.set(id, card);
    exportWaiters.set(id, { resolve, reject });
    worker.postMessage({ type: "export", id, fileIndex: card.fileIndex, file: card.file, record: card.record, format });
  });
}

function mimeFor(filename) {
  return filename.endsWith(".json")
    ? "application/json;charset=utf-8"
    : filename.endsWith(".txt")
      ? "text/plain;charset=utf-8"
      : "text/csv;charset=utf-8";
}

// Delivery per design: <=ZIP_FILE_THRESHOLD files download individually
// (BOM-preserving decode so CSVs stay byte-identical to Python's utf-8-sig);
// above it everything ships as ONE fflate zip with deduped entry names.
function deliver(collected, cardCount, failedCount) {
  const suffix = failedCount ? ` ${failedCount} export(s) failed — see warnings.` : "";
  if (!collected.length) {
    exportStatus(`Nothing was exported — see warnings.${suffix}`);
    return;
  }
  if (deliveryMode(collected.length) === "zip") {
    const names = dedupeFilenames(collected.map((f) => f.filename));
    const entries = {};
    for (const [i, f] of collected.entries()) entries[names[i]] = f.bytes;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipName = `${cardCount}cards_export_${stamp}.zip`;
    downloadBytes(zipName, zipSync(entries), "application/zip");
    exportStatus(`Exported ${collected.length.toLocaleString("en-US")} file(s) from ${cardCount.toLocaleString("en-US")} card(s) as ${zipName}.${suffix}`);
  } else {
    for (const f of collected) {
      if (f.filename.endsWith(".mbn")) {
        // Raw .mbn blobs are binary: download the bytes untouched — the text
        // path's UTF-8 decode would corrupt them.
        downloadBytes(f.filename, f.bytes, "application/octet-stream");
      } else {
        download(f.filename, decodeExportBytes(f.bytes), mimeFor(f.filename));
      }
    }
    exportStatus(`Exported ${collected.length.toLocaleString("en-US")} file(s) from ${cardCount.toLocaleString("en-US")} card(s).${suffix}`);
  }
}

async function exportTicked() {
  if (exporting) {
    exportStatus("An export is already running…", { sticky: true });
    return;
  }
  const ticked = cards.filter((c) => checked.has(c.key));
  if (!ticked.length) {
    exportStatus("No cards are ticked — tick at least one card to export.");
    return;
  }
  const formats = enabledFormats();
  if (!formats.length) {
    exportStatus("No export formats are enabled — tick at least one format.");
    return;
  }
  const jobs = buildExportJobs(ticked, formats);
  const cardCount = new Set(jobs.map((j) => j.card.key)).size;
  const collected = []; // { filename, bytes }
  let failedCount = 0;
  exporting = true;
  els.exportTickedBtn.disabled = true;
  // Clear is disabled while a batch runs: it would orphan the in-flight
  // per-job waiters (they are rejected defensively in clearAll too).
  els.clearBtn.disabled = true;
  try {
    let lastKey = null;
    let done = 0;
    for (const job of jobs) {
      if (job.card.key !== lastKey) {
        lastKey = job.card.key;
        done += 1;
        exportStatus(`Exporting ${done.toLocaleString("en-US")}/${cardCount.toLocaleString("en-US")}…`, { sticky: true });
      }
      try {
        const files = await requestExport(job.card, job.format);
        for (const f of files) collected.push({ filename: f.filename, bytes: bytesFromBase64(f.base64) });
      } catch {
        // The shared error handler already warned; keep exporting the rest.
        failedCount += 1;
      }
    }
    deliver(collected, cardCount, failedCount);
  } catch (err) {
    exportStatus(`Export failed: ${err && err.message ? err.message : err}`);
  } finally {
    exporting = false;
    els.exportTickedBtn.disabled = false;
    els.clearBtn.disabled = false;
  }
}

// --- import ------------------------------------------------------------------------

function importFiles(files) {
  if (!files.length) return;
  scanFiles = [...files];
  // Chip row: one pill per distinct source file, first appearance wins —
  // re-importing the same file leaves the chips unchanged.
  const names = uniqueFileNames([...loadedFiles, ...scanFiles.map((f) => f.name)]);
  loadedFiles.length = 0;
  loadedFiles.push(...names);
  renderLoadedFiles();
  currentScanId = nextMessageId++;
  scanEpoch = sessionEpoch;
  els.cancelBtn.hidden = false;
  setProgress(0, files.length, files[0].name);
  worker.postMessage({ type: "scan", id: currentScanId, files: scanFiles });
}

// --- worker messages ----------------------------------------------------------------

worker.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "progress": {
      if (scanEpoch !== sessionEpoch) break; // late reply from a cleared scan
      setProgress(msg.done, msg.total, msg.currentFile);
      break;
    }
    case "records": {
      if (scanEpoch !== sessionEpoch) break; // late reply from a cleared scan
      for (const record of msg.records) {
        const key = cardKeyOf(record);
        if (cardKeys.has(key)) continue; // main.py:348-363 dedupe
        cardKeys.add(key);
        // The File handle lives on the card: every parseCard/export sends it,
        // so the worker resolves bytes from THIS file no matter how many
        // scans ran since the import.
        cards.push({ record, file: scanFiles[msg.fileIndex] ?? null, fileIndex: msg.fileIndex, key });
      }
      for (const warning of msg.warnings ?? []) {
        addWarning(warning.tool ?? "warning", warning.message, msg.source);
      }
      renderCardList();
      break;
    }
    case "tables": {
      const card = pendingReplies.get(msg.id);
      if (!card) break; // unknown/stale request id
      pendingReplies.delete(msg.id);
      cardCache.put(card.record, msg.tables);
      if (pendingView && pendingView.cardKey === card.key) {
        pendingView = null;
        renderViewer(card, msg.tables);
      }
      if (pendingCompare && pendingCompare.missing.has(card.key)) {
        pendingCompare.missing.delete(card.key);
        pendingCompare.have.push({ label: recordIdentity(card.record.name) || card.record.name, tables: msg.tables });
        if (!pendingCompare.missing.size) {
          const have = pendingCompare.have;
          pendingCompare = null;
          renderCompare(have);
        }
      }
      break;
    }
    case "exportBlob": {
      // One reply per export request; files carries every file the format
      // produced (json=1, csv=2, webcsv=1-4, b0cd/b826=1). The batch runner
      // awaits this; a resolved waiter has no pending entry left.
      pendingReplies.delete(msg.id);
      const waiter = exportWaiters.get(msg.id);
      exportWaiters.delete(msg.id);
      if (waiter) waiter.resolve(msg.files ?? []);
      break;
    }
    case "error": {
      if (msg.id !== undefined) {
        pendingReplies.delete(msg.id);
        const waiter = exportWaiters.get(msg.id);
        if (waiter) {
          exportWaiters.delete(msg.id);
          waiter.reject(new Error(msg.message));
        }
      }
      addWarning("error", msg.message, msg.source);
      break;
    }
    default:
      break;
  }
};

// --- DOM events -----------------------------------------------------------------------

els.pickBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  importFiles(els.fileInput.files);
  els.fileInput.value = "";
});
// Cancel path shared by the Cancel button and Clear: stops the in-flight scan
// (a no-op when none is running) and tears down the progress row.
function cancelInFlightScan() {
  worker.postMessage({ type: "cancel", id: currentScanId });
  if (progressHideTimer !== null) {
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
  els.progressWrap.hidden = true;
  els.cancelBtn.hidden = true;
}

els.cancelBtn.addEventListener("click", () => cancelInFlightScan());

// FULL reset (Clear button): cancel any in-flight scan, drop every card /
// selection / viewer / warning / chip, wipe the IndexedDB parse cache, then
// report what was cleared. No confirm() — Clear is itself the confirmation.
async function clearAll() {
  cancelInFlightScan();
  sessionEpoch++; // orphaned replies from the old scan epoch become no-ops
  // Drop in-flight batch-export waiters so nothing can deadlock on a reply
  // that Clear just orphaned; cleared pendingReplies also makes any late
  // "tables" reply a no-op instead of re-populating the wiped cache.
  for (const waiter of exportWaiters.values()) {
    waiter.reject(new Error("Export cancelled: workbench cleared."));
  }
  exportWaiters.clear();
  pendingReplies.clear();
  const cardCount = cards.length;
  cards.length = 0;
  cardKeys.clear();
  checked.clear();
  scanFiles = [];
  loadedFiles.length = 0;
  pendingView = null;
  pendingCompare = null;
  selectedCard = null;
  els.compareBtn.disabled = true;
  els.warnings.replaceChildren();
  els.warnings.hidden = true;
  destroyViewer();
  els.viewerHost.replaceChildren(els.viewerPlaceholder);
  renderCardList();
  renderLoadedFiles();
  await cardCache.clearAll();
  exportStatus(`Cleared ${cardCount.toLocaleString("en-US")} card(s) and the parse cache.`);
}

els.clearBtn.addEventListener("click", () => clearAll());
els.compareBtn.addEventListener("click", () => openCompare());
els.selectAllBtn.addEventListener("click", () => {
  for (const card of cards) checked.add(card.key);
  syncChecks();
});
els.deselectAllBtn.addEventListener("click", () => {
  checked.clear();
  syncChecks();
});
els.exportTickedBtn.addEventListener("click", () => exportTicked());

for (const eventName of ["dragenter", "dragover"]) {
  els.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("drag");
  });
}
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("drag"));
els.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  els.dropzone.classList.remove("drag");
  if (event.dataTransfer && event.dataTransfer.files.length) importFiles(event.dataTransfer.files);
});

// --- workbench splitter ------------------------------------------------------------

// localStorage can throw (privacy modes); a splitter that never persists is
// better than one that breaks the page.
function readStoredSplitterWidth() {
  try {
    return localStorage.getItem(SPLITTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSplitterWidth(px) {
  try {
    localStorage.setItem(SPLITTER_STORAGE_KEY, String(Math.round(px)));
  } catch {}
}

function clearStoredSplitterWidth() {
  try {
    localStorage.removeItem(SPLITTER_STORAGE_KEY);
  } catch {}
}

function setSplitterAriaBounds() {
  els.splitter.setAttribute("aria-valuemin", String(MIN_CARD_PANE_PX));
  els.splitter.setAttribute("aria-valuemax", String(maxCardPaneWidth(els.workbench.clientWidth)));
}

function applyCardPaneWidth(px) {
  els.cardPane.style.flexBasis = `${Math.round(px)}px`;
  els.splitter.setAttribute("aria-valuenow", String(Math.round(px)));
}

function syncSplitterAria() {
  setSplitterAriaBounds();
  els.splitter.setAttribute("aria-valuenow", String(Math.round(els.cardPane.getBoundingClientRect().width)));
}

let splitterDrag = null; // { id, startX, startWidth }

els.splitter.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if (!shouldDrag(document.body.classList.contains("stacked"))) return;
  event.preventDefault();
  splitterDrag = {
    id: event.pointerId,
    startX: event.clientX,
    startWidth: els.cardPane.getBoundingClientRect().width,
  };
  // Synthetic (untrusted) events have no active pointer to capture; the
  // move/up handlers still work on the splitter for those.
  try {
    els.splitter.setPointerCapture(event.pointerId);
  } catch {}
  document.body.classList.add("dragging");
  els.splitter.classList.add("dragging");
  setSplitterAriaBounds();
});

els.splitter.addEventListener("pointermove", (event) => {
  if (!splitterDrag || event.pointerId !== splitterDrag.id) return;
  const width = clampSplitterWidth(splitterDrag.startWidth + event.clientX - splitterDrag.startX, els.workbench.clientWidth);
  applyCardPaneWidth(width);
});

function endSplitterDrag(event) {
  if (!splitterDrag || event.pointerId !== splitterDrag.id) return;
  splitterDrag = null;
  try {
    els.splitter.releasePointerCapture(event.pointerId);
  } catch {}
  document.body.classList.remove("dragging");
  els.splitter.classList.remove("dragging");
  storeSplitterWidth(els.cardPane.getBoundingClientRect().width);
}

els.splitter.addEventListener("pointerup", endSplitterDrag);
els.splitter.addEventListener("pointercancel", endSplitterDrag);

// Double-click resets to the CSS default (44%) and forgets the stored width.
els.splitter.addEventListener("dblclick", () => {
  clearStoredSplitterWidth();
  els.cardPane.style.removeProperty("flex-basis");
  syncSplitterAria();
});

els.splitter.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const delta = event.key === "ArrowRight" ? 16 : -16;
  const width = clampSplitterWidth(els.cardPane.getBoundingClientRect().width + delta, els.workbench.clientWidth);
  applyCardPaneWidth(width);
  storeSplitterWidth(width);
});

window.addEventListener("resize", () => {
  setSplitterAriaBounds();
  if (els.cardPane.style.flexBasis) {
    applyCardPaneWidth(clampSplitterWidth(els.cardPane.getBoundingClientRect().width, els.workbench.clientWidth));
  }
});

// Restore the persisted width (clamped to the current window) on load.
setSplitterAriaBounds();
const storedSplitterWidth = parseStoredWidth(readStoredSplitterWidth(), els.workbench.clientWidth);
if (storedSplitterWidth !== null) applyCardPaneWidth(storedSplitterWidth);
else syncSplitterAria();

// --- stacked (mobile portrait) layout ------------------------------------------------

// Portrait phones stack the card pane above the viewer (css/app.css media
// query) and hide the splitter; leftover inline widths from drags/resizes
// would fight the stacked CSS, so transitions clear them (applyStackedState)
// and leaving stacked re-applies the persisted split like startup.
// matchMedia is feature-checked: without it the page keeps the split layout
// instead of breaking.
const stackedMq = typeof window.matchMedia === "function"
  ? window.matchMedia(STACKED_MEDIA_QUERY)
  : null;

function handleStackedChange(stacked) {
  applyStackedState(stacked, {
    body: document.body,
    cardPane: els.cardPane,
    storedWidth: readStoredSplitterWidth(),
    containerWidth: els.workbench.clientWidth,
    applyWidth: applyCardPaneWidth,
  });
  if (!stacked) syncSplitterAria();
}

if (stackedMq) {
  const onStackedChange = (event) => handleStackedChange(event.matches);
  if (typeof stackedMq.addEventListener === "function") {
    stackedMq.addEventListener("change", onStackedChange);
  } else if (typeof stackedMq.addListener === "function") {
    stackedMq.addListener(onStackedChange); // older Safari
  }
  // Runs after the startup restore above, so a phone opening with a stored
  // split has its inline width cleared before the stacked view first paints.
  handleStackedChange(stackedMq.matches);
}
