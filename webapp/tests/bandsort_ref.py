#!/usr/bin/env python3
"""Differential reference for viewer.js band/column sort keys.

Execs gui_version/viewer.py's real _band_sort_key + _column_sort_key code
verbatim (same exec-a-block pattern as bandcolors_ref.py) and prints JSON
vectors: sort keys for a battery of cells/values plus fully sorted (forward
and reversed) orders. bandsort.test.mjs pins the JS port against these.

Run: python3 webapp/tests/bandsort_ref.py
"""
import json
import os
import re

VIEWER = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      os.pardir, os.pardir, "gui_version", "viewer.py")
src = open(VIEWER, encoding="utf-8").read()

# Exec the verbatim block: BAND_COLUMN_HEADERS through _column_sort_key.
block = src[src.index("BAND_COLUMN_HEADERS"): src.index("def _band_color")]
ns = {"re": re}
exec(block, ns)
BAND_COLUMN_HEADERS = ns["BAND_COLUMN_HEADERS"]
_band_sort_key = ns["_band_sort_key"]
_column_sort_key = ns["_column_sort_key"]

BAND_CELLS = [
    "8A", "11A", "8A + 11A", "8C + 8A", "1", "1 + 2 + 3", "", "B3A", "42e",
    " 42E", "999Z", "5\n", "8-", "x + 1A", "13", "1A + 1A", "٠٧A", "0007A",
    "+5", "-5", "5A\n", "٥", "123456789012345A", "7A + 7A + 7A", "2", "20A",
    "8A", "1",  # duplicates: probe sorted(reverse=True) stability
]

COL_CASES = [
    {"col": "LTE DL", "values": BAND_CELLS},
    {"col": "NR DL", "values": ["78A + 41C", "41C", "n78", "79", "257A", "1"]},
    {"col": "MIMO DL", "values": ["1 + 1 + 2", "4", "2", "1 + 4", "", "0", "8"]},
    {"col": "SCS DL (kHz)", "values": ["15 + 15", "15", "30 + 30 + 30", "", "15"]},
    {"col": "DL (QAM)", "values": ["256", "", "64"]},
    {"col": "UL TX Switch", "values": ["option 1", "-", "option 1,2", "option 2"]},
    {"col": "BCS", "values": ["All", "0", "None", "3", "-1"]},
    {"col": "BW DL (MHz)", "values": ["100", "40 + 40", "", "25", "8 + 8 + 8"]},
    {"col": "NR UL", "values": ["78A + 41C", "41C", "n78", "79"]},
    {"col": "NonNumeric", "values": [" 5 ", "5.0", "+5", "007", "٢٥٦", "1_0", "abc", "", "5\n"]},
]

out = {"BAND_CELLS": BAND_CELLS, "BAND_KEYS": [_band_sort_key(c) for c in BAND_CELLS],
       "COL_CASES": []}
for case in COL_CASES:
    col = case["col"]
    key = _column_sort_key(col)
    values = case["values"]
    rows = [{col: v} for v in values]
    out["COL_CASES"].append({
        "col": col,
        "values": values,
        "keys": [key(r) for r in rows],
        "sorted": [r[col] for r in sorted(rows, key=key)],
        "sorted_reverse": [r[col] for r in sorted(rows, key=key, reverse=True)],
    })

print("VIEWER_SORT = " + json.dumps(out, ensure_ascii=False))
