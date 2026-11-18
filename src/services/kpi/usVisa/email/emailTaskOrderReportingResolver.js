// Use the selected published ledger snapshot for country ownership at report
// time. 'current' mirrors Calls reporting; an explicit ID pins an older version.
import { readVersionSnapshot } from '../../../taskOrderManagement/taskOrderVersionService.js';
import { createEmailVersionSchedule } from './emailTaskOrderAssignment.js';
export { resolveEmailReportRows } from './emailTaskOrderAssignment.js';

export async function loadEmailReportingSchedule(requested = 'current') {
  const snapshot = await readVersionSnapshot(requested || 'current');
  return createEmailVersionSchedule([snapshot], { pinnedVersionId: snapshot.version.id });
}
