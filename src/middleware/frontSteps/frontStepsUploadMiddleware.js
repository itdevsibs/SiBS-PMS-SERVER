import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';

// Match the existing US Visa import convention: uploaded source files land in
// a project-local temporary directory, are processed into MySQL, then are
// removed by the controller's finally block. The folder is only a temporary
// landing area; it is not permanent data storage.
const root = path.resolve(
  process.env.FRONTSTEPS_IMPORT_TMP_DIR ||
    path.join(process.cwd(), 'uploads', 'tmp', 'frontsteps-imports'),
);
fs.mkdirSync(root, { recursive: true });

// Clean up files left behind only if the process was interrupted before the
// request-level finally block could run. This mirrors the temporary nature of
// the US Visa upload directory while protecting against abandoned files.
const staleAfterMs = Number(process.env.FRONTSTEPS_IMPORT_TMP_RETENTION_HOURS || 24) * 60 * 60 * 1000;
fs.promises.readdir(root, { withFileTypes: true })
  .then(async (entries) => {
    const now = Date.now();
    await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const filename = path.join(root, entry.name);
      try {
        const stat = await fs.promises.stat(filename);
        if (now - stat.mtimeMs > staleAfterMs) await fs.promises.unlink(filename);
      } catch {}
    }));
  })
  .catch(() => {});

const maxFileSize = Number(process.env.FRONTSTEPS_IMPORT_MAX_MB || 25) * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      cb(null, root);
    },
    filename(_req, file, cb) {
      const name = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${crypto.randomUUID()}-${name}`);
    },
  }),
  limits: { fileSize: maxFileSize, files: 1 },
  fileFilter(_req, file, cb) {
    if (!['.csv', '.xlsx', '.xls'].includes(path.extname(file.originalname).toLowerCase())) {
      return cb(
        Object.assign(new Error('Upload a CSV, XLSX, or XLS file'), {
          status: 400,
          code: 'INVALID_FILE_TYPE',
        }),
      );
    }
    return cb(null, true);
  },
});

export function frontStepsUploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();

    // Multer normally cleans failed uploads itself, but remove any path that was
    // already assigned before a validation/limit error as an extra safeguard.
    if (req.file?.path) {
      fs.promises.unlink(req.file.path).catch(() => {});
    }

    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : error.status || 400).json({
      success: false,
      code: tooLarge ? 'FILE_TOO_LARGE' : error.code || 'UPLOAD_FAILED',
      message: tooLarge ? 'Upload exceeds FrontSteps file limit' : error.message,
    });
  });
}
