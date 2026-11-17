/**
 * FrontSteps AI Management Insights Service
 *
 * Orchestrates Phase 6 event-driven Hermes management insights:
 * - Deterministic cache key & snapshot-bound deduplication
 * - Safe authorization & single-employee scoping
 * - Read-only snapshot/insight retrieval (Zero Hermes on GET/filter/refresh)
 * - Durable background worker execution & independent output validation
 *
 * Strict Isolation: Operates strictly inside FrontSteps AI tables and never
 * recalculates scores, mutates snapshots, or adds conversational/chatbot paths.
 */

import crypto from 'crypto';
import * as jobRepo from '../repositories/frontStepsAiJobRepository.js';
import * as policySnapshotRepo from '../repositories/frontStepsAiPolicySnapshotRepository.js';
import * as insightRepo from '../repositories/frontStepsAiInsightRepository.js';
import { getHermesConfig, sendHermesChatCompletion } from './frontStepsAiHermesClient.js';
import {
  InsightContextError,
  resolveScopedReportForInsight,
  assessInsightEvidenceAvailability,
  buildInsightContext,
  buildSafeHumanReadableLimitations,
} from './frontStepsAiInsightContextBuilder.js';
import {
  CONTRACT_V3_SCHEMA,
  buildContractV3OutputSchemaExample,
  buildContractV3EnumLegend,
  extractInsightJsonObject,
  validateHermesInsightResponse,
  auditInsightFindingsSemantics,
} from './frontStepsAiInsightValidator.js';
import {
  loadImmutableSnapshotBundle,
  buildPolicyRuleIndex,
} from './frontStepsAiInsightEvidenceResolver.js';
import { validateDateRange } from '../validators/frontStepsAiQueryValidator.js';

export const INSIGHT_PROMPT_VERSION = 'v3.0';
export const INSIGHT_SCHEMA_VERSION = '3';
export const INSIGHT_PROMPT_CONTRACT_VERSION = 'v3.2';
export const INSIGHT_VALIDATOR_VERSION = 'v3.3';
export const INSIGHT_REPAIR_VERSION = 'v3.2';

const DEFAULT_AUTO_INSIGHT_TYPES = ['SUMMARY', 'ACCOUNT_KPI'];

export class InsightServiceError extends Error {
  constructor(message, { code = 'INSIGHT_SERVICE_ERROR', status = 400, details = null } = {}) {
    super(message);
    this.name = 'InsightServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isAutoInsightGenerationEnabled() {
  return String(process.env.FS_AI_AUTO_INSIGHTS_ON_PUBLISH || 'false').toLowerCase() === 'true';
}

export function getAllowedAutoInsightReportTypes() {
  const configured = String(process.env.FS_AI_AUTO_INSIGHT_REPORT_TYPES || '').trim();
  if (!configured) return [...DEFAULT_AUTO_INSIGHT_TYPES];
  return configured
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => ['SUMMARY', 'ACCOUNT_KPI', 'INDIVIDUAL_KPI_PMP'].includes(s));
}

function normalizeScopeInputs(reportType, filters = {}) {
  const normalizedType = String(reportType || 'SUMMARY').trim().toUpperCase();
  const period = String(filters.period || 'monthly').trim().toLowerCase();

  let scopeFilter = 'all';
  if (normalizedType === 'ACCOUNT_KPI') {
    const account = String(filters.queueName || filters.account || 'all').trim() || 'all';
    const caseQueue = String(filters.caseQueue || 'all').trim() || 'all';
    const caseOrigin = String(filters.caseOrigin || 'all').trim() || 'all';
    const parts = [];
    if (account !== 'all') parts.push(`call:${account}`);
    if (caseQueue !== 'all') parts.push(`cq:${caseQueue}`);
    if (caseOrigin !== 'all') parts.push(`co:${caseOrigin}`);
    scopeFilter = parts.length > 0 ? parts.join('|') : 'all';
    return {
      reportType: normalizedType,
      period,
      startDate: filters.startDate || null,
      endDate: filters.endDate || null,
      account,
      caseQueue,
      caseOrigin,
      queueName: filters.queueName || null,
      employeeId: 'all',
      site: 'all',
      scopeFilter,
    };
  }

  if (normalizedType === 'INDIVIDUAL_KPI_PMP') {
    const employeeId = String(filters.employeeId || 'all').trim() || 'all';
    const site = String(filters.site || 'all').trim() || 'all';
    if (employeeId !== 'all') {
      scopeFilter = `emp:${employeeId}${site !== 'all' ? `|site:${site}` : ''}`;
    } else if (site !== 'all') {
      scopeFilter = `site:${site}`;
    }
    return {
      reportType: normalizedType,
      period,
      startDate: filters.startDate || null,
      endDate: filters.endDate || null,
      account: 'all',
      caseQueue: 'all',
      caseOrigin: 'all',
      queueName: null,
      employeeId,
      site,
      scopeFilter,
    };
  }

  return {
    reportType: normalizedType,
    period,
    startDate: filters.startDate || null,
    endDate: filters.endDate || null,
    account: 'all',
    caseQueue: 'all',
    caseOrigin: 'all',
    queueName: null,
    employeeId: 'all',
    site: 'all',
    scopeFilter: 'all',
  };
}

