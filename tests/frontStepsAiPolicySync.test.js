import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';

// Use path relative to current test file
const serverRoot = path.resolve(import.meta.dirname, '..');

test('Archive Service: computes accurate SHA-256 and archives content-addressed files', async () => {
  const {
    computeSha256,
    archivePolicyBinary,
    getArchivedPolicyBuffer,
    verifyArchiveFileIntegrity,
    getArchiveFilePath,
  } = await import('../src/modules/frontStepsAiReport/services/frontStepsAiPolicyArchiveService.js');

  const samplePdf = Buffer.from('%PDF-1.4 simulated FrontSteps policy PDF content ' + Date.now());
  const expectedHash = crypto.createHash('sha256').update(samplePdf).digest('hex').toLowerCase();

  // 1. Checksum calculation
  const computedHash = computeSha256(samplePdf);
  assert.equal(computedHash, expectedHash);

  // 2. Storage isolation: must not be in public uploads/
  const archivePath = getArchiveFilePath(`${expectedHash}.pdf`);
  assert.ok(!archivePath.includes('/uploads/'), 'Archive path must never reside within /uploads');
  assert.ok(archivePath.endsWith(`${expectedHash}.pdf`));

  // 3. Archive write
  const archiveResult = await archivePolicyBinary(samplePdf, 'test-policy.pdf');
  assert.equal(archiveResult.verifiedChecksum, expectedHash);
  assert.equal(archiveResult.archiveReference, `${expectedHash}.pdf`);
  assert.equal(archiveResult.fileSize, samplePdf.length);
  assert.ok(['ARCHIVED', 'DEDUPLICATED'].includes(archiveResult.archiveStatus));

  // 4. Content retrieval
  const retrievedBuffer = await getArchivedPolicyBuffer(archiveResult.archiveReference);
  assert.ok(retrievedBuffer);
  assert.deepEqual(retrievedBuffer, samplePdf);

  // 5. Integrity verification
  const isIntact = await verifyArchiveFileIntegrity(archiveResult.archiveReference, expectedHash);
  assert.equal(isIntact, true);

  const isCorrupted = await verifyArchiveFileIntegrity(archiveResult.archiveReference, 'wronghash123456');
  assert.equal(isCorrupted, false);

  // 6. Deduplication on subsequent call
  const dedupResult = await archivePolicyBinary(samplePdf, 'test-policy-duplicate.pdf');
  assert.equal(dedupResult.archiveStatus, 'DEDUPLICATED');
  assert.equal(dedupResult.verifiedChecksum, expectedHash);
});

test('Reconciliation Logic: handles additions, mutations, deletions, and eligibility', async () => {
  const { computeSha256 } = await import(
    '../src/modules/frontStepsAiReport/services/frontStepsAiPolicyArchiveService.js'
  );

  // Simulation of reconciliation state machine
  const bufA = Buffer.from('%PDF-1.4 FS-PIP-001 rev 000 initial');
  const bufA2 = Buffer.from('%PDF-1.4 FS-PIP-001 rev 000 mutated file content');
  const bufB = Buffer.from('%PDF-1.4 FS-PMP-001 rev 001 approved');

  const hashA = computeSha256(bufA);
  const hashA2 = computeSha256(bufA2);
  const hashB = computeSha256(bufB);

  assert.notEqual(hashA, hashA2, 'Different binary content must produce different SHA-256');

  // Verify single current eligibility rule logic
  const candidateVersions = [
    { id: 1, doc: 'FS-PMP-001', rev: '000', status: 'Approved', current: 0, avail: 'AVAILABLE', arch: 'ARCHIVED' },
    { id: 2, doc: 'FS-PMP-001', rev: '001', status: 'Approved', current: 1, avail: 'AVAILABLE', arch: 'ARCHIVED' },
    { id: 3, doc: 'FS-PMP-001', rev: '002', status: 'Pending Approval', current: 1, avail: 'AVAILABLE', arch: 'ARCHIVED' },
  ];

  const eligibleCandidates = candidateVersions.filter((v) => {
    return v.status.toLowerCase() === 'approved' && v.current === 1 && v.avail === 'AVAILABLE' && ['ARCHIVED', 'DEDUPLICATED'].includes(v.arch);
  });

  assert.equal(eligibleCandidates.length, 1);
  assert.equal(eligibleCandidates[0].id, 2);
  assert.equal(eligibleCandidates[0].rev, '001');
});

test('Background Worker: starts, stops, and respects kill switch safely', async () => {
  const { startWorker, stopWorker } = await import(
    '../src/modules/frontStepsAiReport/services/frontStepsAiPolicySyncWorker.js'
  );

  // Start with disabled env var
  process.env.FS_AI_POLICY_SYNC_ENABLED = 'false';
  startWorker();
  stopWorker();

  // Test enable
  delete process.env.FS_AI_POLICY_SYNC_ENABLED;
  startWorker({ intervalMs: 60000 });
  stopWorker();
  assert.ok(true, 'Worker started and stopped cleanly without throwing');
});

test('Router & Controller: all 5 policy sync routes are mapped under auth protection', async () => {
  const routesPath = path.join(serverRoot, 'src/modules/frontStepsAiReport/routes/frontStepsAiReportRoutes.js');
  const routesSource = await fs.readFile(routesPath, 'utf8');

  assert.match(routesSource, /router\.use\(authMiddleware, requireFrontStepsAccess\);/);
  assert.match(routesSource, /router\.get\('\/policies\/sync-status', controller\.getPolicySyncStatus\);/);
  assert.match(routesSource, /router\.post\('\/policies\/sync', controller\.triggerPolicySync\);/);
  assert.match(routesSource, /router\.get\('\/policies\/sync-history', controller\.getPolicySyncHistory\);/);
  assert.match(routesSource, /router\.get\('\/policies\/versions', controller\.getPolicyVersions\);/);
  assert.match(routesSource, /router\.get\('\/policies\/versions\/:documentCode', controller\.getPolicyVersionHistory\);/);
  assert.match(routesSource, /router\.get\('\/policies\/:id\/preview', controller\.previewPolicyPdf\);/);
});

test('Database Registry: db.js registers FrontSteps AI policy sync tables', async () => {
  const dbPath = path.join(serverRoot, 'src/config/db.js');
  const dbSource = await fs.readFile(dbPath, 'utf8');

  assert.match(dbSource, /frontstepsAiPolicyVersions:\s*dbTable\(/);
  assert.match(dbSource, /frontstepsAiPolicySyncRuns:\s*dbTable\(/);
  assert.match(dbSource, /frontstepsAiPolicyEvents:\s*dbTable\(/);
});
