/**
 * FrontSteps AI Rule Candidate Validator
 * 
 * Validates, sanitizes, and normalizes structured policy rule candidates returned by Hermes.
 * Enforces strict allowlists for rule types, formula operations, and condition operators.
 * Cross-references source citations against actual page text.
 * 
 * Strict Security: Rejects any executable code, JavaScript, SQL, or shell constructs.
 */

const ALLOWED_RULE_TYPES = new Set([
  'KPI_METRIC',
  'KPI_FORMULA',
  'KPI_WEIGHT',
  'PERFORMANCE_TARGET',
  'ELIGIBILITY',
  'EXCLUSION',
  'INCENTIVE_THRESHOLD',
  'INCENTIVE_CAP',
  'CLASSIFICATION',
  'PMP_PIP_CONDITION',
  'NEW_HIRE_EXCEPTION',
  'ATTENDANCE_CONDITION',
  'QA_POLICY',
  'UNRESOLVED',
]);

const ALLOWED_FORMULA_OPERATIONS = new Set([
  'MIN',
  'MAX',
  'RATIO',
  'PRODUCT',
  'SUM',
  'THRESHOLD_STEP',
  'IF_ELSE',
  'CONSTANT',
  'NONE',
]);

const ALLOWED_OPERATORS = new Set([
  '>=',
  '<=',
  '==',
  '!=',
  '>',
  '<',
  'IN',
  'NOT_IN',
]);

