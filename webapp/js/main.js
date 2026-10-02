// Workbench UI (Task 11 Step 5): drag-drop + file picker import, progress bar
// bound to worker "progress" messages, cancel, record list (name, HWID
// identity, generation, LTE/NR counts), detect-and-warn warnings panel and the
// IndexedDB card-table cache (sha256-keyed). All parsing lives in worker.js;
// this module only handles JSON rows, exactly like the viewer contract.
import { ComboViewer } from "./viewer.js";
import { compareCards } from "./compare.js";
import { download } from "./exporter.js";
import { createCardCache, idbBackend, memoryBackend } from "./cardcache.js";
import {
  MIN_CARD_PANE_PX,
  SPLITTER_STORAGE_KEY,
  clampSplitterWidth,
  maxCardPaneWidth,
  parseStoredWidth,
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
  fileInput: document.getElementById("file-input"),
  progressWrap: document.getElementById("progresswrap"),
  progress: document.getElementById("progress"),
  progressLabel: document.getElementById("progress-label"),
  cancelBtn: document.getElementById("cancel-btn"),
  compareBtn: document.getElementById("compare-btn"),
  warnings: document.getElementById("warnings"),
  cardBody: document.getElementById("cardlist-body"),
  cardsEmpty: document.getElementById("cards-empty"),
  viewerHost: document.getElementById("viewerhost"),
  workbench: document.getElementById("workbench"),
  cardPane: document.getElementById("cardpane"),
  splitter: document.getElementById("splitter"),
};

// --- state ---------------------------------------------------------------------

const GENERATION_DISPLAY = { "DAT/protobuf": "XML DAT" }; // gui_version/main.py:480

const cards = []; // { record, file, fileIndex, key }; file is THE source File
const cardKeys = new Set(); // name\0sha256 dedupe across imports (main.py:249-254)
const checked = new Set(); // card keys (compare selection)
let scanFiles = []; // FileList snapshot of the scan in flight/last completed
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
let progressHideTimer = null; // post-completion hide timer (Rec-2)

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

function renderCardList() {
  els.cardBody.innerHTML = "";
  els.cardsEmpty.hidden = cards.length > 0;
  for (const card of cards) {
    const record = card.record;
    const tr = document.createElement("tr");
    tr.className = card.key === (selectedCard && selectedCard.key) ? "selected" : "";
    const identity = recordIdentity(record.name);
    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked.has(card.key);
    checkbox.setAttribute("aria-label", `Compare ${identity || record.name}`);
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
      selectedCard = card;
      for (const other of els.cardBody.children) other.classList.remove("selected");
      tr.classList.add("selected");
      openCard(card);
    });
    els.cardBody.appendChild(tr);
  }
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
  const head = document.createElement("div");
  head.className = "card-detail";
  head.innerHTML = `<span class="card-detail-title"></span>
    <span class="card-detail-actions">
      <button type="button" data-format="json">Export JSON</button>
      <button type="button" data-format="csv">Export CSV</button>
      <button type="button" data-format="webcsv">Export Web CSV</button>
      <button type="button" data-format="b0cd">Export 0xB0CD (LTE)</button>
      <button type="button" data-format="b826">Export 0xB826 (NR)</button>
    </span>`;
  head.querySelector(".card-detail-title").textContent = record.name;
  for (const btn of head.querySelectorAll("button[data-format]")) {
    btn.addEventListener("click", () => {
      const id = nextMessageId++;
      pendingReplies.set(id, card);
      worker.postMessage({ type: "export", id, fileIndex: card.fileIndex, file: card.file, record: card.record, format: btn.dataset.format });
    });
  }
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

// --- import ------------------------------------------------------------------------

function importFiles(files) {
  if (!files.length) return;
  scanFiles = [...files];
  currentScanId = nextMessageId++;
  els.cancelBtn.hidden = false;
  setProgress(0, files.length, files[0].name);
  worker.postMessage({ type: "scan", id: currentScanId, files: scanFiles });
}

// --- worker messages ----------------------------------------------------------------

worker.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "progress": {
      setProgress(msg.done, msg.total, msg.currentFile);
      break;
    }
    case "records": {
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
      // An export can emit several files; the reply is consumed on the first
      // blob (the rest still download), and an error with the id would clear
      // it too — no pending entry outlives its request.
      pendingReplies.delete(msg.id);
      const bin = atob(msg.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = msg.filename.endsWith(".json")
        ? "application/json;charset=utf-8"
        : msg.filename.endsWith(".txt")
          ? "text/plain;charset=utf-8"
          : "text/csv;charset=utf-8";
      download(msg.filename, new TextDecoder().decode(bytes), mime);
      break;
    }
    case "error": {
      if (msg.id !== undefined) pendingReplies.delete(msg.id);
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
els.cancelBtn.addEventListener("click", () => {
  worker.postMessage({ type: "cancel", id: currentScanId });
  if (progressHideTimer !== null) {
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
  els.progressWrap.hidden = true;
  els.cancelBtn.hidden = true;
});
els.compareBtn.addEventListener("click", () => openCompare());

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
