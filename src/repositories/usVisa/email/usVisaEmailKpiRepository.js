import { pmsDb, pmsTables } from '../../../config/db.js';

// Only cases backed by an active completed import remain after batch deletion.
// Historical legacy cases with a missing first batch remain readable.
const baseConditions = () => ({
  conditions: ["(b.id IS NULL OR b.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS'))", 'e.created_on IS NOT NULL'],
  values: [],
});
const baseJoin = `FROM ${pmsTables.usVisaRawEmailCases} e
  LEFT JOIN ${pmsTables.usVisaImportBatches} b ON b.id = e.batch_id`;

// One row per country/date, not per email or per ledger Skill. The service
// resolves the effective-dated published Task Order before determining bounds.
export async function getEmailKpiCountryDateBoundsRows() {
  const {conditions, values} = baseConditions();
  const [rows] = await pmsDb.query(`SELECT DATE_FORMAT(e.created_on, '%Y-%m-%d') AS created_date,
      e.country_region
    ${baseJoin} WHERE ${conditions.join(' AND ')}
    GROUP BY DATE_FORMAT(e.created_on, '%Y-%m-%d'), e.country_region`, values);
  return rows.map((row) => ({createdDate: row.created_date, countryRegion: row.country_region}));
}

export async function getEmailKpiRows({dateFrom = null, dateTo = null} = {}) {
  const {conditions, values} = baseConditions();
  if (dateFrom) { conditions.push('e.created_on >= ?'); values.push(`${dateFrom} 00:00:00`); }
  if (dateTo) { conditions.push('e.created_on <= ?'); values.push(`${dateTo} 23:59:59`); }
  const [rows] = await pmsDb.query(`SELECT e.id, e.source_case_id, e.country_region, e.owner_raw,
      e.status, e.modified_by_sibs_id AS modified_by_employee_uid,
      e.modified_by_mapping_status, e.created_on,
      DATE_FORMAT(e.created_on, '%Y-%m-%d') AS created_date,
      e.resolution_date, e.case_age
    ${baseJoin} WHERE ${conditions.join(' AND ')} ORDER BY e.created_on ASC, e.id ASC`, values);
  return rows.map((row) => ({
    id: row.id, sourceCaseId: row.source_case_id,
    countryRegion: row.country_region, createdDate: row.created_date,
    ownerRaw: row.owner_raw, status: row.status,
    modifiedByEmployeeUid: row.modified_by_employee_uid,
    modifiedByMappingStatus: row.modified_by_mapping_status,
    createdOn: row.created_on, resolutionDate: row.resolution_date, caseAge: row.case_age,
  }));
}

// Owner values remain discoverable across dates; grouping by country/day keeps
// source dates available for effective-dated matching.
export async function listEmailKpiOwnerValues() {
  const {conditions, values} = baseConditions();
  conditions.push('e.owner_raw IS NOT NULL', "TRIM(e.owner_raw) <> ''");
  const [rows] = await pmsDb.query(`SELECT DISTINCT e.owner_raw, e.country_region,
      DATE_FORMAT(e.created_on, '%Y-%m-%d') AS created_date
    ${baseJoin} WHERE ${conditions.join(' AND ')} ORDER BY e.owner_raw ASC`, values);
  return rows.map((row) => ({ownerRaw: row.owner_raw,
    countryRegion: row.country_region, createdDate: row.created_date}));
}
