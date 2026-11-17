/**
 * FrontSteps AI Independent Insight Validator (Phase 6.2 — Contract v3)
 *
 * Never treats Hermes output as an authoritative source of numeric or policy truth.
 * Contract v3 architecture:
 * - Hermes produces PURELY QUALITATIVE findings + exact `evidence_ids` + `policy_rule_codes`.
 * - PMS independently resolves all numerical values, units, targets, weights, and policy
 *   references straight from the immutable DB snapshot via `frontStepsAiInsightEvidenceResolver.js`.
 * - This validator rejects ANY ungrounded/prohibited numerical prose (digits, %, $, durations,
 *   counts, approximations, spelled-out numeric words), inline technical IDs inside prose,
 *   granularity/aggregation mixing, incompatible or contradictory comparisons, target direction
 *   inversions, fabricated trends, NO_DATA/BLOCKED misrepresentation, privacy breaches, and
 *   prohibited HR/disciplinary actions.
 *
 * Fail-Closed Rule:
 * - Any validation error produces `isValid: false` (`validationStatus: 'REJECTED'`),
 *   preventing `is_current_active = 1` publication.
 */

import { extractJsonFromAssistantResponse } from './frontStepsAiRuleCandidateValidator.js';
import {
  ALLOWED_METRIC_CODE_SET,
  resolveEvidenceIdsWithBundle,
} from './frontStepsAiInsightEvidenceResolver.js';

export const ALLOWED_FINDING_CATEGORIES = new Set([
  'CALL_PERFORMANCE',
  'OPERATIONAL_PERFORMANCE',
  'CALL_CENTER_TREND',
  'CASE_OPERATIONS',
  'CRM_COMPLIANCE',
  'POLICY_GAP',
  'DATA_QUALITY_RISK',
  'STAFFING_OR_BOTTLENECK',
  'COACHING_SUGGESTION',
  'ACCOUNT_SCOPE_COMPARISON',
  'KPI_EXPLANATION',
]);

export const ALLOWED_SEVERITIES = new Set(['INFO', 'WARNING', 'CRITICAL']);

export const ALLOWED_CLAIM_TYPES = new Set([
  'PERFORMANCE_VS_TARGET',
  'BOTTLENECK_OR_RISK',
  'OPERATIONAL_CONCENTRATION',
  'ENTITY_COMPARISON',
  'EXTREME_VS_BASELINE',
  'CRM_COMPLIANCE_GAP',
  'DATA_LIMITATION_EXPLANATION',
  'COACHING_OPPORTUNITY',
]);

export const ALLOWED_FINDING_KEYS = new Set([
  'category',
  'severity',
  'claim_type',
  'headline',
  'observation',
  'evidence_ids',
  'policy_rule_codes',
  'recommendation',
  'limitations',
]);

export const CONTRACT_V3_SCHEMA = Object.freeze({
  schemaVersion: '3',
  statusValue: 'COMPLETED',
  maxFindings: 5,
  allowedTopLevelKeys: [
    'report_snapshot_id',
    'report_type',
    'schema_version',
    'status',
    'executive_summary',
    'findings',
    'data_quality_warnings',
    'overall_limitations',
  ],
  requiredTopLevelKeys: [
    'report_snapshot_id',
    'report_type',
    'schema_version',
    'status',
    'executive_summary',
    'findings',
    'data_quality_warnings',
    'overall_limitations',
  ],
  requiredFindingKeys: [
    'category',
    'severity',
    'headline',
    'observation',
    'evidence_ids',
    'policy_rule_codes',
    'recommendation',
    'limitations',
  ],
  optionalFindingKeys: ['claim_type'],
  allowedCategories: Array.from(ALLOWED_FINDING_CATEGORIES),
  allowedSeverities: Array.from(ALLOWED_SEVERITIES),
  allowedClaimTypes: Array.from(ALLOWED_CLAIM_TYPES),
  forbiddenKeysNote: 'Do NOT add "issues", "analysis", "reasoning", "notes", or any unlisted keys.',
});

const ALLOWED_TOP_LEVEL_KEYS = new Set(CONTRACT_V3_SCHEMA.allowedTopLevelKeys);

/**
 * Single authoritative Contract v3 output JSON template shared across initial prompts
 * and structural repair prompts so schemas never drift independently.
 */
export function buildContractV3OutputSchemaExample({ reportSnapshotId, reportType }) {
  return JSON.stringify(
    {
      report_snapshot_id: Number(reportSnapshotId),
      report_type: String(reportType || 'SUMMARY').toUpperCase(),
      schema_version: CONTRACT_V3_SCHEMA.schemaVersion,
      status: CONTRACT_V3_SCHEMA.statusValue,
      executive_summary: 'Concise purely qualitative management summary with zero numbers.',
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: 'WARNING',
          claim_type: 'PERFORMANCE_VS_TARGET',
          headline: 'Short qualitative headline without numbers',
          observation:
            'Qualitative explanation referencing exact evidence_ids without numbers or inline IDs.',
          evidence_ids: ['Exact verbatim string from allowed_evidence_ids'],
          policy_rule_codes: ['Exact verbatim string from allowed_policy_rule_codes or []'],
          recommendation: 'Practical, non-punitive qualitative action without numbers.',
          limitations: ['Plain human-readable qualitative caveat string without codes or numbers, or []'],
        },
      ],
      data_quality_warnings: ['Plain human-readable data warning string without codes or numbers, or []'],
      overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
    },
    null,
    2
  );
}

/**
 * Single authoritative enum and schema constraint legend shared across initial and repair prompts.
 */
export function buildContractV3EnumLegend() {
  return [
    `REQUIRED TOP-LEVEL KEYS: ${CONTRACT_V3_SCHEMA.requiredTopLevelKeys.join(', ')}. ${CONTRACT_V3_SCHEMA.forbiddenKeysNote}`,
    `TOP-LEVEL ARRAYS: ALWAYS include "data_quality_warnings": [...] AND "overall_limitations": [...] as plain English string arrays (use [] if none; put all caveats/warnings inside these two arrays and never emit objects).`,
    `REQUIRED FINDING KEYS: ${CONTRACT_V3_SCHEMA.requiredFindingKeys.join(', ')} (optional: ${CONTRACT_V3_SCHEMA.optionalFindingKeys.join(', ')}; prefer 1-3 complete findings, max ${CONTRACT_V3_SCHEMA.maxFindings}, or [] if insufficient).`,
    `ALLOWED SEVERITIES: ${CONTRACT_V3_SCHEMA.allowedSeverities.join(' | ')}`,
    `ALLOWED CATEGORIES (pick ONLY here): ${CONTRACT_V3_SCHEMA.allowedCategories.join(' | ')} (avoid CALL_CENTER_TREND on single-period snapshots).`,
    `ALLOWED CLAIM_TYPES (for "claim_type" ONLY): ${CONTRACT_V3_SCHEMA.allowedClaimTypes.join(' | ')}`,
    `CATEGORY VS CLAIM_TYPE BOUNDARY: NEVER put claim_type values ("OPERATIONAL_CONCENTRATION", "BOTTLENECK_OR_RISK", "PERFORMANCE_VS_TARGET", "DATA_LIMITATION_EXPLANATION", "ENTITY_COMPARISON") into "category" (use "OPERATIONAL_PERFORMANCE" / "CRM_COMPLIANCE" / "CALL_PERFORMANCE").`,
    `CLAIM_TYPE TARGET RULE: "PERFORMANCE_VS_TARGET" requires cited fact target_status="BELOW_TARGET", "MEETS_OR_EXCEEDS_TARGET", or "ON_TARGET". For target_status="NO_TARGET", use "BOTTLENECK_OR_RISK", "OPERATIONAL_CONCENTRATION", "ENTITY_COMPARISON", "EXTREME_VS_BASELINE", "COACHING_OPPORTUNITY", or "DATA_LIMITATION_EXPLANATION".`,
    `ATTAINMENT & POLARITY SEPARATION RULE: Keep MEETS_OR_EXCEEDS_TARGET (AHT/AHT_COMPLIANCE) and BELOW_TARGET (CRM_*) in SEPARATE findings, and keep Voice vs CRM metrics separate. For LOWER_IS_BETTER (AHT, ASA) when MEETS_OR_EXCEEDS_TARGET, write "meets policy target" or "within target limit" — NEVER say "above target".`,
    `EVIDENCE & POLICY FORMAT: "evidence_ids" = verbatim allowed_evidence_ids strings starting with "SNAP:"; "policy_rule_codes" = verbatim allowed_policy_rule_codes or []; string arrays = plain English only (no READINESS_* codes, objects, digits, or spelled numbers like "Two"/"Three").`,
  ].join('\n');
}

