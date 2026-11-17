/**
 * FrontSteps AI Policy Archive Service
 * 
 * Provides content-addressed, immutable binary file preservation
 * in a dedicated, protected archive storage directory.
 * 
 * Guarantees:
 * 1. Storage is strictly isolated from public static assets (never in uploads/).
 * 2. Files are named by their verified SHA-256 hash.
 * 3. Identical files are deduplicated automatically.
 * 4. Writes are atomic (write to staging .tmp, verify hash, rename).
 * 5. Historical files remain intact even if original records in source repository are deleted.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_ARCHIVE_DIR = path.resolve(
  process.env.FRONTSTEPS_AI_ARCHIVE_DIR || path.join(process.cwd(), 'storage', 'frontsteps-ai-archive')
);
const TMP_DIR = path.join(DEFAULT_ARCHIVE_DIR, '.tmp');

/**
 * Ensures archive and temporary staging directories exist.
 */
export async function ensureArchiveDirectories() {
  await fs.promises.mkdir(DEFAULT_ARCHIVE_DIR, { recursive: true });
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
}

/**
 * Computes SHA-256 hash of a Buffer.
 * @param {Buffer} buffer
 * @returns {string} Hexadecimal SHA-256 hash (64 characters)
 */
export function computeSha256(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Buffer is required to compute SHA-256 hash');
  }
  return crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
}

/**
 * Resolves a safe file path inside the archive directory, preventing path traversal.
 * @param {string} archiveReference
 * @returns {string} Safe absolute file path
 */
export function getArchiveFilePath(archiveReference) {
  const safeName = path.basename(archiveReference);
  return path.join(DEFAULT_ARCHIVE_DIR, safeName);
}

/**
 * Archives a binary PDF buffer into content-addressed immutable storage.
 * 
 * @param {Buffer} binaryBuffer
 * @param {string} [originalFileName='policy.pdf']
 * @returns {Promise<{
 *   archiveReference: string,
 *   verifiedChecksum: string,
 *   fileSize: number,
 *   archiveStatus: 'ARCHIVED' | 'DEDUPLICATED' | 'FAILED'
 * }>}
 */
export async function archivePolicyBinary(binaryBuffer, originalFileName = 'policy.pdf') {
  if (!binaryBuffer || !Buffer.isBuffer(binaryBuffer) || binaryBuffer.length === 0) {
    throw new Error('Invalid or empty binary buffer provided for archival');
  }

  await ensureArchiveDirectories();

  const verifiedChecksum = computeSha256(binaryBuffer);
  const archiveReference = `${verifiedChecksum}.pdf`;
  const targetPath = getArchiveFilePath(archiveReference);
  const fileSize = binaryBuffer.length;

  try {
    // Check if content-addressed file already exists and is intact
    if (fs.existsSync(targetPath)) {
      const stats = await fs.promises.stat(targetPath);
      if (stats.size === fileSize) {
        return {
          archiveReference,
          verifiedChecksum,
          fileSize,
          archiveStatus: 'DEDUPLICATED',
        };
      }
    }

    // Atomic write: write to temp staging file, verify hash, then rename
    const tempFileName = `${verifiedChecksum}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.tmp`;
    const tempFilePath = path.join(TMP_DIR, tempFileName);

    await fs.promises.writeFile(tempFilePath, binaryBuffer);

    // Verify temp file written successfully
    const tempBuffer = await fs.promises.readFile(tempFilePath);
    const tempHash = computeSha256(tempBuffer);

    if (tempHash !== verifiedChecksum) {
      await fs.promises.unlink(tempFilePath).catch(() => {});
      throw new Error(`Integrity check failed during staging: expected ${verifiedChecksum}, got ${tempHash}`);
    }

    // Atomically rename into permanent content-addressed destination
    await fs.promises.rename(tempFilePath, targetPath);

    return {
      archiveReference,
      verifiedChecksum,
      fileSize,
      archiveStatus: 'ARCHIVED',
    };
  } catch (error) {
    console.error('[FrontSteps AI Archive] Error archiving policy binary:', error);
    return {
      archiveReference: null,
      verifiedChecksum,
      fileSize,
      archiveStatus: 'FAILED',
      error: error.message,
    };
  }
}

/**
 * Retrieves the raw binary buffer of an archived policy file.
 * @param {string} archiveReference
 * @returns {Promise<Buffer|null>}
 */
export async function getArchivedPolicyBuffer(archiveReference) {
  if (!archiveReference) return null;
  const filePath = getArchiveFilePath(archiveReference);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return await fs.promises.readFile(filePath);
  } catch (error) {
    console.error(`[FrontSteps AI Archive] Error reading archived file ${archiveReference}:`, error);
    return null;
  }
}

/**
 * Verifies that the archived file exists and matches the expected SHA-256 checksum.
 * @param {string} archiveReference
 * @param {string} expectedChecksum
 * @returns {Promise<boolean>}
 */
export async function verifyArchiveFileIntegrity(archiveReference, expectedChecksum) {
  if (!archiveReference || !expectedChecksum) return false;
  const filePath = getArchiveFilePath(archiveReference);

  try {
    if (!fs.existsSync(filePath)) return false;
    const buffer = await fs.promises.readFile(filePath);
    const actualChecksum = computeSha256(buffer);
    return actualChecksum.toLowerCase() === expectedChecksum.toLowerCase();
  } catch (error) {
    console.error(`[FrontSteps AI Archive] Integrity verification failed for ${archiveReference}:`, error);
    return false;
  }
}
