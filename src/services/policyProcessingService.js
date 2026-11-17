// Service for PDF Policy extraction, indexing, versioning, and retrieval.
import crypto from "crypto";
import pdfParse from "pdf-parse";
import { pmsDb, pmsTables } from "../config/db.js";

/**
 * Validate that a buffer represents a valid PDF file.
 */
export function validatePdfBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("Invalid file content provided.");
  }
  if (buffer.length < 100) {
    throw new Error("File is too small to be a valid PDF document.");
  }
  // PDF magic header %PDF-
  const header = buffer.subarray(0, 5).toString("ascii");
  if (!header.startsWith("%PDF")) {
    throw new Error("File header does not match standard PDF format (%PDF-).");
  }
  return true;
}

/**
 * Detect if a text line appears to be a heading.
 */
function isHeadingLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return false;

  // Numbered section e.g. "1. PURPOSE", "2.1 Scope"
  if (/^\d+(\.\d+)*\s+[A-Za-z]/.test(trimmed)) return true;

  // Key policy headings
  if (/^(DOCUMENT TITLE|DOCUMENT CODE|REVISION NUMBER|EFFECTIVITY DATE|DATE OF LAST REVIEW|PREPARED FOR|PREPARED BY|REVIEWED BY|APPROVED BY|PURPOSE|SCOPE|POLICY STATEMENT|DEFINITIONS|PERFORMANCE INCENTIVE CRITERIA|PERFORMANCE METRICS|ELIGIBILITY CRITERIA|KPI METRIC MATRIX|CORRECTIVE ACTION|GOVERNANCE|GENERAL PROVISIONS|ACKNOWLEDGEMENT):/i.test(trimmed)) {
    return true;
  }

  // ALL CAPS short line
  if (trimmed.length > 4 && trimmed.length < 60 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Detect if a line looks like a formula or KPI metric condition.
 */
function isFormulaLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /(=|>=|<=|\bSLA\b|\bAHT\b|\bERR\b|\bQA Score\b|\bPoints\b|\bWeight\b|\bMultiplier\b|\bTarget\b|\bThreshold\b|\bBonus\b|\bPenalty\b)/i.test(trimmed) &&
    /\d+%?|\bScore\b|\bRate\b|\bHours\b|\bMinutes\b/i.test(trimmed)
  );
}

/**
 * Detect table lines (tab separated, vertical bars, or column aligned metrics).
 */
function isTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.includes("\t") || (trimmed.match(/\|/g) || []).length >= 2) return true;
  // Multiple spaces between word-number patterns e.g. "Cases Closed    45%    >= 90%"
  if (/\b[A-Za-z\s-]{3,30}\s{3,}\d+%?\s{3,}/.test(trimmed)) return true;
  return false;
}

/**
 * Core PDF Extraction Engine
 */
