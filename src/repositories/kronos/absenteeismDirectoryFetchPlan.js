/**
 * Directory-first Absenteeism retrieval plan.
 *
 * Keep the historical PMS employee ledger as the reporting roster. Verify its
 * employee codes against the Department 1 directory, locally filtered to Account 20, before requesting
 * attendance and per-employee schedules. Leaves are independently requested by
 * the dashboard service as a single account/date-scoped collection.
 *
 * This orchestration does not alter the absence/leave KPI calculations.
 */
function sourceUnavailable(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  throw error;
}

async function boundedMap(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export function assertDirectoryAttendanceIdentity(attendanceRows, directoryByUid) {
  // Also used for next-day attendance fetched for completed overnight shifts.
  for (const row of attendanceRows) {
    const expected = directoryByUid.get(row.employeeUid);
    if (!expected) {
      sourceUnavailable("Kronos attendance returned an unverified employee.",
        "KRONOS_ATTENDANCE_EMPLOYEE_UNVERIFIED");
    }
    if (row.gyEmpId && expected.gyEmpId && Number(row.gyEmpId) !== Number(expected.gyEmpId)) {
      sourceUnavailable(`Kronos employee ID mismatch for ${row.employeeUid}.`,
        "KRONOS_EMPLOYEE_ID_CONFLICT");
    }
  }
}

export async function fetchDirectoryScopedAbsenteeismSources({
  employeeCodes,
  kronosAccountId,
  dateFrom,
  dateTo,
  scheduleDateFrom = dateFrom,
  scheduleDateTo = dateTo,
  forceRefresh = false,
  fetchDirectory,
  fetchAttendance,
  fetchSchedule,
  scheduleConcurrency = 6,
}) {
  // The directory must complete before either dependent source starts.
  const fetchStartedAt = Date.now();
  let directory;
  try {
    directory = await fetchDirectory(kronosAccountId, { forceRefresh });
  } catch (error) {
    error.stage ??= "EMPLOYEE_DIRECTORY_FETCH";
    throw error;
  }
  const directoryMs = Date.now() - fetchStartedAt;
  if (!(directory?.byUid instanceof Map)) {
    sourceUnavailable("Kronos account directory was incomplete.", "KRONOS_DIRECTORY_INCOMPLETE");
  }

  const matchedEmployeeCodes = employeeCodes.filter((uid) => directory.byUid.has(uid));
  const unmatchedRosterEmployeeCount = employeeCodes.length - matchedEmployeeCodes.length;
  // An empty directory intersection must not masquerade as a valid zero-absence period.
  if (!matchedEmployeeCodes.length) {
    sourceUnavailable(
      "No PMS roster employees could be verified in the Kronos US Visa directory.",
      "KRONOS_DIRECTORY_NO_MATCHED_EMPLOYEES",
    );
  }

  const parallelStartedAt = Date.now();
  const [attendance, scheduleResults] = await Promise.all([
    (async () => {
      try {
        return await fetchAttendance({
          kronosAccountId,
          employeeUids: matchedEmployeeCodes,
          dateFrom,
          dateTo,
          forceRefresh,
        });
      } catch (error) {
        error.stage ??= "ATTENDANCE_FETCH";
        throw error;
      }
    })(),
    boundedMap(matchedEmployeeCodes, scheduleConcurrency, async (uid) => {
      try {
        const result = await fetchSchedule(uid, scheduleDateFrom, scheduleDateTo, { forceRefresh });
        return { uid, gyEmpId: directory.byUid.get(uid).gyEmpId, ...result };
      } catch (error) {
        error.stage ??= "SCHEDULE_PAGE_FETCH";
        throw error;
      }
    }),
  ]);

  assertDirectoryAttendanceIdentity(attendance.rows, directory.byUid);

  return {
    directory,
    attendance,
    scheduleResults,
    matchedEmployeeCodes,
    unmatchedRosterEmployeeCount,
    fetchTimingMs: {
      directory: directoryMs,
      concurrentSources: Date.now() - parallelStartedAt,
      total: Date.now() - fetchStartedAt,
    },
  };
}


/** Directory-free source orchestration. Identity comes only from the scoped ledger. */
export async function fetchLedgerScopedAbsenteeismSources({
  roster, kronosAccountId, dateFrom, dateTo,
  scheduleDateFrom = dateFrom, scheduleDateTo = dateTo,
  forceRefresh = false, fetchAttendance, fetchSchedule, scheduleConcurrency = 6,
}) {
  const started = Date.now();
  const byUid = new Map(roster.map(row => [row.employeeUid, row]));
  const matchedEmployeeCodes = [...byUid.keys()];
  const [attendance, scheduleResults] = await Promise.all([
    fetchAttendance({ kronosAccountId, employeeUids: matchedEmployeeCodes, dateFrom, dateTo, forceRefresh }),
    boundedMap(matchedEmployeeCodes, scheduleConcurrency, async uid => ({
      uid, gyEmpId: byUid.get(uid).gyEmpId,
      ...await fetchSchedule(uid, scheduleDateFrom, scheduleDateTo, { forceRefresh }),
    })),
  ]);
  assertDirectoryAttendanceIdentity(attendance.rows, byUid);
  return { byUid, attendance, scheduleResults, matchedEmployeeCodes,
    fetchTimingMs: { directory: 0, concurrentSources: Date.now() - started, total: Date.now() - started } };
}
