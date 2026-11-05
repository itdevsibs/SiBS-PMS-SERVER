// Reporting-only conversion. Source JSON is retained once in us_visa_raw_import_rows.
// The canonical Skill Statistics table does not duplicate AVG Handle Time.
export function parseSourceAverageHandleSeconds(value) {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    // Excel date/time serial fractions represent fractions of one day.
    return n > 0 && n < 1 ? n * 86400 : n;
  }
  const text = String(value).trim();
  // Historical XLSX JSON may store Excel durations as ISO dates from the
  // 1899-12-30 epoch. Only accept that epoch, not arbitrary calendar dates.
  const iso = text.match(/^1899-12-(?:30|31)T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/i);
  if (iso) return ((iso[1] === '24' ? 24 : Number(iso[1])) * 3600) + Number(iso[2]) * 60 + Number(iso[3]) + (text.startsWith('1899-12-31') ? 86400 : 0);
  const hms = text.match(/^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) + Number(`0.${hms[4] || '0'}`);
  return null;
}

export function formatCallsReportAht(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '--';
  const rounded = Math.round(Number(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secondsPart = rounded % 60;
  const padded = (n) => String(n).padStart(2, '0');
  return hours ? `${padded(hours)}:${padded(minutes)}:${padded(secondsPart)}` : `${padded(minutes)}:${padded(secondsPart)}`;
}

export function skillStatsGroupKey(row) {
  return [row.sourceSystem, row.productionDate, row.skillName,
    row.countryRegion || '', row.taskOrderId || '', row.dataGrain].join('\u0001');
}

// Caller must only use the selected, reconciled grain. Positive handled-call
// rows without a usable source AVG Handle Time make the entire group unavailable.
export function attachWeightedAhtToSelectedGrains(selected = [], rawRows = []) {
  const selectedByKey = new Map(selected.map((row) => [skillStatsGroupKey(row), row]));
  const byKey = new Map();
  for (const raw of rawRows) {
    const key = skillStatsGroupKey(raw);
    if (!selectedByKey.has(key)) continue;
    const calls = Number(raw.handledCalls);
    if (!Number.isSafeInteger(calls) || calls < 0) continue;
    let group = byKey.get(key);
    if (!group) { group = { numerator: 0, handled: 0, missing: false }; byKey.set(key, group); }
    if (calls === 0) continue;
    group.handled += calls;
    const avg = parseSourceAverageHandleSeconds(raw.avgHandleRaw);
    if (avg === null) group.missing = true;
    else group.numerator += avg * calls;
  }
  return selected.map((row) => {
    const group = byKey.get(skillStatsGroupKey(row));
    const valid = group && !group.missing && group.handled === row.callsHandled && group.handled > 0;
    return { ...row,
      ahtHandleSecondsNumerator: valid ? group.numerator : row.callsHandled === 0 ? 0 : null,
      ahtHandledCalls: valid ? group.handled : row.callsHandled === 0 ? 0 : null,
      ahtSeconds: valid ? group.numerator / group.handled : null,
    };
  });
}
