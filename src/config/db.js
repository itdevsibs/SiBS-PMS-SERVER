// Configures Kronos and PMS database pools and table helpers.
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const DB_TIMEZONE = "+08:00";

const REQUIRED_DB_ENV_VARS = [
  // DB1 - Kronos
  "DB1_HOST",
  "DB1_USER",
  "DB1_PASSWORD",
  "DB1_NAME",

  // DB2 - PMS
  "DB2_HOST",
  "DB2_USER",
  "DB2_PASSWORD",
  "DB2_NAME",

  // DB3 - HRIS
  "DB3_HOST",
  "DB3_USER",
  "DB3_PASSWORD",
  "DB3_NAME",
];

const SKIP_DB_CHECK = process.env.SKIP_DB_CHECK === "true";

const missingDbEnvVars = REQUIRED_DB_ENV_VARS.filter(
  (envVar) => !process.env[envVar],
);

if (missingDbEnvVars.length > 0 && !SKIP_DB_CHECK) {
  throw new Error(
    `Missing required database env vars: ${missingDbEnvVars.join(", ")}`,
  );
}

// ============================================================
// DATABASE NAMES
// ============================================================

export const KRONOS_DB_NAME = process.env.DB1_NAME || "kronos_testdb";
export const PMS_DB_NAME = process.env.DB2_NAME || "pms_db";
export const HRIS_DB_NAME = process.env.DB3_NAME || "hris_db";

// ============================================================
// DATABASE POOL CREATOR
// ============================================================

function createDbPool({
  host,
  port,
  user,
  password,
  database,
  ssl = false,
}) {
  return mysql.createPool({
    host,
    port: Number(port || 3306),
    user,
    password,
    database,

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

    connectTimeout: 10000,

    timezone: DB_TIMEZONE,

    ssl: ssl
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
  });
}

// ============================================================
// SQL IDENTIFIER UTILITIES
// ============================================================

function cleanSqlIdentifier(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_]/g, "");
}

export function dbTable(databaseName, tableName) {
  const safeDatabaseName = cleanSqlIdentifier(databaseName);
  const safeTableName = cleanSqlIdentifier(tableName);

  if (!safeDatabaseName || !safeTableName) {
    throw new Error("Invalid database or table name.");
  }

  return `\`${safeDatabaseName}\`.\`${safeTableName}\``;
}

// ============================================================
// KRONOS TABLES
// Authentication / employee master data
// ============================================================

export const kronosTables = {
  employee: dbTable(KRONOS_DB_NAME, "gy_employee"),
  user: dbTable(KRONOS_DB_NAME, "gy_user"),
  accounts: dbTable(KRONOS_DB_NAME, "gy_accounts"),
  department: dbTable(KRONOS_DB_NAME, "gy_department"),
};

// ============================================================
// PMS TABLES
// PMS-specific application data only
// ============================================================

export const pmsTables = {
  sample: dbTable(PMS_DB_NAME, "sample"),
  usVisaImportProfiles: dbTable(PMS_DB_NAME, "us_visa_import_profiles"),
  usVisaImportBatches: dbTable(PMS_DB_NAME, "us_visa_import_batches"),
  usVisaRawImportRows: dbTable(PMS_DB_NAME, "us_visa_raw_import_rows"),
  usVisaImportErrors: dbTable(PMS_DB_NAME, "us_visa_import_errors"),
  usVisaRawSkillStatistics: dbTable(
    PMS_DB_NAME,
    "us_visa_raw_skill_statistics",
  ),
};

// ============================================================
// HRIS TABLES
// Authorization / admin access source
// ============================================================

export const hrisTables = {
  assignedAccounts: dbTable(HRIS_DB_NAME, "assigned_accounts"),
};

// ============================================================
// DATABASE CONNECTION POOLS
// ============================================================

// DB1 - Kronos
export const kronosDb = createDbPool({
  host: process.env.DB1_HOST,
  port: process.env.DB1_PORT,
  user: process.env.DB1_USER,
  password: process.env.DB1_PASSWORD,
  database: process.env.DB1_NAME,
});

// DB2 - PMS
export const pmsDb = createDbPool({
  host: process.env.DB2_HOST,
  port: process.env.DB2_PORT,
  user: process.env.DB2_USER,
  password: process.env.DB2_PASSWORD,
  database: process.env.DB2_NAME,
});

// DB3 - HRIS
export const hrisDb = createDbPool({
  host: process.env.DB3_HOST,
  port: process.env.DB3_PORT,
  user: process.env.DB3_USER,
  password: process.env.DB3_PASSWORD,
  database: process.env.DB3_NAME,
});

// ============================================================
// CONNECTION TEST
// ============================================================

async function testSingleConnection(pool, label) {
  let connection;

  try {
    connection = await pool.getConnection();

    await connection.query("SET time_zone = ?", [DB_TIMEZONE]);

    const [[timezoneRow]] = await connection.query(`
      SELECT
        @@session.time_zone AS sessionTimeZone,
        NOW() AS currentTime
    `);

    console.log(`${label} connected successfully`);

    console.log(
      `${label} timezone: ${timezoneRow?.sessionTimeZone || DB_TIMEZONE}`,
    );

    console.log(
      `${label} current time: ${timezoneRow?.currentTime || "-"}`,
    );

    return true;
  } catch (error) {
    console.error(`${label} connection failed:`, {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
    });

    return false;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// ============================================================
// SET POOL TIMEZONE
// ============================================================

async function setPoolTimezone(pool, label) {
  let connection;

  try {
    connection = await pool.getConnection();

    await connection.query("SET time_zone = ?", [DB_TIMEZONE]);

    console.log(
      `${label} session timezone set to ${DB_TIMEZONE}`,
    );

    return true;
  } catch (error) {
    console.error(`Failed to set timezone for ${label}:`, {
      message: error.message,
      code: error.code,
    });

    return false;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// ============================================================
// TEST ALL DATABASE CONNECTIONS
// ============================================================

export async function testDbConnections() {
  if (SKIP_DB_CHECK) {
    console.warn(
      "Skipping database connection checks because SKIP_DB_CHECK=true",
    );

    return true;
  }

  const connectionResults = await Promise.all([
    testSingleConnection(kronosDb, "Kronos DB"),
    testSingleConnection(pmsDb, "PMS DB"),
    testSingleConnection(hrisDb, "HRIS DB"),
  ]);

  await Promise.all([
    setPoolTimezone(kronosDb, "Kronos DB"),
    setPoolTimezone(pmsDb, "PMS DB"),
    setPoolTimezone(hrisDb, "HRIS DB"),
  ]);

  if (!connectionResults.every(Boolean)) {
    throw new Error(
      "One or more database connections failed.",
    );
  }

  return true;
}
