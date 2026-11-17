/**
 * FrontSteps AI PDF Extraction Service
 * 
 * Extracts text, logical sections, tables, formulas, and warnings
 * page-by-page from immutable, content-addressed FrontSteps policy PDFs.
 * 
 * Strict Guarantees:
 * - Read-only on source policy tables.
 * - Operates on immutable policy versions from Phase 1.
 * - Verifies SHA-256 archive integrity prior to processing.
 * - Preserves exact numbers, units, operators, and tabular alignment.
 * - Idempotent: Reuses existing successful extraction unless forceReprocess is requested.
 * - No external LLM or Hermes calls in this phase.
 */

import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import * as syncRepo from '../repositories/frontStepsAiPolicySyncRepository.js';
import * as extractionRepo from '../repositories/frontStepsAiPolicyExtractionRepository.js';
import * as archiveService from './frontStepsAiPolicyArchiveService.js';
import * as indexer from './frontStepsAiPolicyKnowledgeIndexer.js';

const PARSER_VERSION = 'pdf-parse@1.1.4';
const activeExtractionsInMemory = new Set();

/**
 * Validates that a buffer is a valid PDF document.
 */
export function validatePdfBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Invalid file content provided for PDF extraction');
  }
  if (buffer.length < 50) {
    throw new Error('File buffer is too small to be a valid PDF document');
  }
  const header = buffer.subarray(0, 5).toString('ascii');
  if (!header.startsWith('%PDF')) {
    throw new Error('File header does not match standard PDF format (%PDF-)');
  }
  return true;
}

/**
 * Identifies whether a line is a section heading.
 */
export function isHeadingLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return false;

  // Numbered section e.g. "1. PURPOSE", "2.1 Scope", "3.1.2 Definitions"
  if (/^\d+(\.\d+)*\.?\s+[A-Za-z]/.test(trimmed)) return true;

  // Standard policy section titles
  if (
    /^(DOCUMENT TITLE|DOCUMENT CODE|REVISION NUMBER|EFFECTIVITY DATE|DATE OF LAST REVIEW|PREPARED FOR|PREPARED BY|REVIEWED BY|APPROVED BY|PURPOSE|SCOPE|POLICY STATEMENT|DEFINITIONS|PERFORMANCE INCENTIVE CRITERIA|PERFORMANCE METRICS|ELIGIBILITY CRITERIA|KPI METRIC MATRIX|CORRECTIVE ACTION|GOVERNANCE|GENERAL PROVISIONS|ACKNOWLEDGEMENT):?/i.test(
      trimmed
    )
  ) {
    return true;
  }

  // ALL CAPS short line with no lowercase letters
  if (
    trimmed.length >= 4 &&
    trimmed.length <= 60 &&
    trimmed === trimmed.toUpperCase() &&
    /[A-Z]/.test(trimmed) &&
    !/[=<>|]/.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/**
 * Identifies whether a line represents a formula, metric condition, or threshold.
 */
export function isFormulaLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /(=|>=|<=|<|>|\bSLA\b|\bAHT\b|\bERR\b|\bQA\s*Score\b|\bPoints\b|\bWeight\b|\bMultiplier\b|\bTarget\b|\bThreshold\b|\bBonus\b|\bPenalty\b)/i.test(
      trimmed
    ) && /\d+%?|\bScore\b|\bRate\b|\bHours\b|\bMinutes\b|\bSeconds\b/i.test(trimmed)
  );
}

/**
 * Identifies whether a line is part of a table.
 */
export function isTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.includes('\t') || (trimmed.match(/\|/g) || []).length >= 2) return true;
  // Multi-column separated by 3 or more spaces
  const parts = trimmed.split(/\s{3,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && trimmed.length > 8) return true;
  return false;
}

/**
 * Attempts to parse tabular lines into structured rows and cells.
 */
export function extractTablesFromLines(lines) {
  const tables = [];
  let currentTable = null;

  for (const line of lines) {
    if (isTableLine(line)) {
      // Split on tabs, pipes, or 3+ spaces
      const cells = line
        .split(/\t|\||\s{3,}/)
        .map((c) => c.trim())
        .filter(Boolean);

      if (cells.length >= 2) {
        if (!currentTable) {
          currentTable = {
            headers: cells,
            rows: [],
          };
        } else {
          currentTable.rows.push(cells);
        }
      }
    } else {
      if (currentTable && currentTable.rows.length > 0) {
        tables.push(currentTable);
        currentTable = null;
      }
    }
  }

  if (currentTable && currentTable.rows.length > 0) {
    tables.push(currentTable);
  }

  return tables;
}

/**
 * Extracts structured knowledge from an archived FrontSteps policy version.
 * 
 * @param {number|string} versionId - Primary key in frontsteps_ai_policy_versions
 * @param {Object} [options]
 * @param {boolean} [options.forceReprocess=false] - If true, bypasses existing READY cache
 * @returns {Promise<Object>} Extraction run details
 */
