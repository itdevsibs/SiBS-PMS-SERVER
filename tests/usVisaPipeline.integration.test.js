import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { calculateFileSha256 } from "../src/services/imports/shared/fileHashService.js";
import { mapFusecomSkillStatisticsRow } from "../src/services/imports/usVisa/mappers/fusecomMapper.js";
import { mapHeroDashSkillStatisticsRow } from "../src/services/imports/usVisa/mappers/heroDashMapper.js";
import {
  createContentHash,
  createRowHash,
} from "../src/services/imports/shared/rowHashService.js";
import {
  ROW_VALIDATION_ERROR_CODES,
  validateCanonicalSkillStatisticsRow,
} from "../src/services/imports/shared/rowValidator.js";
import {
  openWorkbook,
  readHeaderRow,
  readWorksheetRows,
} from "../src/services/imports/shared/workbookReaderService.js";
import {
  IMPORT_PROFILE_CODES,
  WORKBOOK_VALIDATION_ERROR_CODES,
  validateWorkbookProfile,
} from "../src/services/imports/usVisa/workbookValidator.js";

const heroHeaders = [
  "Date",
  "Country/Region",
  "Skill",
  "Total calls offered",
  "Total calls in IVR",
  "Total handled calls",
  "Handled calls <= SLT",
  "Handled calls > SLT",
  "SL in %",
  "Total IVR time",
  "AVG IVR time",
  "ASA",
  "Queue time (sec)",
  "Total abandoned calls",
  "Abandoned calls <= SLT",
  "Abandoned calls > SLT",
  "% Abandoned rate",
  "AVG handle time",
  "Abandoned calls AVG time",
  "Total talk time",
  "AVG talk time",
  "Calls on hold",
  "Total call time",
  "AVG hold time",
  "Total warp-up time",
  "AVG warp-up time",
  "Total hold time",
  "% Reachability",
];

const heroValidRow = [
  "2026-08-18",
  "US",
  "US Visa English",
  100,
  95,
  80,
  70,
  10,
  "87.5%",
  "01:00:00",
  "00:00:30",
  "00:00:12",
  "769",
  15,
  4,
  11,
  "15%",
  "00:05:00",
  "00:01:10",
  "06:00:00",
  "00:04:30",
  20,
  "08:00:00",
  "00:00:20",
  "00:30:00",
  "00:00:15",
  "00:40:00",
  "93.5%",
];

const fusecomHeaders = [
  "Date",
  "Skill Group Name",
  "Skill Name",
  "Total Calls IVR",
  "Total Calls Offered",
  "Failed Calls",
  "Net Calls Offered",
  "Total Handled Calls",
  "Handled Calls <= SLT",
  "Handled Calls > SLT",
  "Short Calls",
  "Queue Time (sec)",
  "Abandoned Calls AVG Time",
  "Total Abandoned Calls",
  "Net Abandoned Calls",
  "Short Abandoned Calls",
  "% Abandoned Rate",
  "% Service Level non-DIBP",
  "% Service Level DIBP",
  "AVG Handle Time",
  "Total Call Time",
  "Total Talk Time",
  "Total Hold Time",
  "Total After Call Time",
  "AVG Talk Time",
  "AVG Hold Time",
  "AVG After Call Time",
  "Abandoned Calls <= SLT in Time",
  "Abandoned Calls > SLT in Time",
  "% Reachability",
  "Calls on Hold",
];

const fusecomValidRow = [
  "2026-08-18",
  "US Visa",
  "US Visa English",
  95,
  100,
  1,
  99,
  80,
  70,
  10,
  2,
  769,
  "00:01:10",
  15,
  14,
  1,
  "15%",
  "87.5%",
  "90%",
  "00:05:00",
  "08:00:00",
  "06:00:00",
  "00:40:00",
  "00:30:00",
  "00:04:30",
  "00:00:20",
  "00:00:15",
  4,
  11,
  "93.5%",
  20,
];

async function createWorkbookFile(buildWorkbook) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "us-visa-pipeline-"));
  const filePath = path.join(dir, "sample.xlsx");
  const workbook = new ExcelJS.Workbook();

  buildWorkbook(workbook);

  await workbook.xlsx.writeFile(filePath);

  return {
    dir,
    filePath,
  };
}

function addSheet(workbook, name, headers, rows) {
  const worksheet = workbook.addWorksheet(name);

  worksheet.addRow(headers);
  rows.forEach((row) => worksheet.addRow(row));
}

async function readFirstSheetRow(filePath, profileCode) {
  const workbook = await openWorkbook(filePath);
  const validation = validateWorkbookProfile(workbook, profileCode);
  const sheet = validation.sheets[0];
  const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
  const [sourceRow] = readWorksheetRows(workbook, sheet.sheetName, {
    headerRowNumber: sheet.headerRowNumber,
    headers,
  });

  return {
    validation,
    sourceRow,
  };
}