export async function extractPdfPolicy(buffer, { fileName = "document.pdf", documentCode = "", revision = "000" } = {}) {
  validatePdfBuffer(buffer);

  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const pages = [];
  const warnings = [];

  const pagerender = async (pageData) => {
    const textContent = await pageData.getTextContent({ normalizeWhitespace: false });
    let lastY = null;
    let text = "";

    for (const item of textContent.items) {
      if (lastY === null || Math.abs(lastY - item.transform[5]) < 2) {
        text += item.str;
      } else {
        text += "\n" + item.str;
      }
      lastY = item.transform[5];
    }

    const cleanText = text.replace(/\r\n/g, "\n").trim();
    const pageNum = pageData.pageIndex + 1;

    // Check page quality and warnings
    const pageWarnings = [];
    if (cleanText.length < 20) {
      pageWarnings.push(`Page ${pageNum} has little to no readable text; it may contain scanned images or raster graphics.`);
    }

    const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
    const hasFormulas = lines.some(isFormulaLine);
    const hasTables = lines.some(isTableLine);

    const words = cleanText.split(/\s+/).filter(Boolean);

    pages.push({
      pageNumber: pageNum,
      text: cleanText,
      charCount: cleanText.length,
      wordCount: words.length,
      hasTables: hasTables ? 1 : 0,
      hasFormulas: hasFormulas ? 1 : 0,
      hasWarnings: pageWarnings.length > 0 ? 1 : 0,
      warnings: pageWarnings,
    });

    if (pageWarnings.length > 0) {
      warnings.push(...pageWarnings);
    }

    return text;
  };

  const parsed = await pdfParse(buffer, { pagerender });

  // Logical Section Chunking
  const sections = [];
  let currentSection = {
    index: 0,
    heading: "Document Header & Overview",
    sectionType: "metadata",
    startPage: 1,
    endPage: 1,
    lines: [],
  };

  pages.forEach((page) => {
    const lines = page.text.split("\n").map((l) => l.trim()).filter(Boolean);

    lines.forEach((line) => {
      if (isHeadingLine(line) && currentSection.lines.length >= 3) {
        // Finalize previous section
        sections.push({
          index: currentSection.index,
          heading: currentSection.heading,
          sectionType: currentSection.sectionType,
          startPage: currentSection.startPage,
          endPage: currentSection.endPage,
          content: currentSection.lines.join("\n"),
          structuredData: null,
          tokenEstimate: Math.round(currentSection.lines.join("\n").length / 4),
        });

        // Determine section type from heading
        let type = "policy_rules";
        if (/kpi|metric|scorecard|target/i.test(line)) type = "kpi_definition";
        else if (/formula|calculation|weight/i.test(line)) type = "formula";
        else if (/table|matrix|schedule/i.test(line)) type = "table";
        else if (/procedure|step|corrective/i.test(line)) type = "procedure";

        currentSection = {
          index: sections.length,
          heading: line,
          sectionType: type,
          startPage: page.pageNumber,
          endPage: page.pageNumber,
          lines: [line],
        };
      } else {
        currentSection.lines.push(line);
        currentSection.endPage = page.pageNumber;
      }
    });
  });

  // Push final section
  if (currentSection.lines.length > 0) {
    sections.push({
      index: currentSection.index,
      heading: currentSection.heading,
      sectionType: currentSection.sectionType,
      startPage: currentSection.startPage,
      endPage: currentSection.endPage,
      content: currentSection.lines.join("\n"),
      structuredData: null,
      tokenEstimate: Math.round(currentSection.lines.join("\n").length / 4),
    });
  }

  // Determine overall status
  let status = "Ready";
  const emptyPages = pages.filter((p) => p.charCount < 20);
  if (emptyPages.length === pages.length) {
    status = "Failed";
    warnings.push("Document appears entirely scanned or image-based with 0 readable text.");
  } else if (emptyPages.length > 0 || warnings.length > 0) {
    status = "Partial";
  }

  const metadata = {
    pdfFormatVersion: parsed.info?.PDFFormatVersion || "1.4",
    producer: parsed.info?.Producer || "Unknown",
    totalPages: pages.length,
    totalWords: pages.reduce((acc, p) => acc + p.wordCount, 0),
    totalChars: pages.reduce((acc, p) => acc + p.charCount, 0),
    sectionsCount: sections.length,
    hasTables: pages.some((p) => p.hasTables),
    hasFormulas: pages.some((p) => p.hasFormulas),
    extractedAt: new Date().toISOString(),
  };

  return {
    checksum,
    totalPages: pages.length,
    status,
    warnings,
    metadata,
    pages,
    sections,
  };
}

/**
 * Process or Reprocess a policy document by ID.
 */
