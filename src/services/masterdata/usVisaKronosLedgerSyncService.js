// Explicit preview -> approval -> apply for the US Visa Employee Ledger.
// Never invoke this service from a normal ledger GET or KPI request.
import { createHash, randomUUID } from "node:crypto";
import { pmsDb, pmsTables } from "../../config/db.js";
import { fetchKronosLedgerCollections } from "../../repositories/kronos/kronosEmployeeLedgerRepository.js";
import { buildUsVisaLedgerSyncPlan } from "./usVisaLedgerHierarchy.js";

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 10;
const previews = new Map();
let previewPending = null;

function makeError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function baselineFingerprint(rows) {
  return createHash("sha256").update(JSON.stringify(
    rows.map((r) => [String(r.id), String(r.sibs_id), String(r.updated_at ?? ""),
      String(r.kronos_name ?? ""), String(r.agent_name ?? ""), String(r.status ?? ""),
      String(r.task_order ?? ""), String(r.site ?? ""),
      String(r.kronos_account_id ?? ""), String(r.kronos_account_name ?? ""), String(r.kronos_user_status ?? ""),
      String(r.organizational_role ?? ""), String(r.role_source ?? ""),
      String(r.role_review_status ?? ""), String(r.kronos_emp_type ?? ""),
      String(r.hierarchy_sync_status ?? ""), String(r.supervisor_sibs_id ?? ""),
      String(r.us_visa_join_date ?? ""), String(r.us_visa_departure_date ?? ""),
      String(r.team_leader ?? ""), String(r.manager ?? ""), String(r.senior_manager ?? "")])
      .sort((a, b) => a[1].localeCompare(b[1])),
  )).digest("hex");
}

const LEDGER_SELECT = `
  SELECT id, sibs_id, kronos_name, agent_name, status, site, task_order,
         team_leader, manager, senior_manager,
         us_visa_join_date, us_visa_departure_date,
         kronos_employee_id, kronos_account_id, kronos_account_name, supervisor_user_id,
         supervisor_sibs_id, team_leader_sibs_id, manager_sibs_id,
         senior_manager_sibs_id, hierarchy_sync_status,
         kronos_membership_status, kronos_user_status,
         organizational_role, role_source, role_review_status, kronos_emp_type,
         updated_at
  FROM ${pmsTables.usVisaEmployeeLedger}
`;

function tidyPreviews() {
  for (const [key, value] of previews) {
    if (Date.now() > value.expiresAt) previews.delete(key);
  }
  while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
}

export async function previewUsVisaKronosLedgerSync({ actor }) {
  if (!actor) throw makeError("Authenticated sync owner is required.", "LEDGER_SYNC_UNAUTHORIZED", 403);
  // Prevent a double-click from starting two full company-wide API collections.
  if (previewPending) throw makeError("A Kronos ledger preview is already being prepared.", "LEDGER_SYNC_BUSY", 429);
  const owner = String(actor);
  const pending = (async () => {
    const [collections, ledgerResult] = await Promise.all([
      fetchKronosLedgerCollections(),
      pmsDb.query(LEDGER_SELECT),
    ]);
    const existingRows = ledgerResult[0];
    const plan = buildUsVisaLedgerSyncPlan({
      employees: collections.employees,
      users: collections.users,
      existingRows,
    });
    tidyPreviews();
    const token = randomUUID();
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    previews.set(token, {
      owner, expiresAt, plan,
      fingerprint: baselineFingerprint(existingRows),
      applying: false,
    });
    return {
      success: true,
      previewToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      summary: plan.summary,
      diagnostics: collections.diagnostics,
      previewRows: plan.preview,
      totalPreviewRows: plan.totalPreviewRows,
      previewTruncated: plan.totalPreviewRows > plan.preview.length,
      issues: plan.issues,
      message: "Preview generated. No database records have been changed.",
    };
  })();
  previewPending = pending;
  try { return await pending; }
  finally { previewPending = null; }
}

