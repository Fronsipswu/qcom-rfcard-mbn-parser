// Worker protocol: stable source identity (WEBAPP_PERFORMANCE_REVIEW.md step 2).
//
// A File posted to a worker is structured-cloned into a NEW wrapper per message,
// so the old WeakMaps keyed by the File object never hit across requests. main.js
// now assigns a monotonic, never-reused sourceId per imported File and registers
// {sourceId, file} once in the scan; every parseCard/export/importCards carries
// only the id. These tests drive worker.js through a fake `self` and assert the
// per-source memo actually survives across separate messages.
//
// worker.js is a module entry (it installs self.onmessage at import time), so the
// fake self must exist before the dynamic import. `parseModule` once is covered
// by the corpus-gated case at the bottom; the always-on cases use a synthetic tar
// container, because a parseable card requires corpus data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CORPUS_DIR, corpusAvailable } from "./helpers.mjs";

// --- synthetic tar (extractTar ignores the checksum field) ---------------------

const octal = (n, width) => n.toString(8).padStart(width - 1, "0") + "\0";

function tarHeader(name, size) {
  const h = new Uint8Array(512);
  const write = (off, s) => {
    for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
  };
  write(0, name.slice(0, 100));
  write(100, "0000644\0");
  write(108, "0000000\0");
  write(116, "0000000\0");
  write(124, octal(size, 12));
  write(136, octal(0, 12));
  for (let i = 0; i < 8; i++) h[148 + i] = 0x20;
  h[156] = 0x30; // regular file
  write(257, "ustar\0");
  write(263, "00");
  return h;
}

const pad512 = (data) => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
};

function buildTar(members) {
  const blocks = [];
  for (const m of members) blocks.push(tarHeader(m.name, m.data.length), pad512(m.data));
  blocks.push(new Uint8Array(1024)); // end-of-archive marker
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

const MBN_BYTES = new Uint8Array(600);
for (let i = 0; i < MBN_BYTES.length; i++) MBN_BYTES[i] = (i * 13 + 7) & 0xff;
const TAR = buildTar([{ name: "rf_config_1306_0_0.mbn", data: MBN_BYTES }]);

// --- fake worker host ----------------------------------------------------------

const posted = [];
const waiters = [];
globalThis.self = {
  postMessage(message) {
    posted.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(message)) waiters.splice(i, 1)[0].resolve(message);
    }
  },
};

const workerModule = await import(new URL("../js/worker.js", import.meta.url).href);

function waitFor(predicate, start = 0) {
  // Only consider messages posted at/after `start`: several tests post replies
  // with the same shape (e.g. records with fileIndex 0), and an unscoped scan
  // would match an earlier test's reply.
  for (let i = start; i < posted.length; i++) {
    if (predicate(posted[i])) return Promise.resolve(posted[i]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a worker reply")), 5000);
    waiters.push({
      predicate,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    });
  });
}

async function request(message, predicate) {
  const start = posted.length;
  const pending = waitFor(predicate, start);
  globalThis.self.onmessage({ data: message });
  return pending;
}

// --- tests ---------------------------------------------------------------------

test("worker: scan artifacts mean two exports of one sourceId never re-extract", async () => {
  const sourceId = 101;
  const scan = await request(
    { type: "scan", id: 1, files: [{ sourceId, file: new File([TAR], "payload.tar") }] },
    (m) => m.type === "records" && m.fileIndex === 0,
  );
  assert.equal(scan.records.length, 1, "the tar's candidate must be discovered");
  const record = scan.records[0];

  const parseBefore = workerModule.getDebugCounters().parseModule;
  // The scan seeds parseMemo with the exact candidate bytes (step 3), so neither
  // export may run extractContainer again or invoke the parser.
  const extractAfterScan = workerModule.getDebugCounters().extractContainer;

  const first = await request(
    { type: "export", id: 11, sourceId, fileIndex: 0, record, format: "mbn" },
    (m) => m.id === 11,
  );
  assert.deepEqual(new Uint8Array(first.files[0].bytes), MBN_BYTES);

  const second = await request(
    { type: "export", id: 12, sourceId, fileIndex: 0, record, format: "mbn" },
    (m) => m.id === 12,
  );
  assert.deepEqual(new Uint8Array(second.files[0].bytes), MBN_BYTES, "bytes must be identical");
  assert.equal(
    workerModule.getDebugCounters().extractContainer,
    extractAfterScan,
    "seeded scan bytes must make both exports extraction-free",
  );
  assert.equal(workerModule.getDebugCounters().parseModule, parseBefore, "a pure mbn export must never parse");
});

test("worker: an unknown sourceId errors with the request id instead of reading", async () => {
  const reply = await request(
    { type: "parseCard", id: 77, sourceId: 987654, fileIndex: 0, record: { name: "missing.mbn" } },
    (m) => m.type === "error" && m.id === 77,
  );
  assert.match(reply.message, /unknown sourceId/);
});

test("worker: release drops the registered sources so later ops fail loudly", async () => {
  const sourceId = 202;
  await request(
    { type: "scan", id: 2, files: [{ sourceId, file: new File([TAR], "payload2.tar") }] },
    (m) => m.type === "records" && m.fileIndex === 0,
  );
  globalThis.self.onmessage({ data: { type: "release" } });
  const reply = await request(
    { type: "parseCard", id: 78, sourceId, fileIndex: 0, record: { name: "payload2.tar" } },
    (m) => m.type === "error" && m.id === 78,
  );
  assert.match(reply.message, /unknown sourceId/);
});

test("worker: reopening the same card parses once (corpus-gated)", { skip: !corpusAvailable() }, async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  // radio.img is the container image corpusAvailable() guarantees; its scan
  // extracts once and step 3 seeds parseMemo, so reopen must not re-extract.
  const bytes = await readFile(join(CORPUS_DIR, "radio.img"));
  const file = new File([bytes], "radio.img");
  const sourceId = 303;
  const scan = await request(
    { type: "scan", id: 3, files: [{ sourceId, file }] },
    (m) => m.type === "records" && m.fileIndex === 0,
  );
  const record = scan.records[0];
  assert.ok(record, "the image must yield at least one card");
  const extractAfterScan = workerModule.getDebugCounters().extractContainer;

  await request({ type: "parseCard", id: 31, sourceId, fileIndex: 0, record }, (m) => m.id === 31);
  const afterFirst = workerModule.getDebugCounters().parseModule;
  await request({ type: "parseCard", id: 32, sourceId, fileIndex: 0, record }, (m) => m.id === 32);
  assert.equal(
    workerModule.getDebugCounters().parseModule,
    afterFirst,
    "reopening a card must hit the per-source parse memo",
  );
  assert.equal(
    workerModule.getDebugCounters().extractContainer,
    extractAfterScan,
    "seeded scan bytes must make card opens extraction-free",
  );
});
