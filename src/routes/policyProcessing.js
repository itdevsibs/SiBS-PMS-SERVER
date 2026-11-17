// Routes for AI Report Policy Processing (PDF Knowledge Extraction, Versioning, and Retrieval)
import express from "express";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { pmsDb, pmsTables } from "../config/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import {
  getPolicyProcessingOverview,
  listPolicyProcessingDocuments,
  getPolicyProcessingDetail,
  processPolicyDocument,
  searchPolicyContent,
} from "../services/policyProcessingService.js";

const router = express.Router();

// Memory storage for PDF uploads matching frontsteps policies repository pattern
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF documents (.pdf) are supported."));
    }
  },
});

// Protect all policy processing routes with authentication
router.use(authMiddleware);

/**
 * GET /api/policy-processing/overview
 * Returns KPI overview counts for policy processing dashboard cards
 */
router.get("/overview", async (req, res) => {
  try {
    const overview = await getPolicyProcessingOverview();
    return res.json({ success: true, data: overview });
  } catch (error) {
    console.error("Error fetching policy processing overview:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/policy-processing/documents
 * List policy documents with extraction status, pagination, and filters
 */
router.get("/documents", async (req, res) => {
  try {
    const { search, category, status, page, limit } = req.query;
    const result = await listPolicyProcessingDocuments({
      search,
      category,
      status,
      page,
      limit,
    });
    return res.json(result);
  } catch (error) {
    console.error("Error listing policy processing documents:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/policy-processing/documents/:id
 * Retrieve full document details, extracted text by page, sections, versions, and activity
 */
router.get("/documents/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const detail = await getPolicyProcessingDetail(id);
    return res.json(detail);
  } catch (error) {
    console.error(`Error fetching policy processing detail for #${req.params.id}:`, error);
    const status = error.message.includes("not found") ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/policy-processing/documents/:id/preview
 * Stream original approved PDF directly for inline browser rendering
 */
router.get("/documents/:id/preview", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pmsDb.query(
      `SELECT file_name, file_extension, mime_type, file_content 
       FROM ${pmsTables.frontstepsPoliciesRepository} 
       WHERE id = ?`,
      [id],
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Policy document not found." });
    }

    const doc = rows[0];
    if (!doc.file_content) {
      return res.status(404).json({ success: false, message: "No document binary content found." });
    }

    const mime = doc.mime_type || "application/pdf";
    const filename = doc.file_name || `policy_${id}.pdf`;

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);
    return res.send(doc.file_content);
  } catch (error) {
    console.error("Error previewing policy document:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/policy-processing/documents/:id/reprocess
 * Trigger re-extraction of an existing policy document (restricted to authorized roles)
 */
router.post(
  "/documents/:id/reprocess",
  requireRole([7, 6, 10, 5, 9, 11]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const userName =
        req.user?.name ||
        req.user?.username ||
        req.user?.gy_emp_fullname ||
        "Authorized Operator";

      const result = await processPolicyDocument(id, `Manual Reprocess by ${userName}`);
      return res.json({
        success: true,
        message: `Policy #${id} reprocessed successfully.`,
        data: result,
      });
    } catch (error) {
      console.error(`Error reprocessing policy #${req.params.id}:`, error);
      return res.status(500).json({ success: false, message: error.message });
    }
  },
);

/**
 * POST /api/policy-processing/documents/upload
 * Upload an approved policy document and immediately extract and index it
 */
router.post(
  "/documents/upload",
  requireRole([7, 6, 10, 5, 11]),
  upload.single("file"),
  async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, message: "No PDF file uploaded." });
      }

      const {
        document_code,
        policy_title,
        policy_category = "Operations Policy",
        revision_number,
        prepared_for = "Operations",
        remarks = "",
      } = req.body;

      if (!document_code || !policy_title) {
        return res.status(400).json({
          success: false,
          message: "Document Code and Policy Title are required.",
        });
      }

      // Check existing revisions to auto-increment if not provided
      let rev = revision_number;
      if (!rev) {
        const [existingRevs] = await pmsDb.query(
          `SELECT revision_number FROM ${pmsTables.frontstepsPoliciesRepository} WHERE document_code = ?`,
          [document_code.trim()],
        );
        const parsedNums = existingRevs
          .map((r) => parseInt(r.revision_number, 10))
          .filter((n) => !isNaN(n));
        const nextNum = parsedNums.length > 0 ? Math.max(...parsedNums) + 1 : 0;
        rev = String(nextNum).padStart(3, "0");
      }

      // Verify (document_code, revision_number) collision
      const [existing] = await pmsDb.query(
        `SELECT id FROM ${pmsTables.frontstepsPoliciesRepository} WHERE document_code = ? AND revision_number = ?`,
        [document_code.trim(), rev.trim()],
      );

      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          message: `Policy ${document_code} (Rev ${rev}) already exists. Please choose a different revision number.`,
        });
      }

      // Compute SHA-256 Checksum
      const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
      const ext = path.extname(file.originalname).replace(".", "").toLowerCase();
      const uploader =
        req.user?.name ||
        req.user?.username ||
        req.user?.gy_emp_fullname ||
        "Operations Leadership";

      // Mark older versions as not current
      await pmsDb.query(
        `UPDATE ${pmsTables.frontstepsPoliciesRepository} SET is_current_version = 0 WHERE document_code = ?`,
        [document_code.trim()],
      );

      // Insert new authoritative policy document record
      const [insertResult] = await pmsDb.query(
        `INSERT INTO ${pmsTables.frontstepsPoliciesRepository} (
          document_code, policy_title, policy_category, revision_number,
          effectivity_note, approval_status, prepared_for, file_name,
          file_extension, mime_type, file_size, file_content, file_checksum,
          is_current_version, remarks, uploaded_by
        ) VALUES (?, ?, ?, ?, 'Upon Approval', 'Approved', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          document_code.trim(),
          policy_title.trim(),
          policy_category.trim(),
          rev.trim(),
          prepared_for.trim(),
          file.originalname,
          ext,
          file.mimetype,
          file.size,
          file.buffer,
          hash,
          remarks || `Approved ${policy_title} policy document`,
          uploader,
        ],
      );

      const newPolicyId = insertResult.insertId;

      // Automatically trigger extraction and indexing
      const processingResult = await processPolicyDocument(
        newPolicyId,
        `Auto-Index on Upload by ${uploader}`,
      );

      return res.status(201).json({
        success: true,
        message: `Policy ${document_code} (Rev ${rev}) uploaded and processed successfully.`,
        policyId: newPolicyId,
        processing: processingResult,
      });
    } catch (error) {
      console.error("Error uploading policy for processing:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  },
);

/**
 * GET /api/policy-processing/search
 * Step 7: Search extracted policy sections and retrieve with full document context
 */
router.get("/search", async (req, res) => {
  try {
    const { query, category, documentCode, limit } = req.query;
    const results = await searchPolicyContent({
      query,
      category,
      documentCode,
      limit,
    });
    return res.json(results);
  } catch (error) {
    console.error("Error searching policy content:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
