/**
 * FrontSteps AI Policy Synchronization Service
 * 
 * Reconciles authoritative PDF policies from `frontsteps_policies_repository`
 * with `frontsteps_ai_policy_versions`.
 * 
 * Guarantees:
 * - Strict Read-Only interaction with original source tables.
 * - Idempotency: Repeated sync runs produce consistent, reproducible state.
 * - Non-destructive: Soft-flags missing source policies without deleting archive.
 * - Content-addressed immutability with verified SHA-256 binary validation.
 * - Single eligible current version per document code.
 */

import * as syncRepo from '../repositories/frontStepsAiPolicySyncRepository.js';
import * as archiveService from './frontStepsAiPolicyArchiveService.js';

let isSyncingInMemory = false;

/**
 * Runs policy synchronization.
 * 
 * @param {Object} options
 * @param {'MANUAL'|'AUTOMATIC'} [options.triggerType='MANUAL']
 * @param {string} [options.triggeredBy='SYSTEM']
 * @returns {Promise<Object>} Sync run result
 */
export async function runPolicySync({ triggerType = 'MANUAL', triggeredBy = 'SYSTEM' } = {}) {
  // Prevent in-memory concurrency
  if (isSyncingInMemory) {
    return {
      success: false,
      inProgress: true,
      message: 'A policy synchronization is already active in this process.',
    };
  }

  isSyncingInMemory = true;
  let runId = null;

  try {
    // Ensure AI tables are bootstrapped
    await syncRepo.ensureTablesExist();

    // Prevent cross-process concurrency (DB lock)
    const activeRun = await syncRepo.getActiveSyncRun(5);
    if (activeRun) {
      isSyncingInMemory = false;
      return {
        success: false,
        inProgress: true,
        message: 'A policy synchronization run is currently in progress.',
        runId: activeRun.id,
        startedAt: activeRun.started_at,
      };
    }

    runId = await syncRepo.createSyncRun({ triggerType, triggeredBy });

    const metrics = {
      discoveredCount: 0,
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      missingCount: 0,
      failedCount: 0,
      details: [],
    };

    // 1. Fetch all source policies from frontsteps_policies_repository
    const sourcePolicies = await syncRepo.fetchAllSourcePolicies();
    metrics.discoveredCount = sourcePolicies.length;

    const validSourceIds = [];
    const affectedDocCodes = new Set();

    // 2. Process each discovered source policy
    for (const source of sourcePolicies) {
      validSourceIds.push(source.id);
      affectedDocCodes.add(source.document_code);

      try {
        // Fetch binary content
        const binaryBuffer = await syncRepo.fetchSourcePolicyBinary(source.id);

        if (!binaryBuffer || binaryBuffer.length === 0) {
          metrics.failedCount++;
          metrics.details.push({
            sourceId: source.id,
            documentCode: source.document_code,
            status: 'FAILED',
            reason: 'Missing or empty binary content in source repository',
          });
          continue;
        }

        const verifiedChecksum = archiveService.computeSha256(binaryBuffer);

        // Check if an AI version already exists with matching (code, revision, hash)
        const exactMatch = await syncRepo.findAiVersionByDocRevHash(
          source.document_code,
          String(source.revision_number || '000'),
          verifiedChecksum
        );

        if (!exactMatch) {
          // Check if this source record had a different checksum (mutated / replaced binary)
          const existingSourceVersions = await syncRepo.findAiVersionsBySourceId(source.id);

          // Archive binary to secure content-addressed storage
          const archiveResult = await archiveService.archivePolicyBinary(binaryBuffer, source.file_name);

          const newVersionId = await syncRepo.insertAiPolicyVersion({
            sourcePolicyId: source.id,
            documentCode: source.document_code,
            policyTitle: source.policy_title,
            policyCategory: source.policy_category,
            revisionNumber: String(source.revision_number || '000'),
            sourceChecksum: source.file_checksum,
            verifiedChecksum,
            fileName: source.file_name,
            fileExtension: source.file_extension || 'pdf',
            fileSize: binaryBuffer.length,
            mimeType: source.mime_type || 'application/pdf',
            sourceApprovalStatus: source.approval_status || 'Pending Approval',
            sourceIsCurrent: source.is_current_version === 1,
            isEligibleCurrent: false, // Resolved in eligibility step
            sourceAvailability: 'AVAILABLE',
            archiveReference: archiveResult.archiveReference,
            archiveStatus: archiveResult.archiveStatus,
            versionNotes: existingSourceVersions.length > 0
              ? 'New version detected with updated binary content'
              : 'Initial synchronization',
            sourceCreatedAt: source.created_at,
            sourceUpdatedAt: source.updated_at,
          });

          const isMutation = existingSourceVersions.length > 0;
          const eventType = isMutation ? 'SOURCE_REPLACED' : 'VERSION_ADDED';

          await syncRepo.recordPolicyEvent({
            policyVersionId: newVersionId,
            sourcePolicyId: source.id,
            documentCode: source.document_code,
            eventType,
            previousState: isMutation ? { previousChecksum: existingSourceVersions[0].verified_checksum } : null,
            newState: {
              versionId: newVersionId,
              revisionNumber: source.revision_number,
              verifiedChecksum,
              approvalStatus: source.approval_status,
              archiveReference: archiveResult.archiveReference,
            },
            eventMetadata: {
              triggerType,
              triggeredBy,
              archiveStatus: archiveResult.archiveStatus,
            },
          });

          metrics.createdCount++;
          metrics.details.push({
            sourceId: source.id,
            documentCode: source.document_code,
            revisionNumber: source.revision_number,
            status: isMutation ? 'SOURCE_REPLACED' : 'VERSION_ADDED',
            versionId: newVersionId,
          });
        } else {
          // Exact binary match exists: check for metadata changes (approval, current flag, availability)
          const isApprovalChanged =
            String(exactMatch.source_approval_status || '').toLowerCase() !==
            String(source.approval_status || '').toLowerCase();
          const isCurrentChanged =
            Boolean(exactMatch.source_is_current) !== (source.is_current_version === 1);
          const isTitleChanged = exactMatch.policy_title !== source.policy_title;
          const isCategoryChanged = exactMatch.policy_category !== source.policy_category;
          const isRestored = exactMatch.source_availability !== 'AVAILABLE';

          if (isApprovalChanged || isCurrentChanged || isTitleChanged || isCategoryChanged || isRestored) {
            await syncRepo.updateAiPolicyVersionMetadata(exactMatch.id, {
              policyTitle: source.policy_title,
              policyCategory: source.policy_category,
              sourceApprovalStatus: source.approval_status,
              sourceIsCurrent: source.is_current_version === 1,
              sourceAvailability: 'AVAILABLE',
              sourceUpdatedAt: source.updated_at,
              versionNotes: isApprovalChanged
                ? `Approval status updated from ${exactMatch.source_approval_status} to ${source.approval_status}`
                : exactMatch.version_notes,
            });

            if (isApprovalChanged) {
              await syncRepo.recordPolicyEvent({
                policyVersionId: exactMatch.id,
                sourcePolicyId: source.id,
                documentCode: source.document_code,
                eventType: 'STATUS_CHANGED',
                previousState: { approvalStatus: exactMatch.source_approval_status },
                newState: { approvalStatus: source.approval_status },
                eventMetadata: { triggerType, triggeredBy },
              });
            }

            if (isCurrentChanged) {
              await syncRepo.recordPolicyEvent({
                policyVersionId: exactMatch.id,
                sourcePolicyId: source.id,
                documentCode: source.document_code,
                eventType: 'CURRENT_REVISION_CHANGED',
                previousState: { isCurrent: exactMatch.source_is_current },
                newState: { isCurrent: source.is_current_version },
                eventMetadata: { triggerType, triggeredBy },
              });
            }

            metrics.updatedCount++;
            metrics.details.push({
              sourceId: source.id,
              documentCode: source.document_code,
              status: 'METADATA_UPDATED',
              versionId: exactMatch.id,
            });
          } else {
            // Unchanged
            metrics.unchangedCount++;
            metrics.details.push({
              sourceId: source.id,
              documentCode: source.document_code,
              status: 'UNCHANGED',
              versionId: exactMatch.id,
            });
          }
        }
      } catch (policyErr) {
        console.error(`[FrontSteps AI Sync] Error processing policy ID ${source.id}:`, policyErr);
        metrics.failedCount++;
        metrics.details.push({
          sourceId: source.id,
          documentCode: source.document_code,
          status: 'FAILED',
          error: policyErr.message,
        });
      }
    }

    // 3. Detect missing/deleted source policies
    const allAiVersions = await syncRepo.getAiPolicyVersions();
    for (const aiVer of allAiVersions) {
      if (aiVer.source_availability === 'AVAILABLE' && !validSourceIds.includes(Number(aiVer.source_policy_id))) {
        await syncRepo.updateAiPolicyVersionMetadata(aiVer.id, {
          sourceAvailability: 'SOURCE_DELETED',
          isEligibleCurrent: 0,
          versionNotes: 'Source document no longer present in source repository',
        });

        await syncRepo.recordPolicyEvent({
          policyVersionId: aiVer.id,
          sourcePolicyId: aiVer.source_policy_id,
          documentCode: aiVer.document_code,
          eventType: 'SOURCE_MISSING',
          previousState: { availability: 'AVAILABLE' },
          newState: { availability: 'SOURCE_DELETED' },
          eventMetadata: { triggerType, triggeredBy },
        });

        metrics.missingCount++;
        metrics.details.push({
          sourceId: aiVer.source_policy_id,
          documentCode: aiVer.document_code,
          status: 'SOURCE_MISSING',
          versionId: aiVer.id,
        });

        affectedDocCodes.add(aiVer.document_code);
      }
    }

    // 4. Resolve single eligible current version for each affected document code
    for (const docCode of affectedDocCodes) {
      const versions = await syncRepo.getAiVersionsByDocumentCode(docCode);

      // Candidates: approved, marked current in source, available, archived/deduplicated
      const candidates = versions.filter((v) => {
        const isApproved = String(v.source_approval_status || '').toLowerCase() === 'approved';
        const isCurrent = Number(v.source_is_current) === 1;
        const isAvailable = v.source_availability === 'AVAILABLE';
        const isArchived = ['ARCHIVED', 'DEDUPLICATED'].includes(v.archive_status);
        return isApproved && isCurrent && isAvailable && isArchived;
      });

      let eligibleId = null;
      if (candidates.length === 1) {
        eligibleId = candidates[0].id;
      } else if (candidates.length > 1) {
        // Tie-breaker: sort by revision_number DESC, id DESC
        candidates.sort((a, b) => {
          const revA = String(a.revision_number);
          const revB = String(b.revision_number);
          if (revA !== revB) return revB.localeCompare(revA, undefined, { numeric: true });
          return b.id - a.id;
        });
        eligibleId = candidates[0].id;

        await syncRepo.recordPolicyEvent({
          policyVersionId: eligibleId,
          sourcePolicyId: candidates[0].source_policy_id,
          documentCode: docCode,
          eventType: 'METADATA_UPDATED',
          eventMetadata: {
            note: 'Resolved multiple source_is_current candidates; picked latest revision',
            candidateIds: candidates.map((c) => c.id),
          },
        });
      }

      await syncRepo.setDocumentEligibleCurrent(docCode, eligibleId);
    }

    // 5. Determine final run status
    const finalRunStatus =
      metrics.failedCount > 0 && metrics.createdCount === 0 && metrics.updatedCount === 0
        ? 'FAILED'
        : metrics.failedCount > 0
        ? 'PARTIAL'
        : metrics.createdCount === 0 && metrics.updatedCount === 0 && metrics.missingCount === 0
        ? 'NO_CHANGES'
        : 'COMPLETED';

    await syncRepo.completeSyncRun(runId, {
      runStatus: finalRunStatus,
      discoveredCount: metrics.discoveredCount,
      createdCount: metrics.createdCount,
      updatedCount: metrics.updatedCount,
      unchangedCount: metrics.unchangedCount,
      missingCount: metrics.missingCount,
      failedCount: metrics.failedCount,
      syncDetails: metrics.details,
    });

    await syncRepo.recordPolicyEvent({
      documentCode: 'SYSTEM_SYNC',
      eventType: 'SYNC_COMPLETED',
      eventMetadata: {
        runId,
        runStatus: finalRunStatus,
        ...metrics,
      },
    });

    return {
      success: true,
      runId,
      status: finalRunStatus,
      metrics,
    };
  } catch (err) {
    console.error('[FrontSteps AI Sync] Fatal error during policy sync run:', err);

    if (runId) {
      await syncRepo.completeSyncRun(runId, {
        runStatus: 'FAILED',
        errorSummary: err.message,
      }).catch(() => {});

      await syncRepo.recordPolicyEvent({
        documentCode: 'SYSTEM_SYNC',
        eventType: 'SYNC_FAILED',
        eventMetadata: { runId, error: err.message },
      }).catch(() => {});
    }

    return {
      success: false,
      runId,
      status: 'FAILED',
      error: err.message,
    };
  } finally {
    isSyncingInMemory = false;
  }
}

