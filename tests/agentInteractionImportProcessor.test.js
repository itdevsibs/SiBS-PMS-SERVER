import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
} from "../src/services/imports/usVisa/importChunkClassifier.js";
import {
  createAgentInteractionContentHash,
  createAgentInteractionIdentityHash,
} from "../src/services/imports/usVisa/agentInteractions/agentInteractionHashService.js";
import {
  mapAgentInteractionRow,
} from "../src/services/imports/usVisa/agentInteractions/agentInteractionMapper.js";
import {
  validateCanonicalAgentInteractionRow,
} from "../src/services/imports/usVisa/agentInteractions/agentInteractionValidator.js";
import {
  IMPORT_PROFILE_CODES,
  validateWorkbookProfile,
} from "../src/services/imports/usVisa/workbookValidator.js";

const SOURCE_HEADERS = {
  [IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL]: [
    "Call ID",
    "Date",
    "Agent Name",
    "Agent Login",
    "Personal ID",
    "Skill Name",
    "Direction",
    "Status",
    "Arrival Time",
    "Queue Time",
    "Answer Time",
    "End Time",
    "Queue Time (sec)",
    "Talk Time",
    "Hold Time",
    "After Call Time",
    "Handle Time",
    "Hold Count",
    "Disconnect Indicator",
  ],
  [IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL]: [
    "Interaction ID",
    "Date",
    "Agent",
    "Login",
    "Skill",
    "Direction",
    "Disposition",
    "Offered At",
    "Queued At",
    "Connected At",
    "Disconnected At",
    "Queue Seconds",
    "Talk Seconds",
    "Hold Seconds",
    "ACW Seconds",
    "Handle Seconds",
    "Holds",
    "Disconnect Reason",
  ],
  [IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL]: [
    "Interaction ID",
    "Date",
    "Agent Name",
    "Agent ID",
    "Skill",
    "Call Direction",
    "Call Status",
    "Arrival DateTime",
    "Queue DateTime",
    "Answer DateTime",
    "End DateTime",
    "Queue Time (sec)",
    "Talk Time (sec)",
    "Hold Time (sec)",
    "Wrap-up Time (sec)",
    "Handle Time (sec)",
    "Hold Count",
    "Disconnect Indicator",
  ],
};

const SOURCE_ROWS = {
  [IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL]: {
    "Call ID": "FC-1001",
    Date: "2026-07-26",
    "Agent Name": "Fuse Com Agent",
    "Agent Login": "fc.agent",
    "Personal ID": "P-100",
    "Skill Name": "GSS 2.0 :: Germany - English NIV",
    Direction: "Inbound",
    Status: "Handled",
    "Arrival Time": "2026-07-26 08:00:00",
    "Queue Time": "2026-07-26 08:00:03",
    "Answer Time": "2026-07-26 08:00:08",
    "End Time": "2026-07-26 08:06:00",
    "Queue Time (sec)": 5 / 86400,
    "Talk Time": "00:05:10",
    "Hold Time": "00:00:10",
    "After Call Time": "00:00:32",
    "Handle Time": "00:05:52",
    "Hold Count": 1,
    "Disconnect Indicator": "Agent",
    "Optional Source Column": "preserve me",
  },
  [IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL]: {
    "Interaction ID": "FN-2001",
    Date: "2026-07-26",
    Agent: "Fuse Net Agent",
    Login: "fn.agent",
    Skill: "GSS 2.0 TO10 - SEASIA",
    Direction: "Inbound",
    Disposition: "Answered",
    "Offered At": "2026-07-26 09:00:00",
    "Queued At": "2026-07-26 09:00:02",
    "Connected At": "2026-07-26 09:00:07",
    "Disconnected At": "2026-07-26 09:03:00",
    "Queue Seconds": "00:05",
    "Talk Seconds": "02:30",
    "Hold Seconds": "00:00",
    "ACW Seconds": "00:23",
    "Handle Seconds": "02:53",
    Holds: 0,
    "Disconnect Reason": "Customer",
    "FuseNet Only": "preserve me too",
  },
  [IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL]: {
    "Interaction ID": "HD-3001",
    Date: "2026-07-26",
    "Agent Name": "Hero Dash Agent",
    "Agent ID": "HD-A-1",
    Skill: "Australia-CALL English NIV",
    "Call Direction": "Inbound",
    "Call Status": "Handled",
    "Arrival DateTime": "2026-07-26 10:00:00",
    "Queue DateTime": "2026-07-26 10:00:04",
    "Answer DateTime": "2026-07-26 10:00:09",
    "End DateTime": "2026-07-26 10:07:00",
    "Queue Time (sec)": 5 / 86400,
    "Talk Time (sec)": 360 / 86400,
    "Hold Time (sec)": 0,
    "Wrap-up Time (sec)": 51 / 86400,
    "Handle Time (sec)": 411 / 86400,
    "Hold Count": 0,
    "Disconnect Indicator": "Normal",
    "HeroDash Only": "preserved",
  },
};

