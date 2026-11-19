/**
 * Kronos's employee-directory supports a department filter, NOT an account filter.
 * Fetch Call Center Operations (department 1), then verify the returned accountId
 * in PMS before matching employees against the historical PMS US Visa roster.
 *
 * This module is intentionally independent of API transport for fixture testing.
 */
const DIRECTORY_PAGE_LIMIT = 100;
const DIRECTORY_MAX_PAGES = 200;
const US_VISA_ACCOUNT_ID = 20;
const CALL_CENTER_DEPARTMENT_ID = 1;

function sourceError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  throw error;
}

function firstValue(row, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((object, key) => object?.[key], row);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizedUid(value) {
  return String(value ?? '').trim().replace(/^SIB-\s*/i, '').trim().toUpperCase();
}

export function selectUsVisaDirectoryEmployees(rows, {
  accountId = US_VISA_ACCOUNT_ID,
  departmentId = CALL_CENTER_DEPARTMENT_ID,
} = {}) {
  if (!Array.isArray(rows)) {
    sourceError('Kronos department directory did not return a data array.', 'KRONOS_DIRECTORY_INCOMPLETE');
  }
  const byUid = new Map();
  let accountMatchedRows = 0;
  let missingSibsIdRows = 0;
  for (const row of rows) {
    // Account is ALWAYS filtered locally; never trust an unsupported account_id
    // query argument. Missing/invalid account membership is not eligible.
    const returnedAccount = positiveId(firstValue(row, [
      'accountId', 'account_id', 'gy_acc_id', 'employee.accountId', 'employee.gy_acc_id',
    ]));
    if (returnedAccount !== accountId) continue;
    const returnedDepartment = positiveId(firstValue(row, [
      'departmentId', 'department_id', 'employee.departmentId',
    ]));
    if (returnedDepartment !== null && returnedDepartment !== departmentId) continue;
    accountMatchedRows += 1;

    const employeeUid = normalizedUid(firstValue(row, [
      'sibsId', 'employee.sibsId', 'gy_emp_code', 'employee.gy_emp_code',
      'employee_code', 'employee.employee_code', 'sibs_id', 'employee.sibs_id',
      'employeeUid', 'employee_uid',
    ]));
    if (!employeeUid) { missingSibsIdRows += 1; continue; }
    const gyEmpId = positiveId(firstValue(row, [
      'gy_emp_id', 'employee.gy_emp_id', 'employee_id',
    ])); // directory may not expose this field; never invent it

    const previous = byUid.get(employeeUid);
    if (previous?.gyEmpId && gyEmpId && previous.gyEmpId !== gyEmpId) {
      sourceError(`Conflicting Kronos IDs for employee ${employeeUid}.`, 'KRONOS_EMPLOYEE_ID_CONFLICT');
    }
    byUid.set(employeeUid, { employeeUid, gyEmpId: gyEmpId ?? previous?.gyEmpId ?? null });
  }
  if (missingSibsIdRows) {
    sourceError(
      `Kronos Account ${accountId} directory contains ${missingSibsIdRows} employee records without SiBS IDs.`,
      'KRONOS_DIRECTORY_IDENTITY_INCOMPLETE',
    );
  }
  return { byUid, accountMatchedRows };
}

/**
 * A documented department_id request is always used; account filtering happens
 * only after collection. Supports either a single unpaginated data[] response or
 * validated page metadata. Ambiguous exactly-limit unpaginated responses fail
 * closed rather than silently omitting employees.
 */
export async function fetchCallCenterDepartmentDirectory({ requestPage }) {
  const rows = [];
  let pageCount = null;
  let expectedTotal = null;
  let requestCount = 0;
  for (let page = 1; page <= DIRECTORY_MAX_PAGES; page += 1) {
    const payload = await requestPage('/api/v1/employee-directory', {
      params: { department_id: CALL_CENTER_DEPARTMENT_ID, page, limit: DIRECTORY_PAGE_LIMIT },
      retryTransient: true,
      kpiShared: true,
    });
    requestCount += 1;
    if (payload?.success === false || !Array.isArray(payload?.data)) {
      sourceError(`Kronos department directory page ${page} is incomplete.`, 'KRONOS_DIRECTORY_INCOMPLETE');
    }
    const batch = payload.data;
    const pagination = payload.pagination;
    if (!pagination) {
      if (page !== 1 || batch.length === DIRECTORY_PAGE_LIMIT) {
        sourceError('Kronos department directory pagination is ambiguous.', 'KRONOS_DIRECTORY_PAGINATION_UNCONFIRMED');
      }
      // The API may ignore page/limit and return one complete data[] array.
      // Check directory-coverage counts against Kronos in DEV before production.
      return { rows: batch, requestCount, paginationMode: 'UNPAGINATED' };
    }
    const current = Number(pagination.currentPage ?? pagination.current_page);
    const pages = Number(pagination.totalPages ?? pagination.total_pages);
    const total = Number(pagination.totalRecords ?? pagination.total);
    if (page === 1 && current === 1 && pages === 0 && total === 0 && !batch.length) {
      return { rows: [], requestCount, paginationMode: 'PAGINATED' };
    }
    if (!Number.isSafeInteger(current) || current !== page ||
        !Number.isSafeInteger(pages) || pages < 1 || pages > DIRECTORY_MAX_PAGES ||
        !Number.isSafeInteger(total) || total < 0 ||
        (pageCount !== null && pages !== pageCount) ||
        (expectedTotal !== null && total !== expectedTotal)) {
      sourceError('Kronos department directory returned inconsistent pagination.', 'KRONOS_DIRECTORY_PAGINATION_INVALID');
    }
    pageCount = pages;
    expectedTotal = total;
    if (page > 1 && !batch.length) {
      sourceError('Kronos department directory returned an empty intermediate page.', 'KRONOS_DIRECTORY_INCOMPLETE');
    }
    rows.push(...batch);
    if (page === pageCount) {
      if (rows.length !== expectedTotal) {
        sourceError(`Kronos department directory returned ${rows.length} of ${expectedTotal} employees.`,
          'KRONOS_DIRECTORY_INCOMPLETE');
      }
      return { rows, requestCount, paginationMode: 'PAGINATED' };
    }
  }
  sourceError('Kronos department directory exceeded the safe page limit.', 'KRONOS_DIRECTORY_PAGE_LIMIT');
}
