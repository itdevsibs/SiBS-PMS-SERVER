// Identical original source rows remain duplicate imports even when historical
// canonical mapping/rounding rules have changed. Used only after identity match.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sourceRowFingerprint(value) {
  if (value == null || value === '') return null;
  try {
    const input = typeof value === 'string' ? JSON.parse(value) : value;
    if (!input || typeof input !== 'object') return null;
    return JSON.stringify(canonicalize(input));
  } catch {
    return null;
  }
}