function createWorkbook(profileCode, rows = [SOURCE_ROWS[profileCode]], extraHeaders = []) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Agent Level");
  const headers = [
    ...SOURCE_HEADERS[profileCode],
    ...extraHeaders,
  ];

  worksheet.addRow(headers);

  for (const row of rows) {
    worksheet.addRow(headers.map((header) => row[header]));
  }

  return workbook;
}

function prepare(rowJson, profileCode) {
  const mapped = mapAgentInteractionRow(rowJson, {
    profileCode,
    sheetName: "Agent Level",
  });
  const validation = validateCanonicalAgentInteractionRow(mapped.mappedRow);
  const rowHash = createAgentInteractionIdentityHash(mapped.mappedRow);
  const contentHash = createAgentInteractionContentHash(mapped.mappedRow);

  return {
    excelRowNumber: 2,
    mappedRow: mapped.mappedRow,
    rowJson: mapped.rowJson,
    conversionErrors: mapped.conversionErrors,
    validationErrors: validation.errors,
    rowHash,
    contentHash,
    isValid:
      mapped.conversionErrors.length === 0 &&
      validation.errors.length === 0,
  };
}

test("Agent Level profiles detect the correct worksheet and reject wrong profiles", () => {
  for (const profileCode of Object.keys(SOURCE_HEADERS)) {
    const workbook = createWorkbook(profileCode);
    const validation = validateWorkbookProfile(workbook, profileCode);

    assert.equal(validation.isValid, true);
    assert.equal(validation.sourceSystem, profileCode.split("_")[0]);
    assert.equal(validation.sheets[0].sheetName, "Agent Level");
    assert.deepEqual(validation.sheets[0].headers, SOURCE_HEADERS[profileCode]);

    const wrongProfile = validateWorkbookProfile(
      workbook,
      IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND,
    );

    assert.equal(wrongProfile.isValid, false);
  }
});

test("Agent Level workbook validation warns about unknown optional columns", () => {
  const workbook = createWorkbook(
    IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL,
    [
      {
        ...SOURCE_ROWS[IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL],
        "Optional Unmapped Column": "preserved in row_json by the mapper",
      },
    ],
    ["Optional Unmapped Column"],
  );
  const validation = validateWorkbookProfile(
    workbook,
    IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL,
  );

  assert.equal(validation.isValid, true);
  assert.equal(validation.warnings.length, 1);
  assert.equal(validation.warnings[0].errorCode, "UNKNOWN_COLUMN");
  assert.equal(validation.warnings[0].columnName, "Optional Unmapped Column");
});

