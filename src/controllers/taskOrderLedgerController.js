// Controller for US Visa Task Order Ledger records.
import { pmsDb } from "../config/db.js";

export async function getTaskOrderLedger(req, res) {
  try {
    const { taskOrder, search, skill, country } = req.query;

    let sql = `
      SELECT 
        l.id,
        l.skill,
        l.country,
        COALESCE(l.task_order, p.task_order_name) AS task_order,
        p.task_order_code,
        p.region,
        l.status,
        l.created_at,
        l.updated_at
      FROM us_visa_task_order_ledger l
      LEFT JOIN us_visa_task_order_ledger_profiles p ON l.task_order_profile_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (taskOrder && taskOrder !== "ALL" && taskOrder !== "All Task Orders") {
      // Robustly normalize task order for matching e.g. T010 / TO10 / SEASIA / en-dashes
      const rawInput = String(taskOrder).trim().toUpperCase();
      const cleanInput = rawInput.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ");
      const strippedInput = cleanInput.replace(/[^A-Z0-9]/g, "");
      const toStripped = strippedInput.replace(/T0(\d+)/g, "TO$1");
      const tZeroStripped = strippedInput.replace(/TO(\d+)/g, "T0$1");

      let extractedRegion = null;
      if (cleanInput.includes("SEASIA")) extractedRegion = "SEASIA";
      else if (cleanInput.includes("NICE")) extractedRegion = "NICE";
      else if (cleanInput.includes("NESAMI")) extractedRegion = "NESAMI";
      else if (cleanInput.includes("PAC")) extractedRegion = "PAC";
      else if (cleanInput.includes("SEURECA")) extractedRegion = "SEURECA";

      sql += ` AND (
        UPPER(p.task_order_name) = ?
        OR UPPER(l.task_order) = ?
        OR UPPER(p.task_order_code) = ?
        OR REPLACE(REPLACE(REPLACE(REPLACE(UPPER(p.task_order_name), ' ', ''), '-', ''), '_', ''), '–', '') IN (?, ?)
        OR REPLACE(REPLACE(REPLACE(REPLACE(UPPER(p.task_order_code), ' ', ''), '-', ''), '_', ''), '–', '') IN (?, ?)
        OR REPLACE(REPLACE(REPLACE(REPLACE(UPPER(l.task_order), ' ', ''), '-', ''), '_', ''), '–', '') IN (?, ?)
        OR REPLACE(REPLACE(REPLACE(REPLACE(UPPER(l.task_order), ' ', ''), '-', ''), '_', ''), '–', '') LIKE ?
        OR (p.region IS NOT NULL AND UPPER(p.region) = ?)
        OR (? IS NOT NULL AND (p.region = ? OR UPPER(l.task_order) LIKE ?))
      )`;
      params.push(
        cleanInput,
        cleanInput,
        cleanInput,
        toStripped,
        tZeroStripped,
        toStripped,
        tZeroStripped,
        toStripped,
        tZeroStripped,
        `%${toStripped}%`,
        cleanInput,
        extractedRegion,
        extractedRegion,
        `%${extractedRegion}%`,
      );
    }

    if (country && country !== "ALL" && country !== "All Countries") {
      sql += ` AND UPPER(TRIM(l.country)) = UPPER(TRIM(?))`;
      params.push(String(country).trim());
    }

    if (skill && skill !== "ALL" && skill !== "All Skills") {
      sql += ` AND UPPER(TRIM(l.skill)) = UPPER(TRIM(?))`;
      params.push(String(skill).trim());
    }

    if (search && String(search).trim()) {
      const term = `%${String(search).trim().toLowerCase()}%`;
      sql += ` AND (
        LOWER(l.skill) LIKE ?
        OR LOWER(l.country) LIKE ?
        OR LOWER(COALESCE(l.task_order, '')) LIKE ?
        OR LOWER(COALESCE(p.task_order_name, '')) LIKE ?
      )`;
      params.push(term, term, term, term);
    }

    sql += ` ORDER BY l.id ASC`;

    const [rows] = await pmsDb.query(sql, params);

    return res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching task order ledger:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch task order ledger records",
      error: error.message,
    });
  }
}
