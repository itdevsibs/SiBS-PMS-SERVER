// A rate is unavailable unless both counts are known and the denominator is positive.
export function callCount(value) {
  if (value == null || (typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function callRate(numerator, denominator) {
  const n = callCount(numerator), d = callCount(denominator);
  return n === null || d === null || d === 0 ? null : n / d * 100;
}

export function completeCallSum(rows, key) {
  if (!rows.length || rows.some(row => callCount(row[key]) === null)) return null;
  return rows.reduce((sum, row) => sum + callCount(row[key]), 0);
}

export function formatCallRate(rate, digits = 2) {
  return rate == null || !Number.isFinite(rate) ? "--" : `${rate.toFixed(digits)}%`;
}
