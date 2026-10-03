// uecaps.hennes.xyz import helpers (pure logic; HTTP + DOM wiring in main.js).
//
// The parser endpoint POST /parse/multiPart (Javalin, CORS anyHost) takes a
// "requests" form field (JSON array of RequestMultiPart) plus uploaded files
// referenced by index: {inputIndexes:[i], type:"QLTE"|"QNR", description}.
// QLTE consumes a 0xB0CD hexdump text, QNR a 0xB826 hexdump text — exactly
// what the webapp's b0cd/b826 export text produces (analyzer.js writeDiagText:
// "# label\nPayload: <hex>" lines; the parser's splitHex splits on "Payload:").
// A stored multi result is viewed at /view/multi/?id=<uuid> (the parser
// frontend's own library link shape); the parse response carries the id.

export const PARSER_BASE = "https://uecaps.hennes.xyz";

// One entry per non-empty packet set; inputIndexes always stay dense (they
// count only the files actually appended). b0cd -> QLTE, b826 -> QNR.
// Throws when neither packet set exists (rare, legacy-only cards).
export function buildImportEntries(b0cdText, b826Text, description) {
  const has = (t) => typeof t === "string" && t.trim().length > 0;
  if (!has(b0cdText) && !has(b826Text)) {
    throw new Error("No DIAG packets to import — this card has no 0xB0CD/0xB826 data.");
  }
  const entries = [];
  const files = [];
  if (has(b0cdText)) {
    entries.push({ inputIndexes: [files.length], type: "QLTE", description });
    files.push({ filename: `${description}.b0cd.txt`, text: b0cdText });
  }
  if (has(b826Text)) {
    entries.push({ inputIndexes: [files.length], type: "QNR", description });
    files.push({ filename: `${description}.b826.txt`, text: b826Text });
  }
  return { entries, files };
}

export function resultUrl(id) {
  return `${PARSER_BASE}/view/multi/?id=${encodeURIComponent(id)}`;
}
