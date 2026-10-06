// MediaTek end-to-end through the worker message protocol (corpus-gated):
// scan -> records (cards) -> parseCard tables -> export b0cd/b826 -> importCards,
// checked against the Python MTK tool's goldens (goldens/mtk/manifest.json,
// tools/generate_mtk_goldens.py). Runs only when MTK_SAMPLES points at the
// sample tree (e.g. D:/MTK/md1drdi_pack); the module-level parity of every
// device is covered by tools/mtk-parity.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

const SAMPLES = process.env.MTK_SAMPLES ?? "";
const available = SAMPLES && existsSync(SAMPLES);
const manifest = JSON.parse(await readFile(new URL("../goldens/mtk/manifest.json", import.meta.url), "utf8"));
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const posted = [];
const waiters = [];
globalThis.self = {
  postMessage(message) {
    posted.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].predicate(message)) waiters.splice(i, 1)[0].resolve(message);
  },
};
const worker = available ? await import(new URL("../js/worker.js", import.meta.url).href) : null;
void worker;

function request(message, predicate) {
  const start = posted.length;
  return new Promise((resolve, reject) => {
    for (let i = start; i < posted.length; i++) if (predicate(posted[i])) return resolve(posted[i]);
    const timer = setTimeout(() => reject(new Error("timed out waiting for a worker reply")), 120000);
    waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    globalThis.self.onmessage({ data: message });
  });
}

let nextId = 1000;
let nextSource = 5000;

// The worker labels DIAG texts with the input stem; the goldens were made with
// the device name. Only "#" header lines carry the label.
const relabel = (text, stem, device) => text.split("\n").map((line) => (line.startsWith("#") ? line.replaceAll(stem, device) : line)).join("\n");

async function scanAndCheck(device, files, stem) {
  const entry = manifest[device];
  const scanId = nextId++;
  const registered = files.map((file) => ({ sourceId: nextSource++, file }));
  const start = posted.length;
  await request({ type: "scan", id: scanId, files: registered }, (m) => m.type === "progress" && m.currentFile === "" && m.done === m.total);
  const replies = posted.slice(start);
  const errors = replies.filter((m) => m.type === "error");
  assert.deepEqual(errors, [], `${device}: scan errors`);
  const records = replies.filter((m) => m.type === "records").flatMap((m) => m.records.map((r) => ({ r, fileIndex: m.fileIndex })));
  assert.equal(records.length, entry.profiles.length, `${device}: card count`);
  for (const p of entry.profiles) {
    const hit = records.find(({ r }) => r.mtk && r.mtk.bank === p.bank && r.mtk.profile === p.profile);
    assert.ok(hit, `${device}: card bank ${p.bank} / profile ${p.profile}`);
    const sourceId = registered[hit.fileIndex].sourceId;
    // Viewer tables: same rows as the Python viewer, nothing beyond its columns.
    const tables = await request({ type: "parseCard", id: nextId++, sourceId, fileIndex: hit.fileIndex, record: hit.r }, (m) => m.type === "tables" || m.type === "error");
    assert.equal(tables.type, "tables", `${device} b${p.bank}/p${p.profile}: ${tables.message ?? ""}`);
    const t = tables.tables;
    const json = JSON.stringify({ LTE: t.lte_ca, "NR SA (1CC)": t.nr_sa, "NR-CA": t.nr_ca, "EN-DC": t.endc, NRDC: t.nrdc });
    assert.equal(sha(json), p.tables_sha256, `${device} b${p.bank}/p${p.profile}: tables`);
    for (const kind of ["b0cd", "b826"]) {
      const reply = await request({ type: "export", id: nextId++, sourceId, fileIndex: hit.fileIndex, record: hit.r, format: kind }, (m) => m.type === "exportBlob" || m.type === "error");
      assert.equal(reply.type, "exportBlob", `${device}: export ${kind}: ${reply.message ?? ""}`);
      if (p[`${kind}_sha256`]) {
        assert.equal(reply.files.length, 1, `${device} b${p.bank}/p${p.profile}: ${kind} file`);
        assert.equal(sha(relabel(reply.files[0].text, stem, device)), p[`${kind}_sha256`], `${device} b${p.bank}/p${p.profile}: ${kind} text`);
      } else {
        assert.equal(reply.files.length, 0, `${device} b${p.bank}/p${p.profile}: no ${kind} rows -> no file`);
      }
    }
  }
  // Unsupported formats fail with a clear message instead of an empty file.
  const { r, fileIndex } = records[0];
  const bad = await request({ type: "export", id: nextId++, sourceId: registered[fileIndex].sourceId, fileIndex, record: r, format: "csv" }, (m) => m.type === "error" || m.type === "exportBlob");
  assert.equal(bad.type, "error");
  assert.match(bad.message, /not available for MediaTek cards/);
  return { records, registered };
}

async function fileFrom(path) {
  return new File([await readFile(path)], basename(path));
}

test("MTK image with an MTK partition header (RedmiNote105G md1img.img)", { skip: !available }, async () => {
  await scanAndCheck("RedmiNote105G", [await fileFrom(join(SAMPLES, manifest.RedmiNote105G.input))], "md1img");
});

test("MTK ext4 image found by the post-Qualcomm fallback (Xiaomi18Fold tmodem.img)", { skip: !available }, async () => {
  await scanAndCheck("Xiaomi18Fold", [await fileFrom(join(SAMPLES, manifest.Xiaomi18Fold.input))], "tmodem");
});

test("MTK extracted parts imported together (PocoX8 md1rom + md1drdi) and Import to parser", { skip: !available }, async () => {
  const dir = join(SAMPLES, manifest.PocoX8.input);
  const files = [];
  for (const name of (await readdir(dir)).sort()) if (/md1(rom|drdi)/.test(name)) files.push(await fileFrom(join(dir, name)));
  const { records, registered } = await scanAndCheck("PocoX8", files, "MediaTek parts");
  const { r, fileIndex } = records.find(({ r: rec }) => rec.mtk.counts.endc > 0 && rec.mtk.counts.lte > 0);
  const reply = await request({ type: "importCards", id: nextId++, sourceId: registered[fileIndex].sourceId, fileIndex, record: r }, (m) => m.type === "exportBlob" || m.type === "error");
  assert.equal(reply.type, "exportBlob");
  assert.ok(reply.files.some((f) => f.filename.endsWith("_0xB0CD_v41.txt")), "B0CD text for import");
  assert.ok(reply.files.some((f) => f.filename.endsWith("_0xB826_v21_combined.txt")), "B826 text for import");
});
