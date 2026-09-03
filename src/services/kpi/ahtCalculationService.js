function toNullableFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSqlAlias(alias, fallback) {
  const normalized = String(alias || fallback).trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid SQL alias "${normalized}".`);
  }

  return normalized;
}

export function calculateCanonicalHandleSeconds({
  talkSeconds,
  holdSeconds,
  afterCallSeconds,
  handleSeconds,
} = {}) {
  const talk = toNullableFiniteNumber(talkSeconds);

  if (talk !== null) {
    return (
      talk +
      (toNullableFiniteNumber(holdSeconds) ?? 0) +
      (toNullableFiniteNumber(afterCallSeconds) ?? 0)
    );
  }

  return toNullableFiniteNumber(handleSeconds);
}

export function calculateAverageHandleSeconds({
  totalHandleSeconds,
  handledCalls,
} = {}) {
  const total = toNullableFiniteNumber(totalHandleSeconds);
  const calls = toNullableFiniteNumber(handledCalls);

  if (total === null || calls === null || calls <= 0) {
    return null;
  }

  return total / calls;
}

export function buildSkillHandleSecondsSql(alias = "s") {
  const source = normalizeSqlAlias(alias, "s");

  return `
    CASE
      WHEN ${source}.talk_seconds IS NOT NULL
        THEN
          ${source}.talk_seconds
          + COALESCE(${source}.hold_seconds, 0)
          + COALESCE(${source}.after_call_seconds, 0)
      WHEN
        ${source}.avg_handle_seconds IS NOT NULL
        AND ${source}.calls_handled IS NOT NULL
        THEN ${source}.avg_handle_seconds * ${source}.calls_handled
      ELSE 0
    END
  `;
}

export function buildSkillHandleDenominatorSql(alias = "s") {
  const source = normalizeSqlAlias(alias, "s");

  return `
    CASE
      WHEN
        ${source}.talk_seconds IS NOT NULL
        OR ${source}.avg_handle_seconds IS NOT NULL
        THEN COALESCE(${source}.calls_handled, 0)
      ELSE 0
    END
  `;
}

export function buildAgentHandleSecondsSql(alias = "a") {
  const source = normalizeSqlAlias(alias, "a");

  return `
    CASE
      WHEN ${source}.talk_seconds IS NOT NULL
        THEN
          ${source}.talk_seconds
          + COALESCE(${source}.hold_seconds, 0)
          + COALESCE(${source}.after_call_seconds, 0)
      WHEN ${source}.handle_seconds IS NOT NULL
        THEN ${source}.handle_seconds
      ELSE 0
    END
  `;
}

export function buildAgentHandleAvailableSql(alias = "a") {
  const source = normalizeSqlAlias(alias, "a");

  return `
    (
      ${source}.talk_seconds IS NOT NULL
      OR ${source}.handle_seconds IS NOT NULL
    )
  `;
}
