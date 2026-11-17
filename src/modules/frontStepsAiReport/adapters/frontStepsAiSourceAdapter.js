/**
 * FrontSteps AI Report Source Adapter
 * 
 * Strict Isolation: Formats FrontSteps database records into clean AI DTOs.
 * Enforces explicit FrontSteps scoping. Never mixes US Visa records.
 * Avoids fabricated metrics; if calculation is not supported, returns explicit not-ready status.
 */

export function formatCallSummaryMetrics(rawTotals = {}) {
  const offered = Number(rawTotals.total_calls || 0);
  const handled = Number(rawTotals.answered_calls || 0);
  const abandoned = Number(rawTotals.abandoned_calls || 0);
  const totalWait = Number(rawTotals.total_wait_seconds || 0);
  const totalHandle = Number(rawTotals.total_handle_seconds || 0);

  const answerRate = offered > 0 ? ((handled / offered) * 100).toFixed(2) + '%' : '0.00%';
  const abandonRate = offered > 0 ? ((abandoned / offered) * 100).toFixed(2) + '%' : '0.00%';
  const avgWaitSec = handled > 0 ? Math.round(totalWait / handled) : 0;
  const avgHandleSec = handled > 0 ? Math.round(totalHandle / handled) : 0;

  return {
    offered,
    handled,
    abandoned,
    answerRate,
    abandonRate,
    averageSpeedOfAnswer: formatSecondsToTime(avgWaitSec),
    averageHandleTime: formatSecondsToTime(avgHandleSec),
    totalHandleSeconds: totalHandle,
    totalWaitSeconds: totalWait,
    isRealData: offered > 0,
  };
}

export function formatCaseSummaryMetrics(rawCases = {}) {
  const totalCases = Number(rawCases.total_cases || 0);
  const closedCases = Number(rawCases.closed_cases || 0);
  const openCases = Number(rawCases.open_cases || 0);
  const resolutionRate = totalCases > 0 ? ((closedCases / totalCases) * 100).toFixed(2) + '%' : '0.00%';

  return {
    totalCases,
    closedCases,
    openCases,
    resolutionRate,
    isRealData: totalCases > 0,
  };
}

export function formatSecondsToTime(totalSeconds) {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) return '0:00:00';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatPolicyListItem(row) {
  return {
    id: row.id,
    documentCode: row.document_code,
    title: row.policy_title,
    category: row.policy_category,
    revisionNumber: row.revision_number,
    approvalStatus: row.approval_status,
    preparedFor: row.prepared_for || 'FrontSteps',
    fileName: row.file_name,
    fileExtension: row.file_extension,
    fileSize: row.file_size,
    fileChecksum: row.file_checksum,
    isCurrentVersion: Boolean(row.is_current_version),
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Hermes extraction anchor: flags whether this policy document has been extracted
    hermesExtracted: false,
    hermesRuleCount: 0,
  };
}