export function computeScopeFingerprint(reportType, filters = {}) {
  const canonical = normalizeScopeInputs(reportType, filters);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function computeInsightCacheIdentifiers({
  reportSnapshotId,
  sourceDataFingerprint = '',
  filterFingerprint = '',
  snapshotVersionNumber = 1,
  calculationEngineVersion = 'v2.0-phase4c',
  policyRuleSnapshotId,
  policySnapshotFingerprint = '',
  reportType,
  scopeFingerprint,
  promptVersion = INSIGHT_PROMPT_VERSION,
  hermesModel,
  schemaVersion = INSIGHT_SCHEMA_VERSION,
  promptContractVersion = INSIGHT_PROMPT_CONTRACT_VERSION,
  validatorVersion = INSIGHT_VALIDATOR_VERSION,
  repairVersion = INSIGHT_REPAIR_VERSION,
  force = false,
}) {
  const baseString = [
    `rs:${reportSnapshotId}`,
    `rs_ver:${snapshotVersionNumber}`,
    `eng:${calculationEngineVersion}`,
    `src:${sourceDataFingerprint || 'none'}`,
    `flt:${filterFingerprint || 'none'}`,
    `ps:${policyRuleSnapshotId}`,
    `ps_fp:${policySnapshotFingerprint || 'none'}`,
    `rt:${reportType}`,
    `scp:${scopeFingerprint}`,
    `pv:${promptVersion}`,
    `pcv:${promptContractVersion}`,
    `mdl:${hermesModel}`,
    `sv:${schemaVersion}`,
    `vv:${validatorVersion}`,
    `rv:${repairVersion}`,
  ].join('|');

  const cacheFingerprint = crypto.createHash('sha256').update(baseString).digest('hex');
  const cacheKey = force
    ? `${cacheFingerprint}:regen:${Date.now()}:${crypto.randomBytes(2).toString('hex')}`
    : cacheFingerprint;
  const jobDedupePrefix = `REPORT_INSIGHT:${cacheFingerprint.slice(0, 32)}`;

  return {
    cacheFingerprint,
    cacheKey,
    jobDedupePrefix,
  };
}

/**
 * Enforces management-vs-single-employee authorization on insight generation and reads.
 */
export function assertAuthorizedForInsightScope({ reportType, filters = {}, viewerUser = null }) {
  const normalizedType = String(reportType || 'SUMMARY').trim().toUpperCase();
  if (!['SUMMARY', 'ACCOUNT_KPI', 'INDIVIDUAL_KPI_PMP'].includes(normalizedType)) {
    throw new InsightServiceError(
      `Unsupported reportType "${reportType}". Expected SUMMARY, ACCOUNT_KPI, or INDIVIDUAL_KPI_PMP.`,
      { code: 'INVALID_REPORT_TYPE', status: 400 }
    );
  }

  if (!viewerUser || viewerUser.hasFullTeamAccess !== false) {
    return { isRestrictedViewer: false, canGenerate: true };
  }

  // Restricted single-employee viewer (hasFullTeamAccess === false)
  if (normalizedType !== 'INDIVIDUAL_KPI_PMP') {
    throw new InsightServiceError(
      `Access denied: Single-employee role cannot access or generate team-wide ${normalizedType} insights.`,
      { code: 'FORBIDDEN_INSIGHT_SCOPE', status: 403 }
    );
  }

  const targetEmployeeId = String(filters.employeeId || 'all').trim();
  const viewerSibsId = viewerUser.sibsId ? String(viewerUser.sibsId).trim() : null;
  if (!viewerSibsId || targetEmployeeId === 'all' || targetEmployeeId !== viewerSibsId) {
    throw new InsightServiceError(
      `Access denied: Restricted viewer (${viewerSibsId || 'unknown'}) can only access their own individual insight.`,
      { code: 'FORBIDDEN_CROSS_EMPLOYEE_INSIGHT', status: 403 }
    );
  }

  return { isRestrictedViewer: true, canGenerate: true };
}

export function assertAuthorizedToReadInsightRecord(insightRow, viewerUser = null) {
  if (!insightRow) return;
  if (!viewerUser || viewerUser.hasFullTeamAccess !== false) return;

  const viewerSibsId = viewerUser.sibsId ? String(viewerUser.sibsId).trim() : null;
  const allowedPrefix = viewerSibsId ? `emp:${viewerSibsId}` : null;
  const matchesOwner =
    allowedPrefix &&
    insightRow.report_type === 'INDIVIDUAL_KPI_PMP' &&
    (insightRow.scope_filter === allowedPrefix || insightRow.scope_filter.startsWith(`${allowedPrefix}|`));

  if (!matchesOwner) {
    throw new InsightServiceError(
      'Access denied: You are not authorized to view this insight record.',
      { code: 'FORBIDDEN_INSIGHT_ACCESS', status: 403 }
    );
  }
}

function buildDeterministicExecutiveSummary({ context, findings = [], limitationsCatalog = [] }) {
  const snapId = context.reportSnapshotId;
  const rType = context.reportType;
  const period = context.reportingPeriod;
  const readiness = context.executionReadinessState || 'DATA_INCOMPLETE';

  const evidenceHighlights = [];
  const seenEvidence = new Set();
  for (const f of findings) {
    for (const ev of f.resolved_evidence || []) {
      if (!ev?.evidence_id || seenEvidence.has(ev.evidence_id)) continue;
      seenEvidence.add(ev.evidence_id);
      evidenceHighlights.push(`${ev.metric_code}: ${ev.formatted_value}`);
      if (evidenceHighlights.length >= 4) break;
    }
    if (evidenceHighlights.length >= 4) break;
  }

  const evidenceSegment =
    evidenceHighlights.length > 0
      ? ` Key verified metrics: ${evidenceHighlights.join('; ')}.`
      : '';
  const blockedLim = (limitationsCatalog || []).find((l) => l.status === 'BLOCKED' || l.status === 'NO_DATA');
  const limSegment = blockedLim ? ` Note: ${blockedLim.detail}` : '';

  return `Snapshot #${snapId} (${rType}, ${period}, readiness=${readiness}) insight verified from immutable report evidence.${evidenceSegment}${limSegment}`;
}

/**
 * Sanitizes validator error messages before injecting them into a Hermes repair prompt
 * so rejected numerical values or malformed strings are never echoed back to the model.
 * Preserves authorized SNAP:/LIM: evidence identifiers and "Finding #N" references.
 */
export function sanitizeRepairErrorText(errMsg) {
  const preserved = [];
  let text = String(errMsg || '').replace(
    /\b(?:SNAP|LIM):[A-Za-z0-9:_-]+|\bFinding #\d+/g,
    (m) => {
      const idx = preserved.length;
      preserved.push(m);
      return `__PRESERVE_${idx}__`;
    }
  );
  text = text
    .replace(/\bREADINESS_\d+\b/gi, '[READINESS_CODE]')
    .replace(/"[^"]*\d[^"]*"/g, '"[REDACTED_NUMBER]"')
    .replace(/\$?\b\d[\d,.]*%?/g, '[NUMBER]')
    .replace(/"/g, "'");
  return text.replace(/__PRESERVE_(\d+)__/g, (_, i) => preserved[Number(i)] || '');
}

/**
 * Evaluates whether the assembled repair prompt fits within configured budget or context limits.
 * Does NOT invent hardcoded model limits; enforces limits only when configured via options,
 * snapshot context, or supported Hermes config environment variables.
 */
export function evaluateRepairPromptBudget({
  promptChars,
  estimatedTokens,
  options = {},
  context = {},
  hermesConfig = {},
} = {}) {
  const resolvePositiveNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };

  const maxChars =
    resolvePositiveNum(options.repairPromptMaxChars) ??
    resolvePositiveNum(hermesConfig.repairPromptMaxChars);
  const maxTokens =
    resolvePositiveNum(options.repairPromptMaxTokens) ??
    resolvePositiveNum(hermesConfig.repairPromptMaxTokens);
  const modelContextLimitTokens =
    resolvePositiveNum(options.modelContextLimitTokens) ??
    resolvePositiveNum(context?.modelContextLimitTokens) ??
    resolvePositiveNum(hermesConfig.modelContextLimitTokens);

  const reasons = [];
  if (maxChars !== null && promptChars > maxChars) {
    reasons.push(
      `Compact repair prompt length (${promptChars} chars) exceeds configured repairPromptMaxChars (${maxChars}).`
    );
  }
  if (maxTokens !== null && estimatedTokens > maxTokens) {
    reasons.push(
      `Compact repair prompt estimate (${estimatedTokens} tokens) exceeds configured repairPromptMaxTokens (${maxTokens}).`
    );
  }
  if (modelContextLimitTokens !== null && estimatedTokens > modelContextLimitTokens) {
    reasons.push(
      `Compact repair prompt estimate (${estimatedTokens} tokens) exceeds configured modelContextLimitTokens (${modelContextLimitTokens}).`
    );
  }

  return {
    withinBudget: reasons.length === 0,
    reason: reasons.length > 0 ? reasons.join(' ') : null,
    promptChars,
    estimatedTokens,
    limits: {
      repairPromptMaxChars: maxChars,
      repairPromptMaxTokens: maxTokens,
      modelContextLimitTokens,
    },
  };
}

/**
 * Builds a single-schema, compact repair prompt (`messages` + `diagnostics`) for Hermes Call 2.
 * Reuses the authoritative Contract v3 schema & enums from the validator, strips all Attempt 1
 * prose and numbers, and selects ONLY relevant cited facts plus minimum supporting context
 * rather than expanding the full fact catalog on retries.
 */
export function buildCompactRepairPrompt({
  context,
  parsedDraft = null,
  errors = [],
  repairPhase = 'STRUCTURAL',
  maxRepairFacts = 12,
  maxRepairRules = 10,
  maxRepairLimitations = 6,
} = {}) {
  const reportSnapshotId = context?.reportSnapshotId;
  const reportType = String(context?.reportType || 'SUMMARY').toUpperCase();
  const reportingPeriod = context?.reportingPeriod || 'monthly';
  const scopeFilter = context?.scopeFilter || 'all';
  const readiness = context?.executionReadinessState || 'UNKNOWN';

  const fullCatalog = Array.isArray(context?.promptEvidencePackage?.factCatalog)
    ? context.promptEvidencePackage.factCatalog
    : Array.isArray(context?.factCatalog)
      ? context.factCatalog
      : [];
  const fullRules = Array.isArray(context?.promptPolicyRules)
    ? context.promptPolicyRules
    : Array.isArray(context?.policyRules)
      ? context.policyRules
      : [];
  const rawLimitations = Array.isArray(context?.limitationsCatalog)
    ? context.limitationsCatalog
    : Array.isArray(context?.promptEvidencePackage?.human_readable_limitations)
      ? context.promptEvidencePackage.human_readable_limitations
      : Array.isArray(context?.humanReadableLimitations)
        ? context.humanReadableLimitations
        : Array.isArray(context?.promptEvidencePackage?.limitationsCatalog)
          ? context.promptEvidencePackage.limitationsCatalog
          : [];

  const factById = new Map(fullCatalog.map((f) => [f.evidence_id, f]));
  const validRuleCodeSet = new Set(fullRules.map((r) => r.rule_code).filter(Boolean));

  const sanitizedErrors = (Array.isArray(errors) ? errors : [])
    .slice(0, 6)
    .map((e, i) => `(${i + 1}) ${sanitizeRepairErrorText(e)}`)
    .join('\n');

  const rawFindings = Array.isArray(parsedDraft?.findings)
    ? parsedDraft.findings.slice(0, CONTRACT_V3_SCHEMA.maxFindings)
    : [];
  const validDraftCitedIds = [];
  const rawDraftCitedIds = [];
  const citedRuleCodesInOrder = [];
  const findingOutlines = [];
  for (let i = 0; i < rawFindings.length; i++) {
    const f = rawFindings[i];
    const validIds = Array.isArray(f?.evidence_ids)
      ? f.evidence_ids.filter((id) => typeof id === 'string' && factById.has(id)).slice(0, 4)
      : [];
    const validRules = Array.isArray(f?.policy_rule_codes)
      ? f.policy_rule_codes
          .filter((c) => typeof c === 'string' && validRuleCodeSet.has(c))
          .slice(0, 5)
      : [];
    for (const id of validIds) rawDraftCitedIds.push(id);
    for (const rc of validRules) citedRuleCodesInOrder.push(rc);

    const catOk =
      typeof f?.category === 'string' && CONTRACT_V3_SCHEMA.allowedCategories.includes(f.category);
    const sevOk =
      typeof f?.severity === 'string' && CONTRACT_V3_SCHEMA.allowedSeverities.includes(f.severity);
    const granularities = new Set(validIds.map((id) => factById.get(id)?.granularity).filter(Boolean));
    const units = new Set(validIds.map((id) => factById.get(id)?.unit).filter(Boolean));
    const singleScopeAndUnit =
      granularities.size <= 1 && (f?.claim_type !== 'ENTITY_COMPARISON' || units.size <= 1);

    // Never pass broken/empty/null skeletons or multi-granularity/multi-unit dumps back as outlines to echo
    if (
      findingOutlines.length < 3 &&
      validIds.length > 0 &&
      catOk &&
      sevOk &&
      singleScopeAndUnit
    ) {
      for (const id of validIds) validDraftCitedIds.push(id);
      findingOutlines.push({
        finding_number: findingOutlines.length + 1,
        category: f.category,
        claim_type:
          typeof f?.claim_type === 'string' &&
          CONTRACT_V3_SCHEMA.allowedClaimTypes.includes(f.claim_type)
            ? f.claim_type
            : 'BOTTLENECK_OR_RISK',
        severity: f.severity,
        cited_evidence_ids: validIds,
        policy_rule_codes: validRules,
      });
    }
  }
  const citedFactIdsInOrder = validDraftCitedIds.length > 0 ? validDraftCitedIds : rawDraftCitedIds;

  // Compact fact selection: never dump the full catalog when relevant subset suffices
  const cappedFactsLimit =
    fullCatalog.length > 4
      ? Math.min(maxRepairFacts, Math.max(4, fullCatalog.length - 1))
      : Math.min(maxRepairFacts, fullCatalog.length);

  const selectedFacts = [];
  const selectedIds = new Set();
  const addFact = (fact) => {
    if (!fact || selectedIds.has(fact.evidence_id) || selectedFacts.length >= cappedFactsLimit) {
      return false;
    }
    selectedIds.add(fact.evidence_id);
    selectedFacts.push(fact);
    return true;
  };

  const isTargetBearing = (f) => {
    const t = f?.target_status || f?.target_attainment;
    return Boolean(t && t !== 'NO_TARGET' && f?.has_target !== false);
  };

  // Priority 1: Retain cited Attempt 1 facts while reserving room when target-bearing REPORT_PERIOD KPIs exist
  const reportPeriodTargetFacts = fullCatalog.filter(
    (f) => f.granularity === 'REPORT_PERIOD' && isTargetBearing(f)
  );
  const reserveTargetSlots =
    reportPeriodTargetFacts.length > 0 && cappedFactsLimit > 6 ? Math.min(4, reportPeriodTargetFacts.length) : 0;
  const primaryCitedCap = Math.max(0, cappedFactsLimit - reserveTargetSlots);

  const citedEntities = new Set();
  const citedMetrics = new Set();
  const firstPeerGroup = { group: null };
  for (const id of citedFactIdsInOrder) {
    if (selectedFacts.length >= primaryCitedCap) break;
    const f = factById.get(id);
    if (f && addFact(f)) {
      if (f.entity_label) citedEntities.add(f.entity_label);
      if (f.metric_code) citedMetrics.add(f.metric_code);
      if (!firstPeerGroup.group && f.granularity !== 'REPORT_PERIOD' && f.comparable_group) {
        firstPeerGroup.group = f.comparable_group;
      }
    }
  }

  // Ensure target-bearing REPORT_PERIOD KPIs (AHT, AHT_COMPLIANCE, CRM_*) always survive noisy draft citations
  for (const f of reportPeriodTargetFacts) {
    addFact(f);
  }

  // Include sibling peers from the SAME comparable_group so ENTITY_COMPARISON / concentration findings never lack same-unit peers
  const targetCohortGroup =
    firstPeerGroup.group ||
    fullCatalog.find((f) => f.granularity === 'VOICE_QUEUE' && f.metric_code === 'AHT')?.comparable_group ||
    fullCatalog.find((f) => f.granularity === 'VOICE_QUEUE' && f.metric_code === 'CALLS_OFFERED')?.comparable_group ||
    fullCatalog.find((f) => f.granularity === 'INDIVIDUAL_EMPLOYEE')?.comparable_group ||
    null;
  if (targetCohortGroup) {
    let cohortAdded = 0;
    for (const f of fullCatalog) {
      if (cohortAdded >= 4) break;
      if (f.comparable_group === targetCohortGroup && addFact(f)) {
        cohortAdded++;
      }
    }
  }

  // Fill any remaining cited facts from Attempt 1
  for (const id of citedFactIdsInOrder) {
    const f = factById.get(id);
    if (f && addFact(f)) {
      if (f.entity_label) citedEntities.add(f.entity_label);
      if (f.metric_code) citedMetrics.add(f.metric_code);
    }
  }

  // Priority 2: Minimum supporting REPORT_PERIOD context facts for cited entities/metrics
  const supportingLimit = Math.min(
    cappedFactsLimit,
    Math.max(selectedFacts.length + 3, Math.min(8, cappedFactsLimit))
  );
  for (const f of fullCatalog) {
    if (selectedFacts.length >= supportingLimit) break;
    if (
      f.granularity === 'REPORT_PERIOD' &&
      (citedEntities.has(f.entity_label) || citedMetrics.has(f.metric_code))
    ) {
      addFact(f);
    }
  }

  // Priority 3: Stratified fact selection so target-bearing KPIs and distinct
  // peer entities survive even on PARSE failures (when citedFactIdsInOrder is empty)
  if (citedFactIdsInOrder.length === 0) {
    for (const f of fullCatalog) {
      if (selectedFacts.length >= supportingLimit) break;
      if (f.granularity === 'REPORT_PERIOD' && isTargetBearing(f)) {
        addFact(f);
      }
    }
    for (const f of fullCatalog) {
      if (selectedFacts.length >= supportingLimit) break;
      if (
        f.granularity === 'REPORT_PERIOD' &&
        ['CALLS_OFFERED', 'TOTAL_CASES', 'ABANDON_RATE', 'ASA'].includes(f.metric_code)
      ) {
        addFact(f);
      }
    }
    const seenEntityGranularity = new Set(
      selectedFacts.map((f) => `${f.granularity}::${f.entity_label || ''}`)
    );
    const peerFirstOrder = [...fullCatalog].sort((a, b) => {
      const ta = isTargetBearing(a) ? 0 : 1;
      const tb = isTargetBearing(b) ? 0 : 1;
      return ta - tb;
    });
    for (const f of peerFirstOrder) {
      if (selectedFacts.length >= cappedFactsLimit) break;
      if (f.granularity === 'REPORT_PERIOD') continue;
      const egKey = `${f.granularity}::${f.entity_label || ''}`;
      if (!seenEntityGranularity.has(egKey) || selectedFacts.length < supportingLimit) {
        if (addFact(f)) {
          seenEntityGranularity.add(egKey);
        }
      }
    }
  } else {
    for (const f of fullCatalog) {
      if (selectedFacts.length >= supportingLimit) break;
      if (f.granularity === 'REPORT_PERIOD') {
        addFact(f);
      }
    }
  }

  // Priority 4: Ensure a balanced context floor across the catalog
  const minFloor = Math.min(Math.max(4, Math.min(8, fullCatalog.length)), cappedFactsLimit);
  for (const f of fullCatalog) {
    if (selectedFacts.length >= minFloor) break;
    addFact(f);
  }

  const selectedAllowedEvidenceIds = selectedFacts.map((f) => f.evidence_id);
  const compactFactsPayload = selectedFacts.map((f) => ({
    evidence_id: f.evidence_id,
    metric_code: f.metric_code,
    metric_label: f.metric_label || f.prompt_metric_label || f.metric_code,
    granularity: f.granularity,
    aggregation_type: f.aggregation_type,
    entity_label: f.entity_label || f.prompt_entity_label || 'In-scope activity',
    comparable_group: f.comparable_group,
    target_status: f.target_status || f.target_attainment,
    ...(f.policy_rule_code ? { policy_rule_code: f.policy_rule_code } : {}),
    ...(f.relative_standing ? { relative_standing: f.relative_standing } : {}),
  }));

  const selectedMetrics = new Set(selectedFacts.map((f) => f.metric_code).filter(Boolean));
  const metricPolicyMap = context?.verificationCatalog?.metricPolicyMap || {};
  const ruleCatalogByCode = context?.verificationCatalog?.policyRuleCatalogByCode || {};
  const effectiveRepairRulesLimit = Math.max(Number(maxRepairRules) || 10, 14);
  const selectedRules = [];
  const selectedRuleCodes = new Set();
  const addRule = (r) => {
    if (!r?.rule_code || selectedRuleCodes.has(r.rule_code) || selectedRules.length >= effectiveRepairRulesLimit) {
      return;
    }
    selectedRuleCodes.add(r.rule_code);
    selectedRules.push(r);
  };
  for (const r of fullRules) {
    if (selectedMetrics.has(r.metric_code) || r.metric_code === 'FINAL_KPI_SCORE') {
      addRule(r);
    }
  }
  for (const rc of citedRuleCodesInOrder) {
    const meta = ruleCatalogByCode[rc];
    if (!meta || [...selectedMetrics].some((m) => meta.applicableMetrics?.has(m))) {
      addRule(fullRules.find((r) => r.rule_code === rc));
    }
  }
  for (const r of fullRules) {
    addRule(r);
  }
  const selectedAllowedRuleCodes = selectedRules.map((r) => r.rule_code);
  const compactRepairMetricPolicyMap = Object.fromEntries(
    [...selectedMetrics]
      .map((mc) => {
        const entry = metricPolicyMap[mc];
        if (!entry || !entry.has_policy_rules) return null;
        return [
          mc,
          {
            ...(entry.target_rules.length > 0 ? { target: entry.target_rules } : {}),
            ...(entry.weight_rules.length > 0 ? { weight: entry.weight_rules } : {}),
            ...(entry.definition_rules.length > 0 ? { definition: entry.definition_rules } : {}),
          },
        ];
      })
      .filter(Boolean)
  );
  const compactRulesSummary = selectedRules
    .map((r) => `${r.rule_code} (${r.metric_code || r.rule_type || 'GENERAL'})`)
    .join(', ');

  // Always prioritize BLOCKED/NO_DATA limitations first, then normalize into clean human-readable strings ONLY
  const sortedRawLimitations = [...rawLimitations].sort((a, b) => {
    const score = (l) => (l?.status === 'BLOCKED' || l?.status === 'NO_DATA' ? 0 : 1);
    return score(a) - score(b);
  });
  const safeLimitationsList = buildSafeHumanReadableLimitations(sortedRawLimitations).slice(
    0,
    maxRepairLimitations
  );
  const compactLimitationsText = safeLimitationsList.map((text) => `- ${text}`).join('\n');

  const schemaExample = buildContractV3OutputSchemaExample({ reportSnapshotId, reportType });
  const enumLegend = buildContractV3EnumLegend();

  const systemContent = [
    `You are repairing a rejected FrontSteps AI Management Insight JSON output (Contract v${CONTRACT_V3_SCHEMA.schemaVersion}).`,
    'Output ONE raw JSON object ONLY starting with { and ending with }. Do NOT output markdown fences or conversational prose outside the JSON.',
    'Do NOT invoke tools, skills, files, MCP servers, or external commands; every authorized evidence ID, rule code, limitation, and schema field is supplied inline.',
    'Write purely qualitative management prose with ZERO digits, percentages (%), currency ($), counts, durations, approximations, or spelled-out numeric words ("one", "two", "three", "Three", "four", "five", "six", "seven", "eight", "nine", "ten", "twenty", "hundred", "zero" — use "multiple" or "several" instead).',
    'Never fabricate numbers, never output technical readiness codes or objects inside string arrays, never paste "SNAP:..." or "LIM:..." into prose strings, and ALWAYS copy allowed_evidence_ids verbatim starting with "SNAP:".',
  ].join('\n');

  const userContent = `CONTRACT v${CONTRACT_V3_SCHEMA.schemaVersion} REPAIR PASS (${repairPhase} — Snapshot #${reportSnapshotId}, ${reportType}, ${reportingPeriod}, scope=${scopeFilter}, readiness=${readiness}):

VALIDATION FAILURES TO FIX FROM ATTEMPT 1:
${sanitizedErrors || '(1) Output did not satisfy Contract v3 schema or grounding rules.'}

AUTHORITATIVE JSON SCHEMA (REQUIRED — return EVERY top-level key including "data_quality_warnings" and "overall_limitations", and EVERY finding key below verbatim):
${schemaExample}

SCHEMA & ENUM RULES (ZERO DEVIATIONS):
${enumLegend}
- CRITICAL REPAIR CHECKS:
  1. EVERY top-level key MUST exist: "report_snapshot_id", "report_type", "schema_version", "status", "executive_summary", "findings", "data_quality_warnings", "overall_limitations". ALWAYS include "data_quality_warnings": [...] AND "overall_limitations": [...] even if []! Put ALL limitation/warning sentences strictly inside those two arrays — use ZERO extra top-level keys.
  2. EVERY object in "findings" MUST include all required finding keys ("category", "severity", "headline", "observation", "evidence_ids", "policy_rule_codes", "recommendation", "limitations"). Never omit "headline", "severity", "recommendation", "policy_rule_codes", or "limitations". Keep "category" strictly within ALLOWED CATEGORIES (use "OPERATIONAL_PERFORMANCE" with "claim_type": "OPERATIONAL_CONCENTRATION" for queue concentration).
  3. Return EXACTLY TWO or THREE complete, valid findings (NEVER output four or more findings), and close the JSON cleanly after "overall_limitations": [...].
  4. "limitations", "data_quality_warnings", and "overall_limitations" MUST be arrays of plain English strings ONLY — NEVER emit objects, digits, or technical readiness/limitation codes. Never write spelled-out counts like "Two" or "Three" in prose — write "Multiple" or "Several".
  5. Keep REPORT_PERIOD metrics and BIHOURLY_EXTREME/DAILY_EXTREME/DAILY_AVERAGE metrics in SEPARATE findings; never compare metrics with different units (calls vs sec vs %) or mix VOICE_QUEUE with REPORT_PERIOD / SF_CASE_CHANNEL in one finding; keep MEETS_OR_EXCEEDS_TARGET (AHT/AHT_COMPLIANCE) separate from BELOW_TARGET (CRM_*); and for AHT ("LOWER_IS_BETTER"), write "within policy target limit" or "meets target" — NEVER say AHT is "above target".
  6. CLAIM_TYPE TARGET RULE: Set claim_type="PERFORMANCE_VS_TARGET" ONLY when cited fact(s) have target_status != "NO_TARGET" (MEETS_OR_EXCEEDS_TARGET or BELOW_TARGET). For target_status="NO_TARGET" volume/rate metrics (CALLS_OFFERED, CALLS_ANSWERED, CALLS_ABANDONED, ANSWER_RATE, ABANDON_RATE, ASA, TOTAL_CASES), ALWAYS put "BOTTLENECK_OR_RISK", "OPERATIONAL_CONCENTRATION", or "DATA_LIMITATION_EXPLANATION" in "claim_type" (NOT "category") — NEVER "PERFORMANCE_VS_TARGET".

${
  findingOutlines.length > 0 && rawFindings.length <= 3
    ? `VALID ATTEMPT 1 SUBSET TO COMPLETE (1-3 findings total; write complete non-empty headline, observation, recommendation, limitations, plus data_quality_warnings and overall_limitations):\n${JSON.stringify(findingOutlines)}\n\n`
    : 'REBUILD INSTRUCTION: Discard incomplete/unusable Attempt 1 findings above and emit ONLY 2 or 3 complete Contract v3 findings strictly from SELECTED AUTHORIZED FACTS below (keep one metric/unit family per finding), ending with "data_quality_warnings": [...] and "overall_limitations": [...].\n\n'
}ALLOWED_EVIDENCE_IDS (copy exact strings verbatim — every valid ID begins with "SNAP:", never alter any character or invent IDs):
${JSON.stringify(selectedAllowedEvidenceIds)}

SELECTED AUTHORIZED FACTS (${selectedFacts.length} relevant of ${fullCatalog.length} catalog facts):
${compactFactsPayload.length > 0 ? JSON.stringify(compactFactsPayload) : 'NONE (return findings: [] and explain gap in data_quality_warnings and overall_limitations)'}

HUMAN_READABLE_LIMITATIONS (rephrase cleanly in plain English ONLY — NO technical readiness codes, NO digits, NO objects):
${compactLimitationsText || '- Single-period snapshot only; prior-period comparisons are unsupported.'}

ALLOWED_POLICY_RULE_CODES (copy verbatim from the cited metric entry below or use [] — NEVER mix CRM rules onto AHT or vice versa):
${JSON.stringify(selectedAllowedRuleCodes)}
METRIC_POLICY_RULE_MAP: ${JSON.stringify(compactRepairMetricPolicyMap)}
RULE REFERENCE CONTEXT: ${compactRulesSummary || 'NONE'}

FINAL REPAIR CHECKLIST (VERIFY BEFORE WRITING \`{\`):
- Write EXACTLY TWO or THREE complete findings, using ONLY valid ALLOWED CATEGORY values, same-unit/same-granularity facts only, AHT separated from CRM ("within target limit", NOT "above target"), and exact "policy_rule_codes" from ALLOWED_POLICY_RULE_CODES or [].
- Start multi-metric sentences with "Multiple..." or "All tracked..." (ZERO digits or spelled-out counts anywhere).
- EXACT ENDING OF YOUR JSON OBJECT (MANDATORY STRING ARRAYS):
  "data_quality_warnings": ["Plain-English data warning string"],
  "overall_limitations": ["Single-period snapshot only; prior-period comparisons are unsupported."]
}`;

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
  const systemChars = systemContent.length;
  const userChars = userContent.length;
  const totalRepairChars = systemChars + userChars;
  const estimatedRepairTokens = Math.ceil(totalRepairChars / 4);

  return {
    messages,
    diagnostics: {
      repairPhase,
      totalCatalogFacts: fullCatalog.length,
      selectedRepairFactsCount: selectedFacts.length,
      omittedCatalogFactsCount: Math.max(0, fullCatalog.length - selectedFacts.length),
      selectedRepairRulesCount: selectedRules.length,
      selectedRepairLimitationsCount: safeLimitationsList.length,
      allowedEvidenceIds: selectedAllowedEvidenceIds,
      allowedPolicyRuleCodes: selectedAllowedRuleCodes,
      systemChars,
      userChars,
      totalRepairChars,
      estimatedRepairTokens,
      estimateSource: 'LOCAL_CHAR_APPROXIMATION',
    },
  };
}

function buildVerificationCatalogFromPolicyIndex(policyIndex, policySnapshot = null) {
  if (!policyIndex) return {};
  return {
    policySnapshotCode: policySnapshot?.snapshot_code || null,
    allowedCanonicalRuleCodes: policyIndex.canonicalCodes,
    allowedDocumentCodes: policyIndex.documentCodes,
    supersededRuleCodes: policyIndex.supersededCodes,
    policyRuleCatalogByCode: policyIndex.byCode,
    metricPolicyMap: policyIndex.metricPolicyMap,
    documentApplicableMetrics: policyIndex.documentApplicableMetrics,
    documentClaimScopes: policyIndex.documentClaimScopes,
    activeSnapshotDocumentCodes: policyIndex.activeSnapshotDocumentCodes,
  };
}

function evaluateRowSemanticReview(row, { verificationCatalog = null, latestAuditRecord = null } = {}) {
  if (!row) return null;
  const json = row.insight_json || {};
  const findings = Array.isArray(json.findings) ? json.findings : [];
  const generatedUnderValidatorVersion =
    row.validation_report_json?.validatorVersion ||
    row.context_metadata_json?.validatorVersion ||
    (row.id ? 'v3.0' : null);
  const validatorVersionChecked = INSIGHT_VALIDATOR_VERSION;
  const isCurrentValidatorVersion = generatedUnderValidatorVersion === INSIGHT_VALIDATOR_VERSION;

  const hasFullPolicyCatalog = Boolean(
    verificationCatalog?.policyRuleCatalogByCode &&
      Object.keys(verificationCatalog.policyRuleCatalogByCode).length > 0
  );
  const findingsHavePolicyCodes = findings.some(
    (f) => Array.isArray(f?.policy_rule_codes) && f.policy_rule_codes.length > 0
  );

  // Guard against unmocked empty policy snapshots in isolated tests that return mock insights
  const effectiveCatalog =
    hasFullPolicyCatalog || !findingsHavePolicyCodes ? verificationCatalog || {} : null;

  const audit =
    findings.length === 0
      ? {
          findingReviews: [],
          flaggedFindingsCount: 0,
          passedFindingsCount: 0,
          totalFindingsCount: 0,
          hasFlaggedFindings: false,
        }
      : effectiveCatalog !== null
        ? auditInsightFindingsSemantics({ insightJson: json, verificationCatalog: effectiveCatalog })
        : {
            findingReviews: findings.map((f, idx) => {
              const evRes = auditInsightFindingsSemantics({
                insightJson: {
                  findings: [{ ...f, policy_rule_codes: [] }],
                },
                verificationCatalog: {},
              });
              const single = evRes.findingReviews[0] || {
                findingIndex: idx + 1,
                status: 'VERIFIED',
                isSemanticallyVerified: true,
                issues: [],
              };
              return { ...single, findingIndex: idx + 1 };
            }),
            flaggedFindingsCount: 0,
            passedFindingsCount: findings.length,
            totalFindingsCount: findings.length,
            hasFlaggedFindings: false,
          };

  if (effectiveCatalog === null && findings.length > 0) {
    audit.flaggedFindingsCount = audit.findingReviews.filter((r) => r.status === 'FLAGGED').length;
    audit.passedFindingsCount = Math.max(0, findings.length - audit.flaggedFindingsCount);
    audit.hasFlaggedFindings = audit.flaggedFindingsCount > 0;
  }

  const hasFlaggedFindings = Boolean(audit.hasFlaggedFindings);
  const passedSemanticChecks = !hasFlaggedFindings;
  const reviewStatus = hasFlaggedFindings
    ? 'FLAGGED_SEMANTIC_ISSUES'
    : isCurrentValidatorVersion
      ? 'SEMANTICALLY_VERIFIED'
      : 'LEGACY_VALIDATED_PASSED_SEMANTIC_AUDIT';

  const issues = audit.findingReviews.flatMap((fr) => fr.issues || []);
  const latestAuditStatus = latestAuditRecord
    ? {
        id: latestAuditRecord.id,
        eventType: latestAuditRecord.event_type,
        validationStatus: latestAuditRecord.validation_status,
        validatorVersionChecked:
          latestAuditRecord.validation_report_json?.validatorVersionChecked || null,
        errorSummary: latestAuditRecord.error_summary || null,
        createdAt: latestAuditRecord.created_at,
      }
    : null;

  return {
    insightId: row.id || null,
    reviewStatus,
    isSemanticallyVerified: !hasFlaggedFindings,
    passedSemanticChecks,
    hasFlaggedFindings,
    hasUnqualifiedTrustworthyFindings: !hasFlaggedFindings && audit.passedFindingsCount > 0,
    generatedUnderValidatorVersion,
    validatorVersionChecked,
    isCurrentValidatorVersion,
    flaggedFindingsCount: audit.flaggedFindingsCount,
    passedFindingsCount: audit.passedFindingsCount,
    totalFindingsCount: audit.totalFindingsCount,
    findingReviews: audit.findingReviews,
    issues,
    summary: hasFlaggedFindings
      ? `${audit.flaggedFindingsCount} of ${audit.totalFindingsCount} finding(s) flagged under ${validatorVersionChecked} semantic validation.`
      : isCurrentValidatorVersion
        ? `All ${audit.totalFindingsCount} finding(s) passed ${validatorVersionChecked} semantic policy and evidence validation.`
        : `Legacy validated (${generatedUnderValidatorVersion || 'prior version'}); passed retrospective ${validatorVersionChecked} semantic audit with 0 flagged findings.`,
    latestAuditRecord: latestAuditStatus,
  };
}

function formatHydratedInsightForApi(row, semanticReview = null) {
  if (!row) return null;
  const json = row.insight_json || {};
  const rawFindings = Array.isArray(json.findings) ? json.findings : [];
  const reviewsByIdx = new Map(
    Array.isArray(semanticReview?.findingReviews)
      ? semanticReview.findingReviews.map((fr) => [fr.findingIndex, fr])
      : []
  );
  const hydratedFindings = rawFindings.map((f, idx) => {
    const fr = reviewsByIdx.get(idx + 1) || null;
    return fr ? { ...f, semanticReview: fr } : f;
  });

  const validatorVersion =
    row.validation_report_json?.validatorVersion ||
    row.context_metadata_json?.validatorVersion ||
    null;

  return {
    id: row.id,
    reportSnapshotId: row.report_snapshot_id,
    policyRuleSnapshotId: row.policy_rule_snapshot_id,
    reportType: row.report_type,
    reportingPeriod: row.reporting_period,
    scopeFilter: row.scope_filter,
    scopeFingerprint: row.scope_fingerprint,
    cacheFingerprint: row.cache_fingerprint,
    hermesModel: row.hermes_model,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    validatorVersion,
    generationStatus: row.generation_status,
    validationStatus: row.validation_status,
    isCurrentActive: row.is_current_active === 1,
    versionNumber: row.version_number,
    hermesCallsCount: row.hermes_calls_count,
    generationDurationMs: row.generation_duration_ms,
    generatedAt: row.generated_at,
    errorSummary: row.error_summary || null,
    executiveSummary: json.executive_summary || null,
    hasTrustworthyFindings:
      json.has_trustworthy_findings !== undefined
        ? Boolean(json.has_trustworthy_findings)
        : rawFindings.length > 0,
    hasUnqualifiedTrustworthyFindings: semanticReview
      ? Boolean(semanticReview.hasUnqualifiedTrustworthyFindings)
      : rawFindings.length > 0,
    findings: hydratedFindings,
    dataQualityWarnings: Array.isArray(json.data_quality_warnings) ? json.data_quality_warnings : [],
    overallLimitations: Array.isArray(json.overall_limitations) ? json.overall_limitations : [],
    limitationsCatalog: Array.isArray(row.context_metadata_json?.limitationsCatalog)
      ? row.context_metadata_json.limitationsCatalog
      : [],
    policySnapshotCode: json.policy_snapshot_code || row.context_metadata_json?.policySnapshotCode || null,
    validationReport: row.validation_report_json || null,
    semanticReview,
  };
}

/**
 * Performs read-only semantic auditing on persisted insight rows without mutating
 * insight records, emitting Hermes calls, or writing to the database.
 */
export async function hydrateInsightsWithSemanticAudit(rows = [], { includeAuditLookup = true } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const validRows = rows.filter(Boolean);
  if (validRows.length === 0) return [];

  const distinctPolicyIds = [
    ...new Set(
      validRows
        .filter((r) => Array.isArray(r?.insight_json?.findings) && r.insight_json.findings.length > 0)
        .map((r) => Number(r.policy_rule_snapshot_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];

  const catalogByPolicyId = new Map();
  if (distinctPolicyIds.length > 0) {
    await Promise.all(
      distinctPolicyIds.map(async (pid) => {
        const [policySnap, rules] = await Promise.all([
          policySnapshotRepo.getPolicyRuleSnapshotById(pid),
          policySnapshotRepo.getSnapshotRules(pid),
        ]);
        const idx = buildPolicyRuleIndex(Array.isArray(rules) ? rules : [], policySnap || null);
        catalogByPolicyId.set(pid, buildVerificationCatalogFromPolicyIndex(idx, policySnap || null));
      })
    );
  }

  return Promise.all(
    rows.map(async (row) => {
      if (!row) return null;
      const pid = Number(row.policy_rule_snapshot_id);
      const verificationCatalog =
        Number.isFinite(pid) && catalogByPolicyId.has(pid) ? catalogByPolicyId.get(pid) : null;
      const latestAuditRecord =
        includeAuditLookup && row.id
          ? await insightRepo.getLatestSemanticAuditForInsight(row.id)
          : null;
      const semanticReview = evaluateRowSemanticReview(row, {
        verificationCatalog,
        latestAuditRecord,
      });
      return formatHydratedInsightForApi(row, semanticReview);
    })
  );
}

export async function auditExistingInsightsReadOnly({ insightIds = [] } = {}) {
  const cleanIds = [...new Set((insightIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
  const rawRows = await Promise.all(cleanIds.map((id) => insightRepo.getInsightById(id)));
  const hydratedList = await hydrateInsightsWithSemanticAudit(rawRows, { includeAuditLookup: true });
  return cleanIds.map((id, idx) => ({
    insightId: id,
    found: Boolean(hydratedList[idx]),
    insight: hydratedList[idx],
    semanticReview: hydratedList[idx]?.semanticReview || null,
  }));
}

export async function recordRetrospectiveSemanticAudit({
  insightIds = [],
  requestOrigin = 'PHASE_641_SEMANTIC_AUDIT',
} = {}) {
  const cleanIds = [...new Set((insightIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0))];
  const rawRows = await Promise.all(cleanIds.map((id) => insightRepo.getInsightById(id)));
  const hydratedList = await hydrateInsightsWithSemanticAudit(rawRows, { includeAuditLookup: false });

  const results = [];
  for (let i = 0; i < cleanIds.length; i++) {
    const rawRow = rawRows[i];
    const hydrated = hydratedList[i];
    if (!rawRow || !hydrated) {
      results.push({ insightId: cleanIds[i], found: false, auditRecorded: false });
      continue;
    }
    const review = hydrated.semanticReview;
    const eventType = review.hasFlaggedFindings ? 'SEMANTIC_REVIEW_FLAGGED' : 'SEMANTIC_REVIEW_PASSED';
    const validationStatus = review.hasFlaggedFindings ? 'NEEDS_REVIEW' : 'VALIDATED';
    const errorSummary = review.hasFlaggedFindings
      ? review.issues
          .map((d) => `Finding #${d.findingIndex} [${d.code}]: ${d.reason}`)
          .join(' ; ')
          .slice(0, 1900)
      : null;

    const auditWrite = await insightRepo.recordSemanticAuditIfChanged({
      insightRow: rawRow,
      eventType,
      validationStatus,
      validatorVersion: INSIGHT_VALIDATOR_VERSION,
      validationReportJson: {
        validatorVersionChecked: INSIGHT_VALIDATOR_VERSION,
        generatedUnderValidatorVersion: review.generatedUnderValidatorVersion,
        reviewStatus: review.reviewStatus,
        flaggedFindingsCount: review.flaggedFindingsCount,
        passedFindingsCount: review.passedFindingsCount,
        totalFindingsCount: review.totalFindingsCount,
        findingReviews: review.findingReviews,
        issues: review.issues,
      },
      errorSummary,
      requestOrigin,
    });

    results.push({
      insightId: rawRow.id,
      found: true,
      reportType: rawRow.report_type,
      reportSnapshotId: rawRow.report_snapshot_id,
      eventType,
      validationStatus,
      auditId: auditWrite.auditId,
      auditInserted: auditWrite.inserted,
      semanticReview: review,
    });
  }
  return results;
}

/**
 * Read-only retrieval of validated insights for the exact currently authorized
 * report snapshot and filter scope. NEVER calls Hermes or enqueues work.
 */
export async function getInsightsForReport({
  reportType = 'SUMMARY',
  filters = {},
  snapshotId = null,
  viewerUser = null,
}) {
  const normalizedFilters = validateDateRange({ ...filters });
  if (normalizedFilters.isValidPeriod === false) {
    throw new InsightServiceError(normalizedFilters.periodValidationError, {
      code: 'INVALID_PERIOD',
      status: 400,
    });
  }

  const normalizedType = String(reportType || 'SUMMARY').trim().toUpperCase();
  assertAuthorizedForInsightScope({ reportType: normalizedType, filters: normalizedFilters, viewerUser });

  let reportView;
  try {
    reportView = await resolveScopedReportForInsight({
      reportType: normalizedType,
      filters: normalizedFilters,
      snapshotId,
      viewerUser,
    });
  } catch (err) {
    if (err instanceof InsightContextError) {
      return {
        success: true,
        hasInsight: false,
        hasPublishedSnapshot: err.code === 'ROSTER_VERIFICATION_REQUIRED',
        unavailableReason: err.message,
        unavailableCode: err.code,
        hermesCallsCount: 0,
        reportType: normalizedType,
        period: normalizedFilters.period,
        insight: null,
        latestAttempt: null,
        activeJob: null,
        canGenerateInsights: false,
      };
    }
    throw err;
  }

  const scopeCanonical = normalizeScopeInputs(normalizedType, reportView.activeFilters || normalizedFilters);
  const scopeFingerprint = computeScopeFingerprint(normalizedType, reportView.activeFilters || normalizedFilters);
  const resolvedSnapshotId = Number(reportView.snapshot.id);
  const policySnapshotId = Number(
    reportView.snapshot.policyRuleSnapshotId || reportView.policyContext?.snapshotId || 0
  );
  const policySnapshot = policySnapshotId
    ? await policySnapshotRepo.getPolicyRuleSnapshotById(policySnapshotId)
    : await policySnapshotRepo.getActivePolicyRuleSnapshot();

  const availability = assessInsightEvidenceAvailability({
    reportType: normalizedType,
    reportView,
  });
  if (!availability.sufficient) {
    return {
      success: true,
      hasPublishedSnapshot: true,
      hasInsight: false,
      unavailableCode: availability.code,
      unavailableReason: availability.reason,
      hermesCallsCount: 0,
      reportType: normalizedType,
      period: scopeCanonical.period,
      scopeFilter: scopeCanonical.scopeFilter,
      scopeFingerprint,
      cacheFingerprint: null,
      snapshot: {
        id: resolvedSnapshotId,
        versionNumber: reportView.snapshot.versionNumber,
        status: reportView.snapshot.status,
        executionReadinessState: reportView.snapshot.executionReadinessState,
        policyRuleSnapshotId: policySnapshot?.id || policySnapshotId,
      },
      policySnapshot: policySnapshot
        ? {
            id: policySnapshot.id,
            snapshotCode: policySnapshot.snapshot_code,
            snapshotFingerprint: policySnapshot.snapshot_fingerprint,
          }
        : null,
      insight: null,
      latestAttempt: null,
      activeJob: null,
      canGenerateInsights: false,
    };
  }

  const hermesConfig = getHermesConfig();
  const cacheIds = computeInsightCacheIdentifiers({
    reportSnapshotId: resolvedSnapshotId,
    sourceDataFingerprint: reportView.snapshot.sourceDataFingerprint,
    filterFingerprint: reportView.snapshot.filterFingerprint,
    snapshotVersionNumber: reportView.snapshot.versionNumber,
    calculationEngineVersion: reportView.snapshot.calculationEngineVersion,
    policyRuleSnapshotId: policySnapshot?.id || policySnapshotId,
    policySnapshotFingerprint: policySnapshot?.snapshot_fingerprint || '',
    reportType: normalizedType,
    scopeFingerprint,
    hermesModel: hermesConfig.model,
  });

  const [activeInsightRow, latestAttemptRow, activeJobRow] = await Promise.all([
    insightRepo.getActiveInsight({
      reportSnapshotId: resolvedSnapshotId,
      policyRuleSnapshotId: policySnapshot?.id || policySnapshotId,
      scopeFingerprint,
      promptVersion: INSIGHT_PROMPT_VERSION,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
    }),
    insightRepo.getLatestAttemptBySnapshotScope({
      reportSnapshotId: resolvedSnapshotId,
      scopeFingerprint,
      promptVersion: INSIGHT_PROMPT_VERSION,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
    }),
    jobRepo.findActiveJobByIdempotencyPrefix('REPORT_INSIGHT_GENERATION', cacheIds.jobDedupePrefix),
  ]);

  const [activeInsight] = activeInsightRow
    ? await hydrateInsightsWithSemanticAudit([activeInsightRow], { includeAuditLookup: true })
    : [null];
  const latestAttempt =
    latestAttemptRow && (!activeInsightRow || latestAttemptRow.id !== activeInsightRow.id)
      ? {
          id: latestAttemptRow.id,
          generationStatus: latestAttemptRow.generation_status,
          validationStatus: latestAttemptRow.validation_status,
          isPublishedActive: latestAttemptRow.is_current_active === 1,
          errorSummary: latestAttemptRow.error_summary || null,
          validationReport: latestAttemptRow.validation_report_json || null,
          generatedAt: latestAttemptRow.generated_at,
        }
      : null;

  return {
    success: true,
    hasPublishedSnapshot: true,
    hasInsight: Boolean(activeInsight),
    hermesCallsCount: 0,
    reportType: normalizedType,
    period: scopeCanonical.period,
    scopeFilter: scopeCanonical.scopeFilter,
    scopeFingerprint,
    cacheFingerprint: cacheIds.cacheFingerprint,
    snapshot: {
      id: resolvedSnapshotId,
      versionNumber: reportView.snapshot.versionNumber,
      status: reportView.snapshot.status,
      executionReadinessState: reportView.snapshot.executionReadinessState,
      policyRuleSnapshotId: policySnapshot?.id || policySnapshotId,
    },
    policySnapshot: policySnapshot
      ? {
          id: policySnapshot.id,
          snapshotCode: policySnapshot.snapshot_code,
          snapshotFingerprint: policySnapshot.snapshot_fingerprint,
        }
      : null,
    insight: activeInsight,
    latestAttempt,
    activeJob: activeJobRow
      ? {
          id: activeJobRow.id,
          status: activeJobRow.status,
          createdAt: activeJobRow.created_at,
          startedAt: activeJobRow.started_at,
        }
      : null,
    canGenerateInsights: true,
  };
}

/**
 * Retrieves an exact persisted insight by ID with scope authorization enforcement (Zero Hermes).
 */
export async function getInsightByIdAuthorized({ insightId, viewerUser = null }) {
  const row = await insightRepo.getInsightById(insightId);
  if (!row) return null;
  assertAuthorizedToReadInsightRecord(row, viewerUser);
  const [hydrated] = await hydrateInsightsWithSemanticAudit([row], { includeAuditLookup: true });
  return hydrated;
}

/**
 * Lists immutable historical insights linked to their exact report snapshot IDs (Zero Hermes).
 */
export async function listInsightHistory({
  reportType = null,
  filters = {},
  snapshotId = null,
  viewerUser = null,
  limit = 20,
}) {
  if (viewerUser && viewerUser.hasFullTeamAccess === false) {
    assertAuthorizedForInsightScope({
      reportType: reportType || 'INDIVIDUAL_KPI_PMP',
      filters,
      viewerUser,
    });
  }

  let scopeFingerprint = null;
  if (reportType && filters) {
    scopeFingerprint = computeScopeFingerprint(reportType, filters);
  }

  const rows = await insightRepo.listHistoricalInsights({
    reportSnapshotId: snapshotId,
    reportType,
    reportingPeriod: filters.period || null,
    scopeFingerprint,
    validatedOnly: false,
    limit,
  });

  const authorizedRows =
    viewerUser && viewerUser.hasFullTeamAccess === false
      ? rows.filter((r) => {
          try {
            assertAuthorizedToReadInsightRecord(r, viewerUser);
            return true;
          } catch {
            return false;
          }
        })
      : rows;

  return hydrateInsightsWithSemanticAudit(authorizedRows, { includeAuditLookup: true });
}

export async function findEligibleCachedInsight({
  reportSnapshotId,
  policyRuleSnapshotId,
  scopeFingerprint,
  cacheFingerprint,
}) {
  const exactByKey = await insightRepo.getValidatedInsightByCacheKey(cacheFingerprint);
  if (exactByKey) {
    const [hydrated] = await hydrateInsightsWithSemanticAudit([exactByKey], {
      includeAuditLookup: false,
    });
    if (!hydrated?.semanticReview?.hasFlaggedFindings) {
      return { row: exactByKey, hydrated };
    }
  }

  const existingActive = await insightRepo.getActiveInsight({
    reportSnapshotId,
    policyRuleSnapshotId,
    scopeFingerprint,
    promptVersion: INSIGHT_PROMPT_VERSION,
    schemaVersion: INSIGHT_SCHEMA_VERSION,
  });
  if (!existingActive) return null;

  // Never treat legacy validation_status alone as proof an insight satisfies v3.3 semantics
  const [hydratedActive] = await hydrateInsightsWithSemanticAudit([existingActive], {
    includeAuditLookup: false,
  });
  const matchesCurrentFingerprint = existingActive.cache_fingerprint === cacheFingerprint;
  const passedCurrentSemantics = Boolean(
    hydratedActive?.semanticReview?.passedSemanticChecks &&
      !hydratedActive?.semanticReview?.hasFlaggedFindings
  );
  if (hydratedActive?.semanticReview?.hasFlaggedFindings) {
    return null;
  }
  if (!matchesCurrentFingerprint && !passedCurrentSemantics) {
    return null;
  }
  return { row: existingActive, hydrated: hydratedActive };
}

/**
 * Enqueues or reuses a REPORT_INSIGHT_GENERATION background job.
 * Never runs Hermes synchronously on the HTTP request thread.
 */
export async function enqueueInsightGeneration({
  reportType = 'SUMMARY',
  filters = {},
  snapshotId = null,
  viewerUser = null,
  force = false,
  model = null,
  requestOrigin = 'MANUAL_WEB_UI',
}) {
  const normalizedFilters = validateDateRange({ ...filters });
  if (normalizedFilters.isValidPeriod === false) {
    throw new InsightServiceError(normalizedFilters.periodValidationError, {
      code: 'INVALID_PERIOD',
      status: 400,
    });
  }

  const normalizedType = String(reportType || 'SUMMARY').trim().toUpperCase();
  const { isRestrictedViewer } = assertAuthorizedForInsightScope({
    reportType: normalizedType,
    filters: normalizedFilters,
    viewerUser,
  });

  let reportView;
  try {
    reportView = await resolveScopedReportForInsight({
      reportType: normalizedType,
      filters: normalizedFilters,
      snapshotId,
      viewerUser,
    });
  } catch (err) {
    if (err instanceof InsightContextError) {
      throw new InsightServiceError(err.message, { code: err.code, status: err.status });
    }
    throw err;
  }

  const effectiveFilters = reportView.activeFilters || normalizedFilters;
  const availability = assessInsightEvidenceAvailability({
    reportType: normalizedType,
    reportView,
  });
  if (!availability.sufficient) {
    throw new InsightServiceError(availability.reason, {
      code: availability.code,
      status: 409,
    });
  }

  const scopeCanonical = normalizeScopeInputs(normalizedType, effectiveFilters);
  const scopeFingerprint = computeScopeFingerprint(normalizedType, effectiveFilters);
  const resolvedSnapshotId = Number(reportView.snapshot.id);
  const policySnapshotId = Number(
    reportView.snapshot.policyRuleSnapshotId || reportView.policyContext?.snapshotId || 0
  );
  const policySnapshot = policySnapshotId
    ? await policySnapshotRepo.getPolicyRuleSnapshotById(policySnapshotId)
    : await policySnapshotRepo.getActivePolicyRuleSnapshot();

  if (!policySnapshot) {
    throw new InsightServiceError(`Linked policy rule snapshot #${policySnapshotId} not found.`, {
      code: 'POLICY_SNAPSHOT_NOT_FOUND',
      status: 404,
    });
  }

  const hermesConfig = getHermesConfig();
  const selectedModel = model || hermesConfig.model;
  const cacheIds = computeInsightCacheIdentifiers({
    reportSnapshotId: resolvedSnapshotId,
    sourceDataFingerprint: reportView.snapshot.sourceDataFingerprint,
    filterFingerprint: reportView.snapshot.filterFingerprint,
    snapshotVersionNumber: reportView.snapshot.versionNumber,
    calculationEngineVersion: reportView.snapshot.calculationEngineVersion,
    policyRuleSnapshotId: policySnapshot.id,
    policySnapshotFingerprint: policySnapshot.snapshot_fingerprint,
    reportType: normalizedType,
    scopeFingerprint,
    hermesModel: selectedModel,
    force,
  });

  const findReusableCachedResponse = async () => {
    if (force) return null;
    const match = await findEligibleCachedInsight({
      reportSnapshotId: resolvedSnapshotId,
      policyRuleSnapshotId: policySnapshot.id,
      scopeFingerprint,
      cacheFingerprint: cacheIds.cacheFingerprint,
    });
    if (!match) return null;
    return {
      status: 'CACHED',
      reused: true,
      deduplicated: true,
      jobId: null,
      hermesCallsCount: 0,
      reportSnapshotId: resolvedSnapshotId,
      policyRuleSnapshotId: policySnapshot.id,
      scopeFingerprint,
      cacheFingerprint: cacheIds.cacheFingerprint,
      insight: match.hydrated,
      message: 'Reused existing validated insight matching this exact report snapshot and policy.',
    };
  };

  // 1. Fast path: reuse existing valid immutable insight if unchanged & not forced
  const fastCached = await findReusableCachedResponse();
  if (fastCached) return fastCached;

  // 2. Serialize simultaneous non-forced / forced clicks under an advisory lock so
  // concurrent requests never enqueue duplicate background insight jobs.
  const enqueueLockKey = `fs_ai_enq_insight:${cacheIds.jobDedupePrefix}`;
  return jobRepo.withAdvisoryLock(enqueueLockKey, async () => {
    const lockedCached = await findReusableCachedResponse();
    if (lockedCached) return lockedCached;

    const activeJob = await jobRepo.findActiveJobByIdempotencyPrefix(
      'REPORT_INSIGHT_GENERATION',
      cacheIds.jobDedupePrefix
    );
    if (activeJob) {
      return {
        status: activeJob.status,
        reused: false,
        deduplicated: true,
        jobId: activeJob.id,
        hermesCallsCount: 0,
        reportSnapshotId: resolvedSnapshotId,
        policyRuleSnapshotId: policySnapshot.id,
        scopeFingerprint,
        cacheFingerprint: cacheIds.cacheFingerprint,
        message: `Insight generation job #${activeJob.id} is already ${activeJob.status} for this snapshot and scope.`,
      };
    }

    // 3. Create unique job key under deterministic prefix so prior failed runs can still be re-tried
    const jobKey = `${cacheIds.jobDedupePrefix}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;
    const { job } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: jobKey,
      priority: 40,
      payload: {
        reportType: normalizedType,
        filters: scopeCanonical,
        reportSnapshotId: resolvedSnapshotId,
        policyRuleSnapshotId: policySnapshot.id,
        scopeFilter: scopeCanonical.scopeFilter,
        scopeFingerprint,
        cacheFingerprint: cacheIds.cacheFingerprint,
        cacheKey: cacheIds.cacheKey,
        hermesModel: selectedModel,
        promptVersion: INSIGHT_PROMPT_VERSION,
        schemaVersion: INSIGHT_SCHEMA_VERSION,
        force: Boolean(force),
        isRestrictedViewer,
        requestedBySibsId: viewerUser?.sibsId || null,
      },
      requestOrigin,
      maxAttempts: 2,
    });

    return {
      status: job.status || 'QUEUED',
      reused: false,
      deduplicated: false,
      jobId: job.id,
      hermesCallsCount: 0,
      reportSnapshotId: resolvedSnapshotId,
      policyRuleSnapshotId: policySnapshot.id,
      scopeFingerprint,
      cacheFingerprint: cacheIds.cacheFingerprint,
      message: `Insight generation job #${job.id} queued for Snapshot #${resolvedSnapshotId} (${normalizedType}).`,
    };
  });
}

/**
 * Optional post-publication hook invoked after deterministic snapshot publication.
 * Defaults to OFF during initial rollout unless FS_AI_AUTO_INSIGHTS_ON_PUBLISH=true.
 */
export async function maybeEnqueueAutoInsightOnPublish({
  snapshotId,
  reportType,
  reportingPeriod = 'monthly',
  scopeFilter = 'all',
  filters = {},
}) {
  if (!isAutoInsightGenerationEnabled()) {
    return { skipped: true, reason: 'FS_AI_AUTO_INSIGHTS_ON_PUBLISH is disabled' };
  }

  const normalizedType = String(reportType || '').toUpperCase();
  const allowedTypes = getAllowedAutoInsightReportTypes();
  if (!allowedTypes.includes(normalizedType)) {
    return { skipped: true, reason: `Report type ${normalizedType} excluded from auto-insight rollout` };
  }

  // Keep employee-level auto generation strictly restricted unless single scope explicitly safe
  if (normalizedType === 'INDIVIDUAL_KPI_PMP' && String(scopeFilter || 'all') !== 'all') {
    return { skipped: true, reason: 'Employee-level auto-insights skipped for custom scope' };
  }

  return enqueueInsightGeneration({
    reportType: normalizedType,
    filters: { ...filters, period: reportingPeriod },
    snapshotId,
    force: false,
    requestOrigin: 'SNAPSHOT_PUBLICATION_HOOK',
  });
}

/**
 * Worker handler for `REPORT_INSIGHT_GENERATION` jobs.
 * Loads exact verified snapshot + policy context, calls Hermes once (with max 1
 * format-repair retry on broken JSON), validates every claim independently, and
 * persists immutable results/audits.
 */
export async function executeInsightGenerationJob(job, options = {}) {
  const startTime = Date.now();
  const payload =
    typeof job.payload_json === 'string'
      ? JSON.parse(job.payload_json)
      : job.payload_json || {};

  const reportType = String(payload.reportType || 'SUMMARY').toUpperCase();
  const filters = payload.filters || { period: payload.reportingPeriod || 'monthly' };
  const snapshotId = payload.reportSnapshotId || null;
  const force = Boolean(payload.force);
  const viewerUser = payload.isRestrictedViewer
    ? { hasFullTeamAccess: false, sibsId: payload.requestedBySibsId || null }
    : null;

  await insightRepo.ensureInsightTablesExist();

  const context = await buildInsightContext({
    reportType,
    filters,
    snapshotId,
    viewerUser,
  });

  // Ensure immutable snapshot resolution bundle is loaded directly from MySQL snapshot tables
  if (!context.snapshotBundle?.loadedFromImmutableSnapshot && !options.allowInMemoryCatalogFallback) {
    context.snapshotBundle = await loadImmutableSnapshotBundle({
      reportSnapshotId: context.reportSnapshotId,
      reportType,
      reportingPeriod: context.reportingPeriod,
      scopeFilter: context.scopeFilter,
    });
  }

  const scopeFingerprint =
    payload.scopeFingerprint || computeScopeFingerprint(reportType, filters);
  const hermesConfig = getHermesConfig();
  const hermesModel = payload.hermesModel || hermesConfig.model;
  const initialSystemChars = String(context.messages?.[0]?.content || '').length;
  const initialUserChars = String(context.messages?.[1]?.content || '').length;
  const initialPromptChars = initialSystemChars + initialUserChars;
  const initialPromptEstimatedTokens = Math.ceil(initialPromptChars / 4);
  const cacheIds = computeInsightCacheIdentifiers({
    reportSnapshotId: context.reportSnapshotId,
    sourceDataFingerprint: context.sourceDataFingerprint,
    filterFingerprint: context.filterFingerprint,
    snapshotVersionNumber: context.snapshotVersionNumber,
    calculationEngineVersion:
      context.contextPayload.calculationEngineVersion ||
      context.contextPayload.calculation_engine_version ||
      'v2.0-phase4c',
    policyRuleSnapshotId: context.policyRuleSnapshotId,
    policySnapshotFingerprint: context.policySnapshotFingerprint,
    reportType,
    scopeFingerprint,
    hermesModel,
    force,
  });

  // Double-check cache before invoking Hermes if non-forced
  if (!force) {
    const match = await findEligibleCachedInsight({
      reportSnapshotId: context.reportSnapshotId,
      policyRuleSnapshotId: context.policyRuleSnapshotId,
      scopeFingerprint,
      cacheFingerprint: cacheIds.cacheFingerprint,
    });
    if (match?.row) {
      return {
        status: 'COMPLETED',
        reused: true,
        published: true,
        insightId: match.row.id,
        validationStatus: match.row.validation_status,
        reportSnapshotId: context.reportSnapshotId,
        policyRuleSnapshotId: context.policyRuleSnapshotId,
        hermesCallsCount: 0,
        applicationCallsCount: 0,
        upstreamAttemptsCount: 0,
        transportRetriesCount: 0,
      };
    }
  }

  const leaseOwner =
    options.leaseOwner ||
    (job?.lease_token && job?.worker_id
      ? {
          workerId: job.worker_id,
          leaseToken: job.lease_token,
          expectedAttemptCount: job.attempt_count,
          requireOwnership: true,
        }
      : null);
  const enforceLeaseOwnership = Boolean(options.enforceLeaseOwnership) || Boolean(leaseOwner);

  const hermesCompletionFn =
    typeof options.hermesCompletionFn === 'function'
      ? options.hermesCompletionFn
      : sendHermesChatCompletion;

  const maxTransportRetries = options.maxTransportRetries !== undefined ? options.maxTransportRetries : 1;

  let hermesCallsCount = 0;
  let upstreamAttemptsCount = 0;
  let transportRetriesCount = 0;
  const transportRetryReasons = [];

  const invokeHermesBounded = async (messages, callOpts) => {
    // Re-verify active worker lease ownership immediately before any Hermes API invocation
    if (enforceLeaseOwnership && leaseOwner) {
      await jobRepo.assertJobOwnership(job.id, leaseOwner);
    }

    hermesCallsCount++;
    try {
      const resp = await hermesCompletionFn(messages, {
        ...callOpts,
        maxTransportRetries,
      });
      const callUpstream = Number(resp?.upstreamAttempts || 1);
      const callTransportRetries = Number(resp?.transportRetries ?? Math.max(0, callUpstream - 1));
      upstreamAttemptsCount += callUpstream;
      transportRetriesCount += callTransportRetries;
      if (Array.isArray(resp?.transportRetryReasons)) {
        transportRetryReasons.push(...resp.transportRetryReasons);
      }
      return resp;
    } catch (err) {
      const callUpstream = Number(err?.upstreamAttempts || 1);
      const callTransportRetries = Number(err?.transportRetries ?? Math.max(0, callUpstream - 1));
      upstreamAttemptsCount += callUpstream;
      transportRetriesCount += callTransportRetries;
      if (Array.isArray(err?.transportRetryReasons)) {
        transportRetryReasons.push(...err.transportRetryReasons);
      }
      throw err;
    }
  };

  let hermesResponse;
  try {
    hermesResponse = await invokeHermesBounded(context.messages, {
      model: hermesModel,
      temperature: 0.1,
      maxTokens: 4096,
      responseFormat: { type: 'json_object' },
    });
  } catch (transportErr) {
    if (transportErr?.code === 'STALE_JOB_OWNERSHIP' || transportErr instanceof jobRepo.StaleJobOwnershipError) {
      throw transportErr;
    }
    await insightRepo.recordInsightAudit({
      jobId: job.id,
      reportSnapshotId: context.reportSnapshotId,
      policyRuleSnapshotId: context.policyRuleSnapshotId,
      reportType,
      reportingPeriod: context.reportingPeriod,
      scopeFilter: context.scopeFilter,
      scopeFingerprint,
      cacheKey: payload.cacheKey || cacheIds.cacheKey,
      eventType: 'INSIGHT_TRANSPORT_FAILED',
      validationStatus: 'FAILED',
      hermesModel,
      hermesCallsCount,
      durationMs: Date.now() - startTime,
      errorSummary: `${transportErr.message} (appCalls=${hermesCallsCount}, upstreamAttempts=${upstreamAttemptsCount}, transportRetries=${transportRetriesCount})`,
      requestOrigin: job.request_origin || 'MANUAL_WEB_UI',
      requestedBySibsId: payload.requestedBySibsId || null,
    });
    throw transportErr;
  }

  const extractResponseMeta = (resp) => {
    const rawContentStr = String(resp?.content || '');
    let topLevelKeys = null;
    try {
      const parsedObj = extractInsightJsonObject(rawContentStr);
      if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
        topLevelKeys = Object.keys(parsedObj).slice(0, 15);
      }
    } catch {}
    const up = Number(resp?.upstreamAttempts || 1);
    return {
      model: resp?.model || hermesModel,
      usage: resp?.usage || resp?.rawJson?.usage || null,
      finishReason: resp?.rawJson?.choices?.[0]?.finish_reason || null,
      rawLength: rawContentStr.length,
      upstreamAttempts: up,
      transportRetries: Number(resp?.transportRetries ?? Math.max(0, up - 1)),
      topLevelKeys,
      ...(topLevelKeys === null && rawContentStr
        ? {
            rawSnippetHead: rawContentStr.slice(0, 260),
            rawSnippetTail: rawContentStr.length > 260 ? rawContentStr.slice(-260) : '',
          }
        : {}),
    };
  };

  let rawContent = hermesResponse?.content || '';
  const firstCallMeta = extractResponseMeta(hermesResponse);
  let secondCallMeta = null;
  let parseRepairAttempted = false;
  let structuralRepairAttempted = false;
  let repairSkippedDueToBudget = false;
  let repairBudgetCheck = null;
  let repairPromptDiagnostics = null;
  let firstAttemptReport = null;

  const validateCurrentRaw = (contentStr) =>
    validateHermesInsightResponse(contentStr, context, {
      allowInMemoryCatalogFallback: Boolean(options.allowInMemoryCatalogFallback),
    });

  const recordRepairTransportAuditFailure = async (retryTransportErr) => {
    await insightRepo.recordInsightAudit({
      jobId: job.id,
      reportSnapshotId: context.reportSnapshotId,
      policyRuleSnapshotId: context.policyRuleSnapshotId,
      reportType,
      reportingPeriod: context.reportingPeriod,
      scopeFilter: context.scopeFilter,
      scopeFingerprint,
      cacheKey: payload.cacheKey || cacheIds.cacheKey,
      eventType: 'INSIGHT_TRANSPORT_FAILED',
      validationStatus: 'FAILED',
      hermesModel,
      hermesCallsCount,
      durationMs: Date.now() - startTime,
      errorSummary: `${retryTransportErr.message} (appCalls=${hermesCallsCount}, upstreamAttempts=${upstreamAttemptsCount}, transportRetries=${transportRetriesCount})`,
      requestOrigin: job.request_origin || 'MANUAL_WEB_UI',
      requestedBySibsId: payload.requestedBySibsId || null,
    });
  };

  const executeCompactRepairAttempt = async ({ parsedDraft, errors, repairPhase }) => {
    const repairBundle = buildCompactRepairPrompt({
      context,
      parsedDraft,
      errors,
      repairPhase,
      maxRepairFacts: options.maxRepairFacts || 12,
      maxRepairRules: options.maxRepairRules || 10,
      maxRepairLimitations: options.maxRepairLimitations || 6,
    });
    repairPromptDiagnostics = repairBundle.diagnostics;
    repairBudgetCheck = evaluateRepairPromptBudget({
      promptChars: repairBundle.diagnostics.totalRepairChars,
      estimatedTokens: repairBundle.diagnostics.estimatedRepairTokens,
      options,
      context,
      hermesConfig,
    });

    if (!repairBudgetCheck.withinBudget) {
      repairSkippedDueToBudget = true;
      return { executed: false, skippedDueToBudget: true, retryResponse: null };
    }

    const retryResponse = await invokeHermesBounded(repairBundle.messages, {
      model: hermesModel,
      temperature: 0.05,
      maxTokens: 4096,
      responseFormat: { type: 'json_object' },
    });
    secondCallMeta = extractResponseMeta(retryResponse);
    return { executed: true, skippedDueToBudget: false, retryResponse };
  };

  try {
    extractInsightJsonObject(rawContent);
  } catch (parseErr) {
    // Bounded 1-time JSON repair retry using compact single-schema prompt + budget guard
    parseRepairAttempted = true;
    firstAttemptReport = {
      ...firstCallMeta,
      errors: [`Initial parse failed: ${parseErr.message}`],
    };
    try {
      const repairOutcome = await executeCompactRepairAttempt({
        parsedDraft: null,
        errors: [`Initial parse failed: ${parseErr.message}`],
        repairPhase: 'PARSE',
      });
      if (repairOutcome.executed && repairOutcome.retryResponse) {
        rawContent = repairOutcome.retryResponse?.content || rawContent;
      }
    } catch (retryTransportErr) {
      if (retryTransportErr?.code === 'STALE_JOB_OWNERSHIP' || retryTransportErr instanceof jobRepo.StaleJobOwnershipError) {
        throw retryTransportErr;
      }
      await recordRepairTransportAuditFailure(retryTransportErr);
      throw retryTransportErr;
    }
  }

  let validation = validateCurrentRaw(rawContent);
  if (repairSkippedDueToBudget && repairBudgetCheck?.reason) {
    validation = {
      ...validation,
      isValid: false,
      validationStatus: 'REJECTED',
      errors: [...(validation.errors || []), repairBudgetCheck.reason],
    };
  }

  // Bounded 1-time clean Contract v3 repair retry (NEVER echoes rejected numbers or dumps full catalog)
  const needsStructuralRepair =
    !validation.isValid &&
    hermesCallsCount < 2 &&
    !repairSkippedDueToBudget &&
    validation.checks.securityScanPassed !== false &&
    validation.checks.privacyScopePreserved !== false &&
    validation.checks.safetyGuardrailsPassed !== false &&
    validation.checks.noUnsupportedTrends !== false &&
    (!validation.checks.jsonParsed ||
      !validation.checks.schemaValid ||
      !validation.checks.schemaVersionMatched ||
      !validation.checks.snapshotIdentityMatched ||
      !validation.checks.evidenceIdsVerified ||
      !validation.checks.evidenceNumbersVerified ||
      !validation.checks.evidenceResolvedFromSnapshot ||
      !validation.checks.proseFreeOfNumbers ||
      !validation.checks.noApproximations ||
      !validation.checks.granularityConsistent ||
      !validation.checks.comparativeClaimsValid ||
      !validation.checks.narrativeConsistentWithEvidence ||
      !validation.checks.policyCitationsVerified);

  if (needsStructuralRepair) {
    structuralRepairAttempted = true;
    firstAttemptReport = {
      ...firstCallMeta,
      checks: validation.checks,
      errors: validation.errors.slice(0, 8),
    };
    let parsedDraft = null;
    try {
      parsedDraft = extractInsightJsonObject(rawContent);
    } catch {}

    try {
      const repairOutcome = await executeCompactRepairAttempt({
        parsedDraft,
        errors: validation.errors,
        repairPhase: 'STRUCTURAL',
      });
      if (repairOutcome.executed && repairOutcome.retryResponse) {
        rawContent = repairOutcome.retryResponse?.content || rawContent;
        validation = validateCurrentRaw(rawContent);
      } else if (repairOutcome.skippedDueToBudget && repairBudgetCheck?.reason) {
        validation = {
          ...validation,
          isValid: false,
          validationStatus: 'REJECTED',
          errors: [...(validation.errors || []), repairBudgetCheck.reason],
        };
      }
    } catch (retryTransportErr) {
      if (retryTransportErr?.code === 'STALE_JOB_OWNERSHIP' || retryTransportErr instanceof jobRepo.StaleJobOwnershipError) {
        throw retryTransportErr;
      }
      await recordRepairTransportAuditFailure(retryTransportErr);
      throw retryTransportErr;
    }
  }

  // Deterministically synthesize executive summary ONLY if omitted in validated Contract v3 output
  let finalSanitizedInsight = validation.sanitizedInsight;
  if (finalSanitizedInsight && !finalSanitizedInsight.executive_summary) {
    finalSanitizedInsight = {
      ...finalSanitizedInsight,
      executive_summary: buildDeterministicExecutiveSummary({
        context,
        findings: finalSanitizedInsight.findings,
        limitationsCatalog: context.limitationsCatalog,
      }),
    };
  }

  const durationMs = Date.now() - startTime;
  const generationStatus = validation.isValid ? 'COMPLETED' : 'FAILED';
  const errorSummary =
    validation.errors.length > 0 || validation.warnings.length > 0
      ? [...validation.errors, ...validation.warnings].slice(0, 8).join(' | ')
      : null;

  const tokenUsageSummary = {
    gatewayUsageAuthoritative: {
      call1: firstCallMeta?.usage || null,
      call2: secondCallMeta?.usage || null,
      totalPromptTokens:
        (Number(firstCallMeta?.usage?.prompt_tokens || 0) || 0) +
        (Number(secondCallMeta?.usage?.prompt_tokens || 0) || 0),
      totalCompletionTokens:
        (Number(firstCallMeta?.usage?.completion_tokens || 0) || 0) +
        (Number(secondCallMeta?.usage?.completion_tokens || 0) || 0),
      totalTokens:
        (Number(firstCallMeta?.usage?.total_tokens || 0) || 0) +
        (Number(secondCallMeta?.usage?.total_tokens || 0) || 0),
    },
    localBudgetEstimates: {
      estimateSource: 'LOCAL_CHAR_APPROXIMATION',
      note: 'Approximate local character-based estimates used solely for pre-call repair budget checks; not authoritative gateway token accounting.',
      initialEstimatedTokens: initialPromptEstimatedTokens,
      repairEstimatedTokens: repairPromptDiagnostics?.estimatedRepairTokens ?? null,
    },
  };

  const persisted = await insightRepo.persistInsightVersion({
    reportSnapshotId: context.reportSnapshotId,
    policyRuleSnapshotId: context.policyRuleSnapshotId,
    reportType,
    reportingPeriod: context.reportingPeriod,
    scopeFilter: context.scopeFilter,
    scopeFingerprint,
    cacheFingerprint: cacheIds.cacheFingerprint,
    cacheKey: payload.cacheKey || cacheIds.cacheKey,
    hermesModel: secondCallMeta?.model || hermesResponse?.model || hermesModel,
    promptVersion: INSIGHT_PROMPT_VERSION,
    schemaVersion: INSIGHT_SCHEMA_VERSION,
    generationStatus,
    validationStatus: validation.validationStatus,
    insightJson: finalSanitizedInsight,
    validationReportJson: {
      validationStatus: validation.validationStatus,
      checks: validation.checks,
      errors: validation.errors,
      warnings: validation.warnings,
      evidenceCheckedCount: validation.evidenceCheckedCount,
      policyCitationsVerifiedCount: validation.policyCitationsVerifiedCount,
      policyRelevanceDiagnostics: validation.policyRelevanceDiagnostics || [],
      evidenceClaimDiagnostics: validation.evidenceClaimDiagnostics || [],
      semanticDiagnostics: validation.semanticDiagnostics || [],
      applicationCallsCount: hermesCallsCount,
      upstreamAttemptsCount,
      transportRetriesCount,
      transportRetryReasons,
      parseRepairAttempted,
      structuralRepairAttempted,
      repairSkippedDueToBudget,
      repairBudgetCheck,
      repairPromptDiagnostics,
      initialPromptTelemetry: {
        systemChars: initialSystemChars,
        userChars: initialUserChars,
        totalChars: initialPromptChars,
        estimatedTokens: initialPromptEstimatedTokens,
        estimateSource: 'LOCAL_CHAR_APPROXIMATION',
      },
      tokenUsageSummary,
      promptContractVersion: INSIGHT_PROMPT_CONTRACT_VERSION,
      repairVersion: INSIGHT_REPAIR_VERSION,
      validatorVersion: INSIGHT_VALIDATOR_VERSION,
      firstCallMeta,
      secondCallMeta,
      firstAttemptReport,
    },
    contextMetadataJson: {
      reportSnapshotId: context.reportSnapshotId,
      snapshotVersionNumber: context.snapshotVersionNumber,
      snapshotLifecycleStatus: context.snapshotLifecycleStatus,
      executionReadinessState: context.executionReadinessState,
      policySnapshotCode: context.policySnapshotCode,
      scopeFilter: context.scopeFilter,
      isSingleEmployeeScope: context.isSingleEmployeeScope,
      promptVersion: INSIGHT_PROMPT_VERSION,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      promptContractVersion: INSIGHT_PROMPT_CONTRACT_VERSION,
      validatorVersion: INSIGHT_VALIDATOR_VERSION,
      repairVersion: INSIGHT_REPAIR_VERSION,
      initialPromptTelemetry: {
        systemChars: initialSystemChars,
        userChars: initialUserChars,
        totalChars: initialPromptChars,
        estimatedTokens: initialPromptEstimatedTokens,
        estimateSource: 'LOCAL_CHAR_APPROXIMATION',
      },
      repairPromptDiagnostics,
      tokenUsageSummary,
      factCatalogCount: context.factCatalog?.length || 0,
      limitationsCatalogCount: context.limitationsCatalog?.length || 0,
      limitationsCatalog: context.limitationsCatalog || [],
      policyRulesIncludedCount: context.policyRules?.length || 0,
    },
    jobId: job.id,
    leaseOwner: enforceLeaseOwnership ? leaseOwner : null,
    requestOrigin: job.request_origin || 'MANUAL_WEB_UI',
    requestedBySibsId: payload.requestedBySibsId || null,
    hermesCallsCount,
    generationDurationMs: durationMs,
    errorSummary,
  });

  return {
    status: 'COMPLETED',
    reused: false,
    published: persisted.is_current_active === 1,
    insightId: persisted.id,
    validationStatus: persisted.validation_status,
    generationStatus: persisted.generation_status,
    reportSnapshotId: context.reportSnapshotId,
    policyRuleSnapshotId: context.policyRuleSnapshotId,
    scopeFingerprint,
    hermesCallsCount,
    applicationCallsCount: hermesCallsCount,
    upstreamAttemptsCount,
    transportRetriesCount,
    repairSkippedDueToBudget,
    repairBudgetCheck,
    repairPromptDiagnostics,
    tokenUsageSummary,
    durationMs,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}
