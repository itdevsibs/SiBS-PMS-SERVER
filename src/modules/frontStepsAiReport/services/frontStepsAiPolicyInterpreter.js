/**
 * FrontSteps AI Policy Interpreter Service
 * 
 * Orchestrates Hermes AI policy interpretation runs for verified FrontSteps PDF policies.
 * Loads page evidence, prompts the Hermes sibs-pms-analyst profile, validates candidate output,
 * and persists versioned rule candidates and issues into the database.
 * 
 * Strict Isolation: Operates only on FrontSteps AI tables and does NOT activate executable rules.
 */

import * as interpRepo from '../repositories/frontStepsAiPolicyInterpretationRepository.js';
import { buildPolicyInterpretationContext } from './frontStepsAiPolicyContextBuilder.js';
import { sendHermesChatCompletion, getHermesConfig } from './frontStepsAiHermesClient.js';
import {
  extractJsonFromAssistantResponse,
  validatePolicyInterpretationOutput,
} from './frontStepsAiRuleCandidateValidator.js';

const STALE_INTERPRETING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Interprets a verified policy version using Hermes AI.
 * 
 * @param {number} versionId
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 * @param {string} [options.model]
 * @returns {Promise<object>}
 */
export async function interpretPolicyVersion(versionId, { force = false, model = null } = {}) {
  await interpRepo.ensureInterpretationTablesExist();

  // 1. Build policy evidence and verify version/extraction eligibility
  const context = await buildPolicyInterpretationContext(versionId);
  const { version, extractionRun, pages, messages } = context;

  // 2. Check existing runs and concurrency
  const latestRun = await interpRepo.getLatestRunByVersionId(versionId);
  if (latestRun) {
    if (latestRun.status === 'INTERPRETING') {
      const startedAt = new Date(latestRun.started_at).getTime();
      if (Date.now() - startedAt < STALE_INTERPRETING_TIMEOUT_MS) {
        return {
          inProgress: true,
          message: `Policy interpretation is already running for ${version.document_code} (Run ID: ${latestRun.id})`,
          runId: latestRun.id,
          status: 'INTERPRETING',
        };
      }
      // If stale, mark failed and continue
      await interpRepo.updateInterpretationRun(latestRun.id, {
        status: 'FAILED',
        errorDetails: 'Interpretation timed out or crashed in previous session',
      });
    }

    // Reuse existing interpretation if already completed and not forced
    if (!force && ['COMPLETED', 'NEEDS_REVIEW'].includes(latestRun.status)) {
      const existingRules = await interpRepo.getRuleCandidatesByRunId(latestRun.id);
      const existingIssues = await interpRepo.getInterpretationIssuesByRunId(latestRun.id);
      return {
        success: true,
        reusedExisting: true,
        runId: latestRun.id,
        status: latestRun.status,
        documentCode: version.document_code,
        policyVersionId: version.id,
        ruleCount: existingRules.length,
        issueCount: existingIssues.length,
        rules: existingRules,
        issues: existingIssues,
        startedAt: latestRun.started_at,
        completedAt: latestRun.completed_at,
      };
    }
  }

  // 3. Create a new interpretation run
  const config = getHermesConfig();
  const selectedModel = model || config.model;
  const startTime = Date.now();

  const runId = await interpRepo.createInterpretationRun({
    policyVersionId: version.id,
    extractionRunId: extractionRun.id,
    sourceChecksum: version.verified_checksum,
    hermesModel: selectedModel,
    status: 'INTERPRETING',
    attemptCount: 1,
    interpretationVersion: 'v1',
  });

  try {
    console.log(`[FrontSteps AI Interpreter] Requesting Hermes interpretation for ${version.document_code} (Run ID: ${runId}, Model: ${selectedModel})...`);

    // 4. Send inference request to Hermes
    let hermesResponse;
    try {
      hermesResponse = await sendHermesChatCompletion(messages, {
        model: selectedModel,
        maxTokens: 4096,
        responseFormat: { type: 'json_object' },
      });
    } catch (hermesErr) {
      await interpRepo.updateInterpretationRun(runId, {
        status: 'FAILED',
        durationMs: Date.now() - startTime,
        errorDetails: `Hermes transport error: ${hermesErr.message}`,
        completed: true,
      });
      throw hermesErr;
    }

    // 5. Parse JSON assistant output
    let parsedJson;
    try {
      parsedJson = extractJsonFromAssistantResponse(hermesResponse.content);
    } catch (parseErr) {
      console.warn(`[FrontSteps AI Interpreter] JSON parse failed on first attempt for ${version.document_code}. Retrying with strict format instruction...`);

      // Bounded 1-time retry for valid JSON
      try {
        const retryMessages = [
          ...messages,
          { role: 'assistant', content: hermesResponse.content },
          {
            role: 'user',
            content: `The response did not parse as valid JSON (${parseErr.message}). Please return ONLY the raw JSON object starting with { and ending with } according to the required schema. No introductory or closing remarks.`,
          },
        ];
        const retryResponse = await sendHermesChatCompletion(retryMessages, {
          model: selectedModel,
          temperature: 0.05,
          maxTokens: 4096,
          responseFormat: { type: 'json_object' },
        });
        parsedJson = extractJsonFromAssistantResponse(retryResponse.content);
        hermesResponse = retryResponse;
      } catch (retryErr) {
        await interpRepo.updateInterpretationRun(runId, {
          status: 'FAILED',
          durationMs: Date.now() - startTime,
          errorDetails: `Failed to extract valid JSON from Hermes response: ${retryErr.message}`,
          rawResponseJson: hermesResponse?.content,
          completed: true,
        });
        throw new Error(`Hermes response could not be parsed as structured rule JSON: ${retryErr.message}`);
      }
    }

    // 6. Validate, sanitize, and verify rules against extracted pages
    const validatedResult = validatePolicyInterpretationOutput(parsedJson, {
      pages,
      documentCode: version.document_code,
      revisionNumber: version.revision_number,
      versionId: version.id,
    });

    const candidateRules = validatedResult.rules.map((r) => ({
      ...r,
      interpretationRunId: runId,
      policyVersionId: version.id,
    }));

    const interpretationIssues = validatedResult.issues.map((i) => ({
      ...i,
      interpretationRunId: runId,
      policyVersionId: version.id,
    }));

    // 7. Persist candidate rules and issues
    if (candidateRules.length > 0) {
      await interpRepo.insertRuleCandidates(candidateRules);
    }
    if (interpretationIssues.length > 0) {
      await interpRepo.insertInterpretationIssues(interpretationIssues);
    }

    const durationMs = Date.now() - startTime;
    const finalStatus = validatedResult.interpretationStatus;

    // 8. Update run record
    await interpRepo.updateInterpretationRun(runId, {
      status: finalStatus,
      ruleCount: candidateRules.length,
      issueCount: interpretationIssues.length,
      durationMs,
      rawResponseJson: parsedJson,
      completed: true,
    });

    console.log(`[FrontSteps AI Interpreter] Completed interpretation for ${version.document_code} in ${durationMs}ms (Rules: ${candidateRules.length}, Issues: ${interpretationIssues.length}, Status: ${finalStatus})`);

    return {
      success: true,
      runId,
      status: finalStatus,
      documentCode: version.document_code,
      policyVersionId: version.id,
      ruleCount: candidateRules.length,
      issueCount: interpretationIssues.length,
      rules: candidateRules,
      issues: interpretationIssues,
      metadata: validatedResult.metadata,
      durationMs,
    };
  } catch (err) {
    console.error(`[FrontSteps AI Interpreter] Error interpreting ${version.document_code}:`, err);
    throw err;
  }
}

/**
 * Retrieves the latest interpretation status and rules for a version.
 */
export async function getPolicyVersionInterpretation(versionId) {
  await interpRepo.ensureInterpretationTablesExist();
  const latestRun = await interpRepo.getLatestRunByVersionId(versionId);
  if (!latestRun) {
    return {
      hasInterpretation: false,
      status: 'NOT_INTERPRETED',
      ruleCount: 0,
      issueCount: 0,
    };
  }

  const rules = await interpRepo.getRuleCandidatesByRunId(latestRun.id);
  const issues = await interpRepo.getInterpretationIssuesByRunId(latestRun.id);

  return {
    hasInterpretation: true,
    run: latestRun,
    status: latestRun.status,
    ruleCount: rules.length,
    issueCount: issues.length,
    rules,
    issues,
  };
}

/**
 * Retrieves persisted rule candidates for a version.
 */
export async function getPolicyVersionRules(versionId) {
  await interpRepo.ensureInterpretationTablesExist();
  return interpRepo.getRuleCandidatesByVersionId(versionId);
}