test("maps representative Agent Level rows into the canonical model", () => {
  const expectations = {
    [IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL]: {
      sourceSystem: "FUSECOM",
      sourceInteractionId: null,
      callId: "FC-1001",
      sourceAgentKey: "fc.agent",
      agentLogin: "fc.agent",
      personalId: "P-100",
      skillNameRaw: "GSS 2.0 :: Germany - English NIV",
    },
    [IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL]: {
      sourceSystem: "FUSENET",
      sourceInteractionId: "FN-2001",
      callId: null,
      sourceAgentKey: "fn.agent",
      agentLogin: "fn.agent",
      personalId: null,
      skillNameRaw: "GSS 2.0 TO10 - SEASIA",
    },
    [IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL]: {
      sourceSystem: "HERODASH",
      sourceInteractionId: "HD-3001",
      callId: null,
      sourceAgentKey: "HD-A-1",
      agentLogin: null,
      personalId: "HD-A-1",
      skillNameRaw: "Australia-CALL English NIV",
    },
  };

  for (const [profileCode, row] of Object.entries(SOURCE_ROWS)) {
    const mapped = mapAgentInteractionRow(row, {
      profileCode,
      sheetName: "Agent Level",
    });

    assert.deepEqual(mapped.conversionErrors, []);
    assert.equal(mapped.mappedRow.source_system, expectations[profileCode].sourceSystem);
    assert.equal(mapped.mappedRow.source_interaction_id, expectations[profileCode].sourceInteractionId);
    assert.equal(mapped.mappedRow.call_id, expectations[profileCode].callId);
    assert.equal(mapped.mappedRow.source_agent_key, expectations[profileCode].sourceAgentKey);
    assert.equal(mapped.mappedRow.agent_login, expectations[profileCode].agentLogin);
    assert.equal(mapped.mappedRow.personal_id, expectations[profileCode].personalId);
    assert.equal(mapped.mappedRow.skill_name_raw, expectations[profileCode].skillNameRaw);
    assert.equal(mapped.mappedRow.production_date, "2026-07-26");
    assert.equal(mapped.mappedRow.interaction_type, "CALL");
    assert.deepEqual(mapped.rowJson, row);
  }
});

test("classifies Agent Level duplicate, conflict, and new records by identity/content hashes", () => {
  const original = prepare(
    SOURCE_ROWS[IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL],
    IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL,
  );
  const duplicate = prepare(
    { ...SOURCE_ROWS[IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL] },
    IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL,
  );
  const conflict = prepare(
    {
      ...SOURCE_ROWS[IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL],
      "Talk Time": "00:06:00",
    },
    IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL,
  );
  const newRecord = prepare(
    {
      ...SOURCE_ROWS[IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL],
      "Call ID": "FC-1002",
    },
    IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL,
  );

  const existingByHash = new Map([
    [
      original.rowHash,
      {
        id: 11,
        rowHash: original.rowHash,
        contentHash: original.contentHash,
      },
    ],
  ]);
  const classified = classifyPreparedChunkRows({
    rows: [duplicate, conflict, newRecord],
    existingByHash,
    seenRows: new Map(),
  });

  assert.equal(classified[0].classification, IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW);
  assert.equal(classified[1].classification, IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT);
  assert.equal(classified[2].classification, IMPORT_ROW_CLASSIFICATIONS.NEW);
});

test("invalid Agent Level rows are quarantined while valid rows continue", () => {
  const valid = prepare(
    SOURCE_ROWS[IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL],
    IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL,
  );
  const invalid = prepare(
    {
      ...SOURCE_ROWS[IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL],
      "Interaction ID": "",
      "Agent ID": "",
      "Agent Name": "",
      "Arrival DateTime": "",
    },
    IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL,
  );
  const classified = classifyPreparedChunkRows({
    rows: [invalid, valid],
    existingByHash: new Map(),
    seenRows: new Map(),
  });

  assert.equal(invalid.isValid, false);
  assert.equal(
    invalid.validationErrors.some(
      (error) => error.errorCode === "MISSING_INTERACTION_IDENTITY",
    ),
    true,
  );
  assert.equal(classified[0].classification, IMPORT_ROW_CLASSIFICATIONS.INVALID);
  assert.equal(classified[1].classification, IMPORT_ROW_CLASSIFICATIONS.NEW);
});
