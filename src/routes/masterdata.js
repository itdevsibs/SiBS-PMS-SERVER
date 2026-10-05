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

const router = Router();

// Employee Ledger / Master Data is shared only by approved management roles.
router.use(
  authMiddleware,
  requireRole([6, 7, 9, 10, 11]),
);

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

    if (rawSearch) {
      const searchPattern = `%${rawSearch}%`;
      whereClauses.push(`(
        l.sibs_id LIKE ? OR 
        l.kronos_name LIKE ? OR 
        k.gy_emp_fullname LIKE ? OR 
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
      for (let i = 0; i < 16; i++) {
        queryParams.push(searchPattern);
      }
    }

    let countQuery = `
      SELECT COUNT(*) AS total 
      FROM ${pmsTables.usVisaEmployeeLedger} l
      LEFT JOIN ${kronosTables.employee} k ON (
        TRIM(k.gy_emp_code) = TRIM(l.sibs_id)
        OR LOWER(TRIM(k.gy_emp_fullname)) = LOWER(TRIM(l.agent_name))
      )
    `;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    const [countRows] = await pmsDb.query(countQuery, queryParams);
    const totalRecords = Number(countRows[0]?.total || 0);

    if (totalRecords === 0) {
      return res.json({
        success: true,
        total: 0,
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
        COALESCE(
          NULLIF(TRIM(l.kronos_name), ''),
          NULLIF(TRIM(k.gy_emp_fullname), '')
        ) AS kronosName,
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
        l.team_leader AS teamLeader,
        l.manager,
        l.senior_manager AS seniorManager,
        CASE
          WHEN l.us_visa_join_date IS NOT NULL AND l.us_visa_join_date > '1990-01-01' THEN
            CAST(DATEDIFF(COALESCE(l.us_visa_departure_date, CURRENT_DATE()), l.us_visa_join_date) AS CHAR)
          ELSE NULL
        END AS tenurity,
        l.modality
      FROM ${pmsTables.usVisaEmployeeLedger} l
      LEFT JOIN ${kronosTables.employee} k ON (
        TRIM(k.gy_emp_code) = TRIM(l.sibs_id)
        OR LOWER(TRIM(k.gy_emp_fullname)) = LOWER(TRIM(l.agent_name))
      )
    `;
    if (whereClauses.length > 0) {
      dataQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    dataQuery += ` ORDER BY l.id ASC LIMIT ? OFFSET ?`;
    const dataParams = [...queryParams, limit, offset];

    const [rows] = await pmsDb.query(dataQuery, dataParams);

    return res.json({
      success: true,
      total: totalRecords,
      page,
      limit,
      totalPages: Math.ceil(totalRecords / limit),
      data: rows,
    });

  } catch (error) {
    console.error("Failed to fetch us_visa_employee_ledger:", error);
    next(error);
  }
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
      tenurity,
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
        { val: tenurity, col: "tenurity" },
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
        const tenurity = item.tenurity ?? null;
        const modality = item.modality ?? null;

        await connection.query(
          `
            INSERT INTO ${pmsTables.usVisaEmployeeLedger} (
              sibs_id, kronos_name, call_novo_email, agent_name, fusecom_name,
              fusenet_name, herodash_name, msd_name, site, status, phase,
              task_order, task_order_description, us_visa_departure_date,
              us_visa_join_date, team_leader, manager, senior_manager,
              tenurity, modality
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              tenurity = VALUES(tenurity),
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
            tenurity,
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

