// Handles Master Data & Employee Identity Ledger APIs
import { Router } from "express";
import {
  kronosDb,
  kronosTables,
  pmsDb,
  pmsTables,
} from "../config/db.js";

const router = Router();

function normalizeValue(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
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
 * GET /api/masterdata/ledger
 * Query params:
 *   - search: string (matches SIBS ID, name, email, or any tool alias)
 *   - filter: string ('all' | 'incomplete' | 'aliased' | 'unified')
 *   - account: string (filter by account / campaign)
 *   - viewAll: boolean ('true' to view without search query)
 *   - limit: number (default 50)
 *   - offset: number (default 0)
 */
router.get("/ledger", async (req, res, next) => {
  try {
    const rawSearch = String(req.query.search || "").trim();
    const filter = String(req.query.filter || "all").toLowerCase().trim();
    const account = String(req.query.account || "").trim();
    const viewAll = req.query.viewAll === "true";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 10000);
    const offset = (page - 1) * limit;

    const hasFilter = filter && filter !== "all";
    const hasAccount = Boolean(account);
    const hasSearch = Boolean(rawSearch);
    const shouldQuery = hasSearch || hasFilter || hasAccount || viewAll;

    const isUsVisa = account.toLowerCase() === "us visa";

    // If an account other than US Visa is selected, do not fetch data (US Visa only for now)
    if (hasAccount && !isUsVisa) {
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

    // Master data ledger is strictly restricted to US Visa for now
    whereClauses.push(`gy_emp_account = 'US Visa'`);

    // Filter by aliased (employees with tool aliases registered)
    if (filter === "aliased") {
      const [aliasedRows] = await pmsDb.query(`
        SELECT DISTINCT employee_uid 
        FROM ${pmsTables.usVisaEmployeeAliases}
        WHERE is_active = 1 AND alias_type IN ('FUSECOM_NAME', 'HERODASH_NAME', 'FUSENET_NAME', 'AGENT_NAME')
      `);
      const aliasedUids = aliasedRows.map((r) => r.employee_uid).filter(Boolean);
      if (aliasedUids.length === 0) {
        return res.json({ success: true, total: 0, data: [] });
      }
      const inPlaceholders = aliasedUids.map(() => "?").join(", ");
      whereClauses.push(`gy_emp_code IN (${inPlaceholders})`);
      queryParams.push(...aliasedUids);
    }

    // Filter by incomplete (missing PERSONAL_ID in PMS aliases)
    if (filter === "incomplete") {
      const [withPhoneRows] = await pmsDb.query(`
        SELECT DISTINCT employee_uid 
        FROM ${pmsTables.usVisaEmployeeAliases}
        WHERE is_active = 1 AND alias_type = 'PERSONAL_ID' AND TRIM(alias_value) != ''
      `);
      const withPhoneUids = withPhoneRows.map((r) => r.employee_uid).filter(Boolean);
      if (withPhoneUids.length > 0) {
        const inPlaceholders = withPhoneUids.map(() => "?").join(", ");
        whereClauses.push(`gy_emp_code NOT IN (${inPlaceholders})`);
        queryParams.push(...withPhoneUids);
      }
    }

    // Filter by unified (has PERSONAL_ID in PMS aliases)
    if (filter === "unified") {
      const [withPhoneRows] = await pmsDb.query(`
        SELECT DISTINCT employee_uid 
        FROM ${pmsTables.usVisaEmployeeAliases}
        WHERE is_active = 1 AND alias_type = 'PERSONAL_ID' AND TRIM(alias_value) != ''
      `);
      const withPhoneUids = withPhoneRows.map((r) => r.employee_uid).filter(Boolean);
      if (withPhoneUids.length === 0) {
        return res.json({ success: true, total: 0, data: [] });
      }
      const inPlaceholders = withPhoneUids.map(() => "?").join(", ");
      whereClauses.push(`gy_emp_code IN (${inPlaceholders})`);
      queryParams.push(...withPhoneUids);
    }

    // Search filter across Kronos & PMS Aliases
    if (hasSearch) {
      const searchPattern = `%${rawSearch}%`;
      const [matchedAliasRows] = await pmsDb.query(
        `
          SELECT DISTINCT employee_uid 
          FROM ${pmsTables.usVisaEmployeeAliases}
          WHERE alias_value LIKE ? AND is_active = 1
          LIMIT 50
        `,
        [searchPattern],
      );

      const employeeUidsFromAliases = matchedAliasRows
        .map((r) => r.employee_uid)
        .filter(Boolean);

      if (employeeUidsFromAliases.length > 0) {
        const inPlaceholders = employeeUidsFromAliases.map(() => "?").join(", ");
        whereClauses.push(`(
          gy_emp_fullname LIKE ? OR 
          gy_emp_code LIKE ? OR 
          gy_emp_email LIKE ? OR 
          gy_emp_code IN (${inPlaceholders})
        )`);
        queryParams.push(
          searchPattern,
          searchPattern,
          searchPattern,
          ...employeeUidsFromAliases,
        );
      } else {
        whereClauses.push(`(
          gy_emp_fullname LIKE ? OR 
          gy_emp_code LIKE ? OR 
          gy_emp_email LIKE ?
        )`);
        queryParams.push(searchPattern, searchPattern, searchPattern);
      }
    }

    // First, count total matching rows for pagination
    let countQuery = `SELECT COUNT(*) AS total FROM ${kronosTables.employee}`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    const [countRows] = await kronosDb.query(countQuery, queryParams);
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

    // Build main SQL query
    let employeesQuery = `
      SELECT 
        gy_emp_id,
        gy_emp_code,
        gy_emp_fullname,
        gy_emp_email,
        gy_emp_account
      FROM ${kronosTables.employee}
    `;

    if (whereClauses.length > 0) {
      employeesQuery += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    // Sort by tool aliases if requested
    const sortBy = String(req.query.sortBy || "").toLowerCase().trim();
    const sortOrder = String(req.query.sortOrder || "desc").toLowerCase().trim() === "asc" ? "asc" : "desc";

    const validSortTools = {
      fusecom: { type: "FUSECOM_NAME", src: "FUSECOM" },
      fusenet: { type: "FUSENET_NAME", src: "FUSENET" },
      herodash: { type: "HERODASH_NAME", src: "HERODASH" },
    };

    let sortOrderByClause = "gy_emp_id DESC";
    const sortQueryParams = [];

    if (validSortTools[sortBy]) {
      const toolCfg = validSortTools[sortBy];
      const [toolAliasRows] = await pmsDb.query(
        `SELECT DISTINCT employee_uid, alias_value 
         FROM ${pmsTables.usVisaEmployeeAliases} 
         WHERE (alias_type = ? OR (source_system = ? AND alias_type = 'AGENT_NAME')) 
           AND is_active = 1 
           AND TRIM(alias_value) != ''
         ORDER BY alias_value ASC`,
        [toolCfg.type, toolCfg.src],
      );

      const uidMap = new Map();
      for (const row of toolAliasRows) {
        const uidStr = String(row.employee_uid || "").trim();
        if (uidStr && !uidMap.has(uidStr)) {
          uidMap.set(uidStr, row.alias_value);
        }
      }
      const sortedUids = Array.from(uidMap.keys());

      if (sortedUids.length > 0) {
        const inPlaceholders = sortedUids.map(() => "?").join(", ");
        if (sortOrder === "desc") {
          // Aliases first (0), ordered by alias name, then no-aliases (1) by gy_emp_id DESC
          sortOrderByClause = `CASE WHEN gy_emp_code IN (${inPlaceholders}) THEN 0 ELSE 1 END ASC, FIELD(gy_emp_code, ${inPlaceholders}) ASC, gy_emp_id DESC`;
          sortQueryParams.push(...sortedUids, ...sortedUids);
        } else {
          // No-aliases first (0), then aliases (1), ordered by alias name
          sortOrderByClause = `CASE WHEN gy_emp_code IN (${inPlaceholders}) THEN 1 ELSE 0 END ASC, FIELD(gy_emp_code, ${inPlaceholders}) ASC, gy_emp_id DESC`;
          sortQueryParams.push(...sortedUids, ...sortedUids);
        }
      }
    }

    employeesQuery += ` ORDER BY ${sortOrderByClause} LIMIT ? OFFSET ?`;
    const [employees] = await kronosDb.query(employeesQuery, [
      ...queryParams,
      ...sortQueryParams,
      limit,
      offset,
    ]);

    if (employees.length === 0) {
      return res.json({
        success: true,
        total: totalRecords,
        page,
        limit,
        totalPages: Math.ceil(totalRecords / limit),
        data: [],
      });
    }

    // Fetch aliases for all returned employees
    const empCodes = employees.map((e) => e.gy_emp_code).filter(Boolean);
    let aliasesByEmpCode = new Map();

    if (empCodes.length > 0) {
      const inPlaceholders = empCodes.map(() => "?").join(", ");
      const [aliasRows] = await pmsDb.query(
        `
          SELECT 
            employee_uid,
            alias_type,
            source_system,
            alias_value,
            normalized_alias_value,
            is_active
          FROM ${pmsTables.usVisaEmployeeAliases}
          WHERE employee_uid IN (${inPlaceholders}) AND is_active = 1
        `,
        empCodes,
      );

      for (const row of aliasRows) {
        const uid = String(row.employee_uid);
        if (!aliasesByEmpCode.has(uid)) {
          aliasesByEmpCode.set(uid, []);
        }
        aliasesByEmpCode.get(uid).push(row);
      }
    }

    // Transform each employee into the unified ledger record
    const unifiedLedger = employees.map((emp) => {
      const uid = String(emp.gy_emp_code);
      const aliases = aliasesByEmpCode.get(uid) || [];
      const canonicalName = emp.gy_emp_fullname || "";

      // Look up tool-specific aliases
      const fusecomAlias = aliases.find(
        (a) =>
          a.alias_type === "FUSECOM_NAME" ||
          (a.source_system === "FUSECOM" && a.alias_type === "AGENT_NAME"),
      );

      const fusenetAlias = aliases.find(
        (a) =>
          a.alias_type === "FUSENET_NAME" ||
          (a.source_system === "FUSENET" && a.alias_type === "AGENT_NAME"),
      );

      const herodashAlias = aliases.find(
        (a) =>
          a.alias_type === "HERODASH_NAME" ||
          (a.source_system === "HERODASH" && a.alias_type === "AGENT_NAME"),
      );

      const phoneAlias = aliases.find((a) => a.alias_type === "PERSONAL_ID");
      const loginAlias = aliases.find((a) => a.alias_type === "AGENT_LOGIN");

      const phoneId = phoneAlias ? phoneAlias.alias_value : null;
      const agentLogin = loginAlias ? loginAlias.alias_value : null;

      const fusecomName = fusecomAlias ? fusecomAlias.alias_value : null;
      const fusenetName = fusenetAlias ? fusenetAlias.alias_value : null;
      const herodashName = herodashAlias ? herodashAlias.alias_value : null;

      const isExactFusecom =
        fusecomName ? normalizeValue(fusecomName) === normalizeValue(canonicalName) : false;
      const isExactFuseNet =
        fusenetName ? normalizeValue(fusenetName) === normalizeValue(canonicalName) : false;
      const isExactHeroDash =
        herodashName ? normalizeValue(herodashName) === normalizeValue(canonicalName) : false;

      const hasCustomAlias =
        Boolean(
          (fusecomName && !isExactFusecom) ||
          (fusenetName && !isExactFuseNet) ||
          (herodashName && !isExactHeroDash),
        );
      const hasPhoneId = Boolean(phoneId && phoneId.trim());

      // Dynamic Health Indicator
      let status = "UNIFIED";
      let statusReason = "All tools verified";

      if (!hasPhoneId) {
        status = "INCOMPLETE";
        statusReason = "Missing Phone ID";
      } else if (hasCustomAlias) {
        status = "ALIASED";
        statusReason = "Custom tool alias active";
      }

      return {
        sibsId: emp.gy_emp_code,
        fullName: canonicalName,
        email: emp.gy_emp_email || "",
        account: emp.gy_emp_account || "Unassigned",
        phoneId: phoneId,
        agentLogin: agentLogin,
        status,
        statusReason,
        toolMappings: {
          fusecom: {
            name: fusecomName,
            type: fusecomName ? (isExactFusecom ? "EXACT" : "ALIAS") : null,
          },
          fusenet: {
            name: fusenetName,
            type: fusenetName ? (isExactFuseNet ? "EXACT" : "ALIAS") : null,
          },
          herodash: {
            name: herodashName,
            type: herodashName ? (isExactHeroDash ? "EXACT" : "ALIAS") : null,
          },
        },
      };
    });

    return res.json({
      success: true,
      total: totalRecords,
      page,
      limit,
      totalPages: Math.ceil(totalRecords / limit),
      data: unifiedLedger,
    });
  } catch (error) {
    console.error("Failed to fetch master data ledger:", error);
    next(error);
  }
});

/**
 * PUT /api/masterdata/ledger/:sibsId
 * Updates or sets tool aliases and Phone/Login for an employee.
 */
router.put("/ledger/:sibsId", async (req, res, next) => {
  try {
    const sibsId = String(req.params.sibsId || "").trim();
    if (!sibsId) {
      return res.status(400).json({
        success: false,
        message: "SIBS ID is required.",
      });
    }

    const {
      phoneId,
      agentLogin,
      fusecomName,
      fusenetName,
      herodashName,
    } = req.body || {};

    const connection = await pmsDb.getConnection();
    try {
      await connection.beginTransaction();

      const upsertAlias = async (aliasType, sourceSystem, value) => {
        const trimmed = String(value || "").trim();
        const normalized = normalizeValue(trimmed);

        // Check if an alias record already exists for this employee, tool type, and source
        const [existing] = await connection.query(
          `
            SELECT id FROM ${pmsTables.usVisaEmployeeAliases}
            WHERE employee_uid = ? AND alias_type = ? AND source_system = ?
            ORDER BY id ASC
          `,
          [sibsId, aliasType, sourceSystem],
        );

        if (existing.length > 0) {
          const targetId = existing[0].id;

          if (!trimmed) {
            // Deactivate and clear the existing record in-place
            await connection.query(
              `
                UPDATE ${pmsTables.usVisaEmployeeAliases}
                SET alias_value = '',
                    normalized_alias_value = '',
                    is_active = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `,
              [targetId],
            );
          } else {
            // Update the existing record in-place (no new row, no auto-increment)
            await connection.query(
              `
                UPDATE ${pmsTables.usVisaEmployeeAliases}
                SET alias_value = ?,
                    normalized_alias_value = ?,
                    is_active = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
              `,
              [trimmed, normalized, targetId],
            );
          }

          // Clean up any extraneous duplicate rows if they exist
          if (existing.length > 1) {
            await connection.query(
              `
                DELETE FROM ${pmsTables.usVisaEmployeeAliases}
                WHERE employee_uid = ? AND alias_type = ? AND source_system = ? AND id != ?
              `,
              [sibsId, aliasType, sourceSystem, targetId],
            );
          }
        } else if (trimmed) {
          // Only insert if no record exists yet and a value is supplied
          await connection.query(
            `
              INSERT INTO ${pmsTables.usVisaEmployeeAliases}
                (employee_uid, alias_type, source_system, alias_value, normalized_alias_value, is_active)
              VALUES (?, ?, ?, ?, ?, 1)
            `,
            [sibsId, aliasType, sourceSystem, trimmed, normalized],
          );
        }
      };

      if (phoneId !== undefined) {
        await upsertAlias("PERSONAL_ID", "GLOBAL", phoneId);
      }
      if (agentLogin !== undefined) {
        await upsertAlias("AGENT_LOGIN", "GLOBAL", agentLogin);
      }
      if (fusecomName !== undefined) {
        await upsertAlias("FUSECOM_NAME", "FUSECOM", fusecomName);
      }
      if (fusenetName !== undefined) {
        await upsertAlias("FUSENET_NAME", "FUSENET", fusenetName);
      }
      if (herodashName !== undefined) {
        await upsertAlias("HERODASH_NAME", "HERODASH", herodashName);
      }

      await connection.commit();

      return res.json({
        success: true,
        message: `Successfully aligned tool identities for SIBS ID ${sibsId}.`,
      });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Failed to update tool alignment:", error);
    next(error);
  }
});

export default router;

