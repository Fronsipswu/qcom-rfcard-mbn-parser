#!/usr/bin/env python3
"""Differential reference for the webapp 0xB0CD/0xB826 DIAG exports.

Runs the repo's gui_version/qualcomm_rf_combo_analyzer.py (byte-identical to
the upstream gui_version) on one blob file and writes the exact DIAG export
texts via the real _write_diag implementation, plus prints the per-packet
labels and payload hex as JSON. diag.test.mjs pins the JS exportModule output
to these files byte for byte.

Run: python3 webapp/tests/diag_ref.py <blob.bin> <name> <generation> <outdir>
"""
import json
import os
import sys
from pathlib import Path

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, os.pardir)
sys.path.insert(0, os.path.join(ROOT, "gui_version"))

import qualcomm_rf_combo_analyzer as analyzer  # noqa: E402


def main() -> None:
    blob_path, name, generation, outdir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    blob = Path(blob_path).read_bytes()

    record = analyzer.ModuleRecord(
        inner_path=blob_path,
        name=name,
        generation=generation,
        size=len(blob),
        hwid=0,
        fsid=0,
        bid=0,
        external=True,
        source_path=blob_path,
    )
    parsed = analyzer.parse_module(record, blob)

    written = {}
    for key, log_code, version in (
        ("b0cd", "0xB0CD", 41),
        ("b826", "0xB826", 22),
    ):
        packets = parsed["diag"][key]
        destination = Path(outdir) / f"{key}.txt"
        analyzer._write_diag(destination, log_code, version, packets)
        written[key] = {
            "file": str(destination),
            "labels": [label for label, _ in packets],
            "hex": [payload.hex() for _, payload in packets],
        }

    print("DIAGREF = " + json.dumps(written))


if __name__ == "__main__":
    main()
