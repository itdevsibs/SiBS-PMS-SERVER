// Handles Master Data & Employee Identity Ledger APIs
import { Router } from "express";
import {
  kronosDb,
  kronosTables,
  pmsDb,
  pmsTables,
} from "../config/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import { calculateLedgerTenurity, getLedgerTenurityDateWarning, getLedgerEmploymentStatus, LEDGER_STATUS_SORT_SQL, todayInManila } from "../services/masterdata/employeeLedgerEmploymentStatus.js";
import { previewUsVisaKronosLedgerSync, applyUsVisaKronosLedgerSync } from "../services/masterdata/usVisaKronosLedgerSyncService.js";

const router = Router();

// Employee Ledger / Master Data is shared only by approved management roles.
router.use(
  authMiddleware,
  requireRole([6, 7, 9, 10, 11]),
);


/**
 * Explicit Kronos sync for Super Admin, WFM and Master Data users.
 * Permissioned separately from ordinary ledger reads.
 * No live Kronos fetch is made when the ledger page is opened.
 */
router.post("/ledger/kronos-sync/preview", requireRole([7, 9, 11]), async (req, res, next) => {
  try {
    const result = await previewUsVisaKronosLedgerSync({ actor: req.user?.username || req.user?.id });
    return res.json(result);
  } catch (error) { next(error); }
});

router.post("/ledger/kronos-sync/apply", requireRole([7, 9, 11]), async (req, res, next) => {
  try {
    const result = await applyUsVisaKronosLedgerSync({
      actor: req.user?.username || req.user?.id,
      previewToken: req.body?.previewToken,
    });
    return res.json(result);
  } catch (error) { next(error); }
});

function normalizeSibsId(value) {
  return String(value || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim();
}

function formatDateForSql(val) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) {
      return d.toISOString().split("T")[0];
    }
  }
  const str = String(val).trim();
  if (!str || str.includes("#REF!") || str.includes("#N/A")) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const mdy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0];
  }
  return null;
}

function cleanExcelString(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  if (!str || str.includes("#REF!") || str.includes("#N/A") || str.includes("#VALUE!") || str.includes("#NAME?")) {
    return null;
  }
  return str;
}

/**
 * GET /api/masterdata/accounts
 * Returns distinct account list from Kronos employees.
 */
router.get("/accounts", async (req, res, next) => {
  try {
    const [rows] = await kronosDb.query(`
      SELECT DISTINCT gy_emp_account AS account
      FROM ${kronosTables.employee}
      WHERE gy_emp_account IS NOT NULL AND TRIM(gy_emp_account) != ''
      ORDER BY gy_emp_account ASC
    `);
    const accounts = rows.map((r) => r.account).filter(Boolean);
    return res.json({ success: true, accounts });
  } catch (err) {
    console.error("Failed to fetch accounts:", err);
    next(err);
  }
});

/**
 * GET /api/masterdata/task-orders
 * Returns distinct task orders from us_visa_employee_ledger.
 */
router.get("/task-orders", async (req, res, next) => {
  try {
    const [rows] = await pmsDb.query(`
      SELECT DISTINCT TRIM(task_order) AS taskOrder
      FROM ${pmsTables.usVisaEmployeeLedger}
      WHERE task_order IS NOT NULL 
        AND TRIM(task_order) != '' 
        AND task_order NOT LIKE '%#REF!%'
        AND LOWER(TRIM(task_order)) NOT LIKE '%operations manager%'
        AND LOWER(TRIM(task_order)) NOT IN ('om', '- om', 'operations manager', '- operations manager')
      ORDER BY taskOrder ASC
    `);
    const taskOrders = rows.map((r) => r.taskOrder).filter(Boolean);
    return res.json({ success: true, taskOrders });
  } catch (err) {
    console.error("Failed to fetch task orders:", err);
    next(err);
  }
});

/**
 * GET /api/masterdata/ledger
 * Query params:
 *   - search: string (matches SIBS ID, name, email, or any tool identity)
 *   - filter: string ('all' | 'incomplete' | 'aligned' | 'unified')
 *   - account: string (filter by account / campaign)
 *   - taskOrder: string (filter by task order)
 *   - viewAll: boolean ('true' to view without search query)
 *   - limit: number (default 50)
 *   - offset: number (default 0)
 */
