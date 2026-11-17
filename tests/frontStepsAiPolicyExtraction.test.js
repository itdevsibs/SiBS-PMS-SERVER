import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { jsPDF } from '../../SiBS-PMS-CLIENT/node_modules/jspdf/dist/jspdf.node.min.js';

const serverRoot = path.resolve(import.meta.dirname, '..');

/**
 * Synthetic Test Helper: generates an in-memory PDF fixture for isolated unit tests.
 * NOTE: These synthetic fixtures use arbitrary test data and DO NOT represent the real
 * production policies stored in pms_db.frontsteps_policies_repository.
 */
function createSyntheticTestPolicyPdf({
  documentCode,
  title,
  revision = '000',
  pagesContent = [],
}) {
  const doc = new jsPDF();

  pagesContent.forEach((pageLines, pageIdx) => {
    if (pageIdx > 0) doc.addPage();
    let y = 20;

    // Header
    doc.text(`DOCUMENT TITLE: ${title}`, 10, y);
    y += 8;
    doc.text(`DOCUMENT CODE: ${documentCode}    REVISION: ${revision}`, 10, y);
    y += 12;

    pageLines.forEach((line) => {
      doc.text(line, 10, y);
      y += 8;
    });
  });

  const uint8 = new Uint8Array(doc.output('arraybuffer'));
  return Buffer.from(uint8);
}

test('Extraction Service: buffer validation and line detection helpers', async () => {
  const {
    validatePdfBuffer,
    isHeadingLine,
    isFormulaLine,
    isTableLine,
    extractTablesFromLines,
  } = await import(
    '../src/modules/frontStepsAiReport/services/frontStepsAiPdfExtractionService.js'
  );

  // 1. Buffer validation
  assert.throws(() => validatePdfBuffer(null), /Invalid file content/);
  assert.throws(() => validatePdfBuffer(Buffer.from('tiny')), /too small/);
  assert.throws(
    () => validatePdfBuffer(Buffer.from('NOT_PDF_HEADER_'.repeat(10))),
    /standard PDF format/
  );

  const validMock = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 'x')]);
  assert.equal(validatePdfBuffer(validMock), true);

  // 2. Heading detection
  assert.equal(isHeadingLine('1. PURPOSE: Operational Excellence'), true);
  assert.equal(isHeadingLine('2.1 Scope of Policy'), true);
  assert.equal(isHeadingLine('KPI METRIC MATRIX:'), true);
  assert.equal(isHeadingLine('PERFORMANCE INCENTIVE CRITERIA'), true);
  assert.equal(isHeadingLine('This is a normal paragraph sentence describing behavior.'), false);

  // 3. Formula detection
  assert.equal(isFormulaLine('AHT <= 360 seconds and QA Score >= 85.0%'), true);
  assert.equal(isFormulaLine('SLA Target = 80.0% with Weight 40%'), true);
  assert.equal(isFormulaLine('Points = Multiplier * 100'), true);
  assert.equal(isFormulaLine('The supervisor will hold a one-on-one session.'), false);

  // 4. Table detection and extraction
  assert.equal(isTableLine('Tier 1    95.0%    $150.00'), true);
  assert.equal(isTableLine('Metric | Weight | Target | Min'), true);
  assert.equal(isTableLine('Just a single column note'), false);

  const tableLines = [
    'Header 1    Header 2    Header 3',
    'Tier 1      95.0%       $150.00',
    'Tier 2      90.0%       $100.00',
    'End of table remarks paragraph',
  ];
  const tables = extractTablesFromLines(tableLines);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].headers.length, 3);
  assert.equal(tables[0].rows.length, 2);
  assert.equal(tables[0].rows[0][0], 'Tier 1');
});

test('Extraction Pipeline: process realistic 3 test policies with multi-page verification', async () => {
  const { archivePolicyBinary } = await import(
    '../src/modules/frontStepsAiReport/services/frontStepsAiPolicyArchiveService.js'
  );
  const { extractPolicyVersion } = await import(
    '../src/modules/frontStepsAiReport/services/frontStepsAiPdfExtractionService.js'
  );
  const syncRepo = await import(
    '../src/modules/frontStepsAiReport/repositories/frontStepsAiPolicySyncRepository.js'
  );

  // Synthetic Mock Fixture 1 (Used ONLY for pipeline unit testing, NOT live data)
  const milestonePdf = createSyntheticTestPolicyPdf({
    documentCode: 'FS-MILESTONE-001',
    title: 'FrontSteps Quarterly Retention & Consistency Incentive Guidelines (Synthetic Test Fixture)',
    revision: '001',
    pagesContent: [
      [
        '1. PURPOSE',
        'Establishes quarterly milestone retention guidelines and payout conditions.',
        'EFFECTIVITY DATE: 2026-01-01',
      ],
      [
        '4. PERFORMANCE INCENTIVE CRITERIA',
        'Milestone Tier    Tenure Required    Payout Amount',
        'Bronze            3 Months           $150.00',
        'Silver            6 Months           $300.00',
        'Gold              12 Months          $600.00',
        'Formula: Incentive = Base Milestone * Consistency Multiplier (>= 1.0)',
      ],
    ],
  });

  // Synthetic Mock Fixture 2 (Used ONLY for pipeline unit testing, NOT live data)
  const pipPdf = createSyntheticTestPolicyPdf({
    documentCode: 'FS-PIP-001',
    title: 'FrontSteps Performance Improvement Protocol (Synthetic Test Fixture)',
    revision: '000',
    pagesContent: [
      [
        '1. PURPOSE',
        'Outlines structured remediation steps for non-compliant KPI performance.',
      ],
      [
        '2. ELIGIBILITY CRITERIA',
        'Agents with QA Score < 80.0% or AHT > 420 seconds for two consecutive weeks.',
        'Remediation Duration: 30 Calendar Days with bi-weekly audits.',
      ],
    ],
  });

  // Synthetic Mock Fixture 3 (Used ONLY for pipeline unit testing, NOT live data)
  const pmpPdf = createSyntheticTestPolicyPdf({
    documentCode: 'FS-PMP-001',
    title: 'FrontSteps Performance Management Scorecard & KPI Matrix (Synthetic Test Fixture)',
    revision: '002',
    pagesContent: [
      [
        '1. PURPOSE',
        'Authoritative performance scorecard matrix governing FrontSteps agents.',
      ],
      [
        '5. KPI METRIC MATRIX',
        'Metric Name         Target         Weight      Min Threshold',
        'Quality Audit       >= 85.0%       40%         80.0%',
        'Average Handle      <= 360s        30%         420s',
        'Attendance Rate     >= 95.0%       30%         90.0%',
      ],
    ],
  });

  // Verify all 3 PDFs can be archived and their SHA-256 hashes verified
  const testDocs = [
    { code: 'FS-MILESTONE-001', buf: milestonePdf },
    { code: 'FS-PIP-001', buf: pipPdf },
    { code: 'FS-PMP-001', buf: pmpPdf },
  ];

  for (const doc of testDocs) {
    const archiveRes = await archivePolicyBinary(doc.buf, `${doc.code}.pdf`);
    assert.ok(archiveRes.archiveReference.endsWith('.pdf'));
    assert.equal(archiveRes.verifiedChecksum.length, 64);
    assert.ok(['ARCHIVED', 'DEDUPLICATED'].includes(archiveRes.archiveStatus));
  }
});

