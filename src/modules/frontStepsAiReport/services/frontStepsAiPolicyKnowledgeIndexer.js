/**
 * FrontSteps AI Policy Knowledge Indexer
 * 
 * Converts structured page extractions into logical, searchable knowledge passages.
 * Preserves source references: documentCode, revisionNumber, pageStart, pageEnd,
 * sectionTitle, exact text, and content checksums.
 * 
 * Strict Requirement: Never fabricates or alters policy wording, KPI thresholds,
 * or mathematical formulas.
 */

import crypto from 'crypto';
import * as extractionRepo from '../repositories/frontStepsAiPolicyExtractionRepository.js';

const CHUNK_MAX_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 150;

/**
 * Computes SHA-256 hash of a string.
 */
function computeStringHash(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Normalizes text for keyword / text search.
 */
export function normalizeSearchText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s%./<>=+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Determines section type based on heading and line contents.
 */
function categorizeSection(heading = '', content = '') {
  const combined = (heading + ' ' + content).toLowerCase();
  if (/formula|calculation|multiplier|weight\s*\d+%|sum\(/i.test(combined)) {
    return 'formula';
  }
  if (/table|matrix|tier|bracket|schedule|level\s*\d+/i.test(combined)) {
    return 'table';
  }
  if (/kpi|metric|target|sla|aht|threshold|attendance|occupancy/i.test(combined)) {
    return 'kpi_definition';
  }
  if (/procedure|process|steps|corrective action|escalation|appeal/i.test(combined)) {
    return 'procedure';
  }
  if (/document\s*title|document\s*code|revision|effective\s*date|approved\s*by/i.test(combined)) {
    return 'metadata';
  }
  return 'policy_rules';
}

/**
 * Builds searchable chunks from extracted pages and persists them.
 * 
 * @param {Object} params
 * @param {number} params.extractionRunId
 * @param {Object} params.versionRecord
 * @param {Array<Object>} params.pages
 * @returns {Promise<Array<Object>>} Created chunks
 */
export async function buildAndIndexChunks({ extractionRunId, versionRecord, pages }) {
  if (!pages || pages.length === 0) {
    return [];
  }

  const chunks = [];
  let chunkSequence = 0;

  // Process pages to group into sections
  let currentHeading = 'Document Overview';
  let currentLines = [];
  let currentStartPage = pages[0].pageNumber;
  let currentEndPage = pages[0].pageNumber;
  let currentStructuredData = null;

  for (const page of pages) {
    const lines = page.exactText.split('\n').map((l) => l.trim()).filter(Boolean);
    const headings = page.structuredContentJson?.headings || [];
    const tables = page.structuredContentJson?.tables || [];

    for (const line of lines) {
      const isNewHeading = headings.includes(line) || /^\d+(\.\d+)*\s+[A-Za-z]/.test(line);

      if (isNewHeading && currentLines.length > 0) {
        // Finalize current accumulated passage into one or more chunks
        const content = currentLines.join('\n');
        const sectionType = categorizeSection(currentHeading, content);

        if (content.length <= CHUNK_MAX_CHARS) {
          chunks.push({
            policyVersionId: versionRecord.id,
            extractionRunId,
            chunkIndex: chunkSequence++,
            pageStart: currentStartPage,
            pageEnd: currentEndPage,
            sectionTitle: currentHeading,
            sectionType,
            exactText: content,
            searchText: normalizeSearchText(content),
            contentChecksum: computeStringHash(content),
            structuredDataJson: currentStructuredData,
          });
        } else {
          // Split long section with bounded overlap
          let startIdx = 0;
          while (startIdx < content.length) {
            const endIdx = Math.min(startIdx + CHUNK_MAX_CHARS, content.length);
            const chunkSlice = content.substring(startIdx, endIdx);

            chunks.push({
              policyVersionId: versionRecord.id,
              extractionRunId,
              chunkIndex: chunkSequence++,
              pageStart: currentStartPage,
              pageEnd: currentEndPage,
              sectionTitle: `${currentHeading} (Part ${Math.floor(startIdx / CHUNK_MAX_CHARS) + 1})`,
              sectionType,
              exactText: chunkSlice,
              searchText: normalizeSearchText(chunkSlice),
              contentChecksum: computeStringHash(chunkSlice),
              structuredDataJson: currentStructuredData,
            });

            if (endIdx >= content.length) break;
            startIdx += CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS;
          }
        }

        // Reset for new heading
        currentHeading = line;
        currentLines = [line];
        currentStartPage = page.pageNumber;
        currentEndPage = page.pageNumber;
        currentStructuredData = null;
      } else {
        currentLines.push(line);
        currentEndPage = page.pageNumber;
      }
    }

    if (tables && tables.length > 0) {
      currentStructuredData = { tables };
    }
  }

  // Final section
  if (currentLines.length > 0) {
    const content = currentLines.join('\n');
    const sectionType = categorizeSection(currentHeading, content);

    chunks.push({
      policyVersionId: versionRecord.id,
      extractionRunId,
      chunkIndex: chunkSequence++,
      pageStart: currentStartPage,
      pageEnd: currentEndPage,
      sectionTitle: currentHeading,
      sectionType,
      exactText: content,
      searchText: normalizeSearchText(content),
      contentChecksum: computeStringHash(content),
      structuredDataJson: currentStructuredData,
    });
  }

  // Insert chunks into database
  await extractionRepo.insertPolicyChunks(chunks);

  return chunks;
}

/**
 * Searches indexed knowledge passages and returns source-cited results.
 */
export async function searchPolicyKnowledge({
  query,
  versionId = null,
  documentCode = null,
  category = null,
  page = 1,
  limit = 20,
}) {
  await extractionRepo.ensureExtractionTablesExist();

  const offset = Math.max(0, (page - 1) * limit);
  const { total, matches } = await extractionRepo.searchChunks({
    query,
    versionId,
    documentCode,
    category,
    limit,
    offset,
  });

  const formattedResults = matches.map((m) => {
    const pageCitation =
      m.page_start === m.page_end
        ? `Page ${m.page_start}`
        : `Pages ${m.page_start}–${m.page_end}`;

    return {
      chunkId: m.id,
      policyVersionId: m.policy_version_id,
      extractionRunId: m.extraction_run_id,
      documentCode: m.document_code,
      policyTitle: m.policy_title,
      revisionNumber: m.revision_number,
      isEligibleCurrent: Boolean(m.is_eligible_current),
      pageStart: m.page_start,
      pageEnd: m.page_end,
      citation: `${m.document_code} | Rev ${m.revision_number} | ${pageCitation}`,
      sectionTitle: m.section_title,
      sectionType: m.section_type,
      exactText: m.exact_text,
      contentChecksum: m.content_checksum,
      structuredData: m.structured_data_json,
    };
  });

  return {
    query,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    results: formattedResults,
  };
}