export async function processPolicyDocument(policyId, triggeredBy = "System") {
  const startTime = Date.now();

  // 1. Fetch document from frontsteps_policies_repository
  const [docRows] = await pmsDb.query(
    `SELECT id, document_code, policy_title, policy_category, revision_number, 
            file_name, file_size, file_checksum, file_content
     FROM ${pmsTables.frontstepsPoliciesRepository}
     WHERE id = ?`,
    [policyId],
  );

  if (!docRows || docRows.length === 0) {
    throw new Error(`Policy document #${policyId} not found in repository.`);
  }

  const doc = docRows[0];
  if (!doc.file_content) {
    throw new Error(`Policy document #${policyId} has no binary file content.`);
  }

  // 2. Insert initial job record
  const [jobResult] = await pmsDb.query(
    `INSERT INTO ${pmsTables.policyProcessingJobs} (
      policy_id, job_type, status, triggered_by
    ) VALUES (?, 'extract', 'Processing', ?)`,
    [policyId, triggeredBy],
  );
  const jobId = jobResult.insertId;

  try {
    // 3. Extract text, pages, sections
    const extraction = await extractPdfPolicy(doc.file_content, {
      fileName: doc.file_name,
      documentCode: doc.document_code,
      revision: doc.revision_number,
    });

    const durationMs = Date.now() - startTime;

    // 4. Upsert policy_processing_documents record
    const [existingProc] = await pmsDb.query(
      `SELECT id FROM ${pmsTables.policyProcessingDocuments} WHERE policy_id = ? AND revision_number = ?`,
      [policyId, doc.revision_number],
    );

    let processingId = null;
    if (existingProc.length > 0) {
      processingId = existingProc[0].id;
      await pmsDb.query(
        `UPDATE ${pmsTables.policyProcessingDocuments} SET
          file_name = ?,
          file_checksum = ?,
          file_size = ?,
          total_pages = ?,
          processing_status = ?,
          processing_warnings = ?,
          processing_error = NULL,
          extraction_metadata = ?,
          extracted_at = NOW(),
          updated_at = NOW()
        WHERE id = ?`,
        [
          doc.file_name,
          extraction.checksum,
          doc.file_size,
          extraction.totalPages,
          extraction.status,
          JSON.stringify(extraction.warnings),
          JSON.stringify(extraction.metadata),
          processingId,
        ],
      );

      // Clean existing pages & sections for clean atomic replacement
      await pmsDb.query(`DELETE FROM ${pmsTables.policyExtractedPages} WHERE processing_id = ?`, [processingId]);
      await pmsDb.query(`DELETE FROM ${pmsTables.policyExtractedSections} WHERE processing_id = ?`, [processingId]);
    } else {
      const [insertProc] = await pmsDb.query(
        `INSERT INTO ${pmsTables.policyProcessingDocuments} (
          policy_id, document_code, revision_number, file_name, file_checksum,
          file_size, total_pages, processing_status, processing_warnings,
          extraction_metadata, extracted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          policyId,
          doc.document_code,
          doc.revision_number,
          doc.file_name,
          extraction.checksum,
          doc.file_size,
          extraction.totalPages,
          extraction.status,
          JSON.stringify(extraction.warnings),
          JSON.stringify(extraction.metadata),
        ],
      );
      processingId = insertProc.insertId;
    }

    // 5. Insert Extracted Pages
    for (const page of extraction.pages) {
      await pmsDb.query(
        `INSERT INTO ${pmsTables.policyExtractedPages} (
          processing_id, policy_id, document_code, revision_number,
          page_number, page_text, char_count, word_count, has_tables,
          has_formulas, has_warnings, page_warnings
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          processingId,
          policyId,
          doc.document_code,
          doc.revision_number,
          page.pageNumber,
          page.text,
          page.charCount,
          page.wordCount,
          page.hasTables,
          page.hasFormulas,
          page.hasWarnings,
          JSON.stringify(page.warnings),
        ],
      );
    }

    // 6. Insert Extracted Sections
    for (const sec of extraction.sections) {
      await pmsDb.query(
        `INSERT INTO ${pmsTables.policyExtractedSections} (
          processing_id, policy_id, document_code, revision_number,
          section_index, heading, section_type, start_page, end_page,
          content, structured_data, token_estimate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          processingId,
          policyId,
          doc.document_code,
          doc.revision_number,
          sec.index,
          sec.heading,
          sec.sectionType,
          sec.startPage,
          sec.endPage,
          sec.content,
          sec.structuredData ? JSON.stringify(sec.structuredData) : null,
          sec.tokenEstimate,
        ],
      );
    }

    // 7. Update Job Status
    await pmsDb.query(
      `UPDATE ${pmsTables.policyProcessingJobs} SET
        processing_id = ?, status = ?, duration_ms = ?
       WHERE id = ?`,
      [processingId, extraction.status, durationMs, jobId],
    );

    return {
      success: true,
      policyId,
      processingId,
      documentCode: doc.document_code,
      status: extraction.status,
      totalPages: extraction.totalPages,
      sectionsCount: extraction.sections.length,
      warningsCount: extraction.warnings.length,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    await pmsDb.query(
      `UPDATE ${pmsTables.policyProcessingJobs} SET
        status = 'Failed', error_message = ?, duration_ms = ?
       WHERE id = ?`,
      [err.message, durationMs, jobId],
    );
    throw err;
  }
}

/**
 * Get Policy Processing Overview Statistics (Cards)
 */
export async function getPolicyProcessingOverview() {
  // Query total documents from repository
  const [totalRows] = await pmsDb.query(
    `SELECT COUNT(*) as total FROM ${pmsTables.frontstepsPoliciesRepository}`,
  );
  const total = Number(totalRows[0]?.total || 0);

  // Query processing counts
  const [statusRows] = await pmsDb.query(
    `SELECT 
      SUM(CASE WHEN processing_status = 'Ready' THEN 1 ELSE 0 END) as ready_count,
      SUM(CASE WHEN processing_status = 'Partial' THEN 1 ELSE 0 END) as partial_count,
      SUM(CASE WHEN processing_status = 'Failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN processing_status IN ('Pending', 'Processing') THEN 1 ELSE 0 END) as in_progress_count
     FROM ${pmsTables.policyProcessingDocuments}`,
  );

  const ready = Number(statusRows[0]?.ready_count || 0);
  const partial = Number(statusRows[0]?.partial_count || 0);
  const failed = Number(statusRows[0]?.failed_count || 0);
  const inProgress = Number(statusRows[0]?.in_progress_count || 0);

  // Any document in repository without a completed processing record is Pending
  const pending = Math.max(0, total - (ready + partial + failed));

  return {
    totalDocuments: total,
    successfullyProcessed: ready,
    pendingOrProcessing: pending + inProgress,
    failedOrRequiresAttention: failed + partial,
  };
}

/**
 * List Policy Documents with Processing Metadata & Filtering
 */
export async function listPolicyProcessingDocuments({
  search = "",
  category = "all",
  status = "all",
  page = 1,
  limit = 10,
} = {}) {
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
  const safeLimit = Math.max(1, parseInt(limit, 10));

  let whereClauses = ["1=1"];
  const params = [];

  if (category && category !== "all") {
    whereClauses.push("p.policy_category = ?");
    params.push(category);
  }

  if (status && status !== "all") {
    if (status === "Pending") {
      whereClauses.push("(pp.processing_status = 'Pending' OR pp.processing_status IS NULL)");
    } else {
      whereClauses.push("pp.processing_status = ?");
      params.push(status);
    }
  }

  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    whereClauses.push(
      "(p.document_code LIKE ? OR p.policy_title LIKE ? OR p.policy_category LIKE ? OR p.file_name LIKE ?)",
    );
    params.push(term, term, term, term);
  }

  const whereSql = whereClauses.join(" AND ");

  // Count total matching
  const countSql = `
    SELECT COUNT(*) as total
    FROM ${pmsTables.frontstepsPoliciesRepository} p
    LEFT JOIN ${pmsTables.policyProcessingDocuments} pp 
      ON pp.policy_id = p.id AND pp.revision_number = p.revision_number
    WHERE ${whereSql}
  `;
  const [countRows] = await pmsDb.query(countSql, params);
  const total = Number(countRows[0]?.total || 0);

  // Fetch paginated rows
  const dataSql = `
    SELECT 
      p.id,
      p.document_code,
      p.policy_title,
      p.policy_category,
      p.revision_number,
      p.file_name,
      p.file_size,
      p.file_checksum,
      p.is_current_version,
      p.uploaded_by,
      p.created_at,
      p.updated_at,
      COALESCE(pp.id, NULL) AS processing_id,
      COALESCE(pp.total_pages, 0) AS total_pages,
      COALESCE(pp.processing_status, 'Pending') AS processing_status,
      pp.processing_warnings,
      pp.processing_error,
      pp.extraction_metadata,
      pp.extracted_at AS last_processed
    FROM ${pmsTables.frontstepsPoliciesRepository} p
    LEFT JOIN ${pmsTables.policyProcessingDocuments} pp 
      ON pp.policy_id = p.id AND pp.revision_number = p.revision_number
    WHERE ${whereSql}
    ORDER BY p.document_code ASC, p.revision_number DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pmsDb.query(dataSql, [...params, safeLimit, offset]);

  return {
    success: true,
    data: rows,
    pagination: {
      total,
      page: parseInt(page, 10),
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

/**
 * Get Full Policy Details for Modal (Metadata, Pages, Sections, History, Activity)
 */
export async function getPolicyProcessingDetail(policyId) {
  // 1. Policy Document Metadata
  const [docRows] = await pmsDb.query(
    `SELECT 
      id, document_code, policy_title, policy_category, revision_number,
      last_review_date, effectivity_date, effectivity_note, approval_status,
      prepared_for, prepared_by, reviewed_by, approved_by,
      file_name, file_extension, mime_type, file_size, file_checksum,
      is_current_version, remarks, uploaded_by, created_at, updated_at
     FROM ${pmsTables.frontstepsPoliciesRepository}
     WHERE id = ?`,
    [policyId],
  );

  if (!docRows.length) {
    throw new Error(`Policy document #${policyId} not found.`);
  }
  const document = docRows[0];

  // 2. Processing Document Record
  const [procRows] = await pmsDb.query(
    `SELECT id, total_pages, processing_status, processing_warnings,
            processing_error, extraction_metadata, extracted_at, created_at, updated_at
     FROM ${pmsTables.policyProcessingDocuments}
     WHERE policy_id = ? AND revision_number = ?`,
    [policyId, document.revision_number],
  );
  const processing = procRows[0] || {
    id: null,
    total_pages: 0,
    processing_status: "Pending",
    processing_warnings: [],
    processing_error: null,
    extraction_metadata: null,
    extracted_at: null,
  };

  // 3. Extracted Pages
  let pages = [];
  if (processing.id) {
    const [pageRows] = await pmsDb.query(
      `SELECT id, page_number, page_text, char_count, word_count,
              has_tables, has_formulas, has_warnings, page_warnings
       FROM ${pmsTables.policyExtractedPages}
       WHERE processing_id = ?
       ORDER BY page_number ASC`,
      [processing.id],
    );
    pages = pageRows;
  }

  // 4. Extracted Sections
  let sections = [];
  if (processing.id) {
    const [secRows] = await pmsDb.query(
      `SELECT id, section_index, heading, section_type, start_page, end_page,
              content, structured_data, token_estimate
       FROM ${pmsTables.policyExtractedSections}
       WHERE processing_id = ?
       ORDER BY section_index ASC`,
      [processing.id],
    );
    sections = secRows;
  }

  // 5. Version History (all revisions of this document_code)
  const [versions] = await pmsDb.query(
    `SELECT p.id, p.document_code, p.policy_title, p.revision_number,
            p.file_name, p.file_size, p.file_checksum, p.is_current_version,
            p.uploaded_by, p.created_at,
            COALESCE(pp.processing_status, 'Pending') AS processing_status,
            pp.extracted_at AS last_processed
     FROM ${pmsTables.frontstepsPoliciesRepository} p
     LEFT JOIN ${pmsTables.policyProcessingDocuments} pp
       ON pp.policy_id = p.id AND pp.revision_number = p.revision_number
     WHERE p.document_code = ?
     ORDER BY p.revision_number DESC, p.created_at DESC`,
    [document.document_code],
  );

  // 6. Processing Activity (Jobs log)
  const [jobs] = await pmsDb.query(
    `SELECT id, job_type, status, triggered_by, duration_ms, error_message, created_at
     FROM ${pmsTables.policyProcessingJobs}
     WHERE policy_id = ?
     ORDER BY created_at DESC
     LIMIT 15`,
    [policyId],
  );

  return {
    success: true,
    document,
    processing,
    pages,
    sections,
    versions,
    activity: jobs,
  };
}

/**
 * Step 7: Search Policy Content
 */
export async function searchPolicyContent({
  query = "",
  category = "all",
  documentCode = "",
  limit = 20,
} = {}) {
  let whereClauses = ["1=1"];
  const params = [];

  if (documentCode) {
    whereClauses.push("pes.document_code = ?");
    params.push(documentCode);
  }

  if (category && category !== "all") {
    whereClauses.push("p.policy_category = ?");
    params.push(category);
  }

  if (query && query.trim()) {
    const term = `%${query.trim()}%`;
    whereClauses.push("(pes.heading LIKE ? OR pes.content LIKE ?)");
    params.push(term, term);
  }

  const whereSql = whereClauses.join(" AND ");

  const sql = `
    SELECT 
      pes.id,
      pes.policy_id,
      pes.document_code,
      pes.revision_number,
      pes.section_index,
      pes.heading,
      pes.section_type,
      pes.start_page,
      pes.end_page,
      pes.content,
      pes.token_estimate,
      p.policy_title,
      p.policy_category,
      p.file_name
    FROM ${pmsTables.policyExtractedSections} pes
    INNER JOIN ${pmsTables.frontstepsPoliciesRepository} p ON p.id = pes.policy_id
    WHERE ${whereSql}
    ORDER BY pes.document_code ASC, pes.start_page ASC, pes.section_index ASC
    LIMIT ?
  `;

  const [rows] = await pmsDb.query(sql, [...params, Math.max(1, parseInt(limit, 10))]);

  return {
    success: true,
    count: rows.length,
    results: rows,
  };
}