/**
 * Retrieves the current synchronization status and latest execution metrics.
 */
export async function getSyncStatus() {
  await syncRepo.ensureTablesExist();

  const [activeRun, latestRun, allVersions] = await Promise.all([
    syncRepo.getActiveSyncRun(5),
    syncRepo.getLatestSyncRun(),
    syncRepo.getAiPolicyVersions(),
  ]);

  const totalVersions = allVersions.length;
  const eligibleCount = allVersions.filter((v) => Number(v.is_eligible_current) === 1).length;
  const missingCount = allVersions.filter((v) => v.source_availability === 'SOURCE_DELETED').length;
  const uniqueDocCodes = new Set(allVersions.map((v) => v.document_code)).size;

  return {
    success: true,
    isRunning: Boolean(activeRun),
    activeRun: activeRun || null,
    latestRun: latestRun || null,
    summary: {
      uniqueDocuments: uniqueDocCodes,
      totalPolicyVersions: totalVersions,
      currentEligibleCount: eligibleCount,
      missingFromSourceCount: missingCount,
    },
  };
}

/**
 * Retrieves synchronized policy versions with filtering.
 */
export async function getPolicyVersions(filters = {}) {
  await syncRepo.ensureTablesExist();
  const rows = await syncRepo.getAiPolicyVersions(filters);
  return {
    success: true,
    total: rows.length,
    data: rows,
  };
}

/**
 * Retrieves comprehensive version history and lifecycle events for a specific policy.
 */
export async function getPolicyVersionHistory(documentCode) {
  if (!documentCode) {
    throw new Error('documentCode is required');
  }

  await syncRepo.ensureTablesExist();

  const [versions, events] = await Promise.all([
    syncRepo.getAiVersionsByDocumentCode(documentCode),
    syncRepo.getPolicyEvents(documentCode, 100),
  ]);

  return {
    success: true,
    documentCode,
    versions,
    events,
  };
}

/**
 * Retrieves past synchronization runs.
 */
export async function getSyncHistory(limit = 20) {
  await syncRepo.ensureTablesExist();
  const runs = await syncRepo.getSyncRunHistory(limit);
  return {
    success: true,
    total: runs.length,
    data: runs,
  };
}
