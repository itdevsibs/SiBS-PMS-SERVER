import assert from "node:assert/strict";
import test from "node:test";

import {
  countWfmHistoryLogs,
  createWfmHistoryLog,
  listWfmHistoryLogs,
} from "../src/repositories/wfmHistoryLogRepository.js";

test("creates and retrieves WFM history log with user information", async () => {
  const testFileName = `test-file-${Date.now()}.xlsx`;
  const testUserName = "DWIGHT ANTHONY CAGANDE";
  const testEmail = "dwightanthony.bumaat@thesibling.com";

  const createdLog = await createWfmHistoryLog({
    action: "removed",
    account: "US VISA",
    rawDataTitle: "Herodash",
    fileName: testFileName,
    message: `Removed ${testFileName} from Herodash`,
    userName: testUserName,
    userEmail: testEmail,
    logDate: "2026-08-19",
  });

  assert.ok(createdLog);
  assert.ok(createdLog.id);
  assert.equal(createdLog.action, "removed");
  assert.equal(createdLog.account, "US VISA");
  assert.equal(createdLog.rawDataTitle, "Herodash");
  assert.equal(createdLog.fileName, testFileName);
  assert.equal(createdLog.userName, testUserName);
  assert.equal(createdLog.userEmail, testEmail);

  const logs = await listWfmHistoryLogs({
    date: "2026-08-19",
    account: "US VISA",
    limit: 10,
  });

  assert.ok(Array.isArray(logs));
  const found = logs.find((l) => l.fileName === testFileName);
  assert.ok(found);
  assert.equal(found.userName, testUserName);

  const total = await countWfmHistoryLogs({
    date: "2026-08-19",
    account: "US VISA",
  });
  assert.ok(total >= 1);
});