// Security pattern to detect executable code injections
const DANGEROUS_CODE_PATTERN = /(?:eval\s*\(|function\s*\(|=>|<script|SELECT\s+.*FROM|DROP\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|UNION\s+SELECT|process\.env|require\s*\(|child_process|exec\s*\()/i;

/**
 * Sanitizes Hermes assistant output by neutralizing accidental Python string concatenations
 * or method chaining (e.g. `+ str(...)`, `.replace(...)`) emitted within JSON strings.
 */
function sanitizeHermesJson(raw) {
  const lines = raw.split('\n');
  const cleanedLines = lines.map((line) => {
    const closingDelimMatch = line.match(/([\]}],?)\s*$/);
    const suffix = closingDelimMatch ? closingDelimMatch[1] : (line.trimEnd().endsWith(',') ? ',' : '');

    let l = line;
    // If a string literal is followed by Python + or * operators
    if (/(")\s*[*+]/.test(l)) {
      l = l.replace(/(")\s*[*+].*$/, '$1' + suffix);
    }
    // If a string ends with Python method chaining like .replace(...)
    if (/(")\.[a-zA-Z_]\w*\(/.test(l)) {
      l = l.replace(/(")\.[a-zA-Z_]\w*\(.*$/, '$1' + suffix);
    }
    return l;
  });

  return cleanedLines.join('\n');
}

/**
 * Finds the first balanced top-level JSON object { ... } in the text.
 */
function findBalancedJsonObject(text) {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
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
          return text.substring(firstBrace, i + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Extracts and parses JSON from raw assistant content.
 * Handles code fences (```json ... ```), trailing commentary, and Python syntax artifacts.
 */
export function extractJsonFromAssistantResponse(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') {
    throw new Error('Raw response content is empty or not a string');
  }

  const trimmed = rawContent.trim();

  // 1. Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {}

  // 2. Try extracting from ```json ... ``` code blocks
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
    try {
      return JSON.parse(sanitizeHermesJson(fenceMatch[1].trim()));
    } catch {}
  }

  // 3. Try finding balanced JSON object { ... }
  const balanced = findBalancedJsonObject(trimmed);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {}
    try {
      return JSON.parse(sanitizeHermesJson(balanced));
    } catch {}
  }

  // 4. Try finding outer JSON object brackets { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidateJson = trimmed.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidateJson);
    } catch {}
    try {
      return JSON.parse(sanitizeHermesJson(candidateJson));
    } catch {}
  }

  // 5. Fallback: If JSON was cut off mid-stream, attempt structural recovery
  if (firstBrace !== -1) {
    let candidate = trimmed.substring(firstBrace);
    const lastObjEnd = Math.max(candidate.lastIndexOf('},\n'), candidate.lastIndexOf('},'), candidate.lastIndexOf('}\n'));
    if (lastObjEnd > 100) {
      const repaired = candidate.substring(0, lastObjEnd + 1) + '\n  ],\n  "issues": []\n}';
      try {
        return JSON.parse(repaired);
      } catch {}
      try {
        return JSON.parse(sanitizeHermesJson(repaired));
      } catch {}
    }
  }

  throw new Error('No valid JSON object found in Hermes assistant response');
}

/**
 * Normalizes text for fuzzy containment matching.
 */
function normalizeTextForComparison(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validates a single rule candidate against schema, allowlists, and actual page text.
 */
export function validateSingleRuleCandidate(rule, { pages = [], documentCode = '', revisionNumber = '000', versionId = null }) {
  const issues = [];
  let validationStatus = 'VALID';

  // 1. Validate rule_key
  const rawKey = String(rule.rule_key || '').trim();
  const ruleKey = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 100);
  if (!ruleKey) {
    issues.push({
      issueType: 'MISSING_RULE_KEY',
      severity: 'ERROR',
      details: 'Rule is missing a valid rule_key identifier',
    });
    validationStatus = 'INVALID';
  }

  // 2. Validate rule_type
  let ruleType = String(rule.rule_type || 'UNRESOLVED').toUpperCase();
  if (!ALLOWED_RULE_TYPES.has(ruleType)) {
    issues.push({
      issueType: 'UNSUPPORTED_RULE_TYPE',
      severity: 'WARNING',
      details: `Rule type "${ruleType}" is not in allowlist. Defaulted to UNRESOLVED.`,
    });
    ruleType = 'UNRESOLVED';
    validationStatus = 'FLAGGED';
  }

  // 3. Security check on description and formula
  const description = String(rule.description || '').trim();
  if (DANGEROUS_CODE_PATTERN.test(description)) {
    issues.push({
      issueType: 'SECURITY_VIOLATION',
      severity: 'ERROR',
      details: 'Rule description contains prohibited code/script patterns',
    });
    validationStatus = 'INVALID';
  }

  // 4. Formula validation
  let formula = rule.formula;
  if (formula) {
    let operation = String(formula.operation || 'NONE').toUpperCase();
    if (!ALLOWED_FORMULA_OPERATIONS.has(operation)) {
      issues.push({
        issueType: 'UNSUPPORTED_FORMULA_OPERATION',
        severity: 'WARNING',
        details: `Formula operation "${operation}" is not in allowlist. Sanitized to NONE.`,
      });
      operation = 'NONE';
      validationStatus = 'FLAGGED';
    }

    const formulaDesc = String(formula.description || '');
    if (DANGEROUS_CODE_PATTERN.test(formulaDesc)) {
      issues.push({
        issueType: 'SECURITY_VIOLATION',
        severity: 'ERROR',
        details: 'Formula description contains prohibited code/script patterns',
      });
      validationStatus = 'INVALID';
    }

    formula = {
      operation,
      description: formulaDesc.substring(0, 500),
      operands: Array.isArray(formula.operands)
        ? formula.operands.map((op) => String(op).substring(0, 100))
        : [],
    };
  }

  // 5. Conditions validation
  const conditions = [];
  if (Array.isArray(rule.conditions)) {
    for (const cond of rule.conditions) {
      const field = String(cond.field || '').trim().substring(0, 100);
      const op = String(cond.operator || '==').trim();
      const val = cond.value;

      if (!ALLOWED_OPERATORS.has(op)) {
        issues.push({
          issueType: 'INVALID_CONDITION_OPERATOR',
          severity: 'WARNING',
          details: `Condition operator "${op}" is not allowed`,
        });
        validationStatus = 'FLAGGED';
      } else {
        conditions.push({ field, operator: op, value: val });
      }
    }
  }

  // 6. Source page and excerpt verification
  const source = rule.source || {};
  const pageNum = parseInt(source.page_number, 10);
  const exactExcerpt = String(source.exact_excerpt || '').trim();

  let pageStart = null;
  let pageEnd = null;
  let citation = `${documentCode} | Rev ${revisionNumber}`;

  if (!pageNum || isNaN(pageNum)) {
    issues.push({
      issueType: 'MISSING_SOURCE_PAGE',
      severity: 'WARNING',
      details: 'Rule does not cite a valid source page number',
    });
    if (validationStatus === 'VALID') validationStatus = 'FLAGGED';
  } else {
    pageStart = pageNum;
    pageEnd = pageNum;
    citation += ` | Page ${pageNum}`;

    // Verify page exists in document
    const targetPage = pages.find((p) => p.page_number === pageNum);
    if (!targetPage) {
      issues.push({
        issueType: 'INVALID_PAGE_REFERENCE',
        severity: 'WARNING',
        details: `Cited page ${pageNum} does not exist in extracted document (total pages: ${pages.length})`,
      });
      if (validationStatus === 'VALID') validationStatus = 'FLAGGED';
    } else if (exactExcerpt) {
      // Check if excerpt exists in page text
      const normPageText = normalizeTextForComparison(targetPage.exact_text);
      const normExcerpt = normalizeTextForComparison(exactExcerpt);

      if (!normPageText.includes(normExcerpt) && normExcerpt.length > 20) {
        // Excerpt not verbatim found on cited page
        issues.push({
          issueType: 'EXCERPT_MISMATCH',
          severity: 'INFO',
          details: `Source excerpt could not be matched verbatim on page ${pageNum}`,
          source_reference: `Page ${pageNum}`,
        });
      }
    }
  }

  const sanitized = {
    documentCode,
    policyVersionId: versionId,
    ruleKey: ruleKey || `rule_${Date.now()}`,
    ruleType,
    metricCode: rule.metric_code ? String(rule.metric_code).trim().substring(0, 100) : null,
    description: description.substring(0, 1000),
    value: rule.value ?? null,
    unit: rule.unit ?? null,
    candidateJson: {
      ruleKey,
      ruleType,
      metricCode: rule.metric_code || null,
      description,
      value: rule.value ?? null,
      unit: rule.unit ?? null,
      formula: formula || null,
      conditions,
      source: {
        page_number: pageStart,
        exact_excerpt: exactExcerpt,
      },
      uncertainties: Array.isArray(rule.uncertainties) ? rule.uncertainties : [],
    },
    validationStatus,
    pageStart,
    pageEnd,
    exactExcerpt: exactExcerpt ? exactExcerpt.substring(0, 1500) : null,
    citation,
  };

  return { sanitized, issues, isValid: validationStatus !== 'INVALID' };
}

/**
 * Validates the full Hermes policy interpretation output.
 */
export function validatePolicyInterpretationOutput(parsedJson, {
  pages = [],
  documentCode = '',
  revisionNumber = '000',
  versionId = null,
}) {
  const resultIssues = [];
  const validRules = [];

  if (!parsedJson || typeof parsedJson !== 'object') {
    throw new Error('Interpretation output is not an object');
  }

  // Validate document code match
  if (parsedJson.document_code && parsedJson.document_code !== documentCode) {
    resultIssues.push({
      issueType: 'DOCUMENT_CODE_MISMATCH',
      severity: 'WARNING',
      issueDetails: `Hermes returned document code ${parsedJson.document_code}, expected ${documentCode}`,
    });
  }

  // Extract rules array
  const rawRules = Array.isArray(parsedJson.rules) ? parsedJson.rules : [];
  if (rawRules.length === 0) {
    resultIssues.push({
      issueType: 'NO_RULES_EXTRACTED',
      severity: 'WARNING',
      issueDetails: 'Hermes did not identify any rule candidates for this policy',
    });
  }

  for (const r of rawRules) {
    const { sanitized, issues } = validateSingleRuleCandidate(r, {
      pages,
      documentCode,
      revisionNumber,
      versionId,
    });
    validRules.push(sanitized);
    for (const iss of issues) {
      resultIssues.push({
        issueType: iss.issueType,
        severity: iss.severity,
        issueDetails: iss.details,
        sourceReference: iss.source_reference || `Rule: ${sanitized.ruleKey}`,
      });
    }
  }

  // Extract issues array from Hermes output
  if (Array.isArray(parsedJson.issues)) {
    for (const iss of parsedJson.issues) {
      resultIssues.push({
        issueType: String(iss.issue_type || 'HERMES_POLICY_NOTE').substring(0, 100),
        severity: String(iss.severity || 'WARNING').toUpperCase(),
        issueDetails: String(iss.issue_details || JSON.stringify(iss)).substring(0, 1000),
        sourceReference: iss.source_reference ? String(iss.source_reference).substring(0, 255) : null,
      });
    }
  }

  return {
    documentCode,
    versionId,
    interpretationStatus: validRules.some((r) => r.validationStatus === 'INVALID')
      ? 'NEEDS_REVIEW'
      : resultIssues.some((i) => i.severity === 'ERROR')
      ? 'NEEDS_REVIEW'
      : 'COMPLETED',
    rules: validRules,
    issues: resultIssues,
    metadata: {
      documentSummary: parsedJson.document_summary || '',
      pdfInternalRevision: parsedJson.pdf_internal_revision || '',
      qaStatus: parsedJson.qa_status || null,
      attendanceStatus: parsedJson.attendance_status || null,
    },
  };
}
