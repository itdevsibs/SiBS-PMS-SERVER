import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const DB_TIMEZONE = "+08:00";

const REQUIRED_DB_ENV_VARS = [
  "DB1_HOST",
  "DB1_USER",
  "DB1_PASSWORD",
  "DB1_NAME",
  "DB2_HOST",
  "DB2_USER",
  "DB2_PASSWORD",
  "DB2_NAME",
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

export const KRONOS_DB_NAME = process.env.DB1_NAME || "kronos";
export const PMS_DB_NAME = process.env.DB2_NAME || "pms";

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

export const kronosTables = {
  employee: dbTable(KRONOS_DB_NAME, "gy_employee"),
  user: dbTable(KRONOS_DB_NAME, "gy_user"),
  accounts: dbTable(KRONOS_DB_NAME, "gy_accounts"),
  department: dbTable(KRONOS_DB_NAME, "gy_department"),
};

export const pmsTables = {
  sample: dbTable(PMS_DB_NAME, "sample"),
};

export const kronosDb = createDbPool({
  host: process.env.DB1_HOST,
  port: process.env.DB1_PORT,
  user: process.env.DB1_USER,
  password: process.env.DB1_PASSWORD,
  database: process.env.DB1_NAME,
});

export const pmsDb = createDbPool({
  host: process.env.DB2_HOST,
  port: process.env.DB2_PORT,
  user: process.env.DB2_USER,
  password: process.env.DB2_PASSWORD,
  database: process.env.DB2_NAME,
});

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
    console.log(`${label} current time: ${timezoneRow?.currentTime || "-"}`);

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

async function setPoolTimezone(pool, label) {
  let connection;

  try {
    connection = await pool.getConnection();

    await connection.query("SET time_zone = ?", [DB_TIMEZONE]);

    console.log(`${label} session timezone set to ${DB_TIMEZONE}`);

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

export async function testDbConnections() {
  if (SKIP_DB_CHECK) {
    console.warn("Skipping database connection checks because SKIP_DB_CHECK=true");

    return true;
  }

  const connectionResults = await Promise.all([
    testSingleConnection(kronosDb, "Kronos DB"),
    testSingleConnection(pmsDb, "PMS DB"),
  ]);

  await Promise.all([
    setPoolTimezone(kronosDb, "Kronos DB"),
    setPoolTimezone(pmsDb, "PMS DB"),
  ]);

  if (!connectionResults.every(Boolean)) {
    throw new Error("One or more database connections failed.");
  }

  return true;
}
