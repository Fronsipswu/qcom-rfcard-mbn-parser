# Goldens manifest

Differential goldens generated from the Python parsers for the webapp rewrite.
Regenerate with the exact command below whenever `gui_version/` parsers change;
review the diff before committing.

- Generator command: `python3 tools/generate_goldens.py --corpus-dir /home/henrik/apps/qualcomm-hwcombos-mbn-parser --out webapp/goldens`
- Python version: `Python 3.14.4`
- Parser commit (`git rev-parse HEAD` at generation time): `125f0e30ff1ea8a5a7bc9067bc25209705ae878f`

Contents:

- `corpus.json` — per-image `ModuleRecord` summaries (`record_json` in the generator);
  `inner_path` is normalized by replacing a leading extracted-container scratch
  directory (`fat_<rand>`, `sparse_<rand>`, …) with the bare tag (`fat/…`, `sparse/…`)
  so goldens are byte-identical across regeneration runs.
- `parse/<image>__<record>.json` — a transform of `parse_module` output: the flat
  `combinations` list is grouped by each row's `table` key (first-appearance order)
  into `{table: [rows]}`, then rows are sampled per table (first 5 + every 20th,
  see `SAMPLES_PER_TABLE`/`PARSE_SAMPLE_RATE` — positional, not RNG-seeded);
  `metadata`/`diag` sections are dropped; components kept in full;
  `*raw_hex` strings truncated to 64 chars (recursive).
- `tables/<image>__<record>.json` — full `generate_web_tables` output.

Apple C-series differential goldens (`apple/`):

- `apple/manifest.json` — per-bank inspect summaries (committed; small).
- `apple/tables.json` / `apple/diag.json` — full `generate_combo_tables` output and
  b0cd/b826 DIAG texts for all 58 banks. Oversized reference dumps (>100 MB GitHub
  limit) — excluded from git, tests skip without them.
- Regenerate after any apple-parser change:
  `python3 tools/generate_apple_goldens.py --corpus-dir /home/henrik/apps/qualcomm-hwcombos-mbn-parser --out webapp/goldens`
  (uses the fixed reference in `apple-c-modem-parser/apple_parser_fix`).
