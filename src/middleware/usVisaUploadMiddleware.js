// Handles safe temporary upload storage for US VISA raw Excel workbooks.
import fs from "fs";
import path from "path";
import crypto from "crypto";

import multer from "multer";

const DEFAULT_MAX_FILE_SIZE_MB = 50;
const UPLOAD_FIELD_NAME = "file";

const tempUploadDirectory = path.resolve(
  process.env.US_VISA_IMPORT_TEMP_DIR ||
    path.join(process.cwd(), "uploads", "tmp", "us-visa-imports"),
);

function getMaxFileSizeBytes() {
  const configuredValue = Number(
    process.env.US_VISA_IMPORT_MAX_FILE_SIZE_MB,
  );
  const maxFileSizeMb =
    Number.isFinite(configuredValue) && configuredValue > 0
      ? configuredValue
      : DEFAULT_MAX_FILE_SIZE_MB;

  return Math.floor(maxFileSizeMb * 1024 * 1024);
}

function ensureTempUploadDirectory() {
  fs.mkdirSync(tempUploadDirectory, {
    recursive: true,
  });
}

function getFileExtension(fileName = "") {
  return path.extname(String(fileName || "")).toLowerCase();
}

function createUploadError(code, message, status = 400) {
  const error = new Error(message);

  error.status = status;
  error.code = code;

  return error;
}

function isXlsxFile(file = {}) {
  return getFileExtension(file.originalname) === ".xlsx";
}

ensureTempUploadDirectory();

const storage = multer.diskStorage({
  destination(_req, _file, callback) {
    try {
      ensureTempUploadDirectory();

      callback(null, tempUploadDirectory);
    } catch (error) {
      callback(error);
    }
  },

  filename(_req, file, callback) {
    const safeOriginalName = path
      .basename(String(file.originalname || "upload.xlsx"))
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniquePrefix = `${Date.now()}-${crypto.randomUUID()}`;

    callback(null, `${uniquePrefix}-${safeOriginalName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: getMaxFileSizeBytes(),
    files: 1,
  },
  fileFilter(_req, file, callback) {
    if (!isXlsxFile(file)) {
      return callback(
        createUploadError(
          "INVALID_FILE_TYPE",
          "Only .xlsx files are supported.",
        ),
      );
    }

    return callback(null, true);
  },
});

function normalizeUploadError(error) {
  if (!error) return null;

  if (error.code === "INVALID_FILE_TYPE") {
    return createUploadError(
      "INVALID_FILE_TYPE",
      error.message || "Only .xlsx files are supported.",
    );
  }

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return createUploadError(
        "FILE_TOO_LARGE",
        "Uploaded file exceeds the maximum allowed size.",
        413,
      );
    }

    if (error.code === "LIMIT_FILE_COUNT") {
      return createUploadError(
        "TOO_MANY_FILES",
        "Only one file can be uploaded.",
      );
    }

    if (error.code === "LIMIT_UNEXPECTED_FILE") {
      const code =
        error.field === UPLOAD_FIELD_NAME ? "TOO_MANY_FILES" : "UNEXPECTED_FILE";

      return createUploadError(
        code,
        code === "TOO_MANY_FILES"
          ? "Only one file can be uploaded."
          : "Unexpected file field.",
      );
    }

    return createUploadError(
      "UPLOAD_ERROR",
      error.message || "File upload failed.",
    );
  }

  return createUploadError(
    "UPLOAD_ERROR",
    error.message || "File upload failed.",
    error.status || 500,
  );
}

function sendUploadError(res, error) {
  return res.status(error.status || 400).json({
    success: false,
    message: error.message,
    code: error.code || "UPLOAD_ERROR",
  });
}

export function usVisaUploadMiddleware(req, res, next) {
  upload.single(UPLOAD_FIELD_NAME)(req, res, (error) => {
    const uploadError = normalizeUploadError(error);

    if (uploadError) {
      return sendUploadError(res, uploadError);
    }

    if (!req.file) {
      return sendUploadError(
        res,
        createUploadError(
          "FILE_REQUIRED",
          "A .xlsx file is required.",
        ),
      );
    }

    return next();
  });
}

export {
  tempUploadDirectory as usVisaTempUploadDirectory,
  UPLOAD_FIELD_NAME as usVisaUploadFieldName,
};

export default usVisaUploadMiddleware;