export async function applyUsVisaKronosLedgerSync({ actor, previewToken }) {
  const snapshot = previews.get(String(previewToken || ""));
  if (!snapshot || snapshot.expiresAt < Date.now()) {
    throw makeError("Kronos ledger preview has expired. Generate a new preview.", "LEDGER_SYNC_PREVIEW_EXPIRED");
  }
  if (snapshot.owner !== String(actor || "")) {
    throw makeError("This preview belongs to a different user.", "LEDGER_SYNC_NOT_OWNER", 403);
  }
  if (snapshot.applying) throw makeError("This preview is already being applied.", "LEDGER_SYNC_ALREADY_RUNNING");
  snapshot.applying = true;
  let connection = null;
  try {
    connection = await pmsDb.getConnection();
    await connection.beginTransaction();
    const [baselineRows] = await connection.query(`${LEDGER_SELECT} ORDER BY id ASC FOR UPDATE`);
    if (baselineFingerprint(baselineRows) !== snapshot.fingerprint) {
      throw makeError("Employee Ledger changed since preview. Refresh the preview before applying.", "LEDGER_SYNC_STALE_PREVIEW");
    }

    const results = { inserted: 0, updated: 0, unchanged: 0, preserved: snapshot.plan.nonCurrent.length,
      classifiedOutsideUsVisa: 0, managementNamesBackfilled: 0,
      joinDatesPopulated: 0, departureDatesPopulated: 0, userStatusesRefreshed: 0 };
    for (const row of snapshot.plan.currentRows) {
      if (row.action === "ADD") {
        // New employees receive only verified account-join/last-working dates.
        // Do not invent status, Task Order, modality or vendor aliases.
        await connection.query(`
          INSERT INTO ${pmsTables.usVisaEmployeeLedger} (
            sibs_id, kronos_name, agent_name, site,
            kronos_employee_id, kronos_account_id, kronos_account_name, supervisor_user_id,
            supervisor_sibs_id, team_leader_sibs_id, manager_sibs_id,
            senior_manager_sibs_id, hierarchy_sync_status,
            kronos_membership_status, kronos_last_synced_at,
            organizational_role, role_source, role_review_status, kronos_emp_type,
            team_leader, manager, senior_manager,
            us_visa_join_date, us_visa_departure_date, kronos_user_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CURRENT_US_VISA', UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          row.sibsId, row.name, row.name, row.site,
          row.kronosEmployeeId, row.accountId, row.accountName, row.supervisorUserId,
          row.supervisorSibsId, row.teamLeader?.sibsId || null,
          row.manager?.sibsId || null, row.seniorManager?.sibsId || null,
          row.hierarchyStatus,
          row.role.organizationalRole, row.role.roleSource,
          row.role.roleReviewStatus, row.role.kronosEmpType,
          row.displayNames?.teamLeader || null, row.displayNames?.manager || null,
          row.displayNames?.seniorManager || null,
          row.employmentDates?.joinDate || null,
          row.employmentDates?.departureDate || null,
          row.kronosUserStatus,
        ]);
        results.userStatusesRefreshed++;
        if (row.employmentDates?.joinDate) results.joinDatesPopulated++;
        if (row.employmentDates?.departureDate) results.departureDatesPopulated++;
        results.inserted++;
      } else {
        // Do not update the original `status`, TO or aliases. Add only verified
        // missing account dates; existing historical dates are never overwritten.
        await connection.query(`
          UPDATE ${pmsTables.usVisaEmployeeLedger}
          SET kronos_name = COALESCE(?, kronos_name),
              kronos_employee_id = ?, kronos_account_id = ?, kronos_account_name = ?,
              supervisor_user_id = ?, supervisor_sibs_id = ?,
              team_leader_sibs_id = ?,
              manager_sibs_id = ?,
              senior_manager_sibs_id = ?,
              hierarchy_sync_status = ?,
              organizational_role = ?, role_source = ?,
              role_review_status = ?, kronos_emp_type = ?,
              kronos_membership_status = 'CURRENT_US_VISA',
              kronos_last_synced_at = UTC_TIMESTAMP(),
              team_leader = COALESCE(?, team_leader),
              manager = COALESCE(?, manager),
              senior_manager = COALESCE(?, senior_manager),
              us_visa_join_date = CASE WHEN us_visa_join_date IS NULL OR YEAR(us_visa_join_date) < 1990
                THEN COALESCE(?, us_visa_join_date) ELSE us_visa_join_date END,
              us_visa_departure_date = CASE WHEN us_visa_departure_date IS NULL OR YEAR(us_visa_departure_date) < 1990
                THEN COALESCE(?, us_visa_departure_date) ELSE us_visa_departure_date END,
              kronos_user_status = ?
          WHERE sibs_id = ?
        `, [
          row.name, row.kronosEmployeeId, row.accountId, row.accountName,
          row.supervisorUserId, row.supervisorSibsId,
          row.teamLeader?.sibsId || null,
          row.manager?.sibsId || null,
          row.seniorManager?.sibsId || null,
          row.hierarchyStatus,
          row.role.organizationalRole, row.role.roleSource,
          row.role.roleReviewStatus, row.role.kronosEmpType,
          row.displayNames?.teamLeader || null, row.displayNames?.manager || null,
          row.displayNames?.seniorManager || null,
          row.employmentDates?.joinDate || null,
          row.employmentDates?.departureDate || null,
          row.kronosUserStatus,
          row.sibsId,
        ]);
        results.userStatusesRefreshed++;
        if (row.employmentDates?.joinDate) results.joinDatesPopulated++;
        if (row.employmentDates?.departureDate) results.departureDatesPopulated++;
        if (row.action === "UPDATE") results.updated++;
        else results.unchanged++;
        if (row.needsNameBackfill) results.managementNamesBackfilled++;
      }
    }
    // Historical records remain in the ledger with their original employment
    // windows, Task Orders, statuses, legacy manager names and vendor aliases.
    // Current role evidence (e.g. TL account 78, Manager 77, SOM 76/59) is
    // recorded independently of current Account 20 campaign membership.
    for (const row of snapshot.plan.nonCurrent) {
      if (row.role && row.hierarchy) {
        await connection.query(`
          UPDATE ${pmsTables.usVisaEmployeeLedger}
          SET kronos_employee_id = COALESCE(?, kronos_employee_id),
              kronos_account_id = COALESCE(?, kronos_account_id),
              kronos_account_name = COALESCE(?, kronos_account_name),
              supervisor_user_id = ?, supervisor_sibs_id = ?,
              team_leader_sibs_id = ?, manager_sibs_id = ?, senior_manager_sibs_id = ?,
              hierarchy_sync_status = ?,
              organizational_role = ?, role_source = ?, role_review_status = ?,
              kronos_emp_type = ?,
              kronos_membership_status = ?, kronos_last_synced_at = UTC_TIMESTAMP(),
              team_leader = COALESCE(NULLIF(TRIM(team_leader), ''), ?),
              manager = COALESCE(NULLIF(TRIM(manager), ''), ?),
              senior_manager = COALESCE(NULLIF(TRIM(senior_manager), ''), ?),
              kronos_user_status = ?
          WHERE sibs_id = ?
        `, [
          row.kronosEmployeeId, row.accountId, row.accountName,
          row.hierarchy.supervisorUserId, row.hierarchy.directSupervisorCode,
          row.hierarchy.teamLeader?.sibsId || null,
          row.hierarchy.manager?.sibsId || null,
          row.hierarchy.seniorManager?.sibsId || null,
          row.hierarchy.status,
          row.role.organizationalRole, row.role.roleSource, row.role.roleReviewStatus,
          row.role.kronosEmpType, row.membership,
          row.displayNames?.teamLeader || null,
          row.displayNames?.manager || null,
          row.displayNames?.seniorManager || null,
          row.kronosUserStatus,
          row.sibsId,
        ]);
        results.userStatusesRefreshed++;
        if (row.needsNameBackfill) results.managementNamesBackfilled++;
        results.classifiedOutsideUsVisa++;
      } else if (row.role?.roleReviewStatus === "VERIFIED" &&
                 row.role.organizationalRole === "AGENT" &&
                 row.membership === "US_VISA_NAME_MATCH") {
        // Account-name evidence confirms a US Visa Agent even if the numeric
        // Kronos account is now Attrited/Unassigned. Update only classification
        // and sync metadata; do not replace historical hierarchy or status.
        await connection.query(`
          UPDATE ${pmsTables.usVisaEmployeeLedger}
          SET kronos_employee_id = COALESCE(?, kronos_employee_id),
              kronos_account_id = COALESCE(?, kronos_account_id),
              kronos_account_name = COALESCE(?, kronos_account_name),
              organizational_role = ?, role_source = ?, role_review_status = ?,
              kronos_emp_type = COALESCE(?, kronos_emp_type),
              kronos_membership_status = ?, kronos_last_synced_at = UTC_TIMESTAMP(),
              kronos_user_status = ?
          WHERE sibs_id = ?
        `, [
          row.kronosEmployeeId, row.accountId, row.accountName,
          row.role.organizationalRole, row.role.roleSource, row.role.roleReviewStatus,
          row.role.kronosEmpType, row.membership, row.kronosUserStatus, row.sibsId,
        ]);
        results.classifiedOutsideUsVisa++;
        results.userStatusesRefreshed++;
      } else {
        // No trusted role: preserve previously verified historical
        // role values instead of overwriting them with NULL/UNRESOLVED.
        await connection.query(`
          UPDATE ${pmsTables.usVisaEmployeeLedger}
          SET kronos_account_id = COALESCE(?, kronos_account_id),
              kronos_account_name = COALESCE(?, kronos_account_name),
              kronos_membership_status = ?,
              kronos_last_synced_at = UTC_TIMESTAMP(), kronos_user_status = ?
          WHERE sibs_id = ?
        `, [row.accountId, row.accountName, row.membership, row.kronosUserStatus, row.sibsId]);
        results.userStatusesRefreshed++;
      }
    }
    await connection.commit();
    previews.delete(String(previewToken));
    return { success: true, ...results, message: "Kronos sync applied. Verified missing US Visa dates populated; historical values preserved." };
  } catch (error) {
    if (connection) await connection.rollback();
    throw error;
  } finally {
    connection?.release();
    snapshot.applying = false;
  }
}