router.get("/ledger", async (req, res, next) => {
  try {
    const rawSearch = String(req.query.search || "").trim();
    const account = String(req.query.account || "").trim();
    const taskOrder = String(req.query.taskOrder || "").trim();
    const organizationalRole = String(req.query.organizationalRole || "").trim().toUpperCase();
    const employmentStatus = String(req.query.employmentStatus || "").trim();
    if (organizationalRole && !["AGENT", "TEAM_LEADER", "MANAGER", "SENIOR_MANAGER", "NEEDS_REVIEW", "UNCLASSIFIED"].includes(organizationalRole)) {
      return res.status(400).json({ success: false, message: "Invalid organizational role filter." });
    }
    if (employmentStatus && !["Active", "Inactive", "Needs Verification"].includes(employmentStatus)) {
      return res.status(400).json({ success: false, message: "Invalid employment status filter." });
    }
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 10000);
    const offset = (page - 1) * limit;

    const isUsVisa = !account || account.toLowerCase() === "us visa";

    if (!isUsVisa) {
      return res.json({
        success: true,
        total: 0,
        page: 1,
        limit,
        totalPages: 0,
        data: [],
      });
    }

    const whereClauses = [];
    const queryParams = [];

    if (taskOrder && taskOrder !== "All Task Orders") {
      whereClauses.push("TRIM(l.task_order) = ?");
      queryParams.push(taskOrder);
    }

    if (organizationalRole) {
      if (organizationalRole === "NEEDS_REVIEW") {
        whereClauses.push("l.role_review_status = 'NEEDS_REVIEW'");
      } else if (organizationalRole === "UNCLASSIFIED") {
        whereClauses.push("(l.organizational_role IS NULL OR (l.organizational_role = 'UNRESOLVED' AND COALESCE(l.role_review_status, '') <> 'NEEDS_REVIEW'))");
      } else {
        whereClauses.push("l.organizational_role = ?");
        queryParams.push(organizationalRole);
      }
    }

    if (employmentStatus) {
      if (employmentStatus === "Active") {
        whereClauses.push("l.kronos_user_status = 0");
      } else if (employmentStatus === "Inactive") {
        whereClauses.push("l.kronos_user_status = 1");
      } else if (employmentStatus === "Needs Verification") {
        whereClauses.push("(l.kronos_user_status IS NULL OR l.kronos_user_status NOT IN (0, 1))");
      }
    }

    if (rawSearch) {
      const searchPattern = `%${rawSearch}%`;
      whereClauses.push(`(
        l.sibs_id LIKE ? OR 
        l.kronos_name LIKE ? OR 
        l.call_novo_email LIKE ? OR 
        l.agent_name LIKE ? OR 
        l.fusecom_name LIKE ? OR 
        l.fusenet_name LIKE ? OR 
        l.herodash_name LIKE ? OR 
        l.msd_name LIKE ? OR 
        l.site LIKE ? OR 
        l.status LIKE ? OR 
        l.phase LIKE ? OR 
        l.task_order LIKE ? OR 
        l.team_leader LIKE ? OR 
        l.manager LIKE ? OR 
        l.senior_manager LIKE ?
      )`);
      for (let i = 0; i < 15; i++) {
        queryParams.push(searchPattern);
      }
    }

    let countQuery = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN l.kronos_user_status = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN l.kronos_user_status = 1 THEN 1 ELSE 0 END) AS inactive,
        SUM(CASE WHEN l.kronos_user_status IS NULL OR l.kronos_user_status NOT IN (0, 1) THEN 1 ELSE 0 END) AS needsVerification,
        SUM(CASE WHEN l.kronos_user_status IN (0, 1) THEN 1 ELSE 0 END) AS kronosVerified
      FROM ${pmsTables.usVisaEmployeeLedger} l
    `;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    const [countRows] = await pmsDb.query(countQuery, queryParams);
    const totalRecords = Number(countRows[0]?.total || 0);
    const summary = {
      total: totalRecords,
      active: Number(countRows[0]?.active || 0),
      inactive: Number(countRows[0]?.inactive || 0),
      needsVerification: Number(countRows[0]?.needsVerification || 0),
      kronosVerified: Number(countRows[0]?.kronosVerified || 0),
    };

    if (totalRecords === 0) {
      return res.json({
        success: true,
        total: 0,
        summary,
        page,
        limit,
        totalPages: 0,
        data: [],
      });
    }

    let dataQuery = `
      SELECT 
        l.id,
        l.sibs_id AS sibsId,
        NULLIF(TRIM(l.kronos_name), '') AS kronosName,
        l.call_novo_email AS callNovoEmail,
        l.agent_name AS agentName,
        l.fusecom_name AS fusecomName,
        l.fusenet_name AS fusenetName,
        l.herodash_name AS herodashName,
        l.msd_name AS msdName,
        l.site,
        l.status,
        l.phase,
        CASE
          WHEN l.task_order LIKE '%#REF!%' THEN NULL
          ELSE l.task_order
        END AS taskOrder,
        CASE
          WHEN l.task_order_description LIKE '%#REF!%'
            OR l.task_order_description LIKE '%#N/A%'
            OR l.task_order_description LIKE '%#VALUE!%'
            OR TRIM(l.task_order_description) = ''
          THEN NULL
          ELSE l.task_order_description
        END AS taskOrderDescription,
        DATE_FORMAT(l.us_visa_departure_date, '%Y-%m-%d') AS usVisaDepartureDate,
        DATE_FORMAT(l.us_visa_join_date, '%Y-%m-%d') AS usVisaJoinDate,
        COALESCE(NULLIF(TRIM(l.team_leader), ''),
          CASE WHEN l.team_leader_sibs_id IS NOT NULL
            AND l.us_visa_departure_date IS NULL
            AND l.hierarchy_sync_status IN ('VERIFIED', 'PARTIAL')
            AND LOWER(TRIM(COALESCE(l.status, ''))) NOT IN
              ('inactive', 'resigned', 'attrited', 'terminated', 'separated') THEN
            COALESCE(NULLIF(TRIM(tl.kronos_name), ''), NULLIF(TRIM(tl.agent_name), '')) END
        ) AS teamLeader,
        COALESCE(NULLIF(TRIM(l.manager), ''),
          CASE WHEN l.manager_sibs_id IS NOT NULL
            AND l.us_visa_departure_date IS NULL
            AND l.hierarchy_sync_status IN ('VERIFIED', 'PARTIAL')
            AND LOWER(TRIM(COALESCE(l.status, ''))) NOT IN
              ('inactive', 'resigned', 'attrited', 'terminated', 'separated') THEN
            COALESCE(NULLIF(TRIM(mgr.kronos_name), ''), NULLIF(TRIM(mgr.agent_name), '')) END
        ) AS manager,
        COALESCE(NULLIF(TRIM(l.senior_manager), ''),
          CASE WHEN l.senior_manager_sibs_id IS NOT NULL
            AND l.us_visa_departure_date IS NULL
            AND l.hierarchy_sync_status IN ('VERIFIED', 'PARTIAL')
            AND LOWER(TRIM(COALESCE(l.status, ''))) NOT IN
              ('inactive', 'resigned', 'attrited', 'terminated', 'separated') THEN
            COALESCE(NULLIF(TRIM(som.kronos_name), ''), NULLIF(TRIM(som.agent_name), '')) END
        ) AS seniorManager,
        l.modality,
        l.kronos_employee_id AS kronosEmployeeId,
        l.kronos_account_id AS kronosAccountId,
        l.kronos_account_name AS kronosAccountName,
        l.supervisor_sibs_id AS supervisorSibsId,
        l.team_leader_sibs_id AS teamLeaderSibsId,
        l.manager_sibs_id AS managerSibsId,
        l.senior_manager_sibs_id AS seniorManagerSibsId,
        l.organizational_role AS organizationalRole,
        l.role_source AS roleSource,
        l.role_review_status AS roleReviewStatus,
        l.kronos_emp_type AS kronosEmpType,
        l.kronos_user_status AS kronosUserStatus,
        l.hierarchy_sync_status AS hierarchySyncStatus,
        l.kronos_membership_status AS kronosMembershipStatus,
        DATE_FORMAT(DATE_ADD(l.kronos_last_synced_at, INTERVAL 8 HOUR), '%Y-%m-%d %H:%i:%s') AS kronosLastSyncedAt
      FROM ${pmsTables.usVisaEmployeeLedger} l
      LEFT JOIN ${pmsTables.usVisaEmployeeLedger} tl
        ON tl.sibs_id = l.team_leader_sibs_id
      LEFT JOIN ${pmsTables.usVisaEmployeeLedger} mgr
        ON mgr.sibs_id = l.manager_sibs_id
      LEFT JOIN ${pmsTables.usVisaEmployeeLedger} som
        ON som.sibs_id = l.senior_manager_sibs_id
    `;
    if (whereClauses.length > 0) {
      dataQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    // Default status-first ordering applies to the FULL filtered dataset,
    // before pagination. Never use insertion order as an employment proxy.
    dataQuery += ` ORDER BY ${LEDGER_STATUS_SORT_SQL} ASC,
      LOWER(COALESCE(NULLIF(TRIM(l.kronos_name), ''), NULLIF(TRIM(l.agent_name), ''), l.sibs_id)) ASC,
      l.sibs_id ASC, l.id ASC LIMIT ? OFFSET ?`;
    const dataParams = [...queryParams, limit, offset];

    const [rows] = await pmsDb.query(dataQuery, dataParams);
    // Derive all row tenures against the same Manila calendar day.
    const currentManilaDate = todayInManila();

    return res.json({
      success: true,
      total: totalRecords,
      summary,
      page,
      limit,
      totalPages: Math.ceil(totalRecords / limit),
      data: rows.map((row) => ({
        ...row,
        tenurity: calculateLedgerTenurity(row.usVisaJoinDate, row.usVisaDepartureDate, currentManilaDate),
        tenurityDateWarning: getLedgerTenurityDateWarning(row.usVisaJoinDate, row.usVisaDepartureDate),
        // Kronos-only classification (gy_user_status: 0 active, 1 inactive).
        // Historical status and employment dates remain separate ledger fields.
        employmentStatus: getLedgerEmploymentStatus(row),
      })),
    });

  } catch (error) {
    console.error("Failed to fetch us_visa_employee_ledger:", error);
    next(error);
  }
});

/** Roles are managed by Kronos synchronization; manual edits are disabled.
 * Keep a hard rejection for older clients that still call this endpoint.
 */
router.put("/ledger/:sibsId/organizational-role", (req, res) => {
  return res.status(403).json({
    success: false,
    message: "Organizational roles are read-only and cannot be edited manually.",
  });
});

/**
 * PUT /api/masterdata/ledger/:sibsId
 * Updates employee and source-tool identity fields directly in the ledger.
 */
router.put("/ledger/:sibsId", async (req, res, next) => {
  try {
    const sibsId = normalizeSibsId(req.params.sibsId);
    if (!sibsId) {
      return res.status(400).json({
        success: false,
        message: "SIBS ID is required.",
      });
    }

    // Do not permit role changes through the generic ledger edit endpoint either.
    // Organizational roles are derived by the approved Kronos sync workflow.
    const immutableRoleFields = [
      "organizationalRole", "organizational_role",
      "roleSource", "role_source", "roleReviewStatus", "role_review_status",
    ];
    if (immutableRoleFields.some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
      return res.status(403).json({
        success: false,
        message: "Organizational roles are read-only and cannot be edited manually.",
      });
    }

    const {
      kronosName,
      callNovoEmail,
      agentName,
      fusecomName,
      fusenetName,
      herodashName,
      msdName,
      site,
      status,
      phase,
      taskOrder,
      taskOrderDescription,
      usVisaDepartureDate,
      usVisaJoinDate,
      teamLeader,
      manager,
      seniorManager,
      modality,
    } = req.body || {};

    const connection = await pmsDb.getConnection();
    try {
      await connection.beginTransaction();

      // 1. Update us_visa_employee_ledger fields if any are provided
      const ledgerUpdates = [];
      const ledgerParams = [];

      const stringFields = [
        { val: kronosName, col: "kronos_name" },
        { val: callNovoEmail, col: "call_novo_email" },
        { val: agentName, col: "agent_name" },
        { val: fusecomName, col: "fusecom_name" },
        { val: fusenetName, col: "fusenet_name" },
        { val: herodashName, col: "herodash_name" },
        { val: msdName, col: "msd_name" },
        { val: site, col: "site" },
        { val: status, col: "status" },
        { val: phase, col: "phase" },
        { val: taskOrder, col: "task_order" },
        { val: taskOrderDescription, col: "task_order_description" },
        { val: teamLeader, col: "team_leader" },
        { val: manager, col: "manager" },
        { val: seniorManager, col: "senior_manager" },
        { val: modality, col: "modality" },
      ];

      for (const item of stringFields) {
        if (item.val !== undefined) {
          ledgerUpdates.push(`${item.col} = ?`);
          ledgerParams.push(item.val !== null ? String(item.val).trim() : null);
        }
      }

      if (usVisaDepartureDate !== undefined) {
        ledgerUpdates.push("us_visa_departure_date = ?");
        ledgerParams.push(formatDateForSql(usVisaDepartureDate));
      }

      if (usVisaJoinDate !== undefined) {
        ledgerUpdates.push("us_visa_join_date = ?");
        ledgerParams.push(formatDateForSql(usVisaJoinDate));
      }

      if (ledgerUpdates.length > 0) {
        ledgerUpdates.push("updated_at = CURRENT_TIMESTAMP");
        ledgerParams.push(sibsId);
        await connection.query(
          `UPDATE ${pmsTables.usVisaEmployeeLedger} SET ${ledgerUpdates.join(", ")} WHERE sibs_id = ?`,
          ledgerParams
        );
      }

      // Employee ledger is now the single source of truth for tool identities.

      await connection.commit();

      return res.json({
        success: true,
        message: `Successfully updated employee record for SIBS ID ${sibsId}.`,
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Failed to update employee record:", error);
    next(error);
  }
});

/**
 * POST /api/masterdata/ledger/batch-import
 * Batch updates source-tool identity fields directly in the employee ledger.
 */
router.post("/ledger/batch-import", async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No employee records provided for import.",
      });
    }

    const connection = await pmsDb.getConnection();
    try {
      await connection.beginTransaction();

      let updatedCount = 0;

      for (const item of items) {
        let sibsId = normalizeSibsId(item.sibsId);
        const fullName = String(item.fullName || "").trim();

        // If SIBS ID is missing, resolve the canonical numeric employee code.
        if (!sibsId && fullName) {
          const [foundEmp] = await kronosDb.query(
            `SELECT gy_emp_code FROM ${kronosTables.employee} WHERE UPPER(TRIM(gy_emp_fullname)) = ? LIMIT 1`,
            [fullName.toUpperCase()],
          );
          if (foundEmp.length > 0) {
            sibsId = normalizeSibsId(foundEmp[0].gy_emp_code);
          }
        }

        if (!sibsId) continue;

        const fusecomName = item.fusecomName !== undefined ? String(item.fusecomName || "").trim() : undefined;
        const fusenetName = item.fusenetName !== undefined ? String(item.fusenetName || "").trim() : undefined;
        const herodashName = item.herodashName !== undefined ? String(item.herodashName || "").trim() : undefined;
        const msdName = item.msdName !== undefined ? String(item.msdName || "").trim() : undefined;

        const updates = [];
        const params = [];
        const addUpdate = (column, value) => {
          if (value === undefined) return;
          updates.push(`${column} = ?`);
          params.push(value || null);
        };

        addUpdate("fusecom_name", fusecomName);
        addUpdate("fusenet_name", fusenetName);
        addUpdate("herodash_name", herodashName);
        addUpdate("msd_name", msdName);

        if (!updates.length) continue;

        const [result] = await connection.query(
          `
            UPDATE ${pmsTables.usVisaEmployeeLedger}
            SET ${updates.join(", ")},
                updated_at = CURRENT_TIMESTAMP
            WHERE sibs_id = ?
          `,
          [...params, sibsId],
        );

        if (result.affectedRows > 0) {
          updatedCount++;
        }
      }

      await connection.commit();

      return res.json({
        success: true,
        count: updatedCount,
        message: `Successfully updated ledger tool identities for ${updatedCount} employee${updatedCount === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Failed to batch import ledger tool alignment:", error);
    next(error);
  }
});


