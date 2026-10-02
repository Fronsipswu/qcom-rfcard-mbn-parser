// Loaded-file chips helper (pure). The chip row under the import bar renders
// one pill per distinct loaded source file; repeats (re-imports of the same
// file) must not add a second chip, and first-appearance order is stable.
export function uniqueFileNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names ?? []) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
