#!/usr/bin/env python3
"""Regenerate the apple differential goldens webapp/goldens/apple/{tables,diag}.json
from the FIXED python reference parser.

Usage: python3 tools/generate_apple_goldens.py [--corpus-dir DIR] [--out DIR]

The reference is <corpus>/apple-c-modem-parser/apple_parser_fix (updated parser
with the LTE EN-DC MIMO decode); bank fixtures are the pre-decompressed bins in
<corpus>/apple-c-modem-parser/<layout>/ftab_cr_banks/<stem>.bin. Golden keys
mirror the tests: "<layout>/<stem>". manifest.json is NOT rewritten — the
inspect counts are layout/scan-level and unaffected by the feature-matrix fix.

tables.json/diag.json are oversized reference dumps (GitHub 100 MB limit): they
stay untracked (webapp/.gitignore) and the differential tests skip without
them; regenerate locally with this tool after any parser change.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus-dir", default=str(REPO.parent))
    ap.add_argument("--out", default=str(REPO / "webapp" / "goldens"))
    args = ap.parse_args()
    corpus = Path(args.corpus_dir)
    out = Path(args.out) / "apple"

    sys.path.insert(0, str(corpus / "apple-c-modem-parser" / "apple_parser_fix"))
    import apple_cr_parser as parser  # noqa: E402
    from apple_export import export_bank  # noqa: E402
    from viewer import generate_combo_tables  # noqa: E402

    ref = corpus / "apple-c-modem-parser"
    banks = {}
    for layout in ("c1", "c2"):
        for bin_path in sorted((ref / layout / "ftab_cr_banks").glob("*.bin")):
            banks[f"{layout}/{bin_path.stem}"] = bin_path
    if len(banks) != 58:
        raise SystemExit(f"expected 58 bank fixtures, found {len(banks)}")

    tables_golden = {}
    diag_golden = {}
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        for key, path in banks.items():
            stem = key.split("/")[1]
            bank = parser.parse_bank(path)
            parser.require_valid_bank(bank)
            tables_golden[key] = generate_combo_tables(bank)
            # Export through the reference's own export path so the diag texts
            # are byte-identical to what apple_export.py produces.
            export_bank(bank, tmp, stem, formats=("b0cd", "b826"))
            diag_golden[key] = {
                "b0cd": (tmp / f"{stem}_0xB0CD_v41.txt").read_text(encoding="utf-8"),
                "b826": (tmp / f"{stem}_0xB826_v22.txt").read_text(encoding="utf-8"),
            }
            print(key)

    out.mkdir(parents=True, exist_ok=True)
    (out / "tables.json").write_text(json.dumps(tables_golden, indent=1) + "\n", encoding="utf-8")
    (out / "diag.json").write_text(json.dumps(diag_golden, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out / 'tables.json'} and {out / 'diag.json'} for {len(banks)} banks")


if __name__ == "__main__":
    main()
