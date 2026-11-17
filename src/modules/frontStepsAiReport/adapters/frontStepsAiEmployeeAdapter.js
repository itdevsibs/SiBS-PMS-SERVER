/**
 * FrontSteps AI Employee & Attendance Governance Adapter
 *
 * Read-only bulk loader and identity reconciliation engine over:
 * - PMS `frontsteps_employee_aliases`
 * - Live Kronos API (`/api/v1/employee-directory`, `/api/v1/employee-attendance`, `/api/v1/employee-schedules`)
 * - Kronos DB fallback (`gy_employee`, `gy_user`, `gy_leave`, `gy_schedule`, `gy_holiday_calendar`, `gy_tracker`)
 *
 * Key Phase 4C Safeguards:
 * - Rejects MySQL zero-dates ('0000-00-00') so active employees are never misclassified as separated.
 * - Reconciles Live Kronos Directory/Attendance against stale kronos_testdb snapshots (e.g. post-Oct-7
 *   attendance, 6859 post-snapshot separation on 2026-10-02, 6855 stalled tracker after 2026-10-07).
 * - Excludes temporary sept transfers now belonging to other accounts (e.g. US Visa / CFAS) while
 *   keeping strict FrontSteps isolation.
 * - Classifies every actor across 6 deterministic categories without rewriting source IDs (`1403`/`1603`).
 *
 * Strict Isolation: Read-only queries only. Zero writes, zero Hermes calls.
 */