test("valid HeroDash upload maps, validates, hashes, and preserves row_json", async () => {
  const { dir, filePath } = await createWorkbookFile((workbook) => {
    addSheet(workbook, "Hero Current", heroHeaders, [heroValidRow]);
  });

  try {
    const { validation, sourceRow } = await readFirstSheetRow(
      filePath,
      IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND,
    );
    const mapped = mapHeroDashSkillStatisticsRow(sourceRow.rowJson);
    const rowValidation = validateCanonicalSkillStatisticsRow(mapped.mappedRow);
    const rowHash = createRowHash(mapped.mappedRow);
    const contentHash = createContentHash(mapped.mappedRow);

    assert.equal(validation.isValid, true);
    assert.equal(rowValidation.isValid, true);
    assert.equal(mapped.rowJson.Skill, "US Visa English");
    assert.equal(mapped.rowJson["Total calls offered"], 100);
    assert.match(rowHash, /^[a-f0-9]{64}$/);
    assert.match(contentHash, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("valid Fusecom upload maps and validates all supported sheets", async () => {
  const intradayHeaders = [
    "Date-Time",
    ...fusecomHeaders.filter((header) => header !== "Date"),
  ];
  const intradayRow = [
    "2026-08-18T09:30:00Z",
    ...fusecomValidRow.slice(1),
  ];
  const { dir, filePath } = await createWorkbookFile((workbook) => {
    addSheet(workbook, "Per Day", fusecomHeaders, [fusecomValidRow]);
    addSheet(workbook, "Summary", fusecomHeaders, [fusecomValidRow]);
    addSheet(workbook, "Half Hourly Statistics", intradayHeaders, [intradayRow]);
    addSheet(workbook, "15 Minutes Statistics", intradayHeaders, [intradayRow]);
  });

  try {
    const workbook = await openWorkbook(filePath);
    const validation = validateWorkbookProfile(
      workbook,
      IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND,
    );

    assert.equal(validation.isValid, true);

    for (const sheet of validation.sheets) {
      const headers = readHeaderRow(workbook, sheet.sheetName, 1);
      const [sourceRow] = readWorksheetRows(workbook, sheet.sheetName, {
        headerRowNumber: 1,
        headers,
      });
      const mapped = mapFusecomSkillStatisticsRow(sourceRow.rowJson, {
        sheetName: sheet.sheetName,
        dataGrain: sheet.dataGrain,
      });

      assert.equal(validateCanonicalSkillStatisticsRow(mapped.mappedRow).isValid, true);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("corrupted XLSX returns controlled workbook error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "us-visa-corrupt-"));
  const filePath = path.join(dir, "corrupt.xlsx");

  try {
    await fs.writeFile(filePath, "not really xlsx");

    await assert.rejects(
      () => openWorkbook(filePath),
      (error) => error.code === "CORRUPTED_WORKBOOK",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("duplicate exact workbook produces the same whole-file hash", async () => {
  const first = await createWorkbookFile((workbook) => {
    addSheet(workbook, "Hero Current", heroHeaders, [heroValidRow]);
  });
  const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), "us-visa-pipeline-copy-"));
  const secondPath = path.join(secondDir, "renamed.xlsx");

  try {
    await fs.copyFile(first.filePath, secondPath);

    assert.equal(
      await calculateFileSha256(first.filePath),
      await calculateFileSha256(secondPath),
    );
  } finally {
    await fs.rm(first.dir, { recursive: true, force: true });
    await fs.rm(secondDir, { recursive: true, force: true });
  }
});

test("workbook validation reports missing worksheet, missing header, and unknown header", async () => {
  const missingSheet = new ExcelJS.Workbook();
  addSheet(missingSheet, "Per Day", fusecomHeaders, [fusecomValidRow]);

  const missingSheetResult = validateWorkbookProfile(
    missingSheet,
    IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND,
  );
  assert.ok(
    missingSheetResult.errors.some(
      (error) => error.errorCode === WORKBOOK_VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
    ),
  );

  const missingHeader = new ExcelJS.Workbook();
  addSheet(
    missingHeader,
    "Hero Current",
    heroHeaders.filter((header) => header !== "Skill"),
    [heroValidRow.slice(0, -1)],
  );
  const missingHeaderResult = validateWorkbookProfile(
    missingHeader,
    IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND,
  );
  assert.ok(
    missingHeaderResult.errors.some(
      (error) => error.errorCode === WORKBOOK_VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN,
    ),
  );

  const unknownHeader = new ExcelJS.Workbook();
  addSheet(unknownHeader, "Hero Current", [...heroHeaders, "Source Only"], [[...heroValidRow, "kept"]]);
  const unknownHeaderResult = validateWorkbookProfile(
    unknownHeader,
    IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND,
  );
  assert.equal(unknownHeaderResult.isValid, true);
  assert.ok(
    unknownHeaderResult.warnings.some(
      (warning) => warning.errorCode === WORKBOOK_VALIDATION_ERROR_CODES.UNKNOWN_COLUMN,
    ),
  );
});

test("row validation covers invalid date, integer, number, negative, and missing required value", () => {
  const mapped = mapHeroDashSkillStatisticsRow({
    Date: "bad date",
    Skill: "",
    "Total calls offered": "not integer",
    "Queue time (sec)": "not duration",
    "Calls on hold": -1,
  });
  const validation = validateCanonicalSkillStatisticsRow({
    ...mapped.mappedRow,
    calls_offered: 1.5,
    queue_seconds: "bad number",
    calls_on_hold: -1,
  });

  assert.ok(mapped.conversionErrors.some((error) => error.errorCode === "INVALID_DATE"));
  assert.ok(mapped.conversionErrors.some((error) => error.errorCode === "INVALID_DURATION"));
  assert.ok(
    validation.errors.some(
      (error) => error.errorCode === ROW_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
    ),
  );
  assert.ok(
    validation.errors.some(
      (error) => error.errorCode === ROW_VALIDATION_ERROR_CODES.INVALID_INTEGER,
    ),
  );
  assert.ok(
    validation.errors.some(
      (error) => error.errorCode === ROW_VALIDATION_ERROR_CODES.INVALID_NUMBER,
    ),
  );
  assert.ok(
    validation.errors.some(
      (error) => error.errorCode === ROW_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
    ),
  );
});

test("logical duplicate, conflict, exact duplicate, retry, and stable hashes are deterministic", () => {
  const row = mapHeroDashSkillStatisticsRow({
    Date: "2026-08-18",
    "Country/Region": " United   States ",
    Skill: "US VISA English",
    "Total calls offered": 100,
  }).mappedRow;
  const sameIdentity = mapHeroDashSkillStatisticsRow({
    Date: "2026-08-18",
    "Country/Region": "united states",
    Skill: " us visa   english ",
    "Total calls offered": 100,
  }).mappedRow;
  const changedContent = {
    ...sameIdentity,
    calls_offered: 101,
  };

  const rowHash = createRowHash(row);
  const sameRowHash = createRowHash(sameIdentity);
  const contentHash = createContentHash(row);

  assert.equal(rowHash, sameRowHash);
  assert.equal(contentHash, createContentHash(sameIdentity));
  assert.notEqual(contentHash, createContentHash(changedContent));
  assert.equal(rowHash, createRowHash(row));
  assert.equal(contentHash, createContentHash(row));
});

test("15-minute and 30-minute rows at same timestamp do not collide", () => {
  const base = {
    source_system: "FUSECOM",
    production_date: "2026-08-18",
    interval_start: "2026-08-18 09:30:00",
    source_skill_name: "US Visa English",
  };

  assert.notEqual(
    createRowHash({
      ...base,
      data_grain: "SKILL_15_MINUTE",
    }),
    createRowHash({
      ...base,
      data_grain: "SKILL_30_MINUTE",
    }),
  );
});

test("partial success can classify valid and invalid rows without mutating source row_json", () => {
  const valid = mapHeroDashSkillStatisticsRow({
    Date: "2026-08-18",
    "Country/Region": "US",
    Skill: "US Visa English",
    "Total calls offered": 100,
  });
  const invalid = mapHeroDashSkillStatisticsRow({
    Date: "bad date",
    "Country/Region": "US",
    Skill: "",
    "Total calls offered": "bad",
  });
  const validResult = validateCanonicalSkillStatisticsRow(valid.mappedRow);
  const invalidResult = validateCanonicalSkillStatisticsRow(invalid.mappedRow);

  assert.equal(validResult.isValid, true);
  assert.equal(invalidResult.isValid, false);
  assert.deepEqual(invalid.rowJson, {
    Date: "bad date",
    "Country/Region": "US",
    Skill: "",
    "Total calls offered": "bad",
  });
});

test("database unique constraint and repository insert-only behavior guard canonical logical records", async () => {
  const migration = await fs.readFile(
    path.resolve("migrations/20260818_000001_create_us_visa_import_tables.sql"),
    "utf8",
  );
  const repository = await fs.readFile(
    path.resolve("src/repositories/usVisa/usVisaSkillStatisticsRepository.js"),
    "utf8",
  );

  assert.match(
    migration,
    /UNIQUE KEY uq_us_visa_raw_skill_statistics_row_hash \(row_hash\)/,
  );
  assert.equal(
    /ON DUPLICATE KEY UPDATE\s+(?!id\s*=\s*id)/i.test(repository),
    false,
  );
});