/**
 * POST /api/masterdata/ledger/import-us-visa
 * Imports full 20-column records into us_visa_employee_ledger in pms_db
 */
router.post("/ledger/import-us-visa", async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No employee records provided for import.",
      });
    }

    const connection = await pmsDb.getConnection();
    try {
      await connection.beginTransaction();

      let upsertedCount = 0;

      for (const item of items) {
        const sibsId = normalizeSibsId(item.sibsId || item.sibs_id);
        if (!sibsId) continue;

        const kronosName = item.kronosName ?? item.kronos_name ?? null;
        const callNovoEmail = item.callNovoEmail ?? item.call_novo_email ?? null;
        const agentName = item.agentName ?? item.agent_name ?? null;
        const fusecomName = item.fusecomName ?? item.fusecom_name ?? null;
        const fusenetName = item.fusenetName ?? item.fusenet_name ?? null;
        const herodashName = item.herodashName ?? item.herodash_name ?? null;
        const msdName = item.msdName ?? item.msd_name ?? null;
        const site = item.site ?? null;
        const status = item.status ?? null;
        const phase = item.phase ?? null;
        const rawTaskOrder = cleanExcelString(item.taskOrder ?? item.task_order);
        const taskOrder =
          rawTaskOrder &&
          (rawTaskOrder.toLowerCase().includes("operations manager") ||
            /^\s*[-–—]?\s*om\s*$/i.test(rawTaskOrder))
            ? null
            : rawTaskOrder;
        const taskOrderDescription = cleanExcelString(item.taskOrderDescription ?? item.task_order_description);
        const usVisaDepartureDate = formatDateForSql(item.usVisaDepartureDate ?? item.us_visa_departure_date);
        const usVisaJoinDate = formatDateForSql(item.usVisaJoinDate ?? item.us_visa_join_date);
        const teamLeader = item.teamLeader ?? item.team_leader ?? null;
        const manager = item.manager ?? null;
        const seniorManager = item.seniorManager ?? item.senior_manager ?? null;
        // Legacy Excel "Tenurity" cells are ignored; the API derives days from dates.
        const modality = item.modality ?? null;

        await connection.query(
          `
            INSERT INTO ${pmsTables.usVisaEmployeeLedger} (
              sibs_id, kronos_name, call_novo_email, agent_name, fusecom_name,
              fusenet_name, herodash_name, msd_name, site, status, phase,
              task_order, task_order_description, us_visa_departure_date,
              us_visa_join_date, team_leader, manager, senior_manager,
              modality
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              kronos_name = VALUES(kronos_name),
              call_novo_email = VALUES(call_novo_email),
              agent_name = VALUES(agent_name),
              fusecom_name = VALUES(fusecom_name),
              fusenet_name = VALUES(fusenet_name),
              herodash_name = VALUES(herodash_name),
              msd_name = VALUES(msd_name),
              site = VALUES(site),
              status = VALUES(status),
              phase = VALUES(phase),
              task_order = VALUES(task_order),
              task_order_description = VALUES(task_order_description),
              us_visa_departure_date = VALUES(us_visa_departure_date),
              us_visa_join_date = VALUES(us_visa_join_date),
              team_leader = VALUES(team_leader),
              manager = VALUES(manager),
              senior_manager = VALUES(senior_manager),
              modality = VALUES(modality),
              updated_at = CURRENT_TIMESTAMP
          `,
          [
            sibsId,
            kronosName,
            callNovoEmail,
            agentName,
            fusecomName,
            fusenetName,
            herodashName,
            msdName,
            site,
            status,
            phase,
            taskOrder,
            taskOrderDescription,
            usVisaDepartureDate,
            usVisaJoinDate,
            teamLeader,
            manager,
            seniorManager,
            modality,
          ],
        );
        upsertedCount++;
      }

      // Auto-fill any empty or missing kronos_name from gy_employee under kronos_testdb
      await connection.query(`
        UPDATE ${pmsTables.usVisaEmployeeLedger} l
        JOIN ${kronosTables.employee} k ON (
          TRIM(k.gy_emp_code) = TRIM(l.sibs_id)
          OR LOWER(TRIM(k.gy_emp_fullname)) = LOWER(TRIM(l.agent_name))
        )
        SET l.kronos_name = TRIM(k.gy_emp_fullname)
        WHERE (l.kronos_name IS NULL OR TRIM(l.kronos_name) = '' OR l.kronos_name = '—')
          AND NULLIF(TRIM(k.gy_emp_fullname), '') IS NOT NULL
      `);

      await connection.commit();

      return res.json({
        success: true,
        count: upsertedCount,
        message: `Successfully saved ${upsertedCount} employee records into us_visa_employee_ledger.`,
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Failed to import us_visa_employee_ledger:", error);
    next(error);
  }
});

export default router;

