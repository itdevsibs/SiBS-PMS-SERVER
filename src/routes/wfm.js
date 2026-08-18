// Stores WFM imported files and parsed rows in the PMS database.
import express from "express";

import { pmsDb, pmsTables } from "../config/db.js";

const router = express.Router();

let tableReadyPromise = null;

function safeString(value) {
  return String(value ?? "").trim();
}

function toNullableString(value) {
  const text = safeString(value);

  return text || null;
}

function toPositiveInteger(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function getFileExtension(fileName = "") {
  const match = safeString(fileName).match(/\.([^.]+)$/);

  return match ? match[1].toLowerCase() : null;
}

function buildDisplayName(account, taskOrder, fileTitle) {
  return [account, taskOrder, fileTitle].map(safeString).filter(Boolean).join("-");
}

function quoteColumn(columnName) {
  return `\`${String(columnName).replace(/`/g, "``")}\``;
}

function parseJsonArray(value) {
  if (!value) return [];

  try {
    const parsedValue = JSON.parse(value);

    return Array.isArray(parsedValue) ? parsedValue : [];
  } catch {
    return [];
  }
}

function normalizeIdentifier(value, fallback = "imported_file") {
  const normalized = safeString(value)
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 58);

  return normalized || fallback;
}

function getDateNamePart(fileTitle) {
  const fileName = safeString(fileTitle).replace(/\.[^.]+$/, "");
  const monthDateYearMatch = fileName.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\d{0,2}(?:\s*[-_ ]\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)?[a-z]*\d{1,2})?(?:,?\s*[-_ ]?\s*\d{2,4})?\b/i,
  );

  if (monthDateYearMatch) {
    return normalizeIdentifier(monthDateYearMatch[0], "import");
  }

  const numericDateMatch = fileName.match(
    /\b\d{1,2}[-_/]\d{1,2}[-_/]\d{2,4}\b/,
  );

  if (numericDateMatch) {
    return normalizeIdentifier(numericDateMatch[0], "import");
  }

  return normalizeIdentifier(new Date().toISOString().slice(0, 10), "import");
}

function buildBaseDataTableName(fileTitle) {
  const fileName = safeString(fileTitle).replace(/\.[^.]+$/, "");
  const firstName = normalizeIdentifier(fileName.split(/[\s_-]+/)[0], "file");
  const datePart = getDateNamePart(fileName);

  return normalizeIdentifier(`${firstName}_${datePart}`, "wfm_import");
}

async function getAvailableDataTableName(fileTitle) {
  const baseName = buildBaseDataTableName(fileTitle).slice(0, 58);
  let tableName = baseName;
  let suffix = 2;

  while (suffix < 1000) {
    const [existingTables] = await pmsDb.query("SHOW TABLES LIKE ?", [tableName]);

    if (!existingTables.length) {
      return tableName;
    }

    tableName = `${baseName}_${suffix}`.slice(0, 64);
    suffix += 1;
  }

  throw new Error("Could not create a unique table name for imported file.");
}

function normalizeMysqlColumnName(columnName, fallback) {
  const text = safeString(columnName) || fallback;

  return text.slice(0, 64);
}

function getImportColumnNames(columns = []) {
  const usedColumns = new Map();

  return columns.map((column, index) => {
    const baseName = normalizeMysqlColumnName(column, `Column ${index + 1}`);
    const usedCount = usedColumns.get(baseName) || 0;
    const finalName =
      usedCount > 0
        ? normalizeMysqlColumnName(`${baseName} ${usedCount + 1}`, `Column ${index + 1}`)
        : baseName;

    usedColumns.set(baseName, usedCount + 1);

    return {
      sourceName: safeString(column) || `Column ${index + 1}`,
      dbName: finalName,
    };
  });
}

async function ensureColumn(columnName, columnDefinition, afterColumn) {
  const [columns] = await pmsDb.query(
    `SHOW COLUMNS FROM ${pmsTables.wfmImportedFiles} LIKE ?`,
    [columnName],
  );

  if (!columns.length) {
    const afterSql = afterColumn ? ` AFTER \`${afterColumn}\`` : "";

    await pmsDb.query(
      `ALTER TABLE ${pmsTables.wfmImportedFiles}
       ADD COLUMN ${columnDefinition}${afterSql}`,
    );
  }
}

async function ensureWfmImportedFilesTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = (async () => {
      await pmsDb.query(`
        CREATE TABLE IF NOT EXISTS ${pmsTables.wfmImportedFiles} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          upload_id VARCHAR(191) NOT NULL,
          account VARCHAR(100) NOT NULL,
          task_order VARCHAR(100) NOT NULL,
          card_id VARCHAR(191) NOT NULL,
          file_title VARCHAR(255) NOT NULL,
          display_name VARCHAR(600) NOT NULL,
          file_path VARCHAR(500) NULL,
          generated_table_name VARCHAR(100) NULL,
          file_extension VARCHAR(20) NULL,
          file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
          row_count INT UNSIGNED NOT NULL DEFAULT 0,
          column_count INT UNSIGNED NOT NULL DEFAULT 0,
          columns_json LONGTEXT NULL,
          rows_json LONGTEXT NULL,
          uploaded_at_ms BIGINT UNSIGNED NULL,
          uploaded_at_label VARCHAR(100) NULL,
          uploaded_by VARCHAR(191) NULL,
          metadata_json LONGTEXT NULL,
          graph_ready TINYINT(1) NOT NULL DEFAULT 0,
          graph_ready_at TIMESTAMP NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          UNIQUE KEY uq_wfm_imported_files_upload_id (upload_id),
          KEY idx_wfm_imported_files_account_task_order (account, task_order),
          KEY idx_wfm_imported_files_file_title (file_title)
        )
      `);

      await ensureColumn(
        "display_name",
        "display_name VARCHAR(600) NOT NULL DEFAULT ''",
        "file_title",
      );
      await ensureColumn(
        "columns_json",
        "columns_json LONGTEXT NULL",
        "column_count",
      );
      await ensureColumn(
        "rows_json",
        "rows_json LONGTEXT NULL",
        "columns_json",
      );
      await ensureColumn(
        "generated_table_name",
        "generated_table_name VARCHAR(100) NULL",
        "file_path",
      );
      await ensureColumn(
        "graph_ready",
        "graph_ready TINYINT(1) NOT NULL DEFAULT 0",
        "metadata_json",
      );
      await ensureColumn(
        "graph_ready_at",
        "graph_ready_at TIMESTAMP NULL",
        "graph_ready",
      );
    })();
  }

  return tableReadyPromise;
}

