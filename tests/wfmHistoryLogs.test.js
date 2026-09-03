import assert from "node:assert/strict";
import test, { after } from "node:test";

import { pmsDb, pmsTables } from "../src/config/db.js";
import {
  countWfmHistoryLogs,
  createWfmHistoryLog,
  listWfmHistoryLogs,
} from "../src/repositories/historyLogRepository.js";

after(async () => {
  await pmsDb.end();
});

test("creates and retrieves WFM history log with user information", async () => {
  const testFileName = `test-file-${Date.now()}.xlsx`;
  const testUserName = "WFM HISTORY TEST USER";
  const testUserId = "TEST-EMPLOYEE-ID";

  const createdLog = await createWfmHistoryLog({
    action: "imported",
    account: "US VISA",
    rawDataTitle: "Herodash",
    fileName: testFileName,
    message: `Imported ${testFileName} to US VISA - Herodash.`,
    userId: testUserId,
    userName: testUserName,
    userEmail: "wfm-history-test@example.com",
    createdAt: new Date(),
  });

  assert.ok(createdLog);
  assert.ok(createdLog.id);
  assert.equal(createdLog.action, "imported");
  assert.equal(createdLog.account, "US VISA");
  assert.equal(createdLog.rawDataTitle, "Herodash");
  assert.equal(createdLog.fileName, testFileName);
  assert.equal(createdLog.userId, testUserId);
  assert.equal(createdLog.userName, testUserName);
  assert.ok(createdLog.formattedTime);

  const logs = await listWfmHistoryLogs({
    account: "US VISA",
    search: testFileName,
    limit: 10,
  });

  const found = logs.find((log) => log.id === createdLog.id);
  assert.ok(found);
  assert.equal(found.userName, testUserName);

  const total = await countWfmHistoryLogs({
    account: "US VISA",
    search: testFileName,
  });
  assert.equal(total, 1);

  await pmsDb.query(`DELETE FROM ${pmsTables.wfmHistoryLogs} WHERE id = ?`, [
    createdLog.id,
  ]);
});
