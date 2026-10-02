#!/usr/bin/env python3
"""Golden reference for bandcolors.js — execs viewer.py's real code verbatim.

Run: python3 webapp/tests/bandcolors_ref.py   (prints PALETTE/md5/GOLDEN/SPANS
vectors that bandcolors.test.mjs pins; regenerate after viewer.py changes.)
"""
import ast, hashlib, json, os, re, sys

VIEWER = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      os.pardir, os.pardir, "gui_version", "viewer.py")
src = open(VIEWER, encoding="utf-8").read()

# Extract PALETTE literal via ast (annotation makes it non-executable as-is)
m = re.search(r"PALETTE: tuple\[str, \.\.\.\] = (\(.*?\))\n", src, re.S)
PALETTE = ast.literal_eval(m.group(1))
assert len(PALETTE) == 40, len(PALETTE)

# Exec the verbatim helper block (lines from BAND_COLUMN_HEADERS through _band_spans)
block = src[src.index("BAND_COLUMN_HEADERS"): src.index("def _band_sort_key")]
ns = {"re": re}
exec(block, ns)
BAND_COLUMN_HEADERS = ns["BAND_COLUMN_HEADERS"]
_band_spans = ns["_band_spans"]
_column_band_prefix = ns["_column_band_prefix"]

def _band_color(canonical):
    digest = int.from_bytes(hashlib.md5(canonical.encode("utf-8")).digest(), "big")
    return PALETTE[digest % len(PALETTE)]

# --- sanity / spot checks -------------------------------------------------
print("PALETTE_js =", json.dumps(list(PALETTE)))
print("md5_B3_hex =", hashlib.md5(b"B3").hexdigest())
print("md5_B3_mod40 =", int(hashlib.md5(b"B3").hexdigest(), 16) % 40)
print("B42_vs_n42_equal =", _band_color("B42") == _band_color("n42"))
print("int.from_bytes == int(hexdigest,16):",
      int.from_bytes(hashlib.md5(b"B3").digest(), "big") == int(hashlib.md5(b"B3").hexdigest(), 16))
print("md5IntMod checks:")
for s, m_ in [("B3", 40), ("", 40), ("n78", 1024), ("BΩ", 40), (chr(0x1D7CE) + "3", 7)]:
    d = int.from_bytes(hashlib.md5(s.encode("utf-8")).digest(), "big")
    print(f"  {s!r} mod {m_} = {d % m_}")

# --- canonical set (>=200) ------------------------------------------------
canon = [f"B{i}" for i in range(1, 121)] + [f"n{i}" for i in range(1, 121)]
canon += [f"{p}{i}" for i in range(121, 301, 7) for p in ("B", "n")]
canon += ["B0", "n0", "B1000", "n99999", "n007", "B123456789012345678901234567890",
          "B", "n", "x", "BΩ", "nÄ", "", "B" + chr(0x1D7CE) + "3"]
print("canonical_count =", len(canon))
print("GOLDEN = " + json.dumps([[c, _band_color(c)] for c in canon], ensure_ascii=False, separators=(",", ":")))

# --- span battery ----------------------------------------------------------
cells = [
    ("42E + 7A", "LTE DL"), ("78A + 41C", "NR DL"), ("B3A", "NR DL"), ("B3A", "LTE DL"),
    ("B3C + B7A", "LTE DL"), ("XX + B3", "LTE DL"), ("B3 + ", "LTE DL"), ("999Z", "LTE DL"),
    ("999Z", "NR DL"), ("8-", "LTE DL"), ("2 + 4", "FR1 UL"), ("256", "SCS"), ("1A + 1A", "FR2 DL"),
    ("n78", "LTE DL"), ("B3", "MIMO DL"), ("", "LTE DL"), ("b3", "LTE DL"), ("B3AB", "LTE DL"),
    ("B3\n", "LTE DL"), ("B٤٢", "LTE DL"), (" 42E", "LTE DL"), ("42E + XX + 7A", "LTE DL"),
    ("FR1DL", "FR1 DL"), ("78A + 41C", "FR2 DL"), ("1 + 2 + 3", "NR UL"), ("n41D + n28A", "NR DL"),
    ("B66A + B2NONE", "LTE DL"), ("LTE DL", "LTE DL"), ("42e", "LTE DL"), ("B42G", "FR1 DL"),
]
print("SPANS = " + json.dumps(
    [[cell, hdr, _band_spans(cell, hdr)] for cell, hdr in cells], ensure_ascii=False))
print("PREFIX =", {h: _column_band_prefix(h) for h in
      ["LTE DL", "LTE UL", "NR DL", "FR1 DL", "FR2 UL", "lte dl", "X LTE Y", "MIMO DL", ""]})
