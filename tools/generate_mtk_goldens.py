"""Reference outputs for the webapp MTK port, produced by the Python MTK tool.

Runs the MTK GUI backend (main.MtkBackend from mtk-drdi-combo-parser) over each
sample input exactly the way the desktop GUI does:
  inspect -> summarize(retain_combos=True) -> profile_records
  per profile: build_tables(lte, nr) from the in-memory snapshot (viewer)
               extract_and_export(formats={b0cd, b826}) (export bar)

Full outputs (large) go to --out (keep it outside git); a compact manifest of
counts and sha256 digests is written to webapp/goldens/mtk/manifest.json so the
JS port can be checked without shipping the full tables.

usage: python tools/generate_mtk_goldens.py --mtk D:/MTK/mtk-drdi-combo-parser \
           --samples D:/MTK/md1drdi_pack --out D:/MTK/webapp-goldens
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

# Sample inputs: a packaged image where one exists, else the folder holding the
# split parts (md1rom + md1drdi, or md1rom + md1drdi_hdr + md1drdi_data).
SAMPLES = {
    "OppoFindX9Pro": "OppoFindX9Pro",
    "Pixel11": "Pixel11/modem.img",
    "PocoX8": "PocoX8",
    "RG620T-EG": "RG620T-EG/modem-verified.img",
    "RedmiNote105G": "RedmiNote105G/md1img.img",
    "RedmiNote12Pro": "RedmiNote12Pro/md1img.img",
    "SM-X936B": "SM-X936B",
    "VIVO-X300-MAX": "VIVO-X300-MAX",
    "Xiaomi17T": "Xiaomi17T",
    "Xiaomi17TPro": "Xiaomi17TPro",
    "Xiaomi18Fold": "Xiaomi18Fold/tmodem.img",
}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mtk", required=True, type=Path)
    ap.add_argument("--samples", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()
    sys.path.insert(0, str(args.mtk))
    import main as mtk  # noqa: E402  (the MTK tool's GUI backend module)
    from mtk_viewer import build_tables  # noqa: E402

    manifest_path = Path(__file__).resolve().parent.parent / "webapp" / "goldens" / "mtk" / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for device, rel in SAMPLES.items():
        if args.only and device not in args.only:
            continue
        source = args.samples / rel
        out_dir = args.out / device
        out_dir.mkdir(parents=True, exist_ok=True)
        record = mtk.MtkBackend.inspect(source)
        summary = mtk.MtkBackend.summarize(record, retain_combos=True)
        records = mtk.MtkBackend.profile_records(record, summary)
        entry = {"input": rel, "packaging": record.packaging, "layers": list(record.layers),
                 "loader": summary["loader"], "profiles": []}
        for r in records:
            tag = f"bank{r.capability_bank_index}_p{r.profile}"
            data = record.combo_cache.get((r.capability_bank_index, r.profile))
            tables = build_tables(data["lte"], data["nr"]) if data else None
            prof = {"bank": r.capability_bank_index, "profile": r.profile, "counts": r.counts,
                    "bank_only": bool(r.details.get("bank_only")),
                    "secondary_bank": r.details.get("secondary_bank")}
            if tables is not None:
                text = json.dumps(tables, ensure_ascii=False, separators=(",", ":"))
                (out_dir / f"{tag}_tables.json").write_text(text, encoding="utf-8")
                prof["tables"] = {k: len(v) for k, v in tables.items()}
                prof["tables_sha256"] = sha(text)
            with tempfile.TemporaryDirectory() as tmp:
                try:
                    mtk.MtkBackend.extract_and_export(
                        r, Path(tmp), device=device, loader="auto", extraction_profile=str(r.profile),
                        export_formats=frozenset(("b0cd", "b826")))
                    for f in sorted(Path(tmp).glob("*_0xB*.txt")):
                        kind = "b0cd" if "B0CD" in f.name else "b826"
                        text = f.read_text(encoding="utf-8")
                        (out_dir / f"{tag}_{kind}.txt").write_text(text, encoding="utf-8")
                        prof[f"{kind}_sha256"] = sha(text)
                        prof[f"{kind}_name"] = f.name
                except Exception as exc:  # recorded, not fatal: the port must match failures too
                    prof["export_error"] = f"{type(exc).__name__}: {exc}"
            entry["profiles"].append(prof)
        manifest[device] = entry
        print(f"{device}: {entry['loader']}, {len(entry['profiles'])} profiles, "
              f"{sum(1 for p in entry['profiles'] if 'export_error' in p)} export errors", flush=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
