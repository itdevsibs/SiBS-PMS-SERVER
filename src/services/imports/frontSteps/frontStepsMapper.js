import crypto from 'node:crypto';
import { cleanSourceRow } from './frontStepsValidator.js';
import {
  FRONTSTEPS_MAPPING_STATUSES,
  getFrontStepsIdentityResolution,
} from './frontStepsEmployeeIdentityService.js';

export const normalizeAlias = (value) => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, ' ')
  .toUpperCase();

export function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sqlDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();

  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (match) {
    let hour = Number(match[4]) % 12;
    if (match[7].toUpperCase() === 'PM') hour += 12;
    const year = Number(match[3]);
    const month = Number(match[1]);
    const day = Number(match[2]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day ||
      minute > 59 ||
      second > 59
    ) return null;

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  }

  match = text.match(/^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 || minute > 59 || second > 59
  ) return null;

  return `${match[1]}-${match[2]}-${match[3]} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

export function numeric(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function nonempty(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function statusOf(raw) {
  const status = String(raw ?? '').trim().toLowerCase();
  if (['closed', 'closed by customer', 'auto close'].includes(status)) return 'CLOSED';
  if (['new', 'open', 'working', 'in progress', 'pending'].includes(status)) return 'OPEN';
  return 'OTHER';
}

function mappingColumns(identityMap, name) {
  const resolution = getFrontStepsIdentityResolution(identityMap, name);
  return {
    sibsId: resolution.sibsId || null,
    status: resolution.matchStatus || FRONTSTEPS_MAPPING_STATUSES.UNMATCHED,
    method: resolution.matchMethod || null,
  };
}

const NON_EMPLOYEE_IDENTITIES = new Set([
  'SALESFORCE ADMIN',
  'FRONTSTEPS SITE GUEST USER',
  'SUPPORT SITE GUEST USER',
  'ACTIVEO ADMIN USER',
  'AUTOMATED PROCESS',
  'RESIDENT SUPPORT',
]);

function shouldFlagUnmapped(name, mapping) {
  const normalized = normalizeAlias(name);
  return Boolean(
    normalized &&
    !NON_EMPLOYEE_IDENTITIES.has(normalized) &&
    mapping.status !== FRONTSTEPS_MAPPING_STATUSES.MATCHED
  );
}

function buildMappingWarning(column, name, mapping) {
  if (!shouldFlagUnmapped(name, mapping)) return null;
  const ambiguous = mapping.status === FRONTSTEPS_MAPPING_STATUSES.AMBIGUOUS;
  return {
    code: ambiguous ? 'AMBIGUOUS_EMPLOYEE_MAPPING' : 'UNMATCHED_EMPLOYEE_MAPPING',
    column,
    value: name,
    message: ambiguous
      ? `${column} "${name}" matched more than one employee and was not assigned automatically.`
      : `${column} "${name}" did not match a configured FrontSteps Salesforce alias or an exact Kronos employee name.`,
  };
}

export function mapFrontStepsRow(input, reportType, identityMap = new Map()) {
  const raw = cleanSourceRow(input, reportType);
  const rowHash = sourceHash(input);
  const issues = [];
  const mappingWarnings = [];
  let recordId;
  let columns;
  let modifiedAt = null;
  let unmapped = false;

  if (reportType === 'CASES') {
    recordId = nonempty(raw['Case Number']);
    const openedAt = sqlDate(raw['Date/Time Opened']);
    const closedAt = sqlDate(raw['Date/Time Closed']);
    modifiedAt = sqlDate(raw['Case Date/Time Last Modified']);

    if (!recordId) issues.push(['MISSING_CASE_NUMBER', 'Case Number', 'A unique Case Number is required']);
    if (raw['Date/Time Opened'] && !openedAt) issues.push(['INVALID_OPENED_AT', 'Date/Time Opened', 'Invalid case opened timestamp']);
    if (raw['Date/Time Closed'] && !closedAt) issues.push(['INVALID_CLOSED_AT', 'Date/Time Closed', 'Invalid case closed timestamp']);
    if (raw['Case Date/Time Last Modified'] && !modifiedAt) issues.push(['INVALID_MODIFIED_AT', 'Case Date/Time Last Modified', 'Invalid case modified timestamp']);

    const caseOwner = nonempty(raw['Case Owner']);
    const modifiedBy = nonempty(raw['Case Last Modified By']);
    const ownerMapping = mappingColumns(identityMap, caseOwner);
    const modifiedByMapping = mappingColumns(identityMap, modifiedBy);

    const ownerWarning = buildMappingWarning('Case Owner', caseOwner, ownerMapping);
    const modifiedByWarning = buildMappingWarning('Case Last Modified By', modifiedBy, modifiedByMapping);
    if (ownerWarning) mappingWarnings.push(ownerWarning);
    if (modifiedByWarning) mappingWarnings.push(modifiedByWarning);
    unmapped = mappingWarnings.length > 0;

    columns = [
      recordId,
      openedAt,
      closedAt,
      modifiedAt,
      'UNCONFIRMED',
      nonempty(raw.Queue),
      caseOwner,
      ownerMapping.sibsId,
      ownerMapping.status,
      ownerMapping.method,
      modifiedBy,
      modifiedByMapping.sibsId,
      modifiedByMapping.status,
      modifiedByMapping.method,
      nonempty(raw['Case Origin']),
      nonempty(raw.Type),
      nonempty(raw.Subject),
      nonempty(raw.Resolution),
      nonempty(raw['Resolution Sub Codes']),
      nonempty(raw['Case Summary']),
      nonempty(raw.Status),
      statusOf(raw.Status),
      null,
    ];
  } else {
    recordId = nonempty(raw['Voice Call ID']);
    const startAt = sqlDate(raw['Call Start Time']);
    const queueAt = sqlDate(raw['Call Entered Queue']);
    const acceptedAt = sqlDate(raw['Call Accepted']);
    const endAt = sqlDate(raw['Call End Time']);

    if (!recordId) issues.push(['MISSING_CALL_ID', 'Voice Call ID', 'A unique Voice Call ID is required']);
    if (!startAt) issues.push(['INVALID_CALL_START', 'Call Start Time', 'Valid call start timestamp is required']);

    for (const [header, sourceValue, parsedValue] of [
      ['Call Entered Queue', raw['Call Entered Queue'], queueAt],
      ['Call Accepted', raw['Call Accepted'], acceptedAt],
      ['Call End Time', raw['Call End Time'], endAt],
    ]) {
      if (sourceValue && !parsedValue) issues.push(['INVALID_TIMESTAMP', header, `Invalid ${header} timestamp`]);
    }

    for (const header of [
      'Wait Time', 'Handle Time', 'Call Duration in Seconds',
      'Customer Hold Duration', 'Number Of Holds', 'Related Case Count',
    ]) {
      if (raw[header] && numeric(raw[header]) === null) {
        issues.push(['INVALID_NUMBER', header, `Invalid non-negative ${header} value`]);
      }
    }

    const ownerName = nonempty(raw['Owner Name: Full Name']);
    const ownerMapping = mappingColumns(identityMap, ownerName);
    const ownerWarning = buildMappingWarning('Owner Name: Full Name', ownerName, ownerMapping);
    if (ownerWarning) mappingWarnings.push(ownerWarning);
    unmapped = mappingWarnings.length > 0;

    columns = [
      recordId,
      startAt,
      queueAt,
      acceptedAt,
      endAt,
      'UNCONFIRMED',
      nonempty(raw['Call Type']),
      nonempty(raw['Queue Name']),
      ownerName,
      ownerMapping.sibsId,
      ownerMapping.status,
      ownerMapping.method,
      numeric(raw['Wait Time']),
      numeric(raw['Handle Time']),
      nonempty(raw['Voice Case #']),
      numeric(raw['Related Case Count']),
      numeric(raw['Call Duration in Seconds']),
      numeric(raw['Customer Hold Duration']),
      numeric(raw['Number Of Holds']),
      nonempty(raw['Call Status']),
      nonempty(raw['Call Resolution']),
      acceptedAt ? 1 : 0,
      null,
    ];
  }

  const hash = sourceHash(columns.slice(0, -1));
  columns[columns.length - 1] = hash;

  return {
    raw,
    rowHash,
    hash,
    recordId,
    columns,
    modifiedAt,
    issues,
    mappingWarnings,
    unmapped,
    date: (reportType === 'CASES' ? (columns[2] || columns[1]) : columns[1])?.slice(0, 10) || null,
  };
}
