import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  getAgentInteractionInsertColumns,
  getAgentInteractionInsertValues,
} from "../src/repositories/usVisa/usVisaAgentInteractionRepository.js";
import { pmsTables } from "../src/config/db.js";

const migrationPath = path.resolve(
  "migrations/20260901_000003_create_us_visa_agent_level_tables.sql",
);
const identityMigrationPath = path.resolve(
  "migrations/20260901_000004_add_us_visa_employee_identity_mapping.sql",
);
const scopeMigrationPath = path.resolve(
  "migrations/20260901_000005_create_us_visa_employee_scope_assignments.sql",
);

test("Agent Level migration creates one canonical interaction table and profiles", async () => {
  const migration = await fs.readFile(migrationPath, "utf8");

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS us_visa_raw_agent_interactions/i,
  );
  assert.match(migration, /'FUSECOM_AGENT_LEVEL'/);
  assert.match(migration, /'FUSENET_AGENT_LEVEL'/);
  assert.match(migration, /'HERODASH_AGENT_LEVEL'/);
  assert.match(migration, /'AGENT_LEVEL'/);
  assert.doesNotMatch(migration, /fusecom_agent_raw/i);
  assert.doesNotMatch(migration, /fusenet_agent_raw/i);
  assert.doesNotMatch(migration, /herodash_agent_raw/i);
});

test("Agent interaction table keeps Skill Statistics tables intact", async () => {
  const existingMigration = await fs.readFile(
    path.resolve("migrations/20260818_000001_create_us_visa_import_tables.sql"),
    "utf8",
  );
  const agentMigration = await fs.readFile(migrationPath, "utf8");

  assert.match(existingMigration, /CREATE TABLE IF NOT EXISTS us_visa_raw_skill_statistics/i);
  assert.doesNotMatch(agentMigration, /ALTER TABLE\s+us_visa_raw_skill_statistics/i);
  assert.doesNotMatch(agentMigration, /REFERENCES\s+us_visa_raw_import_rows/i);
  assert.doesNotMatch(agentMigration, /DROP TABLE/i);
});

test("Agent interaction repository exposes columns for all supported source systems", () => {
  const columns = getAgentInteractionInsertColumns();
  const expectedColumns = [
    "batch_id",
    "raw_import_row_id",
    "import_profile_id",
    "source_system",
    "source_sheet",
    "interaction_type",
    "source_interaction_id",
    "call_id",
    "production_date",
    "agent_name_raw",
    "agent_login",
    "personal_id",
    "source_agent_key",
    "employee_uid",
    "mapping_status",
    "mapping_method",
    "skill_name_raw",
    "task_order_id",
    "direction",
    "interaction_status",
    "arrival_at",
    "queue_at",
    "answer_at",
    "end_at",
    "queue_seconds",
    "talk_seconds",
    "hold_seconds",
    "after_call_seconds",
    "handle_seconds",
    "hold_count",
    "disconnect_indicator",
    "row_json",
    "row_identity_hash",
    "row_content_hash",
  ];

  assert.deepEqual(columns, expectedColumns);

  for (const sourceSystem of ["FUSECOM", "FUSENET", "HERODASH"]) {
    const values = getAgentInteractionInsertValues({
      batchId: 1,
      rawImportRowId: null,
      importProfileId: 2,
      sourceSystem,
      sourceSheet: "Agent Level",
      interactionType: "CALL",
      sourceInteractionId: `${sourceSystem}-interaction-1`,
      callId: `${sourceSystem}-call-1`,
      productionDate: "2026-07-26",
      agentNameRaw: "Sample Agent",
      sourceAgentKey: "Sample Agent",
      mappingStatus: "UNMATCHED",
      queueSeconds: 0,
      talkSeconds: 12,
      holdSeconds: 0,
      afterCallSeconds: 3,
      handleSeconds: 15,
      holdCount: 0,
      rowJson: {
        "Source Only Header": "preserved",
        "Call ID": `${sourceSystem}-call-1`,
      },
      rowIdentityHash: "a".repeat(64),
      rowContentHash: "b".repeat(64),
    });

    assert.equal(values.length, columns.length);
    assert.equal(values[columns.indexOf("source_system")], sourceSystem);
    assert.equal(values[columns.indexOf("mapping_status")], "UNMATCHED");
    assert.equal(values[columns.indexOf("mapping_method")], null);
    assert.equal(values[columns.indexOf("queue_seconds")], 0);
    assert.equal(values[columns.indexOf("hold_seconds")], 0);
    assert.equal(values[columns.indexOf("hold_count")], 0);
    assert.equal(
      values[columns.indexOf("row_json")],
      JSON.stringify({
        "Source Only Header": "preserved",
        "Call ID": `${sourceSystem}-call-1`,
      }),
    );
  }
});

