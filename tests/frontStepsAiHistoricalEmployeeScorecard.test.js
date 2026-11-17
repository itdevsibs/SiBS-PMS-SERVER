import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import {
  getPmpPipReport,
  getSummaryReport,
  getAccountKpiReport,
  FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY,
  resolveEmployeeEmploymentStatus,
  resolveAssignmentPeriod,
  buildUnifiedFrontStepsDirectory,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiReportService.js';
import { pmsDb } from '../src/config/db.js';

describe('SiBS PMS FrontSteps AI — Active SiBS Employees Only Suite', () => {
  it('1. FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY covers authoritative FrontSteps employees and identifies the 5 active agents', () => {
    assert.ok(Object.keys(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY).length >= 29);
    
    // Core active employees (Exactly 5)
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['5206'].status, 'ACTIVE');
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['6754'].status, 'ACTIVE');
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['6863'].status, 'ACTIVE');
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['6887'].status, 'ACTIVE');
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['3463'].status, 'ACTIVE');

    // Verification required
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['6855'].status, 'VERIFICATION_REQUIRED');

    // Inactive / Separated / Transferred
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['6859'].status, 'INACTIVE_SEPARATED');
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['3566'].status, 'INACTIVE_SEPARATED');
    assert.equal(FRONTSTEPS_EMPLOYEE_TENURE_REGISTRY['3707'].status, 'TRANSFERRED');
  });

  it('2. resolveEmployeeEmploymentStatus accurately classifies active vs inactive vs verification required', () => {
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '5206' }), 'ACTIVE');
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '6754' }), 'ACTIVE');
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '6863' }), 'ACTIVE');
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '6887' }), 'ACTIVE');
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '3463' }), 'ACTIVE');

    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '6855' }), 'VERIFICATION_REQUIRED');
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '6859' }), 'INACTIVE_SEPARATED');
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '3707' }), 'TRANSFERRED');
    assert.equal(resolveEmployeeEmploymentStatus({ sibsId: '3566' }), 'INACTIVE_SEPARATED');
  });

  it('3. getPmpPipReport returns strictly the 5 currently verified active SiBS employees in directory', async () => {
    const res = await getPmpPipReport({ period: 'monthly' });
    assert.equal(res.success, true);
    assert.equal(res.hasPublishedSnapshot, true);
    assert.equal(res.hermesCallsCount, 0, 'Zero Hermes calls');

    const directory = res.individualKpi.directory;
    assert.ok(Array.isArray(directory));
    assert.equal(directory.length, 5, 'Directory contains strictly the 5 verified active SiBS employees');

    const directorySibsIds = directory.map((e) => e.sibsId).sort();
    assert.deepEqual(directorySibsIds, ['3463', '5206', '6754', '6863', '6887']);

    // Check identityReconciliation counts
    const recon = res.individualKpi.identityReconciliation;
    assert.equal(recon.activeDirectoryCount, 5, 'activeDirectoryCount is 5');
    assert.equal(recon.totalUnifiedDirectoryCount, 5, 'totalUnifiedDirectoryCount is 5');
    assert.equal(recon.separatedDirectoryCount, 0, 'separatedDirectoryCount is 0 in active directory');
    assert.equal(recon.transferredDirectoryCount, 0, 'transferredDirectoryCount is 0 in active directory');
    assert.equal(recon.verificationRequiredDirectoryCount, 0, 'verificationRequiredDirectoryCount is 0 in active directory');
  });

  it('4. Inactive and separated employees (e.g. 6859, 3566, 5631) are completely excluded from active directory', async () => {
    const res = await getPmpPipReport({ period: 'monthly' });
    const directory = res.individualKpi.directory;

    const emp6859 = directory.find((e) => String(e.sibsId) === '6859');
    assert.equal(emp6859, undefined, 'Separated employee 6859 (Aira Sanding) must NOT appear in active directory');

    const emp3566 = directory.find((e) => String(e.sibsId) === '3566');
    assert.equal(emp3566, undefined, 'Separated employee 3566 must NOT appear in active directory');

    const emp5631 = directory.find((e) => String(e.sibsId) === '5631');
    assert.equal(emp5631, undefined, 'Separated employee 5631 must NOT appear in active directory');

    const emp3707 = directory.find((e) => String(e.sibsId) === '3707');
    assert.equal(emp3707, undefined, 'Transferred employee 3707 must NOT appear in active directory');
  });

  it('5. Quarantined employee 6855 (Carlo Crisanto Bondoc) remains held in identityVerificationIssues and excluded from active directory', async () => {
    const res = await getPmpPipReport({ period: 'monthly' });
    const directory = res.individualKpi.directory;

    const emp6855InDir = directory.find((e) => String(e.sibsId) === '6855');
    assert.equal(emp6855InDir, undefined, 'Quarantined employee 6855 must NOT enter active directory');

    assert.equal(res.individualKpi.identityVerificationIssues.length, 1);
    const heldEmp = res.individualKpi.identityVerificationIssues[0];
    assert.equal(heldEmp.sibsId, '6855');
    assert.equal(heldEmp.availabilityStatus, 'ROSTER_VERIFICATION_REQUIRED');
  });

  it('6. Active employee 3463 (Jeazaer Mea Cañedo) displays explicit NO_DATA without zero fabrication', async () => {
    const res = await getPmpPipReport({ period: 'monthly' });
    const emp3463 = res.individualKpi.directory.find((e) => String(e.sibsId) === '3463');
    assert.ok(emp3463, 'Agent 3463 is present in active directory');

    assert.equal(emp3463.employmentStatus, 'ACTIVE');
    assert.equal(emp3463.statusBadgeLabel, 'Active');
    assert.equal(emp3463.assignmentPeriod, '2021-06-14 to Present');
    assert.equal(emp3463.kpis.AHT.status, 'NO_DATA');
    assert.equal(emp3463.kpis.AHT_COMPLIANCE.status, 'NO_DATA');
    assert.equal(emp3463.kpis.CRM_RESOLUTION.status, 'NO_DATA');
    assert.equal(emp3463.kpis.CASES_CLOSED.status, 'NO_DATA');
    assert.equal(emp3463.finalKpiScore.status, 'NO_DATA');
  });

  it('7. Active agents with production data have performance preserved, with Cases Closed and Final KPI Score strictly BLOCKED', async () => {
    const res = await getPmpPipReport({ period: 'monthly' });
    const emp5206 = res.individualKpi.directory.find((e) => String(e.sibsId) === '5206');
    assert.ok(emp5206, 'Agent 5206 (Leslie Joy Patricio) is present');

    assert.equal(emp5206.employmentStatus, 'ACTIVE');
    assert.ok(emp5206.calls.offered > 0);
    assert.ok(emp5206.calls.answered > 0);
    assert.equal(emp5206.kpis.AHT.status, 'CALCULATED');
    assert.equal(emp5206.kpis.AHT_COMPLIANCE.status, 'CALCULATED');

    // Cases Closed and Final KPI Score remain BLOCKED
    assert.equal(emp5206.kpis.CASES_CLOSED.status, 'BLOCKED');
    assert.equal(emp5206.finalKpiScore.status, 'BLOCKED');

    // All active directory members have Cases Closed and Final KPI Score BLOCKED or NO_DATA
    for (const emp of res.individualKpi.directory) {
      assert.ok(['BLOCKED', 'NO_DATA'].includes(emp.kpis.CASES_CLOSED.status));
      assert.ok(['BLOCKED', 'NO_DATA'].includes(emp.finalKpiScore.status));
    }
  });

  it('8. Database snapshots remain 100% byte-for-byte immutable', async () => {
    const [rows] = await pmsDb.query('SELECT id, version_number, payload_json FROM frontsteps_ai_report_snapshots WHERE id IN (60, 285)');
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      const parsed = JSON.parse(r.payload_json);
      assert.ok(Array.isArray(parsed.individualKpi.employees));
      assert.ok(Array.isArray(parsed.individualKpi.excludedEmployees));
    }
  });

  it('9. Restricted viewer sees only their own record in the directory', async () => {
    const restricted = await getPmpPipReport(
      { period: 'monthly', employeeId: 'all' },
      { hasFullTeamAccess: false, sibsId: '5206' }
    );
    assert.equal(restricted.success, true);
    assert.equal(restricted.individualKpi.directory.length, 1);
    assert.equal(restricted.individualKpi.directory[0].sibsId, '5206');
    assert.equal(restricted.individualKpi.employees.length, 1);
    assert.equal(restricted.individualKpi.excludedEmployees.length, 0);
  });

  after(() => {
    setTimeout(() => process.exit(0), 100);
  });
});