export async function extractPolicyVersion(versionId, { forceReprocess = false } = {}) {
  await extractionRepo.ensureExtractionTablesExist();

  const numVersionId = Number(versionId);
  if (!numVersionId || isNaN(numVersionId)) {
    throw new Error('Valid policy version ID is required');
  }

  // Prevent in-memory concurrency for the same version
  if (activeExtractionsInMemory.has(numVersionId)) {
    return {
      success: false,
      inProgress: true,
      message: 'Extraction is currently running for this policy version',
    };
  }

  // Prevent cross-process concurrency (DB lock)
  const activeDbRun = await extractionRepo.getActiveExtractionRunByVersionId(numVersionId, 5);
  if (activeDbRun) {
    return {
      success: false,
      inProgress: true,
      message: 'Extraction is currently running for this policy version in another worker',
      runId: activeDbRun.id,
      startedAt: activeDbRun.started_at,
    };
  }

  // 1. Resolve immutable version record
  const versions = await syncRepo.getAiPolicyVersions();
  const versionRecord = versions.find((v) => Number(v.id) === numVersionId);

  if (!versionRecord) {
    throw new Error(`Policy version #${numVersionId} not found in FrontSteps AI version ledger`);
  }

  // 2. Check for existing successful extraction (idempotency)
  if (!forceReprocess) {
    const existingRun = await extractionRepo.findSuccessfulExtractionRun(
      numVersionId,
      versionRecord.verified_checksum,
      PARSER_VERSION
    );

    if (existingRun) {
      return {
        success: true,
        reusedExisting: true,
        runId: existingRun.id,
        status: existingRun.status,
        pageCount: existingRun.page_count,
        tableCount: existingRun.table_count,
        chunkCount: existingRun.chunk_count,
        message: 'Reused existing verified extraction run',
      };
    }
  }

  activeExtractionsInMemory.add(numVersionId);
  let runId = null;

  try {
    // 3. Obtain protected archive reference and confirm integrity
    const archiveReference = versionRecord.archive_reference;
    if (!archiveReference) {
      throw new Error(`No archive reference associated with policy version #${numVersionId}`);
    }

    const isIntegrityValid = await archiveService.verifyArchiveFileIntegrity(
      archiveReference,
      versionRecord.verified_checksum
    );

    if (!isIntegrityValid) {
      throw new Error(
        `SHA-256 archive integrity check failed for ${archiveReference}. Checksum does not match stored verified_checksum.`
      );
    }

    // 4. Retrieve PDF buffer
    const pdfBuffer = await archiveService.getArchivedPolicyBuffer(archiveReference);
    if (!pdfBuffer) {
      throw new Error(`Archived PDF file ${archiveReference} could not be read from storage`);
    }

    validatePdfBuffer(pdfBuffer);

    // 5. Create new extraction run
    runId = await extractionRepo.createExtractionRun({
      policyVersionId: numVersionId,
      documentCode: versionRecord.document_code,
      revisionNumber: versionRecord.revision_number,
      archiveChecksum: versionRecord.verified_checksum,
      parserVersion: PARSER_VERSION,
    });

    // 6. Page-by-page extraction with layout preservation
    const extractedPages = [];
    const allWarnings = [];
    let totalTablesCount = 0;

    const pagerender = async (pageData) => {
      const textContent = await pageData.getTextContent({ normalizeWhitespace: false });
      const pageNum = pageData.pageIndex + 1;

      // Group text items by vertical line (Y-coordinate transform[5])
      // and sort horizontally (X-coordinate transform[4])
      const lineMap = new Map();
      for (const item of textContent.items) {
        const y = Math.round(item.transform[5]);
        if (!lineMap.has(y)) {
          lineMap.set(y, []);
        }
        lineMap.get(y).push({
          x: item.transform[4],
          str: item.str,
        });
      }

      // Sort lines top-to-bottom (Y descending)
      const sortedY = Array.from(lineMap.keys()).sort((a, b) => b - a);
      const reconstructedLines = [];

      for (const y of sortedY) {
        const itemsInLine = lineMap.get(y).sort((a, b) => a.x - b.x);
        let lineStr = '';
        let lastX = null;

        for (const item of itemsInLine) {
          if (lastX !== null && item.x - lastX > 14) {
            lineStr += '    '; // Preserve tabular column gap
          } else if (lastX !== null && item.x - lastX > 4) {
            lineStr += ' ';
          }
          lineStr += item.str;
          lastX = item.x + (item.str.length * 6);
        }

        if (lineStr.trim()) {
          reconstructedLines.push(lineStr.trimEnd());
        }
      }

      const cleanText = reconstructedLines.join('\n').trim();
      const pageWarnings = [];

      // Detect scanned or empty page
      if (cleanText.length < 20) {
        pageWarnings.push(
          `Page ${pageNum} has little to no readable text; it may contain scanned raster images.`
        );
      }

      // Detect page headings, formulas, and tables
      const headings = reconstructedLines.filter(isHeadingLine);
      const formulas = reconstructedLines.filter(isFormulaLine);
      const tables = extractTablesFromLines(reconstructedLines);

      if (tables.length > 0) {
        totalTablesCount += tables.length;
      }

      const words = cleanText.split(/\s+/).filter(Boolean);
      const pageStatus = cleanText.length < 20 ? 'NEEDS_OCR' : 'READY';

      extractedPages.push({
        policyVersionId: numVersionId,
        extractionRunId: runId,
        pageNumber: pageNum,
        exactText: cleanText,
        structuredContentJson: {
          headings,
          formulas,
          tables,
        },
        extractionStatus: pageStatus,
        charCount: cleanText.length,
        wordCount: words.length,
        hasTables: tables.length > 0,
        hasFormulas: formulas.length > 0,
        warningsJson: pageWarnings.length > 0 ? pageWarnings : null,
      });

      if (pageWarnings.length > 0) {
        allWarnings.push(...pageWarnings);
      }

      return cleanText;
    };

    // Execute PDF parsing
    await pdfParse(new Uint8Array(pdfBuffer), { pagerender });

    // Ensure pages sorted by pageNumber
    extractedPages.sort((a, b) => a.pageNumber - b.pageNumber);

    // 7. Persist extracted pages to database
    await extractionRepo.insertPolicyPages(extractedPages);

    // 8. Build and index searchable chunks
    const chunks = await indexer.buildAndIndexChunks({
      extractionRunId: runId,
      versionRecord,
      pages: extractedPages,
    });

    // 9. Determine overall run status
    const allPagesEmpty = extractedPages.every((p) => p.charCount < 20);
    const somePagesEmpty = extractedPages.some((p) => p.charCount < 20);

    const finalStatus =
      allPagesEmpty
        ? 'NEEDS_OCR'
        : somePagesEmpty
        ? 'PARTIAL'
        : 'READY';

    // 10. Update extraction run completion
    await extractionRepo.updateExtractionRun(runId, {
      status: finalStatus,
      completedAt: true,
      pageCount: extractedPages.length,
      processedPages: extractedPages.length,
      tableCount: totalTablesCount,
      chunkCount: chunks.length,
      warningCount: allWarnings.length,
      warningsJson: allWarnings,
    });

    // 11. Record lifecycle event
    await syncRepo.recordPolicyEvent({
      policyVersionId: numVersionId,
      sourcePolicyId: versionRecord.source_policy_id,
      documentCode: versionRecord.document_code,
      eventType: 'METADATA_UPDATED',
      eventMetadata: {
        action: 'PDF_EXTRACTION_COMPLETED',
        runId,
        status: finalStatus,
        pageCount: extractedPages.length,
        chunkCount: chunks.length,
        tableCount: totalTablesCount,
        warningCount: allWarnings.length,
      },
    });

    return {
      success: true,
      runId,
      status: finalStatus,
      pageCount: extractedPages.length,
      tableCount: totalTablesCount,
      chunkCount: chunks.length,
      warningCount: allWarnings.length,
      warnings: allWarnings,
    };
  } catch (err) {
    console.error(`[FrontSteps AI PDF Extraction] Error processing version #${numVersionId}:`, err);

    if (runId) {
      await extractionRepo.updateExtractionRun(runId, {
        status: 'FAILED',
        errorSummary: err.message,
      }).catch(() => {});

      await syncRepo.recordPolicyEvent({
        policyVersionId: numVersionId,
        sourcePolicyId: versionRecord?.source_policy_id || null,
        documentCode: versionRecord?.document_code || 'UNKNOWN',
        eventType: 'METADATA_UPDATED',
        eventMetadata: {
          action: 'PDF_EXTRACTION_FAILED',
          runId,
          error: err.message,
        },
      }).catch(() => {});
    }

    return {
      success: false,
      runId,
      status: 'FAILED',
      error: err.message,
    };
  } finally {
    activeExtractionsInMemory.delete(numVersionId);
  }
}

/**
 * Retrieves extraction details for a policy version.
 */
export async function getPolicyVersionExtraction(versionId) {
  await extractionRepo.ensureExtractionTablesExist();

  const numVersionId = Number(versionId);
  const latestRun = await extractionRepo.getLatestExtractionRunByVersionId(numVersionId);

  if (!latestRun) {
    return {
      hasExtracted: false,
      status: 'NOT_EXTRACTED',
      run: null,
    };
  }

  return {
    hasExtracted: true,
    status: latestRun.status,
    run: latestRun,
  };
}

/**
 * Retrieves extracted pages for a policy version with pagination.
 */
export async function getPolicyVersionPages(versionId, pagination = {}) {
  await extractionRepo.ensureExtractionTablesExist();
  return extractionRepo.getPagesByVersionId(Number(versionId), pagination);
}

/**
 * Retrieves extracted chunks for a policy version with pagination.
 */
export async function getPolicyVersionChunks(versionId, pagination = {}) {
  await extractionRepo.ensureExtractionTablesExist();
  return extractionRepo.getChunksByVersionId(Number(versionId), pagination);
}