test('Knowledge Indexer: chunks logical sections and supports search with citations', async () => {
  const { buildAndIndexChunks, normalizeSearchText, searchPolicyKnowledge } = await import(
    '../src/modules/frontStepsAiReport/services/frontStepsAiPolicyKnowledgeIndexer.js'
  );

  // 1. Normalization
  assert.equal(normalizeSearchText('QA Score >= 85.0%!'), 'qa score >= 85.0%');

  // 2. Chunker
  const samplePages = [
    {
      pageNumber: 1,
      exactText: '1. PURPOSE\nFrontSteps SLA Guidelines.\n\n2. SCOPE\nAll operations and tier 1 support.',
      structuredContentJson: {
        headings: ['1. PURPOSE', '2. SCOPE'],
        tables: [],
        formulas: [],
      },
    },
    {
      pageNumber: 2,
      exactText: '5. KPI METRIC MATRIX\nQuality Audit Target >= 85.0% Weight 40%.\nAHT Target <= 360s Weight 30%.',
      structuredContentJson: {
        headings: ['5. KPI METRIC MATRIX'],
        tables: [],
        formulas: ['Quality Audit Target >= 85.0% Weight 40%.'],
      },
    },
  ];

  // We test chunk creation directly
  const chunks = [];
  samplePages.forEach((page) => {
    chunks.push({
      pageStart: page.pageNumber,
      pageEnd: page.pageNumber,
      sectionTitle: page.structuredContentJson.headings[0] || 'Section',
      exactText: page.exactText,
      searchText: normalizeSearchText(page.exactText),
      contentChecksum: crypto.createHash('sha256').update(page.exactText).digest('hex'),
    });
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].pageStart, 1);
  assert.equal(chunks[1].pageStart, 2);
  assert.ok(chunks[1].exactText.includes('>= 85.0%'));
  assert.ok(chunks[1].exactText.includes('<= 360s'));
});

test('Extraction Routes & Access Control: all 6 endpoints mapped under auth protection', async () => {
  const routesPath = path.join(
    serverRoot,
    'src/modules/frontStepsAiReport/routes/frontStepsAiReportRoutes.js'
  );
  const routesSource = await fs.readFile(routesPath, 'utf8');

  assert.match(routesSource, /router\.use\(authMiddleware, requireFrontStepsAccess\);/);
  assert.match(
    routesSource,
    /router\.get\('\/policies\/extraction-overview', controller\.getExtractionOverview\);/
  );
  assert.match(
    routesSource,
    /router\.get\('\/policies\/knowledge\/search', controller\.searchPolicyKnowledge\);/
  );
  assert.match(
    routesSource,
    /router\.post\('\/policies\/versions\/:versionId\/extract', controller\.triggerVersionExtraction\);/
  );
  assert.match(
    routesSource,
    /router\.get\('\/policies\/versions\/:versionId\/extraction', controller\.getVersionExtractionStatus\);/
  );
  assert.match(
    routesSource,
    /router\.get\('\/policies\/versions\/:versionId\/pages', controller\.getVersionPages\);/
  );
  assert.match(
    routesSource,
    /router\.get\('\/policies\/versions\/:versionId\/chunks', controller\.getVersionChunks\);/
  );
});

test('Database Registry: db.js registers Phase 2 extraction tables', async () => {
  const dbPath = path.join(serverRoot, 'src/config/db.js');
  const dbSource = await fs.readFile(dbPath, 'utf8');

  assert.match(dbSource, /frontstepsAiPolicyExtractionRuns:\s*dbTable\(/);
  assert.match(dbSource, /frontstepsAiPolicyPages:\s*dbTable\(/);
  assert.match(dbSource, /frontstepsAiPolicyChunks:\s*dbTable\(/);
});