async function createImportedDataTable(tableName, importColumns) {
  const dataColumnsSql = importColumns
    .map((column) => `${quoteColumn(column.dbName)} LONGTEXT NULL`)
    .join(",\n      ");

  await pmsDb.query(`
    CREATE TABLE ${quoteColumn(tableName)} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      excel_row_number INT UNSIGNED NOT NULL,
      ${dataColumnsSql},
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
}

async function insertGeneratedTableRows(tableName, importColumns, rows = []) {
  if (!rows.length) {
    return;
  }

  const insertColumns = [
    "excel_row_number",
    ...importColumns.map((column) => column.dbName),
  ];
  const values = rows.map((row, index) => [
    index + 2,
    ...importColumns.map((column) => {
      const value = row?.[column.sourceName];

      return value == null ? null : String(value);
    }),
  ]);

  await pmsDb.query(
    `
      INSERT INTO ${quoteColumn(tableName)}
        (${insertColumns.map(quoteColumn).join(", ")})
      VALUES ?
    `,
    [values],
  );
}

router.get("/imported-files", async (req, res, next) => {
  try {
    await ensureWfmImportedFilesTable();

    const graphReadyOnly = String(req.query?.graphReady || "").toLowerCase() === "true";
    const whereSql = graphReadyOnly ? "WHERE graph_ready = 1" : "";

    const [rows] = await pmsDb.query(
      `
        SELECT
          upload_id AS uploadId,
          account,
          task_order AS taskOrder,
          card_id AS cardId,
          file_title AS fileTitle,
          display_name AS displayName,
          file_path AS filePath,
          file_extension AS fileExtension,
          file_size AS fileSize,
          row_count AS rowCount,
          column_count AS columnCount,
          uploaded_at_ms AS uploadedAtMs,
          uploaded_at_label AS uploadedAtLabel,
          uploaded_by AS uploadedBy,
          graph_ready AS graphReady,
          graph_ready_at AS graphReadyAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM ${pmsTables.wfmImportedFiles}
        ${whereSql}
        ORDER BY created_at DESC
      `,
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/imported-files/:uploadId/report", async (req, res, next) => {
  try {
    await ensureWfmImportedFilesTable();

    const uploadId = safeString(req.params.uploadId);

    if (!uploadId) {
      return res.status(400).json({
        success: false,
        message: "uploadId is required.",
      });
    }

    const [fileRows] = await pmsDb.query(
      `
        SELECT
          upload_id AS uploadId,
          account,
          task_order AS taskOrder,
          card_id AS cardId,
          file_title AS fileTitle,
          display_name AS displayName,
          generated_table_name AS generatedTableName,
          row_count AS rowCount,
          column_count AS columnCount,
          columns_json AS columnsJson,
          uploaded_at_ms AS uploadedAtMs,
          uploaded_at_label AS uploadedAtLabel,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM ${pmsTables.wfmImportedFiles}
        WHERE upload_id = ?
        LIMIT 1
      `,
      [uploadId],
    );
    const importedFile = fileRows[0];

    if (!importedFile) {
      return res.status(404).json({
        success: false,
        message: "Imported file was not found.",
      });
    }

    if (!importedFile.generatedTableName) {
      return res.status(404).json({
        success: false,
        message: "Imported file table was not found.",
      });
    }

    const [tableColumns] = await pmsDb.query(
      `SHOW COLUMNS FROM ${quoteColumn(importedFile.generatedTableName)}`,
    );
    const dataColumns = tableColumns
      .map((column) => column.Field)
      .filter((column) => !["id", "excel_row_number", "created_at"].includes(column));
    const savedColumns = parseJsonArray(importedFile.columnsJson);
    const responseColumns = savedColumns.length
      ? savedColumns.filter((column) => dataColumns.includes(column))
      : dataColumns;
    const selectedColumns = responseColumns.length ? responseColumns : dataColumns;

    const [rows] = await pmsDb.query(
      `
        SELECT ${selectedColumns.map(quoteColumn).join(", ")}
        FROM ${quoteColumn(importedFile.generatedTableName)}
        ORDER BY excel_row_number ASC, id ASC
      `,
    );

    return res.json({
      success: true,
      data: {
        ...importedFile,
        columns: selectedColumns,
        rows,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/imported-files/:uploadId/graph-ready", async (req, res, next) => {
  try {
    await ensureWfmImportedFilesTable();

    const uploadId = safeString(req.params.uploadId);

    if (!uploadId) {
      return res.status(400).json({
        success: false,
        message: "uploadId is required.",
      });
    }

    const [result] = await pmsDb.query(
      `
        UPDATE ${pmsTables.wfmImportedFiles}
        SET graph_ready = 1,
            graph_ready_at = CURRENT_TIMESTAMP
        WHERE upload_id = ?
      `,
      [uploadId],
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Imported file was not found.",
      });
    }

    return res.json({
      success: true,
      message: "WFM imported file is ready for View Graphs.",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/imported-files", async (req, res, next) => {
  try {
    await ensureWfmImportedFilesTable();

    const uploadId = safeString(req.body?.uploadId);
    const account = safeString(req.body?.account);
    const taskOrder = safeString(req.body?.taskOrder);
    const cardId = safeString(req.body?.cardId);
    const fileTitle = safeString(req.body?.fileTitle);
    const columns = Array.isArray(req.body?.columns) ? req.body.columns : [];
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!uploadId || !account || !taskOrder || !cardId || !fileTitle) {
      return res.status(400).json({
        success: false,
        message:
          "uploadId, account, taskOrder, cardId, and fileTitle are required.",
      });
    }

    const displayName = buildDisplayName(account, taskOrder, fileTitle);
    const metadata = {
      source: "wfm-import-data",
      originalFileName: fileTitle,
    };
    const importColumns = getImportColumnNames(columns.length ? columns : ["Source File"]);
    const generatedTableName = await getAvailableDataTableName(fileTitle);

    await createImportedDataTable(generatedTableName, importColumns);

    try {
      await insertGeneratedTableRows(generatedTableName, importColumns, rows);
    } catch (error) {
      try {
        await pmsDb.query(`DELETE FROM ${quoteColumn(generatedTableName)}`);
      } catch {
        // If cleanup fails, keep the original insert error for the caller.
      }

      throw error;
    }

    await pmsDb.query(
      `
        INSERT INTO ${pmsTables.wfmImportedFiles} (
          upload_id,
          account,
          task_order,
          card_id,
          file_title,
          display_name,
          file_path,
          generated_table_name,
          file_extension,
          file_size,
          row_count,
          column_count,
          columns_json,
          rows_json,
          uploaded_at_ms,
          uploaded_at_label,
          uploaded_by,
          metadata_json,
          graph_ready,
          graph_ready_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        ON DUPLICATE KEY UPDATE
          account = VALUES(account),
          task_order = VALUES(task_order),
          card_id = VALUES(card_id),
          file_title = VALUES(file_title),
          display_name = VALUES(display_name),
          file_path = VALUES(file_path),
          generated_table_name = VALUES(generated_table_name),
          file_extension = VALUES(file_extension),
          file_size = VALUES(file_size),
          row_count = VALUES(row_count),
          column_count = VALUES(column_count),
          columns_json = VALUES(columns_json),
          rows_json = VALUES(rows_json),
          uploaded_at_ms = VALUES(uploaded_at_ms),
          uploaded_at_label = VALUES(uploaded_at_label),
          uploaded_by = VALUES(uploaded_by),
          metadata_json = VALUES(metadata_json),
          graph_ready = 0,
          graph_ready_at = NULL
      `,
      [
        uploadId,
        account,
        taskOrder,
        cardId,
        fileTitle,
        displayName,
        toNullableString(req.body?.filePath),
        generatedTableName,
        getFileExtension(fileTitle),
        toPositiveInteger(req.body?.fileSize),
        rows.length,
        columns.length,
        JSON.stringify(columns),
        JSON.stringify(rows),
        toPositiveInteger(req.body?.uploadedAtMs, null),
        toNullableString(req.body?.uploadedAtLabel),
        toNullableString(req.body?.uploadedBy),
        JSON.stringify(metadata),
      ],
    );

    return res.status(201).json({
      success: true,
      displayName,
      generatedTableName,
      message: "WFM imported file saved.",
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/imported-files/:uploadId", async (req, res, next) => {
  try {
    await ensureWfmImportedFilesTable();

    const uploadId = safeString(req.params.uploadId);

    if (!uploadId) {
      return res.status(400).json({
        success: false,
        message: "uploadId is required.",
      });
    }

    const [fileRows] = await pmsDb.query(
      `
        SELECT generated_table_name AS generatedTableName
        FROM ${pmsTables.wfmImportedFiles}
        WHERE upload_id = ?
        LIMIT 1
      `,
      [uploadId],
    );
    const generatedTableName = fileRows[0]?.generatedTableName;

    if (generatedTableName) {
      try {
        await pmsDb.query(`DROP TABLE IF EXISTS ${quoteColumn(generatedTableName)}`);
      } catch (error) {
        if (error?.code === "ER_NO_SUCH_TABLE") {
          // The metadata can outlive a manually deleted raw table.
        } else if (error?.code !== "ER_TABLEACCESS_DENIED_ERROR") {
          throw error;
        } else {
          try {
            await pmsDb.query(`DELETE FROM ${quoteColumn(generatedTableName)}`);
          } catch (deleteRowsError) {
            if (deleteRowsError?.code !== "ER_NO_SUCH_TABLE") {
              throw deleteRowsError;
            }
          }
        }
      }
    }

    const [result] = await pmsDb.query(
      `
        DELETE FROM ${pmsTables.wfmImportedFiles}
        WHERE upload_id = ?
      `,
      [uploadId],
    );

    return res.json({
      success: true,
      deletedCount: result.affectedRows || 0,
      message: "WFM imported file deleted.",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