test("Agent interaction hashes are constrained and indexed for duplicate protection", async () => {
  const migration = await fs.readFile(migrationPath, "utf8");

  assert.match(migration, /row_identity_hash CHAR\(64\) NOT NULL/i);
  assert.match(migration, /row_content_hash CHAR\(64\) NOT NULL/i);
  assert.match(
    migration,
    /UNIQUE KEY uq_us_visa_agent_interactions_identity_hash \(row_identity_hash\)/i,
  );
  assert.match(
    migration,
    /KEY idx_us_visa_agent_interactions_content_hash \(row_content_hash\)/i,
  );
  assert.ok(
    pmsTables.usVisaRawAgentInteractions.includes("us_visa_raw_agent_interactions"),
  );
});

test("Agent identity mapping migration adds alias support without competing employee master data", async () => {
  const migration = await fs.readFile(identityMigrationPath, "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS us_visa_employee_aliases/i);
  assert.match(migration, /employee_uid VARCHAR\(100\) NOT NULL/i);
  assert.match(migration, /source_system VARCHAR\(50\) NOT NULL DEFAULT 'GLOBAL'/i);
  assert.match(migration, /'PERSONAL_ID'/);
  assert.match(migration, /'AGENT_LOGIN'/);
  assert.match(migration, /'FUSECOM_NAME'/);
  assert.match(migration, /'FUSENET_NAME'/);
  assert.match(migration, /'HERODASH_NAME'/);
  assert.match(migration, /ALTER TABLE us_visa_raw_agent_interactions/i);
  assert.match(migration, /ADD COLUMN mapping_status ENUM/i);
  assert.match(migration, /ADD COLUMN mapping_method VARCHAR\(50\) NULL/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS us_visa_employees/i);
  assert.doesNotMatch(migration, /DROP TABLE/i);
  assert.ok(pmsTables.usVisaEmployeeAliases.includes("us_visa_employee_aliases"));
});

test("US Visa organizational scope migration is effective dated and roster based", async () => {
  const migration = await fs.readFile(scopeMigrationPath, "utf8");

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS us_visa_employee_scope_assignments/i,
  );
  assert.match(migration, /employee_uid VARCHAR\(100\) NOT NULL/i);
  assert.match(migration, /task_order_id VARCHAR\(50\) NOT NULL/i);
  assert.match(migration, /team_leader_uid VARCHAR\(100\) NOT NULL/i);
  assert.match(migration, /operations_manager_uid VARCHAR\(100\) NOT NULL/i);
  assert.match(migration, /effective_from DATE NOT NULL/i);
  assert.match(migration, /effective_to DATE NULL/i);
  assert.match(migration, /CHECK \(effective_to IS NULL OR effective_to >= effective_from\)/i);
  assert.doesNotMatch(migration, /skill_name/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS us_visa_employees/i);
  assert.ok(
    pmsTables.usVisaEmployeeScopeAssignments.includes(
      "us_visa_employee_scope_assignments",
    ),
  );
});
