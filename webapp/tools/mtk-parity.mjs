// Parity check of the JS MTK port against the Python MTK tool's goldens
// (tools/generate_mtk_goldens.py). For every sample device: cards (bank,
// profile, counts), every card's viewer tables (sha256 of the exact JSON the
// Python viewer builds) and every card's B0CD / B826 export text.
//
// usage: node tools/mtk-parity.mjs <samples dir> [--goldens <full goldens dir>] [--only Device ...]
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { unwrapBytes, unwrapFiles } from "../js/lib/mtk/containers.js";
import { summarizeMtk, snapshotTables, exportMtkCard, FAMILY_KEYS } from "../js/lib/mtk/backend.js";

const args = process.argv.slice(2);
const samples = args[0];
const goldensDir = args.includes("--goldens") ? args[args.indexOf("--goldens") + 1] : null;
const fresh = args.includes("--fresh-exports");
const only = args.includes("--only") ? args.slice(args.indexOf("--only") + 1) : null;
const manifest = JSON.parse(await readFile(new URL("../goldens/mtk/manifest.json", import.meta.url), "utf8"));
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function filesOf(dir, rel = "") {
  const out = [];
  for (const name of (await readdir(join(dir, rel))).sort()) {
    const p = join(dir, rel, name);
    if ((await stat(p)).isDirectory()) out.push(...await filesOf(dir, rel ? `${rel}/${name}` : name));
    else out.push({ name, dir: rel, path: p });
  }
  return out;
}

// Python json.dumps(tables, separators=(",", ":")) with FAMILIES key order.
function pythonTablesJson(tables) {
  const fam = {};
  for (const [family, key] of Object.entries({ LTE: "lte_ca", "NR SA (1CC)": "nr_sa", "NR-CA": "nr_ca", "EN-DC": "endc", NRDC: "nrdc" })) fam[family] = tables[key];
  void FAMILY_KEYS;
  return JSON.stringify(fam);
}

let failures = 0;
for (const [device, entry] of Object.entries(manifest)) {
  if (only && !only.includes(device)) continue;
  const t0 = performance.now();
  const input = join(samples, entry.input);
  let parts;
  if ((await stat(input)).isDirectory()) {
    const files = [];
    for (const f of await filesOf(input)) files.push({ name: f.name, dir: f.dir, data: new Uint8Array(await readFile(f.path)) });
    parts = await unwrapFiles(files, basename(input));
  } else {
    parts = await unwrapBytes(new Uint8Array(await readFile(input)), basename(input));
  }
  const tUnwrap = performance.now();
  const summary = await summarizeMtk(parts);
  const tSummary = performance.now();
  const problems = [];
  if (summary.loader !== entry.loader) problems.push(`loader ${summary.loader} != ${entry.loader}`);
  if (parts.report.packaging !== entry.packaging) problems.push(`packaging ${parts.report.packaging} != ${entry.packaging}`);
  const want = entry.profiles.map((p) => `${p.bank}/${p.profile}`).join(" ");
  const got = summary.cards.map((c) => `${c.bank}/${c.profile}`).join(" ");
  if (want !== got) problems.push(`cards differ:\n   want ${want}\n   got  ${got}`);
  let tablesOk = 0, exportsOk = 0, exportsTotal = 0;
  for (const p of entry.profiles) {
    const card = summary.cards.find((c) => c.bank === p.bank && c.profile === p.profile);
    if (!card) continue;
    if (JSON.stringify(card.counts) !== JSON.stringify(p.counts)) problems.push(`b${p.bank}/p${p.profile} counts ${JSON.stringify(card.counts)} != ${JSON.stringify(p.counts)}`);
    const json = pythonTablesJson(snapshotTables(summary, p.bank, p.profile));
    if (sha(json) === p.tables_sha256) tablesOk++;
    else {
      problems.push(`b${p.bank}/p${p.profile} tables differ`);
      if (goldensDir && problems.length < 6) {
        const g = JSON.parse(await readFile(join(goldensDir, device, `bank${p.bank}_p${p.profile}_tables.json`), "utf8"));
        const j = JSON.parse(json);
        for (const fam of Object.keys(g)) {
          if (JSON.stringify(g[fam]) !== JSON.stringify(j[fam])) {
            const i = g[fam].findIndex((row, k) => JSON.stringify(row) !== JSON.stringify(j[fam][k]));
            problems.push(`   ${fam}: rows ${j[fam].length} vs ${g[fam].length}; first diff @${i}\n     want ${JSON.stringify(g[fam][i])}\n     got  ${JSON.stringify(j[fam][i])}`);
          }
        }
      }
    }
    if (!(p.b0cd_sha256 || p.b826_sha256)) continue;
    const texts = await exportMtkCard(parts, card, device, undefined, fresh ? {} : { loader: summary.active });
    for (const kind of ["b0cd", "b826"]) {
      const wantSha = p[`${kind}_sha256`];
      if (!wantSha && !texts[kind]) continue;
      exportsTotal++;
      if (texts[kind] !== undefined && sha(texts[kind]) === wantSha) exportsOk++;
      else problems.push(`b${p.bank}/p${p.profile} ${kind} ${texts[kind] === undefined ? "missing" : "differs"}${wantSha ? "" : " (golden has none)"}`);
    }
  }
  const t1 = performance.now();
  const status = problems.length ? "FAIL" : "OK";
  if (problems.length) failures++;
  console.log(`${status.padEnd(4)} ${device.padEnd(14)} ${summary.loader.padEnd(6)} cards ${summary.cards.length}/${entry.profiles.length}  tables ${tablesOk}/${entry.profiles.length}  exports ${exportsOk}/${exportsTotal}  unwrap ${((tUnwrap - t0) / 1000).toFixed(1)}s summarize ${((tSummary - tUnwrap) / 1000).toFixed(1)}s exports ${((t1 - tSummary) / 1000).toFixed(1)}s`);
  for (const line of problems.slice(0, 8)) console.log(`     ${line}`);
}
process.exit(failures ? 1 : 0);
