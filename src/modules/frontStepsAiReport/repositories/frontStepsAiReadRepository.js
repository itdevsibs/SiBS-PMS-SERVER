/**
 * FrontSteps AI Report Read Repository
 * 
 * Strict Read-Only Access to FrontSteps operational data:
 * - frontsteps_raw_calls
 * - frontsteps_raw_cases
 * - frontsteps_import_batches
 * - frontsteps_employee_aliases
 * - frontsteps_policies_repository
 * 
 * Never mutates records or alters original formulas.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const rawCalls = dbTable(PMS_DB_NAME, 'frontsteps_raw_calls');
const rawCases = dbTable(PMS_DB_NAME, 'frontsteps_raw_cases');
const importBatches = dbTable(PMS_DB_NAME, 'frontsteps_import_batches');
const employeeAliases = dbTable(PMS_DB_NAME, 'frontsteps_employee_aliases');
const policiesRepo = pmsTables.frontstepsPoliciesRepository || dbTable(PMS_DB_NAME, 'frontsteps_policies_repository');

export async function getCallMetricsSummary(filters = {}) {
  try {
    let sql = `
      SELECT 
        COUNT(*) AS total_calls,
        COALESCE(SUM(CASE WHEN is_answered = 1 THEN 1 ELSE 0 END), 0) AS answered_calls,
        COALESCE(SUM(CASE WHEN is_answered = 0 OR raw_status = 'Abandoned' THEN 1 ELSE 0 END), 0) AS abandoned_calls,
        COALESCE(SUM(wait_seconds), 0) AS total_wait_seconds,
        COALESCE(SUM(handle_seconds), 0) AS total_handle_seconds
      FROM ${rawCalls}
      WHERE 1=1
    `;
    const params = [];

    if (filters.startDate) {
      sql += ' AND start_at >= ?';
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      sql += ' AND start_at <= ?';
      params.push(`${filters.endDate} 23:59:59`);
    }
    if (filters.queue && filters.queue !== 'all') {
      sql += ' AND queue_name = ?';
      params.push(filters.queue);
    }

    const [[rows]] = await pmsDb.query(sql, params);
    return rows || {};
  } catch (err) {
    console.error('[FrontSteps AI Repo] Error querying call metrics:', err.message);
    return {};
  }
}

export async function getCaseMetricsSummary(filters = {}) {
  try {
    let sql = `
      SELECT 
        COUNT(*) AS total_cases,
        COALESCE(SUM(CASE WHEN closed_at IS NOT NULL OR raw_status = 'Closed' THEN 1 ELSE 0 END), 0) AS closed_cases,
        COALESCE(SUM(CASE WHEN closed_at IS NULL AND (raw_status IS NULL OR raw_status != 'Closed') THEN 1 ELSE 0 END), 0) AS open_cases
      FROM ${rawCases}
      WHERE 1=1
    `;
    const params = [];

    if (filters.startDate) {
      sql += ' AND opened_at >= ?';
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      sql += ' AND opened_at <= ?';
      params.push(`${filters.endDate} 23:59:59`);
    }
    if (filters.queue && filters.queue !== 'all') {
      sql += ' AND queue_name = ?';
      params.push(filters.queue);
    }

    const [[rows]] = await pmsDb.query(sql, params);
    return rows || {};
  } catch (err) {
    console.error('[FrontSteps AI Repo] Error querying case metrics:', err.message);
    return {};
  }
}

export async function getTopCaseDrivers(filters = {}) {
  try {
    let sql = `
      SELECT 
        COALESCE(NULLIF(TRIM(case_type), ''), 'Uncategorized') AS label,
        COUNT(*) AS count
      FROM ${rawCases}
      WHERE 1=1
    `;
    const params = [];

    if (filters.startDate) {
      sql += ' AND opened_at >= ?';
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      sql += ' AND opened_at <= ?';
      params.push(`${filters.endDate} 23:59:59`);
    }

    sql += ' GROUP BY label ORDER BY count DESC LIMIT 8';
    const [rows] = await pmsDb.query(sql, params);
    return rows || [];
  } catch (err) {
    console.error('[FrontSteps AI Repo] Error querying case drivers:', err.message);
    return [];
  }
}

export async function getFrontStepsAccountBreakdown(filters = {}) {
  try {
    const [callsByQueue] = await pmsDb.query(`
      SELECT 
        COALESCE(NULLIF(TRIM(queue_name), ''), 'General FrontSteps') AS queue_name,
        COUNT(*) AS total_calls,
        COALESCE(SUM(CASE WHEN is_answered = 1 THEN 1 ELSE 0 END), 0) AS answered_calls,
        COALESCE(SUM(CASE WHEN is_answered = 0 THEN 1 ELSE 0 END), 0) AS abandoned_calls,
        COALESCE(AVG(handle_seconds), 0) AS avg_handle_seconds,
        COALESCE(AVG(wait_seconds), 0) AS avg_wait_seconds
      FROM ${rawCalls}
      GROUP BY queue_name
      ORDER BY total_calls DESC
      LIMIT 10
    `);

    const [casesByQueue] = await pmsDb.query(`
      SELECT 
        COALESCE(NULLIF(TRIM(queue_name), ''), 'General FrontSteps') AS queue_name,
        COUNT(*) AS total_cases,
        COALESCE(SUM(CASE WHEN closed_at IS NOT NULL OR raw_status = 'Closed' THEN 1 ELSE 0 END), 0) AS closed_cases
      FROM ${rawCases}
      GROUP BY queue_name
      ORDER BY total_cases DESC
      LIMIT 10
    `);

    return { callsByQueue, casesByQueue };
  } catch (err) {
    console.error('[FrontSteps AI Repo] Error querying account breakdown:', err.message);
    return { callsByQueue: [], casesByQueue: [] };
  }
}

export async function getFrontStepsEmployeeRoster(filters = {}) {
  try {
    const [rows] = await pmsDb.query(`
      SELECT DISTINCT
        sibs_id,
        source_alias AS employee_name,
        source_system,
        active,
        updated_at
      FROM ${employeeAliases}
      WHERE active = 1 AND sibs_id IS NOT NULL AND sibs_id != ''
      ORDER BY source_alias ASC
      LIMIT 100
    `);
    return rows || [];
  } catch (err) {
    console.error('[FrontSteps AI Repo] Error querying employee roster:', err.message);
    return [];
  }
}

export async function getFrontStepsPolicies(filters = {}, pagination = { limit: 20, offset: 0 }) {
  try {
    let sql = `
      SELECT 
        id,
        document_code,
        policy_title,
        policy_category,
        revision_number,
        approval_status,
        prepared_for,
        file_name,
        file_extension,
        file_size,
        file_checksum,
        is_current_version,
        uploaded_by,
        created_at,
        updated_at
      FROM ${policiesRepo}
      WHERE 1=1
    `;
    const params = [];

    if (filters.category) {
      sql += ' AND policy_category = ?';
      params.push(filters.category);
    }
    if (filters.status) {
      sql += ' AND approval_status = ?';
      params.push(filters.status);
    }
    if (filters.search) {
      const term = `%${filters.search}%`;
      sql += ' AND (document_code LIKE ? OR policy_title LIKE ? OR policy_category LIKE ?)';
      params.push(term, term, term);
    }

    // Count query
    const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS subquery`;
    const [[countResult]] = await pmsDb.query(countSql, params);
    const total = Number(countResult?.total || 0);

    const limit = Number(pagination?.limit) > 0 ? Number(pagination.limit) : 50;
    const offset = Number(pagination?.offset) >= 0 ? Number(pagination.offset) : 0;

    sql += ' ORDER BY document_code ASC, revision_number DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pmsDb.query(sql, params);
    return { total, rows: rows || [] };
  } catch (err) {
    console.error('[FrontSteps AI Repo] Error querying policies:', err.message);
    return { total: 0, rows: [] };
  }
}

export async function getPolicyPdfContent(id) {
  try {
    const [rows] = await pmsDb.query(
      `SELECT file_name, file_extension, mime_type, file_content FROM ${policiesRepo} WHERE id = ?`,
      [id],
    );
    return rows?.[0] || null;
  } catch (err) {
    console.error('[FrontSteps AI Repo] Error fetching policy PDF:', err.message);
    return null;
  }
}
