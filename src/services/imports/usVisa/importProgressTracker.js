const PROGRESS_TTL_MS = 5 * 60 * 1000;
const progressByToken = new Map();

function normalizeToken(token) {
  const value = String(token || '').trim();
  return value && value.length <= 128 ? value : null;
}

function clampPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), 0), 100);
}

function pruneExpired(now = Date.now()) {
  for (const [token, progress] of progressByToken.entries()) {
    const expiresAt = Number(progress?.expiresAt) || 0;
    if (expiresAt > 0 && expiresAt <= now) {
      progressByToken.delete(token);
    }
  }
}

function buildProgress(token, patch = {}, existing = null) {
  const now = Date.now();
  const previousPercent = clampPercent(existing?.percent, 0);
  const requestedPercent = clampPercent(patch.percent, previousPercent);
  const percent = Math.max(previousPercent, requestedPercent);
  const status = patch.status || existing?.status || 'active';
  const isTerminal = status === 'completed' || status === 'failed';

  return {
    token,
    stage: patch.stage || existing?.stage || 'uploading',
    percent,
    message: patch.message ?? existing?.message ?? '',
    processedRows:
      patch.processedRows === undefined
        ? existing?.processedRows ?? null
        : patch.processedRows === null
          ? null
          : Number(patch.processedRows),
    totalRows:
      patch.totalRows === undefined
        ? existing?.totalRows ?? null
        : patch.totalRows === null
          ? null
          : Number(patch.totalRows),
    status,
    createdAt: existing?.createdAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + (isTerminal ? PROGRESS_TTL_MS : PROGRESS_TTL_MS * 2),
  };
}

export function initializeImportProgress(token, initial = {}) {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) return null;
  pruneExpired();
  const progress = buildProgress(normalizedToken, {
    stage: 'uploading',
    percent: 0,
    status: 'active',
    ...initial,
  });
  progressByToken.set(normalizedToken, progress);
  return { ...progress };
}

export function updateImportProgress(token, patch = {}) {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) return null;
  pruneExpired();
  const existing = progressByToken.get(normalizedToken);
  if (!existing) return initializeImportProgress(normalizedToken, patch);
  const progress = buildProgress(normalizedToken, patch, existing);
  progressByToken.set(normalizedToken, progress);
  return { ...progress };
}

export function completeImportProgress(token, patch = {}) {
  const existing = getImportProgress(token);
  if (!existing) return null;
  return updateImportProgress(token, {
    ...patch,
    stage: 'complete',
    percent: 100,
    status: 'completed',
    processedRows: patch.processedRows ?? existing.totalRows ?? existing.processedRows,
  });
}

export function failImportProgress(token, patch = {}) {
  const existing = getImportProgress(token);
  if (!existing) return null;
  return updateImportProgress(token, {
    ...patch,
    stage: patch.stage || existing.stage,
    percent: patch.percent ?? existing.percent,
    status: 'failed',
  });
}

export function getImportProgress(token) {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) return null;
  pruneExpired();
  const progress = progressByToken.get(normalizedToken);
  return progress ? { ...progress } : null;
}

export function clearImportProgress(token) {
  const normalizedToken = normalizeToken(token);
  return normalizedToken ? progressByToken.delete(normalizedToken) : false;
}
