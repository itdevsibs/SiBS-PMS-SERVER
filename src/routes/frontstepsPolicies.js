// Routes and controller for FrontSteps Policies Repository
import express from "express";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import { pmsDb, pmsTables } from "../config/db.js";

const router = express.Router();

// Memory storage to handle binary buffer directly for LONGBLOB insertion
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
      cb(new Error("Only PDF files are allowed for policy documents (.pdf)"));
    }
  },
});


/**
 * GET /api/frontsteps/policies
 * List all policy records (excluding large binary content for performance)
 */
router.get("/policies", async (req, res) => {
  try {
    const { category, status, search } = req.query;

    let query = `
      SELECT 
        id,
        document_code,
        policy_title,
        policy_category,
        revision_number,
        last_review_date,
        effectivity_date,
        effectivity_note,
        approval_status,
        prepared_for,
        prepared_by,
        reviewed_by,
        approved_by,
        file_name,
        file_extension,
        mime_type,
        file_size,
        file_checksum,
        is_current_version,
        remarks,
        uploaded_by,
        created_at,
        updated_at
      FROM ${pmsTables.frontstepsPoliciesRepository}
      WHERE 1=1
    `;
    const params = [];

    if (category && category !== "all") {
      query += " AND policy_category = ?";
      params.push(category);
    }

    if (status && status !== "all") {
      query += " AND approval_status = ?";
      params.push(status);
    }

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      query += " AND (document_code LIKE ? OR policy_title LIKE ? OR policy_category LIKE ?)";
      params.push(term, term, term);
    }

    query += " ORDER BY document_code ASC, revision_number DESC, created_at DESC";

    const [rows] = await pmsDb.query(query, params);
    return res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("Error fetching policies:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/frontsteps/policies/:id/download
 * Download the original document binary from LONGBLOB
 */
router.get("/policies/:id/download", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pmsDb.query(
      `SELECT file_name, file_extension, mime_type, file_content FROM ${pmsTables.frontstepsPoliciesRepository} WHERE id = ?`,
      [id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Policy document not found." });
    }

    const doc = rows[0];
    if (!doc.file_content) {
      return res.status(404).json({ success: false, message: "No document binary content found for this policy." });
    }

    const mime = doc.mime_type || (doc.file_extension?.toLowerCase() === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const filename = doc.file_name || `policy_${id}.${doc.file_extension || "pdf"}`;

    const isInline = req.query.inline === "true" || req.query.view === "true";
    const dispositionType = isInline ? "inline" : "attachment";

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `${dispositionType}; filename="${encodeURIComponent(filename)}"`);
    return res.send(doc.file_content);
  } catch (error) {
    console.error("Error downloading policy:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/frontsteps/policies/upload
 * Upload a new policy document or revision into frontsteps_policies_repository
 */
router.post("/policies/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: "No file was uploaded." });
    }

    const {
      document_code,
      policy_title,
      policy_category,
      revision_number = "000",
      last_review_date,
      effectivity_date,
      effectivity_note = "Upon Approval",
      approval_status = "Pending Approval",
      prepared_for = "FrontSteps",
      prepared_by,
      reviewed_by,
      approved_by,
      remarks,
      uploaded_by = "System User",
    } = req.body;

    if (!document_code || !policy_title || !policy_category) {
      return res.status(400).json({
        success: false,
        message: "document_code, policy_title, and policy_category are required.",
      });
    }

    // Check if (document_code, revision_number) already exists
    const [existing] = await pmsDb.query(
      `SELECT id FROM ${pmsTables.frontstepsPoliciesRepository} WHERE document_code = ? AND revision_number = ?`,
      [document_code.trim(), revision_number.trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: `Policy ${document_code} revision ${revision_number} already exists. Increment revision number to create a new revision.`,
      });
    }

    // Calculate SHA-256 Checksum
    const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const ext = path.extname(file.originalname).replace(".", "").toLowerCase();

    // Mark previous revisions of the same document_code as not current
    await pmsDb.query(
      `UPDATE ${pmsTables.frontstepsPoliciesRepository} SET is_current_version = 0 WHERE document_code = ?`,
      [document_code.trim()]
    );

    // Insert new record with original buffer into file_content (LONGBLOB)
    const insertSql = `
      INSERT INTO ${pmsTables.frontstepsPoliciesRepository} (
        document_code,
        policy_title,
        policy_category,
        revision_number,
        last_review_date,
        effectivity_date,
        effectivity_note,
        approval_status,
        prepared_for,
        prepared_by,
        reviewed_by,
        approved_by,
        file_name,
        file_extension,
        mime_type,
        file_size,
        file_content,
        file_checksum,
        is_current_version,
        remarks,
        uploaded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `;

    const values = [
      document_code.trim(),
      policy_title.trim(),
      policy_category.trim(),
      revision_number.trim(),
      last_review_date || null,
      effectivity_date || null,
      effectivity_note || "Upon Approval",
      approval_status || "Pending Approval",
      prepared_for || "FrontSteps",
      prepared_by || null,
      reviewed_by || null,
      approved_by || null,
      file.originalname,
      ext,
      file.mimetype,
      file.size,
      file.buffer,
      hash,
      remarks || null,
      uploaded_by || null,
    ];

    const [result] = await pmsDb.query(insertSql, values);

    return res.status(201).json({
      success: true,
      message: `Policy ${document_code} (Rev ${revision_number}) uploaded successfully.`,
      id: result.insertId,
      checksum: hash,
    });
  } catch (error) {
    console.error("Error uploading policy:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/frontsteps/policies/:id/approve
 * Update policy approval status (e.g. "Approved" or "Active")
 */
router.patch("/policies/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const { approval_status = "Approved", approved_by } = req.body || {};

    const [result] = await pmsDb.query(
      `UPDATE ${pmsTables.frontstepsPoliciesRepository} 
       SET approval_status = ?, approved_by = ?, updated_at = NOW() 
       WHERE id = ?`,
      [approval_status, approved_by || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Policy not found." });
    }

    return res.json({
      success: true,
      message: `Policy #${id} has been marked as ${approval_status}.`,
    });
  } catch (error) {
    console.error("Error approving policy:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/frontsteps/policies/:id
 * Delete a policy record from repository
 */
router.delete("/policies/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Check which document code this policy had before deleting
    const [rows] = await pmsDb.query(
      `SELECT document_code FROM ${pmsTables.frontstepsPoliciesRepository} WHERE id = ?`,
      [id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Policy not found." });
    }

    const docCode = rows[0].document_code;

    // Delete record
    await pmsDb.query(
      `DELETE FROM ${pmsTables.frontstepsPoliciesRepository} WHERE id = ?`,
      [id]
    );

    // If another revision exists, promote the latest one to is_current_version = 1
    const [remaining] = await pmsDb.query(
      `SELECT id FROM ${pmsTables.frontstepsPoliciesRepository} 
       WHERE document_code = ? 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [docCode]
    );

    if (remaining.length > 0) {
      await pmsDb.query(
        `UPDATE ${pmsTables.frontstepsPoliciesRepository} SET is_current_version = 1 WHERE id = ?`,
        [remaining[0].id]
      );
    }

    return res.json({
      success: true,
      message: `Policy #${id} deleted successfully.`,
    });
  } catch (error) {
    console.error("Error deleting policy:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;