import { pmsDb, kronosDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import { getKronosApiResponse } from '../../../services/kronos/kronosApiClient.js';
import { getKronosAttendanceSheetScheduleData } from '../../../repositories/kronos/kronosAttendanceRepository.js';

const aliasesTable =
  pmsTables.frontstepsEmployeeAliases || dbTable(PMS_DB_NAME, 'frontsteps_employee_aliases');

export const FRONTSTEPS_KRONOS_ACCOUNT_ID = 64;

import {
  PHASE55_AVAILABILITY_STATES,
  resolveEmployeeAvailabilityState,
} from '../services/frontStepsAiReadinessClassifier.js';

export { PHASE55_AVAILABILITY_STATES };

export const IDENTITY_CATEGORIES = {
  VERIFIED_ACTIVE_FRONTSTEPS: 'VERIFIED_ACTIVE_FRONTSTEPS',
  MISSING_ALIAS_ACTIVE_FS: 'MISSING_ALIAS_ACTIVE_FS',
  ACTIVE_DIRECTORY_STALLED_TRACKER: 'ACTIVE_DIRECTORY_STALLED_TRACKER',
  ACTIVE_DIRECTORY_ZERO_SCHEDULE_UNVERIFIED: 'ACTIVE_DIRECTORY_ZERO_SCHEDULE_UNVERIFIED',
  SEPARATED_RECENT_LIVE_KRONOS: 'SEPARATED_RECENT_LIVE_KRONOS',
  HISTORICAL_OR_NON_AGENT_ALIAS: 'HISTORICAL_OR_NON_AGENT_ALIAS',
  ALIAS_EMPID_MISMATCH: 'ALIAS_EMPID_MISMATCH',
};

/**
 * Parses Kronos/MySQL date strings safely, rejecting MySQL zero dates ('0000-00-00'),
 * epoch/pre-1970 artifacts, and invalid dates so they are never compared as real separation dates.
 */
export function parseValidKronosDate(val) {
  if (val === null || val === undefined) return null;

  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    const year = val.getFullYear();
    if (year < 1970) return null;
    const month = String(val.getMonth() + 1).padStart(2, '0');
    const day = String(val.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const raw = String(val).trim();
  if (!raw || raw.startsWith('0000-00-00')) return null;

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  return `${match[1]}-${match[2]}-${match[3]}`;
}

export const toDateStr = parseValidKronosDate;

/**
 * Normalizes a human person name (stripping diacritics such as CAÑEDO -> canedo and
 * converting "Last, First" -> "first last") for cross-system directory lookup.
 */
export function normalizePersonNameForMatch(name) {
  if (!name) return '';
  let str = String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  if (str.includes(',')) {
    const parts = str.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      str = `${parts[1]} ${parts[0]}`;
    }
  }

  return str
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addDaysIso(dateStr, deltaDays) {
  if (!dateStr) return null;
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + deltaDays * 86400 * 1000).toISOString().slice(0, 10);
}

function locationLabel(locCode) {
  if (Number(locCode) === 0) return 'Tagum';
  if (Number(locCode) === 1) return 'Davao';
  if (Number(locCode) === 2) return 'All Sites';
  return 'Unknown';
}

function isScheduleRowActive(row = {}) {
  const mode = Number(row.schedMode ?? row.gy_sched_mode ?? 0);
  if (mode === 1) return true;
  const login = String(row.schedLogin ?? row.gy_sched_login ?? '').trim();
  const logout = String(row.schedLogout ?? row.gy_sched_logout ?? '').trim();
  return Boolean(
    (login && login !== '00:00:00' && login !== '00:00') ||
      (logout && logout !== '00:00:00' && logout !== '00:00')
  );
}

/**
 * Queries Live Kronos REST API (directory, attendance, schedules) for FrontSteps and
 * builds a full personnel index across Live Kronos Directory for Non-SiBS classification.
 */
async function fetchLiveKronosData({
  startDate,
  endDate,
  extraCodes = [],
}) {
  const effectiveStart = startDate || '2026-07-01';
  const effectiveEnd = endDate || new Date().toISOString().slice(0, 10);
  const extendedSchedEnd = addDaysIso(effectiveEnd, 30) || effectiveEnd;

  // 1. Authoritative active FrontSteps directory (account_ids = 64)
  const fsDirectoryRows = [];
  for (let page = 1; page <= 20; page++) {
    const res = await getKronosApiResponse('/api/v1/employee-directory', {
      params: { account_ids: FRONTSTEPS_KRONOS_ACCOUNT_ID, page, limit: 100 },
    });
    fsDirectoryRows.push(...(Array.isArray(res?.data) ? res.data : []));
    const totalPages = Number(res?.pagination?.totalPages ?? res?.pagination?.total_pages ?? 1);
    if (page >= totalPages) break;
  }

  // 2. Full company active directory for accurate Non-SiBS vs Unmapped-SiBS verification
  const fullDirectoryRows = [];
  const firstFull = await getKronosApiResponse('/api/v1/employee-directory', {
    params: { page: 1, limit: 100 },
  });
  fullDirectoryRows.push(...(Array.isArray(firstFull?.data) ? firstFull.data : []));
  const fullTotalPages = Number(
    firstFull?.pagination?.totalPages ?? firstFull?.pagination?.total_pages ?? 1
  );
  if (fullTotalPages > 1) {
    const pageNums = [];
    for (let p = 2; p <= Math.min(fullTotalPages, 25); p++) pageNums.push(p);
    const restPages = await Promise.all(
      pageNums.map((page) =>
        getKronosApiResponse('/api/v1/employee-directory', { params: { page, limit: 100 } })
      )
    );
    for (const r of restPages) {
      fullDirectoryRows.push(...(Array.isArray(r?.data) ? r.data : []));
    }
  }

  // 3. Live FrontSteps attendance for the period (plus +2 days cushion around boundary dates)
  const attFetchEnd = addDaysIso(effectiveEnd, 2) || effectiveEnd;
  const attendanceRows = [];
  const firstAtt = await getKronosApiResponse('/api/v1/employee-attendance', {
    params: {
      account_id: FRONTSTEPS_KRONOS_ACCOUNT_ID,
      date_from: effectiveStart,
      date_to: attFetchEnd,
      page: 1,
      limit: 100,
    },
  });
  attendanceRows.push(...(Array.isArray(firstAtt?.data) ? firstAtt.data : []));
  const attTotalPages = Number(
    firstAtt?.pagination?.totalPages ?? firstAtt?.pagination?.total_pages ?? 1
  );
  if (attTotalPages > 1) {
    const pageNums = [];
    for (let p = 2; p <= Math.min(attTotalPages, 50); p++) pageNums.push(p);
    for (let i = 0; i < pageNums.length; i += 4) {
      const batch = pageNums.slice(i, i + 4);
      const responses = await Promise.all(
        batch.map((page) =>
          getKronosApiResponse('/api/v1/employee-attendance', {
            params: {
              account_id: FRONTSTEPS_KRONOS_ACCOUNT_ID,
              date_from: effectiveStart,
              date_to: attFetchEnd,
              page,
              limit: 100,
            },
          })
        )
      );
      for (const r of responses) {
        attendanceRows.push(...(Array.isArray(r?.data) ? r.data : []));
      }
    }
  }

  // 4. Live FrontSteps schedules for active directory codes + observed tracker codes
  const scheduleSeedMap = new Map();
  for (const dirEmp of fsDirectoryRows) {
    const code = String(dirEmp.sibsId || '').trim();
    if (!code) continue;
    scheduleSeedMap.set(code, {
      employeeUid: code,
      gyEmpCode: code,
      employeeName: dirEmp.userFullName || `${dirEmp.firstName || ''} ${dirEmp.lastName || ''}`.trim(),
      kronosAccountId: FRONTSTEPS_KRONOS_ACCOUNT_ID,
    });
  }
  for (const att of attendanceRows) {
    const code = String(att.gy_emp_code || att.employee_code || '').trim();
    if (!code) continue;
    const empAccId = Number(att.employee_account_id ?? att.account_id);
    if (empAccId && empAccId !== FRONTSTEPS_KRONOS_ACCOUNT_ID) continue;
    const prev = scheduleSeedMap.get(code) || {
      employeeUid: code,
      gyEmpCode: code,
      employeeName: att.gy_emp_fullname || '',
      kronosAccountId: FRONTSTEPS_KRONOS_ACCOUNT_ID,
    };
    if (!prev.gyEmpId && Number(att.employee_id) > 0) prev.gyEmpId = Number(att.employee_id);
    scheduleSeedMap.set(code, prev);
  }
  for (const code of extraCodes) {
    const clean = String(code || '').trim();
    if (!clean || scheduleSeedMap.has(clean)) continue;
    scheduleSeedMap.set(clean, {
      employeeUid: clean,
      gyEmpCode: clean,
      kronosAccountId: FRONTSTEPS_KRONOS_ACCOUNT_ID,
    });
  }

  let scheduleRows = [];
  if (scheduleSeedMap.size > 0) {
    const schedData = await getKronosAttendanceSheetScheduleData({
      kronosAccountId: FRONTSTEPS_KRONOS_ACCOUNT_ID,
      accountName: 'FrontSteps',
      employeeUids: [...scheduleSeedMap.keys()],
      seedEmployees: [...scheduleSeedMap.values()],
      includeAccountPopulation: false,
      dateFrom: effectiveStart,
      dateTo: extendedSchedEnd,
    });
    scheduleRows = schedData?.schedules || [];
  }

  return {
    available: true,
    error: null,
    fsDirectoryRows,
    fullDirectoryRows,
    attendanceRows,
    scheduleRows,
  };
}

/**
 * Loads FrontSteps mapped employees, Live Kronos + Kronos DB attributes, leave, schedules,
 * holidays, and tracker completeness for the requested date window.
 */
export async function loadEmployeeGovernanceContext({
  startDate = null,
  endDate = null,
  verifiedProrationContext = null,
  overrides = null,
} = {}) {
  let aliases = overrides?.aliases;
  if (!aliases) {
    const [rows] = await pmsDb.query(
      `SELECT id, sibs_id, source_system, source_alias, active
       FROM ${aliasesTable}
       ORDER BY sibs_id, source_system`
    );
    aliases = rows;
  }

  const aliasBySibsId = new Map();
  for (const a of aliases) {
    const id = String(a.sibs_id).trim();
    if (!aliasBySibsId.has(id)) {
      aliasBySibsId.set(id, {
        sibsId: id,
        active: Number(a.active) === 1,
        callsAlias: null,
        casesAlias: null,
        aliases: [],
      });
    }
    const entry = aliasBySibsId.get(id);
    if (Number(a.active) === 1) entry.active = true;
    entry.aliases.push(a.source_alias);
    if (a.source_system === 'SALESFORCE_CALLS') entry.callsAlias = a.source_alias;
    if (a.source_system === 'SALESFORCE_CASES') entry.casesAlias = a.source_alias;
  }

  const aliasSibsIds = Array.from(aliasBySibsId.keys());
  const numericAliasIds = aliasSibsIds.filter((s) => /^\d+$/.test(s)).map((s) => Number(s));

  let kronosEmployees = overrides?.kronosEmployees;
  let allKronosDirectoryDb = overrides?.allKronosEmployeesDb || [];
  if (!kronosEmployees) {
    const codePlace = aliasSibsIds.length ? aliasSibsIds.map(() => '?').join(',') : "'__NONE__'";
    const empIdPlace = numericAliasIds.length ? numericAliasIds.map(() => '?').join(',') : '-1';
    const [[empRows], [allEmpRows]] = await Promise.all([
      kronosDb.query(
        `SELECT gy_emp_id, gy_emp_code, gy_emp_fullname, gy_emp_email, gy_acc_id,
                gy_emp_account, gy_emp_type, gy_emp_hiredate, gy_accjoin, gy_last_working_day,
                gy_assignedloc, gy_work_from, gy_pststartdate, gy_pstenddate,
                gy_certification, gy_gradbaystartdate, gy_gradbayenddate, gy_fullgolivedate
         FROM gy_employee
         WHERE gy_acc_id = 64
            OR LOWER(gy_emp_account) LIKE '%front%'
            OR gy_emp_code IN (${codePlace})
            OR gy_emp_id IN (${empIdPlace})
         ORDER BY gy_emp_fullname ASC`,
        [...aliasSibsIds, ...numericAliasIds]
      ),
      kronosDb.query(
        `SELECT gy_emp_id, gy_emp_code, gy_emp_fullname, gy_emp_email, gy_acc_id, gy_emp_account
         FROM gy_employee`
      ),
    ]);
    kronosEmployees = empRows;
    allKronosDirectoryDb = allEmpRows;
  }

  const kronosByCode = new Map();
  const kronosByEmpId = new Map();
  for (const emp of kronosEmployees) {
    if (emp.gy_emp_code) kronosByCode.set(String(emp.gy_emp_code).trim(), emp);
    if (emp.gy_emp_id) kronosByEmpId.set(String(emp.gy_emp_id).trim(), emp);
  }

  const allEmpCodes = Array.from(
    new Set([
      ...aliasSibsIds,
      ...kronosEmployees.map((e) => (e.gy_emp_code ? String(e.gy_emp_code).trim() : null)).filter(Boolean),
    ])
  );
  const allEmpIds = kronosEmployees.map((e) => e.gy_emp_id).filter(Boolean);

  // Query Live Kronos API (or consume test overrides), with safe fallback to kronosDb
  let liveKronos = overrides?.liveKronos || null;
  if (!liveKronos && !overrides) {
    try {
      liveKronos = await fetchLiveKronosData({
        startDate,
        endDate,
        extraCodes: allEmpCodes.filter((c) => {
          const rec = kronosByCode.get(c);
          return rec && Number(rec.gy_acc_id) === FRONTSTEPS_KRONOS_ACCOUNT_ID;
        }),
      });
    } catch (err) {
      liveKronos = {
        available: false,
        error: err?.message || 'Live Kronos API unreachable; using frozen kronosDb snapshot fallback.',
        fsDirectoryRows: [],
        fullDirectoryRows: [],
        attendanceRows: [],
        scheduleRows: [],
      };
    }
  } else if (!liveKronos) {
    liveKronos = {
      available: false,
      error: null,
      fsDirectoryRows: [],
      fullDirectoryRows: [],
      attendanceRows: [],
      scheduleRows: [],
    };
  }

  // Load gy_user, gy_leave, gy_schedule (fallback), gy_holiday_calendar, gy_tracker (fallback)
  let kronosUsers = overrides?.kronosUsers || [];
  let leaves = overrides?.leaves || [];
  let dbSchedules = overrides?.schedules || [];
  let holidays = overrides?.holidays || [];
  let dbTrackerSummary = overrides?.trackerSummary || null;
  let leaveCoverageMaxInDb = overrides?.leaveCoverageMaxInDb ?? null;

  if (!overrides) {
    if (allEmpCodes.length > 0) {
      const cp = allEmpCodes.map(() => '?').join(',');
      const [userRows] = await kronosDb.query(
        `SELECT gy_user_id, gy_user_code, gy_full_name, gy_user_type, gy_user_status
         FROM gy_user
         WHERE gy_user_code IN (${cp})`,
        allEmpCodes
      );
      kronosUsers = userRows;
    }

    const userIds = kronosUsers.map((u) => u.gy_user_id).filter(Boolean);
    if (userIds.length > 0) {
      const up = userIds.map(() => '?').join(',');
      const leaveParams = [...userIds];
      let dateFilter = '';
      if (startDate && endDate) {
        dateFilter = ' AND gy_leave_date_from <= ? AND gy_leave_date_to >= ?';
        leaveParams.push(endDate, startDate);
      }
      const [[leaveRows], [[maxLeaveRow]]] = await Promise.all([
        kronosDb.query(
          `SELECT gy_leave_id, gy_user_id, gy_acc_id, gy_leave_type, gy_leave_paid,
                  gy_leave_day, gy_leave_date_from, gy_leave_date_to, gy_leave_status
           FROM gy_leave
           WHERE gy_user_id IN (${up})${dateFilter}
           ORDER BY gy_leave_date_from ASC`,
          leaveParams
        ),
        kronosDb.query(
          `SELECT MAX(gy_leave_date_to) AS maxLeaveDate
           FROM gy_leave
           WHERE gy_leave_status = '1'`
        ),
      ]);
      leaves = leaveRows;
      leaveCoverageMaxInDb = parseValidKronosDate(maxLeaveRow?.maxLeaveDate);
    }

    if (!liveKronos.available && allEmpIds.length > 0) {
      const ep = allEmpIds.map(() => '?').join(',');
      const schedParams = [...allEmpIds];
      let schedDateFilter = '';
      if (startDate && endDate) {
        schedDateFilter = ' AND gy_sched_day >= ? AND gy_sched_day <= ?';
        schedParams.push(startDate, endDate);
      }
      const [schedRows] = await kronosDb.query(
        `SELECT gy_emp_id, gy_sched_day, gy_sched_mode, gy_sched_login, gy_sched_logout
         FROM gy_schedule
         WHERE gy_emp_id IN (${ep})${schedDateFilter}`,
        schedParams
      );
      dbSchedules = schedRows;
    }

    let holQuery = `SELECT gy_hol_id, gy_hol_title, gy_hol_date, gy_hol_type_id, gy_hol_loc FROM gy_holiday_calendar WHERE 1=1`;
    const holParams = [];
    if (startDate && endDate) {
      holQuery += ' AND gy_hol_date >= ? AND gy_hol_date <= ?';
      holParams.push(startDate, endDate);
    }
    const [holRows] = await kronosDb.query(holQuery, holParams);
    holidays = holRows;

    if (allEmpCodes.length > 0) {
      const cp = allEmpCodes.map(() => '?').join(',');
      const tParams = [...allEmpCodes];
      let tDateWhere = '';
      if (startDate && endDate) {
        tDateWhere = ' AND DATE(gy_tracker_date) >= ? AND DATE(gy_tracker_date) <= ?';
        tParams.push(startDate, endDate);
      }
      const [[tSummary]] = await kronosDb.query(
        `SELECT COUNT(*) AS rowCount,
                DATE(MIN(gy_tracker_date)) AS minDate,
                DATE(MAX(gy_tracker_date)) AS maxDate
         FROM gy_tracker
         WHERE gy_emp_code IN (${cp})${tDateWhere}`,
        tParams
      );
      dbTrackerSummary = {
        rowCount: Number(tSummary?.rowCount || 0),
        minDate: parseValidKronosDate(tSummary?.minDate),
        maxDate: parseValidKronosDate(tSummary?.maxDate),
      };
    }
  }

  // Index gy_user lookup
  const userByCode = new Map();
  const codeByUserId = new Map();
  for (const u of kronosUsers) {
    if (u.gy_user_code) {
      const code = String(u.gy_user_code).trim();
      userByCode.set(code, u);
      codeByUserId.set(u.gy_user_id, code);
    }
  }

  // Index Live Kronos directory & attendance metadata per employee code
  const liveFsDirByCode = new Map();
  for (const d of liveKronos.fsDirectoryRows || []) {
    const code = String(d.sibsId || d.gy_emp_code || '').trim();
    if (!code) continue;
    liveFsDirByCode.set(code, d);
  }

  const liveFullDirByCode = new Map();
  for (const d of liveKronos.fullDirectoryRows || []) {
    const code = String(d.sibsId || d.gy_emp_code || '').trim();
    if (!code) continue;
    liveFullDirByCode.set(code, d);
  }

  // Aggregate Live Kronos attendance per employee code & window bounds
  const liveAttByCode = new Map();
  let liveGlobalTrackerMin = null;
  let liveGlobalTrackerMax = null;
  let liveAttRowsInWindow = 0;
  let pstEndPopulated = 0;
  let certPopulated = 0;
  let gradBayPopulated = 0;
  let fullGoLivePopulated = 0;
  const trainingSampleSeen = new Set();

  for (const r of liveKronos.attendanceRows || []) {
    const code = String(r.gy_emp_code || r.employee_code || '').trim();
    if (!code) continue;
    const tDate = parseValidKronosDate(r.gy_tracker_date);
    if (!tDate) continue;

    // Exclude rows belonging to employees whose current profile moved out of FrontSteps (e.g. US Visa / CFAS)
    const currentEmpAccId = r.employee_account_id !== undefined ? Number(r.employee_account_id) : null;
    if (
      liveFsDirByCode.size > 0 &&
      !liveFsDirByCode.has(code) &&
      currentEmpAccId &&
      currentEmpAccId !== FRONTSTEPS_KRONOS_ACCOUNT_ID
    ) {
      continue;
    }

    const inRequestedWindow = (!startDate || tDate >= startDate) && (!endDate || tDate <= endDate);
    let stats = liveAttByCode.get(code);
    if (!stats) {
      stats = {
        code,
        datesInWindow: new Set(),
        allDates: new Set(),
        minWindowDate: null,
        maxWindowDate: null,
        maxAnyDate: null,
        liveLastWorkingDay: parseValidKronosDate(r.employee_last_working_day),
        liveAccountId: currentEmpAccId,
        liveAccountName: r.employee_account || null,
        liveAssignedLoc:
          r.employee_assigned_location !== undefined && r.employee_assigned_location !== null
            ? Number(r.employee_assigned_location)
            : null,
        liveWorkFrom:
          r.employee_work_from !== undefined && r.employee_work_from !== null
            ? Number(r.employee_work_from)
            : null,
        liveHireDate: parseValidKronosDate(r.employee_hire_date),
        liveAccJoinDate: parseValidKronosDate(r.employee_account_join_date),
        livePstStartDate: parseValidKronosDate(r.employee_pst_start_date),
        livePstEndDate: parseValidKronosDate(r.employee_pst_end_date),
        liveCertificationDate: parseValidKronosDate(r.employee_certification_date),
        liveGradBayStartDate: parseValidKronosDate(r.employee_grad_bay_start_date),
        liveGradBayEndDate: parseValidKronosDate(r.employee_grad_bay_end_date),
        liveFullGoLiveDate: parseValidKronosDate(r.employee_full_go_live_date),
      };
      liveAttByCode.set(code, stats);
    }

    const rowLwd = parseValidKronosDate(r.employee_last_working_day);
    if (rowLwd) stats.liveLastWorkingDay = rowLwd;

    stats.allDates.add(tDate);
    if (!stats.maxAnyDate || tDate > stats.maxAnyDate) stats.maxAnyDate = tDate;

    if (inRequestedWindow) {
      stats.datesInWindow.add(tDate);
      if (!stats.minWindowDate || tDate < stats.minWindowDate) stats.minWindowDate = tDate;
      if (!stats.maxWindowDate || tDate > stats.maxWindowDate) stats.maxWindowDate = tDate;
      liveAttRowsInWindow++;
      if (!liveGlobalTrackerMin || tDate < liveGlobalTrackerMin) liveGlobalTrackerMin = tDate;
      if (!liveGlobalTrackerMax || tDate > liveGlobalTrackerMax) liveGlobalTrackerMax = tDate;
    }

    if (!trainingSampleSeen.has(code) && (liveFsDirByCode.has(code) || currentEmpAccId === FRONTSTEPS_KRONOS_ACCOUNT_ID)) {
      trainingSampleSeen.add(code);
      if (stats.livePstEndDate) pstEndPopulated++;
      if (stats.liveCertificationDate) certPopulated++;
      if (stats.liveGradBayStartDate || stats.liveGradBayEndDate) gradBayPopulated++;
      if (stats.liveFullGoLiveDate) fullGoLivePopulated++;
    }
  }

  // Group approved leaves by employee code
  const approvedLeavesByCode = new Map();
  for (const lv of leaves) {
    if (String(lv.gy_leave_status) !== '1') continue;
    const code = codeByUserId.get(lv.gy_user_id);
    if (!code) continue;
    approvedLeavesByCode.set(code, (approvedLeavesByCode.get(code) || 0) + Number(lv.gy_leave_day || 0));
  }

  // Group Live schedules (with DB fallback) per employee code
  const liveSchedByCode = new Map();
  if (liveKronos.available || (liveKronos.scheduleRows || []).length > 0) {
    for (const s of liveKronos.scheduleRows || []) {
      const code = String(s.gyEmpCode || s.employeeUid || '').trim();
      const sDay = parseValidKronosDate(s.schedDay || s.gy_sched_day);
      if (!code || !sDay || !isScheduleRowActive(s)) continue;
      let st = liveSchedByCode.get(code);
      if (!st) {
        st = {
          scheduledDaysInWindow: new Set(),
          scheduledDatesAfterEndDate: new Set(),
          novemberDates: new Set(),
          latestScheduleDate: null,
        };
        liveSchedByCode.set(code, st);
      }
      if (!st.latestScheduleDate || sDay > st.latestScheduleDate) st.latestScheduleDate = sDay;
      if ((!startDate || sDay >= startDate) && (!endDate || sDay <= endDate)) {
        st.scheduledDaysInWindow.add(sDay);
      } else if (endDate && sDay > endDate) {
        st.scheduledDatesAfterEndDate.add(sDay);
      }
      if (sDay.slice(0, 7) === '2026-11') {
        st.novemberDates.add(sDay);
      }
    }
  }

  const dbSchedByEmpId = new Map();
  for (const s of dbSchedules) {
    if (Number(s.gy_sched_mode) !== 1) continue;
    const sDay = parseValidKronosDate(s.gy_sched_day);
    if (startDate && endDate && sDay && (sDay < startDate || sDay > endDate)) continue;
    dbSchedByEmpId.set(s.gy_emp_id, (dbSchedByEmpId.get(s.gy_emp_id) || 0) + 1);
  }

  // Build normalized Kronos known-personnel lookup across ALL active Live Directory + all gy_employee DB rows
  const kronosKnownPersonnelMap = new Map();
  const indexKnownPerson = (name, meta) => {
    const key = normalizePersonNameForMatch(name);
    if (!key) return;
    if (!kronosKnownPersonnelMap.has(key)) kronosKnownPersonnelMap.set(key, []);
    kronosKnownPersonnelMap.get(key).push(meta);
  };
  for (const d of liveKronos.fullDirectoryRows || []) {
    const fullName =
      d.userFullName || `${d.firstName || ''} ${d.lastName || ''}`.replace(/\s+/g, ' ').trim();
    indexKnownPerson(fullName, {
      code: String(d.sibsId || '').trim(),
      fullName,
      account: d.account || null,
      accountId: d.accountId ? Number(d.accountId) : null,
      source: 'LIVE_KRONOS_DIRECTORY',
    });
  }
  for (const d of liveKronos.fsDirectoryRows || []) {
    const fullName =
      d.userFullName || `${d.firstName || ''} ${d.lastName || ''}`.replace(/\s+/g, ' ').trim();
    indexKnownPerson(fullName, {
      code: String(d.sibsId || '').trim(),
      fullName,
      account: d.account || 'FrontSteps',
      accountId: FRONTSTEPS_KRONOS_ACCOUNT_ID,
      source: 'LIVE_KRONOS_FS_DIRECTORY',
    });
  }
  for (const emp of allKronosDirectoryDb) {
    indexKnownPerson(emp.gy_emp_fullname, {
      code: emp.gy_emp_code ? String(emp.gy_emp_code).trim() : null,
      fullName: emp.gy_emp_fullname,
      account: emp.gy_emp_account || null,
      accountId: emp.gy_acc_id ? Number(emp.gy_acc_id) : null,
      source: 'KRONOS_DB_GY_EMPLOYEE',
    });
  }

  // Build authoritative 6-category reconciliation
  const aliasIdMismatches = [];
  const separatedOrInactiveInPeriod = [];
  const separatedRecentLiveKronos = [];
  const historicalOrNonAgentAliases = [];
  const nonAgentRolesInAliases = [];
  const kronosActiveFsWithoutAlias = [];
  const activeStalledTrackerEmployees = [];
  const activeZeroScheduleUnverifiedEmployees = [];
  const excludedRosterEntries = [];
  const roster = [];
  const rosterBySibsId = new Map();
  const processedCodes = new Set();

  const verifiedRosterClearances =
    overrides?.verifiedRosterClearances ||
    verifiedProrationContext?.rosterClearances ||
    {};

  // Determine whether peer FrontSteps agents have active Kronos attendance or schedules in this window
  const activeFsAttendingPeersCount = Array.from(liveAttByCode.values()).filter(
    (a) => a.datesInWindow.size > 0
  ).length;
  const activeFsScheduledPeersCount =
    Array.from(liveSchedByCode.values()).filter((s) => s.scheduledDaysInWindow.size > 0).length +
    (liveSchedByCode.size === 0
      ? Array.from(dbSchedByEmpId.values()).filter((c) => c > 0).length
      : 0);
  const kronosHasWindowTelemetry =
    Boolean(liveKronos.available || dbSchedules.length > 0) &&
    (activeFsAttendingPeersCount > 0 || activeFsScheduledPeersCount > 0);

  // Overall effective Live tracker max date within requested window (to detect stalled agents cleanly)
  const effectiveWindowEnd = endDate || liveGlobalTrackerMax;

  function classifyAndRegister(candidate) {
    const {
      sibsId,
      kronosRec,
      aliasInfo,
      liveDirRec,
      empIdFallbackMatch,
    } = candidate;

    const code = liveDirRec?.sibsId
      ? String(liveDirRec.sibsId).trim()
      : kronosRec?.gy_emp_code
        ? String(kronosRec.gy_emp_code).trim()
        : sibsId;
    if (code) processedCodes.add(code);

    const userRec = (code && userByCode.get(code)) || null;
    const liveAtt = (code && liveAttByCode.get(code)) || null;
    const liveSched = (code && liveSchedByCode.get(code)) || null;
    const liveFullRec = (code && liveFullDirByCode.get(code)) || null;

    // Combine DB + Live Kronos metadata cleanly (rejecting '0000-00-00')
    const dbLwd = parseValidKronosDate(kronosRec?.gy_last_working_day);
    const liveLwd = liveAtt?.liveLastWorkingDay || null;
    const effectiveLwd = liveLwd || dbLwd || null;
    const isSeparatedByDate = Boolean(effectiveLwd && (!endDate || effectiveLwd <= endDate));

    const dbUserInactive = userRec && Number(userRec.gy_user_status) !== 0;
    const presentInLiveFsDir = Boolean(liveDirRec);
    const liveDirUserStatus = liveDirRec?.userStatus ?? liveFullRec?.userStatus ?? null;
    const isActiveInLiveFsDir = presentInLiveFsDir && Number(liveDirUserStatus ?? 0) === 0;

    // Detect employees separated AFTER the frozen DB snapshot (e.g. 6859 in Live Kronos)
    const absentFromLiveDirectoryWhenLoaded =
      liveKronos.available &&
      (liveKronos.fsDirectoryRows || []).length > 0 &&
      !presentInLiveFsDir;

    const dbAccId = kronosRec?.gy_acc_id !== undefined ? Number(kronosRec.gy_acc_id) : null;
    const dbAccountName = String(kronosRec?.gy_emp_account || '');
    const liveAccId = liveDirRec?.accountId !== undefined
      ? Number(liveDirRec.accountId)
      : liveAtt?.liveAccountId ?? null;
    const liveAccountName = liveDirRec?.account || liveAtt?.liveAccountName || '';

    const isFrontStepsAccount = Boolean(
      isActiveInLiveFsDir ||
        liveAccId === FRONTSTEPS_KRONOS_ACCOUNT_ID ||
        dbAccId === FRONTSTEPS_KRONOS_ACCOUNT_ID ||
        dbAccountName.toLowerCase().includes('frontsteps') ||
        liveAccountName.toLowerCase().includes('frontsteps')
    );

    const empTypeNum = Number(liveDirRec?.userType ?? kronosRec?.gy_emp_type ?? 1);
    const isAgentRole = Boolean(
      isActiveInLiveFsDir ||
        (!dbAccountName.toLowerCase().includes('team leader') && empTypeNum === 1)
    );

    const employeeName =
      liveDirRec?.userFullName ||
      kronosRec?.gy_emp_fullname ||
      aliasInfo?.callsAlias ||
      aliasInfo?.casesAlias ||
      `Employee ${sibsId}`;

    const assignedLoc =
      liveDirRec?.gy_assignedloc !== undefined && liveDirRec?.gy_assignedloc !== null
        ? Number(liveDirRec.gy_assignedloc)
        : liveAtt?.liveAssignedLoc !== null && liveAtt?.liveAssignedLoc !== undefined
          ? liveAtt.liveAssignedLoc
          : kronosRec?.gy_assignedloc !== undefined && kronosRec?.gy_assignedloc !== null
            ? Number(kronosRec.gy_assignedloc)
            : null;

    // Category 6: Alias ID mismatch (`1403->5515`, `1603->5689`)
    if (empIdFallbackMatch) {
      const mismatchObj = {
        sibsId,
        aliasSibsId: sibsId,
        expectedKronosEmpCode: String(empIdFallbackMatch.gy_emp_code),
        kronosEmpId: empIdFallbackMatch.gy_emp_id,
        kronosUserStatus: userRec?.gy_user_status ?? null,
        employeeName: empIdFallbackMatch.gy_emp_fullname,
        callsAlias: aliasInfo?.callsAlias || null,
        casesAlias: aliasInfo?.casesAlias || null,
        identityCategory: IDENTITY_CATEGORIES.ALIAS_EMPID_MISMATCH,
        issue: `Alias sibs_id '${sibsId}' points to Kronos gy_emp_id instead of gy_emp_code '${empIdFallbackMatch.gy_emp_code}' (source record not auto-rewritten).`,
        reason: `Alias sibs_id '${sibsId}' references Kronos gy_emp_id (expected gy_emp_code '${empIdFallbackMatch.gy_emp_code}'); excluded from active scorecards.`,
        retainedInGlobalTotals: true,
      };
      aliasIdMismatches.push(mismatchObj);
      excludedRosterEntries.push(mismatchObj);
      return;
    }

    // Category 4: Recent post-frozen-snapshot separation proved by Live Kronos (e.g. 6859)
    if (
      (liveLwd && !dbLwd && isSeparatedByDate) ||
      (!presentInLiveFsDir &&
        absentFromLiveDirectoryWhenLoaded &&
        !dbUserInactive &&
        !isSeparatedByDate &&
        dbAccId === FRONTSTEPS_KRONOS_ACCOUNT_ID)
    ) {
      const sepObj = {
        sibsId,
        kronosEmpCode: code,
        kronosEmpId: kronosRec?.gy_emp_id || null,
        employeeName,
        identityCategory: IDENTITY_CATEGORIES.SEPARATED_RECENT_LIVE_KRONOS,
        separatedDate: liveLwd || liveAtt?.maxAnyDate || null,
        lastWorkingDayInDb: dbLwd,
        lastWorkingDayInLiveKronos: liveLwd,
        maxTrackerDate: liveAtt?.maxAnyDate || null,
        kronosAccount: liveFullRec?.account || dbAccountName || 'Separated/Inactive',
        callsAlias: aliasInfo?.callsAlias || null,
        casesAlias: aliasInfo?.casesAlias || null,
        reason: `Separated/inactive post-frozen-snapshot in Live Kronos (absent from Live Directory account_id=64${liveLwd ? `, Live LWD=${liveLwd}` : ''}; frozen kronosDb showed '${kronosRec?.gy_last_working_day || 'null'}').`,
        retainedInGlobalTotals: true,
      };
      separatedRecentLiveKronos.push(sepObj);
      separatedOrInactiveInPeriod.push({
        sibsId,
        employeeName,
        lastWorkingDay: sepObj.separatedDate,
        kronosUserStatus: liveFullRec?.userStatus ?? 'ABSENT_LIVE_DIR',
        reason: sepObj.reason,
      });
      excludedRosterEntries.push(sepObj);
      return;
    }

    // Category 5: Historical / separated / non-agent alias (`3566, 3707, 4604, 5179, ..., 6888`)
    const isHistoricalInactive =
      !isActiveInLiveFsDir &&
      (isSeparatedByDate ||
        dbUserInactive ||
        absentFromLiveDirectoryWhenLoaded ||
        !isFrontStepsAccount);

    if (isHistoricalInactive || !isAgentRole) {
      const reasonParts = [];
      if (!isAgentRole) {
        reasonParts.push(
          `Non-agent Kronos role (${dbAccountName || `gy_emp_type=${empTypeNum}`})`
        );
        nonAgentRolesInAliases.push({
          sibsId,
          employeeName,
          kronosAccount: dbAccountName,
          kronosEmpType: kronosRec?.gy_emp_type ?? null,
        });
      }
      if (isSeparatedByDate) reasonParts.push(`LWD=${effectiveLwd}`);
      if (dbUserInactive) reasonParts.push(`gy_user_status=${userRec?.gy_user_status}`);
      if (!isFrontStepsAccount) {
        reasonParts.push(`Kronos account='${liveAccountName || dbAccountName || 'None'}'`);
      } else if (absentFromLiveDirectoryWhenLoaded) {
        reasonParts.push('Absent from Live Kronos Directory (account_id=64)');
      }

      const histObj = {
        sibsId,
        kronosEmpCode: code,
        kronosEmpId: kronosRec?.gy_emp_id || null,
        employeeName,
        identityCategory: IDENTITY_CATEGORIES.HISTORICAL_OR_NON_AGENT_ALIAS,
        separatedDate: effectiveLwd,
        kronosAccount: liveAccountName || dbAccountName || null,
        kronosUserStatus: userRec?.gy_user_status ?? null,
        callsAlias: aliasInfo?.callsAlias || null,
        casesAlias: aliasInfo?.casesAlias || null,
        reason: reasonParts.join('; ') || 'Historical/non-agent alias excluded from active scorecards',
        retainedInGlobalTotals: true,
      };
      historicalOrNonAgentAliases.push(histObj);
      if (isSeparatedByDate || dbUserInactive) {
        separatedOrInactiveInPeriod.push({
          sibsId,
          employeeName,
          lastWorkingDay: effectiveLwd,
          kronosUserStatus: userRec?.gy_user_status ?? null,
        });
      }
      excludedRosterEntries.push(histObj);
      return;
    }

    // Verified active FrontSteps categories (Categories 1, 2, and 3)
    const maxTrackerDate = liveAtt?.maxWindowDate || liveAtt?.maxAnyDate || null;
    const minTrackerDate = liveAtt?.minWindowDate || null;
    const scheduledDaysCount = liveSched
      ? liveSched.scheduledDaysInWindow.size
      : (kronosRec?.gy_emp_id ? dbSchedByEmpId.get(kronosRec.gy_emp_id) || 0 : 0);

    // Detect active directory agent with scheduled shifts whose tracker stalled mid-period (e.g. 6855 stopping 2026-10-07)
    let scheduledDaysAfterMaxTracker = 0;
    if (liveSched && maxTrackerDate && effectiveWindowEnd && maxTrackerDate < effectiveWindowEnd) {
      for (const sd of liveSched.scheduledDaysInWindow) {
        if (sd > maxTrackerDate && (!liveGlobalTrackerMax || sd <= liveGlobalTrackerMax)) {
          scheduledDaysAfterMaxTracker++;
        }
      }
    }
    const hasStalledTracker = Boolean(
      liveKronos.available &&
        maxTrackerDate &&
        liveGlobalTrackerMax &&
        maxTrackerDate < liveGlobalTrackerMax &&
        scheduledDaysAfterMaxTracker >= 3
    );

    const attendanceDaysInWindow = liveAtt?.datesInWindow?.size || 0;
    const approvedLeaveDays = Number((code && approvedLeavesByCode.get(code)) || 0);
    const clearanceEntry =
      verifiedRosterClearances?.[code] ||
      (liveDirRec?.clearedActive === true
        ? {
            cleared: true,
            reason: liveDirRec.clearanceReason || 'Authoritative directory clearance provided',
          }
        : null);
    const hasAuthoritativeClearance = Boolean(clearanceEntry && clearanceEntry.cleared !== false);

    // Phase 7A.1 Zero-Schedule Safeguard: active directory employee with 0 schedules AND 0 punches
    // and 0 approved leave while peer FrontSteps agents have active Kronos telemetry cannot silently
    // clear into VERIFIED_ACTIVE_FRONTSTEPS without authoritative separation/leave/HR clearance.
    const hasZeroScheduleAndAttendance = Boolean(
      !hasStalledTracker &&
        kronosHasWindowTelemetry &&
        attendanceDaysInWindow === 0 &&
        scheduledDaysCount === 0 &&
        approvedLeaveDays === 0 &&
        !hasAuthoritativeClearance
    );

    const rosterVerificationRequired = hasStalledTracker || hasZeroScheduleAndAttendance;
    const rosterVerificationReasonCodes = [];
    if (hasStalledTracker) {
      rosterVerificationReasonCodes.push('TRACKER_HALTED_WITH_SUBSEQUENT_SCHEDULES');
    }
    if (hasZeroScheduleAndAttendance) {
      rosterVerificationReasonCodes.push('ZERO_SCHEDULE_AND_ZERO_ATTENDANCE_IN_WINDOW');
      rosterVerificationReasonCodes.push('NO_AUTHORITATIVE_SEPARATION_OR_LEAVE_CLEARANCE');
    }

    const hasAliasMapping = Boolean(aliasInfo);
    let identityCategory = IDENTITY_CATEGORIES.VERIFIED_ACTIVE_FRONTSTEPS;
    const statusNotes = [];

    if (!hasAliasMapping && !hasZeroScheduleAndAttendance) {
      identityCategory = IDENTITY_CATEGORIES.MISSING_ALIAS_ACTIVE_FS;
      statusNotes.push(
        `Active in Live Kronos Directory (account_id=64, tracker=${attendanceDaysInWindow}d, schedules=${scheduledDaysCount}d) without an entry in frontsteps_employee_aliases.`
      );
      kronosActiveFsWithoutAlias.push({
        gyEmpCode: code,
        employeeName,
        hireDate: parseValidKronosDate(liveDirRec?.hireDate || kronosRec?.gy_emp_hiredate),
        site: locationLabel(assignedLoc),
        isWfh: Number(kronosRec?.gy_work_from ?? liveAtt?.liveWorkFrom ?? 0) === 1,
        trackerDaysInWindow: attendanceDaysInWindow,
        scheduledDaysInWindow: scheduledDaysCount,
      });
    } else if (hasStalledTracker) {
      identityCategory = IDENTITY_CATEGORIES.ACTIVE_DIRECTORY_STALLED_TRACKER;
      statusNotes.push(
        `Active in Live Kronos Directory (userStatus=0), but attendance stops at ${maxTrackerDate} with ${scheduledDaysAfterMaxTracker} subsequent scheduled day(s) unlogged${liveSched && liveSched.novemberDates.size === 0 ? ` and 0 November schedules (schedule ends ${liveSched.latestScheduleDate || 'N/A'})` : ''}.`
      );
      activeStalledTrackerEmployees.push({
        sibsId: code,
        employeeName,
        maxTrackerDate,
        latestScheduleDate: liveSched?.latestScheduleDate || null,
        scheduledDaysAfterHalt: scheduledDaysAfterMaxTracker,
        novemberScheduleCount: liveSched?.novemberDates?.size || 0,
        reason: statusNotes[0],
      });
    } else if (hasZeroScheduleAndAttendance) {
      identityCategory = IDENTITY_CATEGORIES.ACTIVE_DIRECTORY_ZERO_SCHEDULE_UNVERIFIED;
      statusNotes.push(
        `Active in Live Kronos Directory (userStatus=0), but recorded 0 scheduled workdays, 0 attendance punches, and 0 approved leave days in ${startDate || 'period'}..${endDate || 'end'} while ${Math.max(activeFsAttendingPeersCount, activeFsScheduledPeersCount)} FrontSteps peer(s) had active Kronos schedules/punches; requires HR/Ops separation, transfer, or clearance verification.`
      );
      activeZeroScheduleUnverifiedEmployees.push({
        sibsId: code,
        employeeName,
        maxTrackerDate,
        latestScheduleDate: liveSched?.latestScheduleDate || null,
        scheduledDaysInWindow: scheduledDaysCount,
        attendanceDaysInWindow,
        approvedLeaveDays,
        hasAliasMapping,
        reasonCodes: rosterVerificationReasonCodes,
        reason: statusNotes[0],
      });
    } else if (hasAuthoritativeClearance && attendanceDaysInWindow === 0 && scheduledDaysCount === 0) {
      statusNotes.push(
        `Authoritative roster clearance applied: ${clearanceEntry.reason || 'Confirmed active FrontSteps assignment'}.`
      );
    }

    const row = {
      sibsId: code,
      kronosEmpCode: code,
      kronosEmpId: kronosRec?.gy_emp_id || null,
      employeeName,
      kronosMatchType: kronosRec || liveDirRec ? 'EXACT_EMP_CODE' : 'UNMATCHED_IN_KRONOS',
      hasAliasMapping,
      aliasActive: aliasInfo ? aliasInfo.active : false,
      callsAlias: aliasInfo?.callsAlias || null,
      casesAlias: aliasInfo?.casesAlias || null,
      identityCategory,
      identityStatusNotes: statusNotes,
      isVerifiedActiveFrontSteps: true,
      hasStalledTracker,
      hasZeroScheduleAndAttendance,
      rosterVerificationRequired,
      rosterVerificationReasonCodes,
      authoritativeClearanceApplied: hasAuthoritativeClearance,
      trackerHaltedSince: hasStalledTracker ? maxTrackerDate : null,
      scheduledDaysAfterHalt: scheduledDaysAfterMaxTracker,
      isFrontStepsAccount: true,
      isAgentRole: true,
      isSeparated: false,
      lastWorkingDay: effectiveLwd,
      hireDate: parseValidKronosDate(liveDirRec?.hireDate || kronosRec?.gy_emp_hiredate),
      accountJoinDate: parseValidKronosDate(liveAtt?.liveAccJoinDate || kronosRec?.gy_accjoin),
      pstStartDate: parseValidKronosDate(liveAtt?.livePstStartDate || kronosRec?.gy_pststartdate),
      pstEndDate: parseValidKronosDate(liveAtt?.livePstEndDate || kronosRec?.gy_pstenddate),
      fullGoLiveDate: parseValidKronosDate(liveAtt?.liveFullGoLiveDate || kronosRec?.gy_fullgolivedate),
      assignedLoc,
      siteName: liveDirRec?.site || locationLabel(assignedLoc),
      isWfh: Number(liveAtt?.liveWorkFrom ?? kronosRec?.gy_work_from ?? 0) === 1,
      kronosUserStatus: liveDirUserStatus ?? userRec?.gy_user_status ?? null,
      approvedLeaveDays,
      scheduledWorkdays: scheduledDaysCount,
      latestScheduleDate: liveSched?.latestScheduleDate || null,
      novemberScheduleCount: liveSched?.novemberDates?.size || 0,
      attendanceDaysCount: attendanceDaysInWindow,
      minTrackerDate,
      maxTrackerDate,
    };

    roster.push(row);
    rosterBySibsId.set(row.sibsId, row);
  }

  // 1. Reconcile every alias entry in frontsteps_employee_aliases
  for (const [aliasSibsId, aliasInfo] of aliasBySibsId.entries()) {
    const exactCodeMatch = kronosByCode.get(aliasSibsId) || null;
    const empIdFallbackMatch = !exactCodeMatch ? kronosByEmpId.get(aliasSibsId) || null : null;
    const kronosRec = exactCodeMatch || empIdFallbackMatch;
    const liveDirRec = liveFsDirByCode.get(aliasSibsId) || null;

    classifyAndRegister({
      sibsId: aliasSibsId,
      kronosRec,
      aliasInfo,
      liveDirRec,
      empIdFallbackMatch,
    });
  }

  // 2. Reconcile active Live Kronos Directory FrontSteps employees lacking aliases (e.g. 3463)
  //    or in DB fallback when Kronos DB shows active unaliased FS employee
  for (const dirEmp of liveKronos.fsDirectoryRows || []) {
    const code = dirEmp.sibsId ? String(dirEmp.sibsId).trim() : null;
    if (!code || processedCodes.has(code)) continue;
    classifyAndRegister({
      sibsId: code,
      kronosRec: kronosByCode.get(code) || null,
      aliasInfo: null,
      liveDirRec: dirEmp,
      empIdFallbackMatch: null,
    });
  }

  if (!liveKronos.available) {
    for (const emp of kronosEmployees) {
      const code = emp.gy_emp_code ? String(emp.gy_emp_code).trim() : null;
      const empIdStr = emp.gy_emp_id ? String(emp.gy_emp_id).trim() : null;
      if (!code || processedCodes.has(code)) continue;
      if (aliasBySibsId.has(code) || (empIdStr && aliasBySibsId.has(empIdStr))) continue;

      const isFs =
        Number(emp.gy_acc_id) === FRONTSTEPS_KRONOS_ACCOUNT_ID ||
        String(emp.gy_emp_account || '').toLowerCase().includes('frontsteps');
      const lwd = parseValidKronosDate(emp.gy_last_working_day);
      const userRec = userByCode.get(code);
      const isInactiveUser = userRec && Number(userRec.gy_user_status) !== 0;
      const activeInKronos = (!lwd || (endDate && lwd > endDate)) && !isInactiveUser;
      if (isFs && activeInKronos) {
        classifyAndRegister({
          sibsId: code,
          kronosRec: emp,
          aliasInfo: null,
          liveDirRec: null,
          empIdFallbackMatch: null,
        });
      }
    }
  }

  // Sort active roster deterministically by employeeName
  roster.sort((a, b) => String(a.employeeName).localeCompare(String(b.employeeName)));

  const effectiveTrackerCoverage =
    liveKronos.available && liveAttRowsInWindow > 0
      ? {
          rowCount: liveAttRowsInWindow,
          minDate: liveGlobalTrackerMin,
          maxDate: liveGlobalTrackerMax,
          source: 'LIVE_KRONOS_API',
          dbSnapshotMaxDate: dbTrackerSummary?.maxDate || null,
        }
      : {
          ...(dbTrackerSummary || { rowCount: 0, minDate: null, maxDate: null }),
          source: 'KRONOS_DB_SNAPSHOT',
          dbSnapshotMaxDate: dbTrackerSummary?.maxDate || null,
        };

  // Explicit Proration & Attendance Completeness Validation (fail-closed)
  const prorationBlockingReasons = [];
  if (verifiedProrationContext?.isVerifiedComplete !== true) {
    prorationBlockingReasons.push(
      'Approved training/PST-end, nesting/grad-bay, and partial-production day ledgers are unpopulated (Live Kronos & kronos_testdb end/go-live dates are 0000-00-00; HRIS training plans have 0 rows).'
    );
    prorationBlockingReasons.push(
      'Active policy specifies Cases Closed weekly target 140 prorated for approved leave/training/holidays/partial production days without a deterministic numeric divisor for partial shifts and holidays worked vs off.'
    );
    if (!liveKronos.available && endDate && dbTrackerSummary?.maxDate && dbTrackerSummary.maxDate < endDate) {
      prorationBlockingReasons.push(
        `Kronos DB fallback tracker stops at ${dbTrackerSummary.maxDate} while Live Kronos API was unavailable (window extends to ${endDate}).`
      );
    }
    if (
      leaveCoverageMaxInDb &&
      endDate &&
      leaveCoverageMaxInDb < endDate
    ) {
      prorationBlockingReasons.push(
        `Approved leave ledger in kronos_testdb extends only through ${leaveCoverageMaxInDb} (missing post-${leaveCoverageMaxInDb} through ${endDate}).`
      );
    }
    if (activeStalledTrackerEmployees.length > 0) {
      const names = activeStalledTrackerEmployees
        .map((e) => `${e.employeeName} (${e.sibsId}, last punch ${e.maxTrackerDate})`)
        .join('; ');
      prorationBlockingReasons.push(
        `Active directory agent attendance halted mid-period with open scheduled shifts: ${names}.`
      );
    }
    if (activeZeroScheduleUnverifiedEmployees.length > 0) {
      const names = activeZeroScheduleUnverifiedEmployees
        .map((e) => `${e.employeeName} (${e.sibsId}, 0 schedules / 0 punches)`)
        .join('; ');
      prorationBlockingReasons.push(
        `Active directory agent(s) have 0 schedules, 0 punches, and 0 approved leave without authoritative HR/Ops clearance: ${names}.`
      );
    }
  }

  const holidayBreakdown = (holidays || []).map((h) => ({
    id: h.gy_hol_id,
    title: h.gy_hol_title,
    date: parseValidKronosDate(h.gy_hol_date),
    locCode: h.gy_hol_loc !== undefined && h.gy_hol_loc !== null ? Number(h.gy_hol_loc) : null,
    locLabel: locationLabel(h.gy_hol_loc),
    typeId: h.gy_hol_type_id ?? null,
  }));

  const warnings = [];
  if (liveKronos.error) {
    warnings.push(`Live Kronos API fallback active: ${liveKronos.error}`);
  }
  if (separatedRecentLiveKronos.length > 0) {
    warnings.push(
      `${separatedRecentLiveKronos.length} employee(s) excluded after Live Kronos confirmed separation post frozen snapshot (${separatedRecentLiveKronos.map((s) => `${s.employeeName} [${s.sibsId}]`).join(', ')}).`
    );
  }
  if (activeStalledTrackerEmployees.length > 0) {
    for (const st of activeStalledTrackerEmployees) {
      warnings.push(
        `Active FrontSteps employee ${st.employeeName} (${st.sibsId}) has Live Kronos tracker stopping on ${st.maxTrackerDate} despite ${st.scheduledDaysAfterHalt} subsequent scheduled workday(s); missing attendance is flagged, not fabricated as unexcused absence.`
      );
    }
  }
  if (activeZeroScheduleUnverifiedEmployees.length > 0) {
    for (const zs of activeZeroScheduleUnverifiedEmployees) {
      warnings.push(zs.reason);
    }
  }

  for (const r of roster) {
    r.availabilityStatus = resolveEmployeeAvailabilityState(r);
  }
  for (const ex of excludedRosterEntries) {
    ex.availabilityStatus = resolveEmployeeAvailabilityState(ex);
  }

  return {
    roster,
    rosterBySibsId,
    excludedRosterEntries,
    kronosKnownPersonnelMap,
    holidays,
    leaves,
    verifiedProrationContext: verifiedProrationContext || null,
    diagnostics: {
      totalAliasRows: aliases.length,
      distinctAliasSibsIds: aliasSibsIds.length,
      verifiedActiveCount: roster.length,
      excludedCount: excludedRosterEntries.length,
      kronosExactMatchedCount: roster.filter((r) => r.kronosMatchType === 'EXACT_EMP_CODE').length,
      trackerSource: effectiveTrackerCoverage.source,
      liveKronosAvailable: Boolean(liveKronos.available),
      liveKronosError: liveKronos.error || null,
      liveDirectoryFrontStepsCount: (liveKronos.fsDirectoryRows || []).length,
      liveFullDirectoryCount: (liveKronos.fullDirectoryRows || []).length,
      kronosDbTotalEmployeeCount: allKronosDirectoryDb.length,
      aliasIdMismatches,
      separatedOrInactiveInPeriod,
      separatedRecentLiveKronos,
      historicalOrNonAgentAliases,
      nonAgentRolesInAliases,
      kronosActiveFsWithoutAlias,
      activeStalledTrackerEmployees,
      activeZeroScheduleUnverifiedEmployees,
      warnings,
      holidayCountInPeriod: holidays.length,
      holidayBreakdown,
      approvedLeaveRecordsInPeriod: leaves.filter((l) => String(l.gy_leave_status) === '1').length,
      leaveCoverage: {
        approvedLeaveRecordsInPeriod: leaves.filter((l) => String(l.gy_leave_status) === '1').length,
        maxApprovedLeaveDateInDb: leaveCoverageMaxInDb,
        gapAfterDate:
          leaveCoverageMaxInDb && endDate && leaveCoverageMaxInDb < endDate
            ? leaveCoverageMaxInDb
            : null,
      },
      trainingLedgerCoverage: {
        pstEndDatesPopulated: pstEndPopulated,
        certificationDatesPopulated: certPopulated,
        gradBayDatesPopulated: gradBayPopulated,
        fullGoLiveDatesPopulated: fullGoLivePopulated,
      },
      trackerCoverage: effectiveTrackerCoverage,
      prorationReadiness: {
        isVerifiedComplete: verifiedProrationContext?.isVerifiedComplete === true,
        blockingReasons: prorationBlockingReasons,
      },
    },
  };
}