const DANGEROUS_CONTENT_PATTERN =
  /(?:<script\b|javascript:|eval\s*\(|Function\s*\(|DROP\s+TABLE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+.*SET\s+|UNION\s+SELECT|process\.env|require\s*\(|child_process)/i;

// Safety guardrails banning automated disciplinary/payroll decisions or misconduct claims
const PROHIBITED_HR_ACTION_PATTERNS = [
  /\b(?:initiate|recommend(?:ed|ing)?|suggest(?:ed|ing)?|start|open|create|place\s+(?:the\s+)?(?:employee|agent|them|him|her|staff)|enroll(?:\s+(?:the\s+)?(?:employee|agent|them|him|her))?|put\s+(?:the\s+)?(?:employee|agent|them|him|her)|issue\s+(?:a|an)?)\s+(?:formal\s+)?(?:on\s+|in\s+)?(?:a\s+)?pip\b/i,
  /\b(?:place|put|enroll)\s+[^.]{0,30}\b(?:on|in(?:to)?)\s+(?:a\s+)?pip\b/i,
  /\b(?:recommend(?:ed|ing)?|issue|execute|initiate|impose)\s+(?:a\s+)?(?:termination|terminate\s+employment|disciplinary\s+action|corrective\s+action|suspension|written\s+warning|final\s+warning)\b/i,
  /\b(?:should\s+be|must\s+be)\s+(?:terminated|fired|suspended|placed\s+on\s+pip|docked\s+pay|denied\s+payout)\b/i,
  /\b(?:approve|release|withhold|deduct|dock|reduce|freeze|adjust)\s+(?:incentive(?:\s+payout)?|payroll(?:\s+payout)?|bonus(?:\s+payment)?|compensation|pay)\b/i,
  /\b(?:attendance\s+gap|missing\s+punch(?:es)?|stalled\s+attendance|tracker\s+halt).*?(?:proves?\s+misconduct|awol\s+violation|disciplinary\s+offense|time\s+theft)\b/i,
];
const HR_ACTION_NEGATION_REGEX =
  /\b(?:never|not|nor|neither|cannot|can't|must\s+not|should\s+not|does\s+not|do\s+not|don't|doesn't|avoid|without|prohibit(?:s|ed)?)\b/i;

const ZERO_OR_FAILED_ON_MISSING_PATTERNS = [
  /\b(?:no[_\s]data|missing[_\s](?:source|alias)|blocked|unattributed)\b[^.]{0,90}\b(?:equals?|means?|indicates?|shows?|represents?)\s+(?:0|zero)\s+(?:productivity|performance|cases?\s+closed|output)\b/i,
  /\b(?:missing\s+source\s+alias|no\s+data\s+available|no[_\s]data)\b[^.]{0,90}\b(?:failing|failed\s+kpi|underperform(?:ing|ance)|zero\s+productivity)\b/i,
  /\b(?:0|zero)\s+(?:productivity|performance|kpi\s+score)\b[^.]{0,90}\b(?:no[_\s]data|missing\s+alias|blocked)\b/i,
];

const FABRICATED_TREND_PATTERNS = [
  /\b(?:compared\s+(?:to|with)|vs\.?|versus|than|from)\s+(?:the\s+)?(?:prior|previous|last)\s+(?:period|month|quarter|year|week)\b/i,
  /\b(?:prior|previous|last)\s+(?:month|quarter|year|week)(?:'s)?\b[^.]{0,60}\b(?:increas(?:e|ed|ing)|decreas(?:e|ed|ing)|declin(?:e|ed|ing)|improv(?:e|ed|ing)|dropp(?:ed|ing)|rose|risen|higher|lower|trend)\b/i,
  /\bmonth-over-month\b|\bmom\b|\byear-over-year\b|\byoy\b|\bweek-over-week\b|\bwow\b|\bqoq\b/i,
  /\b(?:forecast(?:ed|s|ing)?|project(?:ed|ion|s)?)\b[^.]{0,60}(?:\bnext\s+(?:month|week|quarter|year)\b|\bupcoming\b|\d)/i,
  /\bprojected\s+to\s+(?:reach|hit|exceed|drop|decline|improve)\b/i,
];

const APPROXIMATION_PATTERN =
  /(?:~\s*\$?\d|\b(?:approx(?:imately)?\.?|roughly|around|nearly|about)\s+(?:\$?\d+(?:,\d{3})*(?:\.\d+)?%?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|double|triple)\b))/i;

const SPELLED_NUMBER_PROSE_PATTERN =
  /(?:\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|thrity|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b|\bone\s+(?:hundred|thousand|million|percent|pct|call|calls|case|cases|sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks|month|months|agent|agents|employee|employees|queue|queues|channel|channels|point|points|score|target)\b)/i;

const NUMERIC_TOKEN_PATTERN =
  /(?:\$\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*%|\d+(?:-\d+)+|\d[\d,]*(?:\.\d+)?)/g;

const INLINE_TECHNICAL_ID_PATTERN = /\b(?:SNAP|LIM):[A-Za-z0-9:_-]+/i;

const TARGET_PERFORMANCE_MISS_PATTERN =
  /\b(?:miss(?:es|ed|ing)?|missed|fell\s+short\s+of|falls\s+short\s+of|short\s+of|underperformed?|worse\s+than|non-?compliant\s+with)\s+(?:the\s+)?(?:policy\s+|sla\s+|scorecard\s+|kpi\s+)?(?:target|threshold|standard|limit|cap)\b/i;

const TARGET_NUMERIC_BELOW_PATTERN =
  /\b(?:below|lower\s+than|under)\s+(?:the\s+)?(?:policy\s+|sla\s+|scorecard\s+|kpi\s+|maximum\s+)?(?:target|threshold|standard|limit|cap|ceiling)\b/i;

const TARGET_PERFORMANCE_PASS_PATTERN =
  /\b(?:meet(?:s|ing)?|met|outperform(?:s|ed|ing)?|compliant\s+with|attained|favorable\s+against)\s+(?:the\s+)?(?:policy\s+|sla\s+|scorecard\s+|kpi\s+)?(?:target|threshold|standard|limit|cap)\b/i;

const TARGET_NUMERIC_ABOVE_PATTERN =
  /\b(?:exceed(?:s|ed|ing)?|above|higher\s+than|beat(?:s|ing)?|surpass(?:es|ed|ing)?)\s+(?:the\s+)?(?:policy\s+|sla\s+|scorecard\s+|kpi\s+|maximum\s+|aht\s+|asa\s+)?(?:target|threshold|standard|cap|limit|ceiling)\b/i;

const COMPARATIVE_THAN_PATTERN =
  /\b(?:higher|lower|greater|fewer|less|faster|slower|better|worse|larger|smaller|stronger|weaker)\b[^.]{0,55}\bthan\s+(?!(?:the\s+)?(?:policy\s+|sla\s+|scorecard\s+|kpi\s+|allowed\s+|expected\s+|normal\s+|historical\s+|maximum\s+|minimum\s+)?(?:target|threshold|standard|benchmark|ceiling|cap|floor|minimum|maximum|prior|previous|last)\b)|\b(?:exceeds?|outperforms?|trails?|lags?\s+behind)\s+(?:the\s+)?(?:other|peer|another|remaining|alternative)\b/i;

const SUPERLATIVE_EXTREME_PATTERN =
  /\b(?:highest|lowest|worst|best|largest|smallest|peak|trough)\b/i;

const RISK_OR_DEFICIT_METRIC_CODES = new Set([
  'BACKLOG_RATE',
  'CLOSED_SLA_PERCENT',
  'ABANDON_RATE',
  'CALLS_ABANDONED',
  'ASA',
]);

const NEUTRAL_VOLUME_METRIC_CODES = new Set([
  'TOTAL_CASES',
  'CLOSED_CASES',
  'CALLS_OFFERED',
  'CALLS_ANSWERED',
  'EMP_METRIC:ATTRIBUTED_CLOSED_CASES',
]);

const SCORECARD_NAMED_METRIC_MATCHERS = [
  { match: /\baht\s+compliance\b/i, code: 'AHT_COMPLIANCE', label: 'AHT Compliance' },
  { match: /\b(?:average\s+handle\s+time|\baht\b)(?!\s+compliance)/i, code: 'AHT', label: 'AHT' },
  {
    match: /\b(?:crm\s+(?:resolution\s+)?sub[-\s]?codes?|sub[-\s]?codes?\s+(?:completion|documentation|selection|events?|fields?|efforts?|work))\b/i,
    code: 'CRM_SUB_CODE_COMPLETION',
    label: 'CRM Sub-Code Completion',
  },
  {
    match: /\b(?:crm\s+(?:case\s+)?summary|summary\s+(?:documentation|completion|field|text\s+block|events?|records?))\b/i,
    code: 'CRM_SUMMARY_COMPLETION',
    label: 'CRM Summary Completion',
  },
  {
    match: /\bcrm\s+resolution(?:\s+(?:field|status|completion|note))?\b(?!\s+sub[-\s]?code)/i,
    code: 'CRM_RESOLUTION',
    label: 'CRM Resolution',
  },
];

const ATTAINMENT_ASSERTION_PATTERN =
  /\b(?:meet(?:s|ing)?\s+(?:the\s+)?(?:policy\s+|required\s+)?(?:target|threshold|standard|expectations?)|met\s+(?:the\s+)?(?:policy\s+)?(?:target|expectations?)|track(?:s|ing)?\s+to\s+target|fall(?:s|ing)?\s+short|fell\s+short|below\s+(?:the\s+|defined\s+)?(?:policy\s+|required\s+)?target|above\s+(?:the\s+)?(?:policy\s+)?target|within\s+(?:the\s+)?(?:policy\s+)?(?:target|limit|threshold)|exceed(?:s|ed)?\s+(?:the\s+)?(?:policy\s+)?target|underperform(?:s|ed|ing)?|non-?compliant|frequency\s+targets?)\b/i;

const BOTTLENECK_ASSERTION_PATTERN =
  /\b(?:operational\s+bottleneck|(?:confirms?|creates?|indicates?|shows?|represents?|causes?|is)\s+(?:a\s+|an\s+)?(?:operational\s+)?bottleneck|bottleneck\s+(?:risk|issue|in|across)|congest(?:ed|ion)|overloaded|overwhelmed|backlog\s+build[- ]?up|processing\s+delays?|slow\s+processing|service[- ]level\s+(?:failure|breach|miss)|sla\s+(?:failure|breach|miss)|imbalance\s+(?:risk|gap|issue)|strain(?:ed)?\s+(?:capacity|processing|operations?))\b/i;

const UNSUPPORTED_CAUSAL_VOLUME_PATTERN =
  /\b(?:high(?:er)?|elevated|large|heavy|concentrated|peak|uneven|substantial)\s+(?:case|call|ticket|queue|channel)?\s*(?:volume|load|counts?|concentration|demand)\b[^.]{0,95}\b(?:proves?|confirms?|demonstrates?|causes?|caused|drives?|leads?\s+to|results?\s+in|indicates?|shows?|means?)\b[^.]{0,95}\b(?:insufficient\s+staffing|understaff(?:ed|ing)|staffing\s+(?:shortage|deficit|gap|inadequacy)|inadequate\s+(?:staffing|staff|capacity|training)|slow\s+processing|processing\s+delays?|service[- ]level\s+(?:failure|breach|miss)|sla\s+(?:failure|breach|miss)|operational\s+bottleneck|agent\s+(?:underperformance|negligence|fatigue))\b/i;

const REVERSE_UNSUPPORTED_CAUSAL_PATTERN =
  /\b(?:insufficient\s+staffing|understaff(?:ed|ing)|staffing\s+shortages?|inadequate\s+(?:staffing|capacity)|slow\s+processing)\b[^.]{0,70}\b(?:caused|drove|led\s+to|resulted\s+in|explains?)\b|\b(?:proves?|confirms?|demonstrates?|is\s+evidence\s+(?:of|that))\b[^.]{0,65}\b(?:insufficient\s+staffing|understaff(?:ed|ing)|staffing\s+(?:shortages?|inadequacy)|slow\s+processing|agent\s+misconduct)\b|\b(?:due\s+to|caused\s+by|driven\s+by|attributable\s+to|stem(?:s|ming)?\s+from|triggered\s+by|resulting\s+from)\b[^.]{0,75}\b(?:training\s+(?:gaps?|deficits?|shortfalls?)|insufficient\s+staffing|understaff(?:ed|ing)|staffing\s+(?:shortages?|deficits?|gaps?)|inadequate\s+(?:staffing|capacity|training)|system\s+(?:outages?|defects?)|routing\s+(?:defects?|bugs?)|agent\s+(?:negligence|misconduct))\b/i;

const EXPLICIT_WEIGHT_CLAIM_PATTERN =
  /\b(?:scorecard\s+weight|weight(?:ed|ing)?\s+(?:points?|contribution|share|factor|percent(?:age)?)|carries\s+(?:a\s+)?weight)\b/i;

const EXPLICIT_DEFINITION_CLAIM_PATTERN =
  /\b(?:metric\s+definition|defined\s+(?:under|in|by)\s+(?:the\s+)?policy|calculated\s+(?:from|as|using)|calculation\s+formula)\b/i;

const EXPLICIT_POLICY_CLAIM_PATTERN =
  /\b(?:policy\s+(?:gap|definition|requirement|mandate|eligibility|exclusion|disqualification|proration|cap|tier)|scorecard\s+weight|carries\s+(?:a\s+)?weight|incentive\s+(?:tier|payout|cap|eligibility|qualification)|milestone\s+(?:eligibility|qualification|period)|defined\s+(?:by|under)\s+(?:the\s+)?policy)\b/i;

const CAUSAL_NEGATION_PREFIX =
  /\b(?:does\s+not|do\s+not|cannot|can't|never|neither|nor|without|not\s+alone|alone\s+does\s+not)\b/i;

function normalizeTextValue(val, maxLen = 1500) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

function normalizePlainStringArray(rawArr, maxLen = 400) {
  if (!Array.isArray(rawArr)) return { items: [], hasNonStringItem: false };
  const items = [];
  let hasNonStringItem = false;
  for (const entry of rawArr) {
    if (typeof entry !== 'string') {
      hasNonStringItem = true;
      continue;
    }
    const clean = entry.trim().slice(0, maxLen);
    if (clean) items.push(clean);
  }
  return { items, hasNonStringItem };
}

/**
 * Strips trailing commas before `}` or `]` outside JSON string literals without modifying strings or keys.
 */
function stripTrailingJsonCommas(text) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) {
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function tryParseJsonObjectStrict(text) {
  for (const candidate of [text, stripTrailingJsonCommas(text)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return null;
}

/**
 * Extracts a parsed JSON object from raw Hermes insight output without inventing fields.
 */
export function extractInsightJsonObject(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    throw new Error('Raw response content is empty or not a string');
  }
  const stripped = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  for (const candidateText of [rawContent, stripped]) {
    if (!candidateText) continue;
    try {
      const obj = extractJsonFromAssistantResponse(candidateText);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch {}
    const parsedDirect = tryParseJsonObjectStrict(candidateText);
    if (parsedDirect) return parsedDirect;
  }

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const fencedObjs = [];
  for (const match of stripped.matchAll(fenceRegex)) {
    const body = String(match[1] || '').trim();
    if (!body) continue;
    const parsed = tryParseJsonObjectStrict(body);
    if (parsed) fencedObjs.push(parsed);
  }
  if (fencedObjs.length > 0) {
    const preferred = fencedObjs.find(
      (o) =>
        Object.prototype.hasOwnProperty.call(o, 'findings') ||
        Object.prototype.hasOwnProperty.call(o, 'schema_version')
    );
    return preferred || fencedObjs[fencedObjs.length - 1];
  }

  const candidates = [];
  for (let start = 0; start < stripped.length; start++) {
    if (stripped[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const slice = stripped.slice(start, i + 1);
            const parsed = tryParseJsonObjectStrict(slice);
            if (parsed) candidates.push(parsed);
            start = i;
            break;
          }
        }
      }
    }
  }
  if (candidates.length > 0) {
    const preferred = candidates.find(
      (o) =>
        Object.prototype.hasOwnProperty.call(o, 'findings') ||
        Object.prototype.hasOwnProperty.call(o, 'schema_version')
    );
    return preferred || candidates[0];
  }

  throw new Error('No valid JSON object found in Hermes assistant response');
}

function resolvePolicyCitationMatches(ref, verificationCatalog) {
  const token = String(ref || '').trim();
  if (!token) return false;
  if (verificationCatalog?.supersededRuleCodes?.has(token)) return false;
  if (verificationCatalog?.allowedCanonicalRuleCodes?.has(token)) return true;
  if (verificationCatalog?.allowedDocumentCodes?.has(token)) return true;
  if (token === verificationCatalog?.policySnapshotCode) return true;
  return false;
}

/**
 * Strips ONLY explicitly verified canonical policy/document codes if referenced as
 * technical metadata in limitations/warnings — never strips metric numbers or arbitrary digits.
 */
function maskVerifiedPolicyIdentifiersOnly(text, verificationCatalog) {
  let s = String(text || '');
  for (const code of verificationCatalog?.allowedCanonicalRuleCodes || []) {
    if (code && s.includes(code)) s = s.split(code).join(' POLICY_CODE ');
  }
  for (const doc of verificationCatalog?.allowedDocumentCodes || []) {
    if (doc && s.includes(doc)) s = s.split(doc).join(' DOC_CODE ');
  }
  if (verificationCatalog?.policySnapshotCode && s.includes(verificationCatalog.policySnapshotCode)) {
    s = s.split(verificationCatalog.policySnapshotCode).join(' POLICY_SNAP ');
  }
  return s;
}

/**
 * Contract v3 strict numerical prose detector.
 * Rejects any standalone digits, %, $, counts, durations, metric targets, or spelled-out numeric claims.
 */
function inspectContractV3ProseForNumbers(labeledFragments, verificationCatalog) {
  const numericHits = [];
  const spelledHits = [];
  const approximationHits = [];
  const inlineIdHits = [];

  for (const { label, text, allowPolicyCodeTokens } of labeledFragments) {
    if (!text || typeof text !== 'string') continue;

    if (INLINE_TECHNICAL_ID_PATTERN.test(text)) {
      inlineIdHits.push(`${label}`);
    }

    const checkedText = allowPolicyCodeTokens
      ? maskVerifiedPolicyIdentifiersOnly(text, verificationCatalog)
      : text;

    if (/~\s*\$?\d/.test(checkedText) || APPROXIMATION_PATTERN.test(checkedText)) {
      approximationHits.push(`${label}`);
    }

    const digitMatches = checkedText.match(NUMERIC_TOKEN_PATTERN) || [];
    if (digitMatches.length > 0) {
      numericHits.push(`${label}: "${digitMatches.slice(0, 4).join('", "')}"`);
    }

    const spelledMatch = SPELLED_NUMBER_PROSE_PATTERN.exec(checkedText);
    if (spelledMatch) {
      spelledHits.push(`${label}: "${spelledMatch[0]}"`);
    }
  }

  return { numericHits, spelledHits, approximationHits, inlineIdHits };
}

function extractClauseMetricCodes(clause) {
  const lower = String(clause || '').toLowerCase();
  const keywordMatchers = [
    { match: /\baht\s+compliance\b/i, code: 'AHT_COMPLIANCE' },
    { match: /\b(?:average\s+handle\s+time|\baht\b)(?!\s+compliance)/i, code: 'AHT' },
    { match: /\bcrm\s+sub[-\s]?code/i, code: 'CRM_SUB_CODE_COMPLETION' },
    { match: /\bcrm\s+summary/i, code: 'CRM_SUMMARY_COMPLETION' },
    { match: /\bcrm\s+resolution/i, code: 'CRM_RESOLUTION' },
    { match: /\b(?:2-?day\s+)?(?:closed\s+)?sla\b/i, code: 'CLOSED_SLA_PERCENT' },
    { match: /\bbacklog\b/i, code: 'BACKLOG_RATE' },
    { match: /\babandon(?:ment|ed)?\s+rate\b/i, code: 'ABANDON_RATE' },
    { match: /\banswer\s+rate\b/i, code: 'ANSWER_RATE' },
    { match: /\b(?:average\s+speed\s+of\s+answer|\basa\b)/i, code: 'ASA' },
    { match: /\b(?:calls?\s+offered|offered\s+calls?)\b/i, code: 'CALLS_OFFERED' },
    { match: /\b(?:calls?\s+answered|answered\s+calls?)\b/i, code: 'CALLS_ANSWERED' },
    { match: /\b(?:calls?\s+abandoned|abandoned\s+calls?)\b/i, code: 'CALLS_ABANDONED' },
    { match: /\b(?:total\s+cases?|case\s+volume|case\s+counts?)\b/i, code: 'TOTAL_CASES' },
  ];

  const matchedCodes = new Set();
  for (const km of keywordMatchers) {
    if (km.match.test(lower)) matchedCodes.add(km.code);
  }
  return matchedCodes;
}

/**
 * Identifies specific metric codes mentioned inside a narrative clause so multi-metric
 * findings can still be validated clause-by-clause for target direction accuracy.
 */
function findClauseMatchedResolvedEvidence(clause, resolvedEvidence) {
  const matchedCodes = extractClauseMetricCodes(clause);
  if (matchedCodes.size === 0) return resolvedEvidence;
  const subset = resolvedEvidence.filter((ev) => matchedCodes.has(ev.metric_code));
  return subset.length > 0 ? subset : resolvedEvidence;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts short clean entity name stems (e.g. queue, channel, or employee name)
 * from entity_label for directional comparison verification when multiple entities are cited.
 */
function extractEntityMatchName(ev) {
  const raw = String(ev?.entity_label || '')
    .replace(/^Voice Queue:\s*/i, '')
    .replace(/^SF Channel:\s*/i, '')
    .replace(/\s*\(SiBS\s+\d+\)\s*$/i, '')
    .trim();
  return raw.length >= 3 ? raw : null;
}

/**
 * Verifies directional target claims, granularity isolation, comparison preconditions,
 * and extreme superlative accuracy against resolved immutable snapshot values.
 */
function validateFindingSemanticsAndComparisons({
  findingIdx,
  claimType,
  headline,
  observation,
  recommendation,
  citedFacts,
  resolvedEvidence,
  checks,
  errors,
}) {
  const findingProse = `${headline}. ${observation}`;
  const fullFindingProse = `${findingProse}. ${recommendation}`;

  if (citedFacts.length === 0) return;

  // 1. Strict Aggregation & Scope Boundary Separation
  const hasPeriodAggregate = citedFacts.some(
    (f) => f.granularity === 'REPORT_PERIOD' && (f.aggregation_type === 'REPORT_TOTAL' || f.aggregation_type === 'WEIGHTED_AVERAGE')
  );
  const hasIntervalStat = citedFacts.some(
    (f) =>
      f.granularity === 'BIHOURLY_EXTREME' ||
      f.granularity === 'DAILY_EXTREME' ||
      f.granularity === 'INTERVAL_AVG_ACTIVE_DAYS' ||
      f.aggregation_type === 'DAILY_AVERAGE' ||
      f.aggregation_type === 'INTERVAL_EXTREME'
  );
  const hasDriverStat = citedFacts.some((f) => f.granularity === 'DRIVER_CATEGORY');
  const hasVoiceQueue = citedFacts.some((f) => f.granularity === 'VOICE_QUEUE');
  const hasCaseChannel = citedFacts.some((f) => f.granularity === 'SF_CASE_CHANNEL');
  const hasEmployeeFact = citedFacts.some((f) => f.granularity === 'INDIVIDUAL_EMPLOYEE');

  if (hasPeriodAggregate && (hasIntervalStat || hasDriverStat)) {
    checks.granularityConsistent = false;
    errors.push(
      `Granularity violation in Finding #${findingIdx + 1}: mixes full REPORT_PERIOD aggregates with intraday/daily/driver subsets.`
    );
  }
  if (hasVoiceQueue && hasCaseChannel) {
    checks.granularityConsistent = false;
    errors.push(
      `Scope boundary violation in Finding #${findingIdx + 1}: merges Voice Call Queues (VOICE_QUEUE) with Salesforce Case Channels (SF_CASE_CHANNEL).`
    );
  }
  if (hasEmployeeFact && (hasPeriodAggregate || hasIntervalStat || hasVoiceQueue || hasCaseChannel)) {
    checks.granularityConsistent = false;
    errors.push(
      `Granularity violation in Finding #${findingIdx + 1}: mixes INDIVIDUAL_EMPLOYEE facts with period/queue/channel aggregates.`
    );
  }

  // Narrative vs granularity wording check
  if (
    hasPeriodAggregate &&
    !hasIntervalStat &&
    /\b(?:daily\s+average|average\s+per\s+day|mean\s+daily|bi-?hourly\s+(?:average|window|peak|spike))\b/i.test(findingProse)
  ) {
    checks.granularityConsistent = false;
    errors.push(
      `Granularity mismatch in Finding #${findingIdx + 1}: cites period aggregate evidence while claiming daily/bi-hourly interval behavior.`
    );
  }
  if (
    hasIntervalStat &&
    !hasPeriodAggregate &&
    /\b(?:full\s+period\s+total|monthly\s+total|annual\s+total|overall\s+period\s+aggregate)\b/i.test(findingProse)
  ) {
    checks.granularityConsistent = false;
    errors.push(
      `Granularity mismatch in Finding #${findingIdx + 1}: cites interval evidence while claiming an overall period total.`
    );
  }

  // 2. Target Attainment & Directional Contradiction Checks (polarity-aware)
  const targetedEvidence = resolvedEvidence.filter((ev) => ev.target_attainment && ev.target_attainment !== 'NO_TARGET');
  const hasTargetClaim =
    claimType === 'PERFORMANCE_VS_TARGET' ||
    TARGET_PERFORMANCE_MISS_PATTERN.test(fullFindingProse) ||
    TARGET_NUMERIC_BELOW_PATTERN.test(fullFindingProse) ||
    TARGET_PERFORMANCE_PASS_PATTERN.test(fullFindingProse) ||
    TARGET_NUMERIC_ABOVE_PATTERN.test(fullFindingProse);

  if (hasTargetClaim && targetedEvidence.length === 0) {
    checks.narrativeConsistentWithEvidence = false;
    errors.push(
      `Finding #${findingIdx + 1} makes a target attainment claim (${claimType || 'prose'}) without citing any metric that has a verified policy target.`
    );
  }

  if (targetedEvidence.length > 0) {
    const clauses = fullFindingProse
      .split(/[.!?;\n]+|\b(?:while|whereas|although|however|but)\b/i)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const clause of clauses) {
      const clauseTargetEvidence = findClauseMatchedResolvedEvidence(clause, targetedEvidence);

      if (TARGET_PERFORMANCE_MISS_PATTERN.test(clause)) {
        const anyBelow = clauseTargetEvidence.some((ev) => ev.target_attainment === 'BELOW_TARGET');
        if (!anyBelow) {
          checks.narrativeConsistentWithEvidence = false;
          errors.push(
            `Contradictory narrative in Finding #${findingIdx + 1}: claims target miss where cited metric(s) actually meet or exceed policy target.`
          );
        }
      }

      if (TARGET_NUMERIC_BELOW_PATTERN.test(clause)) {
        const supportsNumericBelow = clauseTargetEvidence.some((ev) =>
          ev.polarity === 'LOWER_IS_BETTER'
            ? ev.target_attainment === 'MEETS_OR_EXCEEDS_TARGET'
            : ev.target_attainment === 'BELOW_TARGET'
        );
        if (!supportsNumericBelow) {
          checks.narrativeConsistentWithEvidence = false;
          errors.push(
            `Contradictory narrative in Finding #${findingIdx + 1}: claims value is below target/limit where snapshot value is at or above target.`
          );
        }
      }

      if (TARGET_PERFORMANCE_PASS_PATTERN.test(clause)) {
        const anyPass = clauseTargetEvidence.some(
          (ev) => ev.target_attainment === 'MEETS_OR_EXCEEDS_TARGET' || ev.target_attainment === 'ON_TARGET'
        );
        if (!anyPass) {
          checks.narrativeConsistentWithEvidence = false;
          errors.push(
            `Contradictory narrative in Finding #${findingIdx + 1}: claims meeting or attaining target where cited metric(s) are BELOW_TARGET.`
          );
        }
      }

      if (TARGET_NUMERIC_ABOVE_PATTERN.test(clause)) {
        const supportsNumericAbove = clauseTargetEvidence.some((ev) =>
          ev.polarity === 'LOWER_IS_BETTER'
            ? ev.target_attainment === 'BELOW_TARGET'
            : ev.target_attainment === 'MEETS_OR_EXCEEDS_TARGET'
        );
        if (!supportsNumericAbove) {
          checks.narrativeConsistentWithEvidence = false;
          errors.push(
            `Contradictory narrative in Finding #${findingIdx + 1}: claims value exceeds/is above target where snapshot value is below target.`
          );
        }
      }
    }
  }

  // 3. Entity & Metric Comparison Preconditions
  const hasComparativeWording = COMPARATIVE_THAN_PATTERN.test(findingProse);
  const isEntityComparison = claimType === 'ENTITY_COMPARISON' || hasComparativeWording;

  if (isEntityComparison) {
    if (resolvedEvidence.length < 2) {
      checks.comparativeClaimsValid = false;
      errors.push(
        `Unsupported comparison in Finding #${findingIdx + 1}: comparative claim requires at least two compatible snapshot evidence references.`
      );
    } else {
      const first = resolvedEvidence[0];
      const compatibleUnits = resolvedEvidence.every((ev) => ev.unit && first.unit && ev.unit === first.unit);
      const compatibleGranularity = resolvedEvidence.every(
        (ev) => ev.granularity === first.granularity && ev.aggregation_type === first.aggregation_type
      );

      if (!compatibleUnits) {
        checks.comparativeClaimsValid = false;
        errors.push(
          `Incompatible unit comparison in Finding #${findingIdx + 1}: cannot compare different metric units (${resolvedEvidence.map((e) => e.unit).join(' vs ')}).`
        );
      }
      if (!compatibleGranularity) {
        checks.comparativeClaimsValid = false;
        checks.granularityConsistent = false;
        errors.push(
          `Incompatible aggregation comparison in Finding #${findingIdx + 1}: cannot compare ${resolvedEvidence.map((e) => `${e.granularity}/${e.aggregation_type}`).join(' vs ')}.`
        );
      }

      if (claimType === 'ENTITY_COMPARISON') {
        const comparableGroups = new Set(citedFacts.map((f) => f.comparable_group || `${f.granularity}:${f.metric_code}`));
        if (comparableGroups.size > 1) {
          checks.comparativeClaimsValid = false;
          errors.push(
            `Incompatible ENTITY_COMPARISON in Finding #${findingIdx + 1}: cited evidence spans multiple metric groups (${[...comparableGroups].join(', ')}).`
          );
        }
      }

      // Check explicit "<Entity A> ... higher/lower/worse/better than <Entity B>" direction when 2 entities match
      if (compatibleUnits && compatibleGranularity) {
        for (let i = 0; i < resolvedEvidence.length; i++) {
          for (let j = 0; j < resolvedEvidence.length; j++) {
            if (i === j) continue;
            const eA = resolvedEvidence[i];
            const eB = resolvedEvidence[j];
            const nameA = extractEntityMatchName(eA);
            const nameB = extractEntityMatchName(eB);
            if (!nameA || !nameB || nameA.toLowerCase() === nameB.toLowerCase()) continue;
            if (eA.metric_code !== eB.metric_code) continue;

            const dirRegex = new RegExp(
              `${escapeRegex(nameA)}[^.]{0,60}\\b(higher|greater|exceeds?|lower|less|fewer|better|worse)\\b[^.]{0,45}\\b(?:than\\s+)?${escapeRegex(nameB)}`,
              'i'
            );
            const m = dirRegex.exec(findingProse);
            if (!m) continue;

            const dirWord = m[1].toLowerCase();
            const vA = Number(eA.metric_value);
            const vB = Number(eB.metric_value);
            const pol = eA.polarity || 'NEUTRAL';

            let supported = true;
            if (/higher|greater|exceed/.test(dirWord)) {
              supported = vA > vB;
            } else if (/lower|less|fewer/.test(dirWord)) {
              supported = vA < vB;
            } else if (dirWord === 'better') {
              supported = pol === 'LOWER_IS_BETTER' ? vA < vB : vA > vB;
            } else if (dirWord === 'worse') {
              supported = pol === 'LOWER_IS_BETTER' ? vA > vB : vA < vB;
            }

            if (!supported) {
              checks.comparativeClaimsValid = false;
              checks.narrativeConsistentWithEvidence = false;
              errors.push(
                `Contradictory comparison in Finding #${findingIdx + 1}: claimed "${nameA}" is ${dirWord} than "${nameB}", contradicting immutable snapshot values.`
              );
            }
          }
        }
      }
    }
  }

  // 4. Extreme / Relative Standing Contradiction Guard
  if (SUPERLATIVE_EXTREME_PATTERN.test(findingProse)) {
    const hasLowestMarker = citedFacts.some(
      (f) => String(f.fact_key || '').startsWith('LOWEST_') || f.relative_standing === 'LOWEST_IN_GROUP'
    );
    const hasHighestMarker = citedFacts.some(
      (f) =>
        String(f.fact_key || '').startsWith('HIGHEST_') ||
        String(f.fact_key || '').startsWith('PEAK_') ||
        f.relative_standing === 'HIGHEST_IN_GROUP'
    );

    if (
      /\blowest\b/i.test(findingProse) &&
      hasHighestMarker &&
      !hasLowestMarker &&
      citedFacts.length === 1
    ) {
      checks.comparativeClaimsValid = false;
      checks.narrativeConsistentWithEvidence = false;
      errors.push(
        `Contradictory extreme claim in Finding #${findingIdx + 1}: called highest-extreme fact "lowest".`
      );
    }
    if (
      /\b(?:highest|peak)\b/i.test(findingProse) &&
      hasLowestMarker &&
      !hasHighestMarker &&
      citedFacts.length === 1
    ) {
      checks.comparativeClaimsValid = false;
      checks.narrativeConsistentWithEvidence = false;
      errors.push(
        `Contradictory extreme claim in Finding #${findingIdx + 1}: called lowest-extreme fact "highest/peak".`
      );
    }
  }
}

function createSemanticDiagnostic({
  findingIdx,
  code,
  metricCode = null,
  citedPolicyRule = null,
  expectedRelationship = null,
  reason,
}) {
  return {
    findingIndex: findingIdx + 1,
    code,
    metricCode: metricCode || null,
    citedPolicyRule: citedPolicyRule || null,
    expectedRelationship: expectedRelationship || null,
    reason,
  };
}

function formatSemanticDiagnosticError(diag) {
  const parts = [`Semantic validation failed in Finding #${diag.findingIndex}`];
  if (diag.metricCode) parts.push(`metric=${diag.metricCode}`);
  if (diag.citedPolicyRule) parts.push(`citedRule=${diag.citedPolicyRule}`);
  if (diag.expectedRelationship) parts.push(`expectedRelationship=${diag.expectedRelationship}`);
  parts.push(`reason=${diag.reason}`);
  return `${parts[0]} [${parts.slice(1).join(' | ')}]`;
}

/**
 * Deterministically validates that cited policy rules in a finding are active in the
 * policy snapshot, come from approved included documents, and semantically support the
 * finding's cited evidence metrics, claim type, and policy assertions.
 */
export function validateFindingPolicyRelevance({
  findingIdx = 0,
  category = '',
  claimType = null,
  headline = '',
  observation = '',
  recommendation = '',
  limitations = [],
  resolvedEvidence = [],
  policyCodesRaw = [],
  verificationCatalog = {},
}) {
  const diagnostics = [];
  const errors = [];
  const validCodes = [];
  let citationsCheckedCount = 0;

  const citedMetricSet = new Set(resolvedEvidence.map((ev) => ev.metric_code).filter(Boolean));
  const citedMetricsLabel = [...citedMetricSet].join(',') || 'NONE';
  const findingText = `${headline}. ${observation}`;
  const fullContextText = `${findingText}. ${recommendation}. ${(limitations || []).join(' ')}`;

  const ruleCatalog = verificationCatalog?.policyRuleCatalogByCode || null;
  const metricPolicyMap = verificationCatalog?.metricPolicyMap || {};
  const docApplicableMetrics = verificationCatalog?.documentApplicableMetrics || {};
  const docClaimScopes = verificationCatalog?.documentClaimScopes || {};
  const activeSnapshotDocs = verificationCatalog?.activeSnapshotDocumentCodes || new Set();
  const hasFullPolicyCatalog = Boolean(ruleCatalog && Object.keys(ruleCatalog).length > 0);

  const isDataLimitationContext =
    claimType === 'DATA_LIMITATION_EXPLANATION' ||
    category === 'DATA_QUALITY_RISK' ||
    /\b(?:cases_closed|final\s+kpi\s+score|composite\s+(?:scorecard|kpi)|closure\s+attribution|data[- ]?integrity|blocked\s+(?:metric|scorecard))\b/i.test(
      fullContextText
    );
  const discussesScorecardFormula =
    /\b(?:final\s+kpi\s+score|scorecard\s+(?:weight|formula|components?|calculation)|weighted\s+(?:scorecard|components?))\b/i.test(
      fullContextText
    );

  const pushFailure = (params) => {
    const diag = createSemanticDiagnostic({ findingIdx, ...params });
    diagnostics.push(diag);
    errors.push(formatSemanticDiagnosticError(diag));
  };

  const citedCanonicalMeta = [];
  const cleanCitedStrings = [];

  for (const codeRaw of policyCodesRaw) {
    if (typeof codeRaw !== 'string') {
      pushFailure({
        code: 'INVALID_POLICY_CODE_TYPE',
        metricCode: citedMetricsLabel,
        citedPolicyRule: String(codeRaw),
        expectedRelationship: 'STRING_POLICY_RULE_CODE',
        reason: 'Non-string policy_rule_code encountered.',
      });
      continue;
    }
    const codeText = codeRaw.trim().slice(0, 180);
    if (!codeText) continue;
    cleanCitedStrings.push(codeText);

    if (!resolvePolicyCitationMatches(codeText, verificationCatalog)) {
      pushFailure({
        code: 'POLICY_RULE_NOT_IN_ACTIVE_SNAPSHOT',
        metricCode: citedMetricsLabel,
        citedPolicyRule: codeText,
        expectedRelationship: 'ACTIVE_POLICY_SNAPSHOT_RULE',
        reason: `Policy reference "${codeText}" is missing from the active policy snapshot or is superseded.`,
      });
      continue;
    }

    if (!hasFullPolicyCatalog) {
      citationsCheckedCount++;
      validCodes.push(codeText);
      continue;
    }

    const ruleMeta = ruleCatalog[codeText] || null;
    if (ruleMeta) {
      if (activeSnapshotDocs.size > 0 && ruleMeta.documents?.length > 0) {
        const docInSnapshot = ruleMeta.documents.some((d) => activeSnapshotDocs.has(d));
        if (!docInSnapshot) {
          pushFailure({
            code: 'RULE_SOURCE_DOCUMENT_MISMATCH',
            metricCode: citedMetricsLabel,
            citedPolicyRule: codeText,
            expectedRelationship: 'INCLUDED_ACTIVE_POLICY_DOCUMENT',
            reason: `Rule "${codeText}" references document(s) [${ruleMeta.documents.join(', ')}] not included in active policy snapshot.`,
          });
          continue;
        }
      }

      const directMetricMatch = [...citedMetricSet].some((mc) => ruleMeta.applicableMetrics?.has(mc));
      let semanticallyApplicable = false;

      if (ruleMeta.explicitMetricCode && !ruleMeta.isShared) {
        if (directMetricMatch) {
          semanticallyApplicable = true;
        } else if (
          isDataLimitationContext &&
          (ruleMeta.explicitMetricCode === 'CASES_CLOSED' || ruleMeta.explicitMetricCode === 'FINAL_KPI_SCORE')
        ) {
          semanticallyApplicable = true;
        }
      } else if (ruleMeta.isShared) {
        if (ruleMeta.primarySubject === 'FINAL_KPI_SCORE') {
          semanticallyApplicable =
            directMetricMatch || (isDataLimitationContext && discussesScorecardFormula);
        } else if (ruleMeta.primarySubject === 'DATA_INTEGRITY') {
          semanticallyApplicable = isDataLimitationContext;
        } else {
          semanticallyApplicable = directMetricMatch;
        }
      } else if (directMetricMatch) {
        semanticallyApplicable = true;
      }

      if (!semanticallyApplicable) {
        const expectedRel =
          ruleMeta.role === 'METRIC_DEFINITION'
            ? `METRIC_DEFINITION_FOR_${[...citedMetricSet][0] || 'CITED_METRIC'}`
            : ruleMeta.role === 'TARGET'
              ? `PERFORMANCE_TARGET_FOR_${[...citedMetricSet][0] || 'CITED_METRIC'}`
              : `METRIC_OR_CLAIM_APPLICABILITY_FOR_${citedMetricsLabel}`;
        pushFailure({
          code: 'IRRELEVANT_POLICY_CITATION',
          metricCode: citedMetricsLabel,
          citedPolicyRule: codeText,
          expectedRelationship: expectedRel,
          reason: `Policy rule "${codeText}" (subject=${ruleMeta.primarySubject || 'GENERAL'}, role=${ruleMeta.role}) does not apply to cited metric(s) [${citedMetricsLabel}].`,
        });
        continue;
      }

      citationsCheckedCount++;
      validCodes.push(codeText);
      citedCanonicalMeta.push(ruleMeta);
      continue;
    }

    // Document-level code (e.g. FS-PMP-001, FS-PIP-001) or PolicySnapshotCode
    if (verificationCatalog?.allowedDocumentCodes?.has(codeText)) {
      const coveredMetrics = docApplicableMetrics[codeText] || new Set();
      const coveredScopes = docClaimScopes[codeText] || new Set();
      const matchesMetric = [...citedMetricSet].some((mc) => coveredMetrics.has(mc));
      const matchesCaseOrDataScope =
        codeText === 'FS-PMP-001'
          ? isDataLimitationContext || category === 'CRM_COMPLIANCE' || category === 'DATA_QUALITY_RISK'
          : isDataLimitationContext && coveredScopes.has('DATA_LIMITATION_EXPLANATION');

      if (!matchesMetric && !matchesCaseOrDataScope) {
        pushFailure({
          code: 'IRRELEVANT_POLICY_DOCUMENT_CITATION',
          metricCode: citedMetricsLabel,
          citedPolicyRule: codeText,
          expectedRelationship: `POLICY_DOCUMENT_GOVERNING_${citedMetricsLabel}`,
          reason: `Policy document "${codeText}" does not govern cited metric(s) [${citedMetricsLabel}] for this claim.`,
        });
        continue;
      }
      citationsCheckedCount++;
      validCodes.push(codeText);
      continue;
    }

    // Snapshot-level code
    citationsCheckedCount++;
    validCodes.push(codeText);
  }

  // Role-alignment & sufficient-rule checks when full catalog metadata is available
  if (hasFullPolicyCatalog && resolvedEvidence.length > 0) {
    const metricsWithTargetRules = [...citedMetricSet].filter(
      (mc) => (metricPolicyMap[mc]?.target_rules?.length || 0) > 0
    );
    const metricsWithWeightRules = [...citedMetricSet].filter(
      (mc) => (metricPolicyMap[mc]?.weight_rules?.length || 0) > 0
    );
    const metricsWithDefRules = [...citedMetricSet].filter(
      (mc) =>
        (metricPolicyMap[mc]?.definition_rules?.length || 0) > 0 ||
        (metricPolicyMap[mc]?.calculation_rules?.length || 0) > 0
    );

    // When canonical rules ARE explicitly cited on PERFORMANCE_VS_TARGET, at least one must support target evaluation
    if (
      claimType === 'PERFORMANCE_VS_TARGET' &&
      citedCanonicalMeta.length > 0 &&
      metricsWithTargetRules.length > 0
    ) {
      const hasRelevantTargetRule = citedCanonicalMeta.some(
        (m) =>
          m.compatibleRoles?.has('TARGET') &&
          metricsWithTargetRules.some((mc) => m.applicableMetrics?.has(mc))
      );
      if (!hasRelevantTargetRule) {
        pushFailure({
          code: 'TARGET_CLAIM_MISSING_TARGET_RULE',
          metricCode: metricsWithTargetRules.join(','),
          citedPolicyRule: citedCanonicalMeta.map((m) => m.ruleCode).join(', '),
          expectedRelationship: 'PERFORMANCE_TARGET',
          reason:
            'Target attainment finding cited non-target policy rule(s) without an applicable PERFORMANCE_TARGET rule.',
        });
      }
    }

    // Explicit weight claims in prose
    if (EXPLICIT_WEIGHT_CLAIM_PATTERN.test(findingText)) {
      if (metricsWithWeightRules.length === 0 && !discussesScorecardFormula) {
        pushFailure({
          code: 'WEIGHT_CLAIM_WITHOUT_WEIGHT_RULE',
          metricCode: citedMetricsLabel,
          citedPolicyRule: cleanCitedStrings.join(', ') || 'NONE',
          expectedRelationship: 'KPI_WEIGHT',
          reason: `Finding asserts scorecard weighting on metric(s) [${citedMetricsLabel}] that have no KPI_WEIGHT rule in active policy snapshot.`,
        });
      } else if (citedCanonicalMeta.length > 0) {
        const hasWeightRule = citedCanonicalMeta.some(
          (m) =>
            m.compatibleRoles?.has('WEIGHT') ||
            (m.primarySubject === 'FINAL_KPI_SCORE' && m.role === 'CALCULATION')
        );
        if (!hasWeightRule) {
          pushFailure({
            code: 'WEIGHT_CLAIM_RULE_ROLE_MISMATCH',
            metricCode: citedMetricsLabel,
            citedPolicyRule: citedCanonicalMeta.map((m) => m.ruleCode).join(', '),
            expectedRelationship: 'KPI_WEIGHT',
            reason:
              'Finding asserts scorecard weight/points while citing only non-weight policy rules.',
          });
        }
      }
    }

    // Explicit definition / formula claims in prose
    if (EXPLICIT_DEFINITION_CLAIM_PATTERN.test(findingText)) {
      if (metricsWithDefRules.length === 0 && !discussesScorecardFormula) {
        pushFailure({
          code: 'DEFINITION_CLAIM_WITHOUT_DEFINITION_RULE',
          metricCode: citedMetricsLabel,
          citedPolicyRule: cleanCitedStrings.join(', ') || 'NONE',
          expectedRelationship: 'KPI_METRIC_OR_FORMULA',
          reason: `Finding asserts a policy definition/formula for metric(s) [${citedMetricsLabel}] with no KPI_METRIC/KPI_FORMULA rule in snapshot.`,
        });
      } else if (citedCanonicalMeta.length > 0) {
        const hasDefRule = citedCanonicalMeta.some(
          (m) => m.compatibleRoles?.has('METRIC_DEFINITION') || m.compatibleRoles?.has('CALCULATION')
        );
        if (!hasDefRule) {
          pushFailure({
            code: 'DEFINITION_CLAIM_RULE_ROLE_MISMATCH',
            metricCode: citedMetricsLabel,
            citedPolicyRule: citedCanonicalMeta.map((m) => m.ruleCode).join(', '),
            expectedRelationship: 'KPI_METRIC_DEFINITION',
            reason:
              'Finding asserts a metric definition or formula while citing rules lacking KPI_METRIC/KPI_FORMULA role.',
          });
        }
      }
    }

    // Explicit policy/eligibility/incentive/weight claim without any supporting policy rule
    const hasResolvedPolicyRule = resolvedEvidence.some((ev) => Boolean(ev.policy_rule_code));
    const isExplicitPolicyClaim =
      category === 'POLICY_GAP' || EXPLICIT_POLICY_CLAIM_PATTERN.test(findingText);
    if (isExplicitPolicyClaim && cleanCitedStrings.length === 0 && !hasResolvedPolicyRule) {
      pushFailure({
        code: 'POLICY_CLAIM_WITHOUT_SUPPORTING_RULE',
        metricCode: citedMetricsLabel,
        citedPolicyRule: 'NONE',
        expectedRelationship: 'SUPPORTING_POLICY_RULE_REQUIRED',
        reason:
          'Explicit policy, eligibility, weighting, or policy-gap claim lacks supporting policy rules in both citations and evidence snapshot.',
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    diagnostics,
    validCodes,
    citationsCheckedCount,
  };
}

function hasUnnegatedBottleneckAssertion(text = '') {
  const regex = new RegExp(BOTTLENECK_ASSERTION_PATTERN.source, 'gi');
  let m;
  while ((m = regex.exec(String(text || ''))) !== null) {
    const prefix = String(text).slice(Math.max(0, m.index - 32), m.index);
    if (
      /\b(?:no|not|without|never|lack(?:ing)?(?:\s+of)?|absence\s+of)\s+(?:any\s+|an?\s+|established\s+|confirmed\s+|measurable\s+|evidence\s+of\s+)?$/i.test(
        prefix
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Validates that a finding's claim_type, severity, and causal/metric prose assertions are
 * genuinely supported by the cited evidence items in resolvedEvidence.
 */
export function validateEvidenceToClaimRelevance({
  findingIdx = 0,
  category = '',
  claimType = null,
  severity = 'INFO',
  headline = '',
  observation = '',
  resolvedEvidence = [],
}) {
  const errors = [];
  const diagnostics = [];

  if (!Array.isArray(resolvedEvidence) || resolvedEvidence.length === 0) {
    return { valid: true, errors, diagnostics };
  }

  const citedMetricSet = new Set(resolvedEvidence.map((ev) => ev.metric_code).filter(Boolean));
  const citedMetricsLabel = [...citedMetricSet].join(',') || 'NONE';
  const findingProse = `${headline}. ${observation}`;
  const pushIssue = (code, reason, expectedRelationship) => {
    const diag = createSemanticDiagnostic({
      findingIdx,
      code,
      metricCode: citedMetricsLabel,
      expectedRelationship,
      reason,
    });
    diagnostics.push(diag);
    errors.push(formatSemanticDiagnosticError(diag));
  };

  // 1. Reject uncited scorecard KPI metric attainment claims in headline/observation prose
  const proseClauses = findingProse
    .split(/[.!?;\n]+|\b(?:while|whereas|although|however|but)\b/i)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of proseClauses) {
    if (!ATTAINMENT_ASSERTION_PATTERN.test(clause)) continue;
    if (/\b(?:without|excluding|not\s+including|blocked|unavailable)\b/i.test(clause)) continue;

    for (const matcher of SCORECARD_NAMED_METRIC_MATCHERS) {
      if (matcher.match.test(clause) && !citedMetricSet.has(matcher.code)) {
        pushIssue(
          'UNCITED_METRIC_CLAIM',
          `Prose asserts attainment/performance for "${matcher.code}" (${matcher.label}) without citing ${matcher.code} in evidence_ids.`,
          `CITE_EVIDENCE_FOR_${matcher.code}`
        );
      }
    }

    // Reject clause asserting target attainment exclusively on a NO_TARGET metric even if another metric was targeted
    const clauseMetricCodes = extractClauseMetricCodes(clause);
    if (clauseMetricCodes.size > 0) {
      const clauseCitedEv = resolvedEvidence.filter((ev) => clauseMetricCodes.has(ev.metric_code));
      if (
        clauseCitedEv.length > 0 &&
        clauseCitedEv.every((ev) => !ev.target_attainment || ev.target_attainment === 'NO_TARGET')
      ) {
        pushIssue(
          'TARGET_CLAIM_ON_UNTARGETED_METRIC',
          `Clause asserts policy target attainment for un-targeted metric(s) [${clauseCitedEv.map((e) => e.metric_code).join(', ')}].`,
          'TARGET_BEARING_METRIC_EVIDENCE'
        );
      }
    }
  }

  // 2. Distinguish neutral workload/volume distribution from supported bottleneck/risk
  const allMeetTarget = resolvedEvidence.every(
    (ev) => ev.target_attainment === 'MEETS_OR_EXCEEDS_TARGET' || ev.target_attainment === 'ON_TARGET'
  );
  const isPureVolumeDistribution = resolvedEvidence.every(
    (ev) =>
      NEUTRAL_VOLUME_METRIC_CODES.has(ev.metric_code) &&
      (!ev.target_attainment || ev.target_attainment === 'NO_TARGET')
  );
  const assertsBottleneckOrFailure = hasUnnegatedBottleneckAssertion(findingProse);
  const isNegativeSeverity = severity === 'WARNING' || severity === 'CRITICAL';

  if (claimType === 'BOTTLENECK_OR_RISK') {
    if (allMeetTarget) {
      pushIssue(
        'UNSUPPORTED_BOTTLENECK_OR_RISK',
        'Claimed BOTTLENECK_OR_RISK while all cited evidence metrics meet or exceed policy targets.',
        'BELOW_TARGET_OR_RISK_EVIDENCE'
      );
    } else if (isPureVolumeDistribution && (isNegativeSeverity || assertsBottleneckOrFailure)) {
      pushIssue(
        'VOLUME_DOES_NOT_ESTABLISH_BOTTLENECK',
        `Cited metrics [${citedMetricsLabel}] reflect neutral volume distribution (NO_TARGET) without backlog, latency, abandonment, SLA, or target-miss evidence to substantiate a bottleneck or risk warning.`,
        'OBSERVED_WORKLOAD_DISTRIBUTION_OR_RISK_TELEMETRY'
      );
    }
  } else if (isPureVolumeDistribution && assertsBottleneckOrFailure) {
    pushIssue(
      'VOLUME_DOES_NOT_ESTABLISH_BOTTLENECK',
      `Volume metrics [${citedMetricsLabel}] alone cannot establish an operational bottleneck, processing delay, or SLA failure.`,
      'BACKLOG_OR_SLA_OR_LATENCY_EVIDENCE'
    );
  }

  // 3. Reject unsupported causal assertions (e.g. high volume proves understaffing / slow processing / SLA breach)
  for (const clause of findingProse.split(/[.!?;\n]+/)) {
    const cleanClause = clause.trim();
    if (!cleanClause) continue;
    const m1 = UNSUPPORTED_CAUSAL_VOLUME_PATTERN.exec(cleanClause);
    const m2 = REVERSE_UNSUPPORTED_CAUSAL_PATTERN.exec(cleanClause);
    const matched = m1 || m2;
    if (!matched) continue;
    const prefix = cleanClause.slice(Math.max(0, matched.index - 35), matched.index + 35);
    if (CAUSAL_NEGATION_PREFIX.test(prefix)) continue;

    pushIssue(
      'UNSUPPORTED_CAUSAL_CLAIM',
      `Prose makes an unsupported causal conclusion ("${matched[0].slice(0, 120)}") without direct staffing, latency, or SLA-breach proof in cited evidence.`,
      'EVIDENCE_BACKED_OBSERVATION'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    diagnostics,
  };
}

/**
 * Deterministically audits stored Contract v3 findings against current semantic policy
 * and evidence-to-claim validation rules WITHOUT modifying stored content or calling Hermes.
 */
export function auditInsightFindingsSemantics({ insightJson, verificationCatalog = {} }) {
  const findings = Array.isArray(insightJson?.findings) ? insightJson.findings : [];
  const findingReviews = [];
  let flaggedFindingsCount = 0;

  for (let idx = 0; idx < findings.length; idx++) {
    const f = findings[idx] || {};
    const resolvedEvidence = Array.isArray(f.resolved_evidence)
      ? f.resolved_evidence
      : Array.isArray(f.evidence)
        ? f.evidence
        : [];
    const policyCodesRaw = Array.isArray(f.policy_rule_codes) ? f.policy_rule_codes : [];
    const category = String(f.category || '').trim().toUpperCase();
    const severity = String(f.severity || 'INFO').trim().toUpperCase();
    const claimType = f.claim_type ? String(f.claim_type).trim().toUpperCase() : null;
    const headline = normalizeTextValue(f.headline, 240);
    const observation = normalizeTextValue(f.observation || f.explanation, 2000);
    const recommendation = normalizeTextValue(f.recommendation, 1200);
    const limitations = Array.isArray(f.limitations) ? f.limitations : [];

    const semChecks = {
      granularityConsistent: true,
      comparativeClaimsValid: true,
      narrativeConsistentWithEvidence: true,
    };
    const semErrors = [];
    if (resolvedEvidence.length > 0) {
      validateFindingSemanticsAndComparisons({
        findingIdx: idx,
        claimType,
        headline,
        observation,
        recommendation,
        citedFacts: resolvedEvidence,
        resolvedEvidence,
        checks: semChecks,
        errors: semErrors,
      });
    }

    const polRes = validateFindingPolicyRelevance({
      findingIdx: idx,
      category,
      claimType,
      headline,
      observation,
      recommendation,
      limitations,
      resolvedEvidence,
      policyCodesRaw,
      verificationCatalog,
    });

    const evClaimRes = validateEvidenceToClaimRelevance({
      findingIdx: idx,
      category,
      claimType,
      severity,
      headline,
      observation,
      resolvedEvidence,
    });

    const issues = [
      ...polRes.diagnostics,
      ...evClaimRes.diagnostics,
      ...semErrors.map((err) =>
        createSemanticDiagnostic({
          findingIdx: idx,
          code: 'SEMANTIC_CONSISTENCY_MISMATCH',
          metricCode: [...new Set(resolvedEvidence.map((e) => e.metric_code).filter(Boolean))].join(','),
          expectedRelationship: 'EVIDENCE_CONSISTENT_CLAIM',
          reason: err,
        })
      ),
    ];

    const isFlagged = issues.length > 0;
    if (isFlagged) flaggedFindingsCount++;

    findingReviews.push({
      findingIndex: idx + 1,
      status: isFlagged ? 'FLAGGED' : 'VERIFIED',
      isSemanticallyVerified: !isFlagged,
      issues,
    });
  }

  return {
    findingReviews,
    flaggedFindingsCount,
    passedFindingsCount: Math.max(0, findings.length - flaggedFindingsCount),
    totalFindingsCount: findings.length,
    hasFlaggedFindings: flaggedFindingsCount > 0,
  };
}

/**
 * Validates raw Hermes completion text (Contract v3) against strict qualitative schema,
 * Evidence Resolver verification against the immutable DB snapshot, granularity/aggregation
 * separation, comparative & directional accuracy, policy citations, privacy, and safety rules.
 */
export function validateHermesInsightResponse(rawContent, context, options = {}) {
  const errors = [];
  const warnings = [];
  const checks = {
    jsonParsed: false,
    securityScanPassed: true,
    schemaValid: false,
    schemaVersionMatched: false,
    snapshotIdentityMatched: false,
    evidenceIdsVerified: true,
    evidenceScopeMatched: true,
    metricCodesValid: true,
    evidenceNumbersVerified: true,
    evidenceResolvedFromSnapshot: true,
    granularityConsistent: true,
    policyCitationsVerified: true,
    proseFreeOfNumbers: true,
    proseNumbersGrounded: true,
    noApproximations: true,
    noUnsupportedTrends: true,
    comparativeClaimsValid: true,
    narrativeConsistentWithEvidence: true,
    safetyGuardrailsPassed: true,
    privacyScopePreserved: true,
  };

  if (typeof rawContent === 'string' && DANGEROUS_CONTENT_PATTERN.test(rawContent)) {
    checks.securityScanPassed = false;
    errors.push('Response rejected: potentially executable script/SQL content detected.');
  }

  let parsed = null;
  if (rawContent && typeof rawContent === 'object' && !Array.isArray(rawContent)) {
    parsed = rawContent;
    checks.jsonParsed = true;
  } else {
    try {
      parsed = extractInsightJsonObject(String(rawContent || ''));
      checks.jsonParsed = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    } catch (err) {
      errors.push(`Invalid JSON from Hermes: ${err.message}`);
    }
  }

  if (!checks.jsonParsed || !parsed) {
    return {
      isValid: false,
      validationStatus: 'REJECTED',
      sanitizedInsight: null,
      errors,
      warnings,
      checks,
      evidenceCheckedCount: 0,
      policyCitationsVerifiedCount: 0,
    };
  }

  const serializedCheck = JSON.stringify(parsed);
  if (DANGEROUS_CONTENT_PATTERN.test(serializedCheck)) {
    checks.securityScanPassed = false;
    errors.push('Parsed insight JSON contains unsafe executable syntax.');
  }

  // Unexpected top-level key drift check (e.g. substituting "issues")
  const unknownTopKeys = Object.keys(parsed).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unknownTopKeys.length > 0) {
    errors.push(`Unexpected top-level JSON key(s): ${unknownTopKeys.join(', ')}.`);
  }

  // Contract v3 schema version
  const schemaVer = String(parsed.schema_version ?? '').trim();
  if (schemaVer === '3' || schemaVer === '3.0') {
    checks.schemaVersionMatched = true;
  } else {
    errors.push(`Invalid or missing schema_version "${parsed.schema_version}". Expected "3".`);
  }

  // Snapshot identity: allow omission (bound deterministically by PMS), reject on mismatch
  const hasSnapIdField =
    parsed.report_snapshot_id !== undefined && parsed.report_snapshot_id !== null && parsed.report_snapshot_id !== '';
  const hasReportTypeField =
    parsed.report_type !== undefined && parsed.report_type !== null && String(parsed.report_type).trim() !== '';

  const snapId = hasSnapIdField ? Number(parsed.report_snapshot_id) : Number(context.reportSnapshotId);
  const reportType = hasReportTypeField
    ? String(parsed.report_type).trim().toUpperCase()
    : String(context.reportType).trim().toUpperCase();

  if (snapId !== Number(context.reportSnapshotId)) {
    errors.push(
      `Snapshot mismatch: Hermes returned report_snapshot_id=${parsed.report_snapshot_id}, expected ${context.reportSnapshotId}.`
    );
  } else if (reportType !== String(context.reportType).toUpperCase()) {
    errors.push(
      `Report type mismatch: Hermes returned report_type="${parsed.report_type}", expected "${context.reportType}".`
    );
  } else {
    checks.snapshotIdentityMatched = true;
  }

  const status = String(parsed.status || 'COMPLETED').trim().toUpperCase();
  if (status !== 'COMPLETED') {
    errors.push(`Unexpected Hermes insight status "${status}". Expected "COMPLETED".`);
  }

  const rawExecSummary =
    parsed.executive_summary !== undefined && parsed.executive_summary !== null
      ? normalizeTextValue(parsed.executive_summary, 2000)
      : '';
  const execSummaryProvided = parsed.executive_summary !== undefined && parsed.executive_summary !== null;
  if (execSummaryProvided && rawExecSummary.length < 15) {
    errors.push('Provided executive_summary is trivially short.');
  }

  const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : null;
  const hasDqArray = Array.isArray(parsed.data_quality_warnings);
  const hasOverallLimArray = Array.isArray(parsed.overall_limitations);
  if (!hasDqArray) {
    errors.push('Missing required top-level array "data_quality_warnings".');
  }
  if (!hasOverallLimArray) {
    errors.push('Missing required top-level array "overall_limitations".');
  }

  const dqRes = normalizePlainStringArray(parsed.data_quality_warnings, 400);
  const limRes = normalizePlainStringArray(parsed.overall_limitations, 400);
  if (dqRes.hasNonStringItem) {
    errors.push('data_quality_warnings must contain plain strings only.');
  }
  if (limRes.hasNonStringItem) {
    errors.push('overall_limitations must contain plain strings only.');
  }
  const dqWarnings = dqRes.items;
  const overallLimitations = limRes.items;

  if (!findingsRaw) {
    errors.push('Insight response must provide a "findings" array.');
  } else if (findingsRaw.length > CONTRACT_V3_SCHEMA.maxFindings) {
    errors.push(
      `Too many findings (${findingsRaw.length}); maximum allowed under Contract v3 is ${CONTRACT_V3_SCHEMA.maxFindings}.`
    );
  } else if (
    findingsRaw.length === 0 &&
    overallLimitations.length === 0 &&
    dqWarnings.length === 0
  ) {
    errors.push(
      'Empty findings array must be accompanied by explicit overall_limitations or data_quality_warnings.'
    );
  }

  const factCatalogById = context.factCatalogById || {};
  const allowInMemoryFallback =
    options.allowInMemoryCatalogFallback !== undefined
      ? Boolean(options.allowInMemoryCatalogFallback)
      : !context.snapshotBundle;

  const normalizedFindings = [];
  let evidenceCheckedCount = 0;
  let policyCitationsVerifiedCount = 0;
  const policyRelevanceDiagnostics = [];
  const evidenceClaimDiagnostics = [];
  const labeledProseFragments = [];
  let allFindingsSchemaValid = true;

  if (execSummaryProvided && rawExecSummary) {
    labeledProseFragments.push({
      label: 'executive_summary',
      text: rawExecSummary,
      allowPolicyCodeTokens: false,
    });
  }

  if (Array.isArray(findingsRaw)) {
    for (let idx = 0; idx < findingsRaw.length; idx++) {
      const f = findingsRaw[idx];
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} is not a JSON object.`);
        continue;
      }

      const unknownFindingKeys = Object.keys(f).filter((k) => !ALLOWED_FINDING_KEYS.has(k));
      if (unknownFindingKeys.length > 0) {
        allFindingsSchemaValid = false;
        errors.push(
          `Finding #${idx + 1} contains unexpected key(s): ${unknownFindingKeys.join(', ')}.`
        );
      }

      const category = String(f.category || '').trim().toUpperCase();
      const severity = String(f.severity || '').trim().toUpperCase();
      const rawClaimType =
        f.claim_type !== undefined && f.claim_type !== null && String(f.claim_type).trim() !== ''
          ? String(f.claim_type).trim().toUpperCase()
          : null;
      const headline = normalizeTextValue(f.headline, 240);
      const observation = normalizeTextValue(f.observation, 2000);
      const recommendation = normalizeTextValue(f.recommendation, 1200);
      const evidenceIdsRaw = Array.isArray(f.evidence_ids) ? f.evidence_ids : null;
      const hasPolicyRuleArray = Array.isArray(f.policy_rule_codes);
      const policyCodesRaw = hasPolicyRuleArray ? f.policy_rule_codes : [];
      const hasFindingLimitationsArray = Array.isArray(f.limitations);
      const fLimRes = normalizePlainStringArray(f.limitations, 400);
      if (!hasPolicyRuleArray) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} is missing required "policy_rule_codes" array.`);
      }
      if (!hasFindingLimitationsArray) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} is missing required "limitations" array.`);
      }
      if (fLimRes.hasNonStringItem) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} limitations must contain plain strings only.`);
      }

      if (!ALLOWED_FINDING_CATEGORIES.has(category)) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} uses invalid or missing category "${f.category}".`);
      }
      if (!ALLOWED_SEVERITIES.has(severity)) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} uses invalid or missing severity "${f.severity}".`);
      }
      if (rawClaimType && !ALLOWED_CLAIM_TYPES.has(rawClaimType)) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} uses invalid claim_type "${f.claim_type}".`);
      }
      if (!headline || headline.length < 4) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} is missing a valid headline.`);
      }
      if (!observation || observation.length < 10) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} is missing mandatory non-empty "observation".`);
      }
      if (!recommendation || recommendation.length < 10) {
        allFindingsSchemaValid = false;
        errors.push(`Finding #${idx + 1} is missing mandatory non-empty "recommendation".`);
      }
      if (!evidenceIdsRaw || evidenceIdsRaw.length === 0) {
        allFindingsSchemaValid = false;
        checks.evidenceIdsVerified = false;
        errors.push(`Finding #${idx + 1} ("${headline}") must cite at least one verified evidence_id.`);
      }

      labeledProseFragments.push(
        { label: `finding[${idx}].headline`, text: headline, allowPolicyCodeTokens: false },
        { label: `finding[${idx}].observation`, text: observation, allowPolicyCodeTokens: false },
        { label: `finding[${idx}].recommendation`, text: recommendation, allowPolicyCodeTokens: false }
      );
      fLimRes.items.forEach((lim, lIdx) => {
        labeledProseFragments.push({
          label: `finding[${idx}].limitations[${lIdx}]`,
          text: lim,
          allowPolicyCodeTokens: true,
        });
      });

      const verifiedEvidenceIds = [];
      const citedFacts = [];

      if (evidenceIdsRaw) {
        const seenIds = new Set();
        for (const rawId of evidenceIdsRaw) {
          if (typeof rawId !== 'string') {
            checks.evidenceIdsVerified = false;
            errors.push(`Finding #${idx + 1} contains non-string evidence_id.`);
            continue;
          }
          const evId = rawId.trim();
          if (!evId) {
            checks.evidenceIdsVerified = false;
            errors.push(`Finding #${idx + 1} contains an empty evidence_id.`);
            continue;
          }
          if (seenIds.has(evId)) continue;
          seenIds.add(evId);
          evidenceCheckedCount++;

          if (!Object.prototype.hasOwnProperty.call(factCatalogById, evId)) {
            checks.evidenceIdsVerified = false;
            checks.evidenceNumbersVerified = false;
            errors.push(
              `Finding #${idx + 1} cites unsupported or unknown evidence_id "${evId}".`
            );
            continue;
          }

          const fact = factCatalogById[evId];
          if (
            Number(fact.report_snapshot_id) !== Number(context.reportSnapshotId) ||
            String(fact.report_type).toUpperCase() !== String(context.reportType).toUpperCase() ||
            String(fact.reporting_period).toLowerCase() !== String(context.reportingPeriod).toLowerCase() ||
            String(fact.scope_filter) !== String(context.scopeFilter)
          ) {
            checks.evidenceScopeMatched = false;
            errors.push(
              `Finding #${idx + 1} cites evidence_id "${evId}" outside snapshot/period/scope boundary.`
            );
            continue;
          }

          if (
            fact.employee_sibs_id &&
            !context.authorizedEmployeeIds?.has(String(fact.employee_sibs_id))
          ) {
            checks.privacyScopePreserved = false;
            checks.evidenceScopeMatched = false;
            errors.push(
              `Finding #${idx + 1} cites unauthorized employee evidence "${evId}".`
            );
            continue;
          }

          if (!ALLOWED_METRIC_CODE_SET.has(fact.metric_code) || !context.verificationCatalog?.allowedMetricCodes?.has(fact.metric_code)) {
            checks.metricCodesValid = false;
            errors.push(`Finding #${idx + 1} resolves to unallowlisted metric "${fact.metric_code}".`);
            continue;
          }

          citedFacts.push(fact);
          verifiedEvidenceIds.push(evId);
        }
      }

      // Resolve authoritative values strictly via PMS Evidence Resolver
      const resolutionResult =
        verifiedEvidenceIds.length > 0
          ? resolveEvidenceIdsWithBundle({
              evidenceIds: verifiedEvidenceIds,
              context,
              snapshotBundle: context.snapshotBundle || null,
              allowInMemoryCatalogFallback: allowInMemoryFallback,
            })
          : { resolved: [], errors: [] };

      if (resolutionResult.errors.length > 0) {
        checks.evidenceResolvedFromSnapshot = false;
        checks.evidenceNumbersVerified = false;
        resolutionResult.errors.forEach((e) => errors.push(`Finding #${idx + 1}: ${e}`));
      }

      const resolvedEvidence = resolutionResult.resolved || [];

      validateFindingSemanticsAndComparisons({
        findingIdx: idx,
        claimType: rawClaimType,
        headline,
        observation,
        recommendation,
        citedFacts,
        resolvedEvidence,
        checks,
        errors,
      });

      const evClaimRes = validateEvidenceToClaimRelevance({
        findingIdx: idx,
        category,
        claimType: rawClaimType,
        severity,
        headline,
        observation,
        resolvedEvidence,
      });
      if (!evClaimRes.valid) {
        checks.narrativeConsistentWithEvidence = false;
        errors.push(...evClaimRes.errors);
        evidenceClaimDiagnostics.push(...evClaimRes.diagnostics);
      }

      const policyRelRes = validateFindingPolicyRelevance({
        findingIdx: idx,
        category,
        claimType: rawClaimType,
        headline,
        observation,
        recommendation,
        limitations: fLimRes.items,
        resolvedEvidence,
        policyCodesRaw,
        verificationCatalog: context.verificationCatalog,
      });
      if (!policyRelRes.valid) {
        checks.policyCitationsVerified = false;
        errors.push(...policyRelRes.errors);
        policyRelevanceDiagnostics.push(...policyRelRes.diagnostics);
      }
      policyCitationsVerifiedCount += policyRelRes.citationsCheckedCount;
      const normalizedPolicyCodes = policyRelRes.validCodes;

      // Enrich policy references resolved deterministically from snapshot rules without dropping explicit valid citations
      const mergedPolicyRefs = [...normalizedPolicyCodes];
      for (const ev of resolvedEvidence) {
        if (
          ev.policy_rule_code &&
          resolvePolicyCitationMatches(ev.policy_rule_code, context.verificationCatalog) &&
          !mergedPolicyRefs.includes(ev.policy_rule_code)
        ) {
          mergedPolicyRefs.push(ev.policy_rule_code);
        }
      }

      normalizedFindings.push({
        category: ALLOWED_FINDING_CATEGORIES.has(category) ? category : null,
        severity: ALLOWED_SEVERITIES.has(severity) ? severity : null,
        claim_type: rawClaimType && ALLOWED_CLAIM_TYPES.has(rawClaimType) ? rawClaimType : null,
        headline: headline || null,
        observation: observation || null,
        explanation: observation || null,
        evidence_ids: verifiedEvidenceIds,
        resolved_evidence: resolvedEvidence,
        evidence: resolvedEvidence.map((ev) => ({
          evidence_id: ev.evidence_id,
          metric_code: ev.metric_code,
          metric_label: ev.metric_label,
          metric_value: ev.metric_value,
          formatted_value: ev.formatted_value,
          unit: ev.unit,
          target_value: ev.target_value,
          formatted_target: ev.formatted_target,
          target_unit: ev.target_unit,
          target_attainment: ev.target_attainment,
          weight_percent: ev.weight_percent,
          snapshot_reference: ev.snapshot_reference,
          granularity: ev.granularity,
          aggregation_type: ev.aggregation_type,
          entity_label: ev.entity_label,
          policy_rule_code: ev.policy_rule_code,
          supporting_document_codes: ev.supporting_document_codes,
          source_status: ev.source_status,
        })),
        policy_rule_codes: normalizedPolicyCodes,
        policy_references: mergedPolicyRefs,
        recommendation: recommendation || null,
        limitations: fLimRes.items,
      });
    }
  }

  checks.schemaValid =
    checks.jsonParsed &&
    checks.schemaVersionMatched &&
    checks.snapshotIdentityMatched &&
    status === CONTRACT_V3_SCHEMA.statusValue &&
    (!execSummaryProvided || rawExecSummary.length >= 15) &&
    Array.isArray(findingsRaw) &&
    findingsRaw.length <= CONTRACT_V3_SCHEMA.maxFindings &&
    hasDqArray &&
    hasOverallLimArray &&
    unknownTopKeys.length === 0 &&
    !dqRes.hasNonStringItem &&
    !limRes.hasNonStringItem &&
    allFindingsSchemaValid &&
    normalizedFindings.length === findingsRaw.length;

  dqWarnings.forEach((w, i) =>
    labeledProseFragments.push({
      label: `data_quality_warnings[${i}]`,
      text: w,
      allowPolicyCodeTokens: true,
    })
  );
  overallLimitations.forEach((l, i) =>
    labeledProseFragments.push({
      label: `overall_limitations[${i}]`,
      text: l,
      allowPolicyCodeTokens: true,
    })
  );

  const combinedText = labeledProseFragments.map((f) => f.text).join(' \n ');

  // Privacy scope check for single-employee view
  if (context.isSingleEmployeeScope && context.forbiddenEmployeeTokens?.size > 0) {
    const lowerCombined = combinedText.toLowerCase();
    for (const forbiddenToken of context.forbiddenEmployeeTokens) {
      if (!forbiddenToken) continue;
      if (/^\d+$/.test(forbiddenToken)) {
        if (new RegExp(`\\b${forbiddenToken}\\b`).test(combinedText)) {
          checks.privacyScopePreserved = false;
          errors.push(
            `Cross-employee leak detected: unauthorized employee ID "${forbiddenToken}" appeared in single-employee insight.`
          );
        }
      } else if (forbiddenToken.length >= 5 && lowerCombined.includes(forbiddenToken)) {
        checks.privacyScopePreserved = false;
        errors.push(
          `Cross-employee leak detected: unauthorized teammate name appeared in single-employee insight.`
        );
      }
    }
  }

  // Final KPI Score prose fabrication guard when FINAL_KPI_SCORE is BLOCKED
  if (context.isFinalScoreBlocked) {
    const claimedScoreRegex = /final\s+kpi\s+score\s*(?:is|of|=|:|achieved|scored|reached)\s*(?:\d|passing|satisfactory|complete)/gi;
    if (claimedScoreRegex.test(combinedText)) {
      checks.safetyGuardrailsPassed = false;
      errors.push('Fabricated Final KPI Score claim detected while score is BLOCKED.');
    }
  }

  // Prohibited HR / PIP / payroll automation or misconduct claims (clause-scoped with explicit negation awareness)
  for (const clause of combinedText.split(/[.!?;\n]+/)) {
    const cleanClause = clause.trim();
    if (!cleanClause) continue;
    for (const pat of PROHIBITED_HR_ACTION_PATTERNS) {
      const m = pat.exec(cleanClause);
      if (!m) continue;
      const prefixWindow = cleanClause.slice(Math.max(0, m.index - 40), m.index);
      if (HR_ACTION_NEGATION_REGEX.test(prefixWindow)) continue;
      checks.safetyGuardrailsPassed = false;
      errors.push(
        `Prohibited automated HR/disciplinary/payroll directive detected matching /${pat.source}/.`
      );
      break;
    }
  }

  // BLOCKED / NO_DATA conflated with 0/fail (ignoring explicit safety disclaimers like "never zero productivity")
  const zeroFailNegationRegex =
    /\b(?:never|not|nor|neither|cannot|can't|must\s+not|should\s+not|does\s+not|do\s+not|don't|doesn't)\b/i;
  for (const clause of combinedText.split(/[.!?;\n]+/)) {
    const cleanClause = clause.trim();
    if (!cleanClause) continue;
    let conflationFound = false;
    for (const pat of ZERO_OR_FAILED_ON_MISSING_PATTERNS) {
      const m = pat.exec(cleanClause);
      if (m) {
        const beforeZeroIdx = m[0].search(/\b(?:0|zero|failing|failed|underperform)\b/i);
        const contextWindow =
          beforeZeroIdx >= 0 ? m[0].slice(Math.max(0, beforeZeroIdx - 45), beforeZeroIdx) : m[0];
        if (!zeroFailNegationRegex.test(contextWindow)) {
          conflationFound = true;
          break;
        }
      }
    }
    if (conflationFound) {
      checks.safetyGuardrailsPassed = false;
      errors.push(
        'Prohibited conflation of BLOCKED/NO_DATA with zero or failing performance detected.'
      );
      break;
    }
  }

  // Unsupported cross-period trend / forecast rejection
  if (!context.hasComparableHistoricalPeriods) {
    for (const pat of FABRICATED_TREND_PATTERNS) {
      if (pat.test(combinedText)) {
        checks.noUnsupportedTrends = false;
        errors.push(
          `Unsupported cross-period comparison or future forecast detected matching /${pat.source}/.`
        );
      }
    }
  }

  // Strict Contract v3 numerical prose ban
  const numInspection = inspectContractV3ProseForNumbers(
    labeledProseFragments,
    context.verificationCatalog
  );
  if (numInspection.approximationHits.length > 0) {
    checks.noApproximations = false;
    checks.proseFreeOfNumbers = false;
    checks.proseNumbersGrounded = false;
    errors.push(
      `Approximate numeric phrasing is prohibited under Contract v3 (in ${numInspection.approximationHits.join(', ')}).`
    );
  }
  if (numInspection.numericHits.length > 0) {
    checks.proseFreeOfNumbers = false;
    checks.proseNumbersGrounded = false;
    errors.push(
      `Contract v3 prohibits numbers/digits in qualitative narrative (${numInspection.numericHits.slice(0, 5).join('; ')}); remove numbers and cite verified evidence_ids instead.`
    );
  }
  if (numInspection.spelledHits.length > 0) {
    checks.proseFreeOfNumbers = false;
    checks.proseNumbersGrounded = false;
    errors.push(
      `Contract v3 prohibits spelled-out numeric quantities in qualitative narrative (${numInspection.spelledHits.slice(0, 4).join('; ')}); rewrite qualitatively.`
    );
  }
  if (numInspection.inlineIdHits.length > 0) {
    checks.proseFreeOfNumbers = false;
    checks.proseNumbersGrounded = false;
    errors.push(
      `Inline technical IDs (SNAP:/LIM:) must appear only in structured arrays, not prose (${numInspection.inlineIdHits.join(', ')}).`
    );
  }

  let validationStatus = 'VALIDATED';
  if (errors.length > 0) {
    validationStatus = 'REJECTED';
  } else if (warnings.length > 0) {
    validationStatus = 'NEEDS_REVIEW';
  }

  const sanitizedInsight =
    validationStatus === 'REJECTED' &&
    (!checks.snapshotIdentityMatched || !checks.privacyScopePreserved)
      ? null
      : {
          schema_version: '3',
          report_snapshot_id: snapId,
          report_type: reportType,
          reporting_period: context.reportingPeriod,
          scope_filter: context.scopeFilter,
          policy_rule_snapshot_id: context.policyRuleSnapshotId,
          policy_snapshot_code: context.policySnapshotCode,
          status: 'COMPLETED',
          has_trustworthy_findings: normalizedFindings.length > 0,
          executive_summary: rawExecSummary || null,
          findings: normalizedFindings,
          data_quality_warnings: dqWarnings,
          overall_limitations: overallLimitations,
        };

  return {
    isValid: validationStatus === 'VALIDATED',
    validationStatus,
    sanitizedInsight,
    errors,
    warnings,
    checks,
    evidenceCheckedCount,
    policyCitationsVerifiedCount,
    policyRelevanceDiagnostics,
    evidenceClaimDiagnostics,
    semanticDiagnostics: [...policyRelevanceDiagnostics, ...evidenceClaimDiagnostics],
  };
}

/**
 * Async convenience validator that ensures the immutable DB snapshot bundle is loaded
 * from MySQL before running Contract v3 validation + authoritative Evidence Resolution.
 */
export async function validateAndResolveInsightResponse(rawContent, context, options = {}) {
  let effectiveContext = context;
  if (!context?.snapshotBundle?.loadedFromImmutableSnapshot && context?.reportSnapshotId) {
    const { loadImmutableSnapshotBundle } = await import('./frontStepsAiInsightEvidenceResolver.js');
    const bundle = await loadImmutableSnapshotBundle({
      reportSnapshotId: context.reportSnapshotId,
      reportType: context.reportType,
      reportingPeriod: context.reportingPeriod,
      scopeFilter: context.scopeFilter,
    });
    effectiveContext = { ...context, snapshotBundle: bundle };
  }
  return validateHermesInsightResponse(rawContent, effectiveContext, {
    ...options,
    allowInMemoryCatalogFallback: false,
  });
}
