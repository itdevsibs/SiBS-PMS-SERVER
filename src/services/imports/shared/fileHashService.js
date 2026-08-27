// Streams uploaded files into SHA-256 hashes without loading full workbooks.
import crypto from "crypto";
import fs from "fs";

export class FileHashError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "FileHashError";
    this.code = options.code || "FILE_HASH_ERROR";
    this.cause = options.cause;
  }
}

export function calculateFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath) {
      reject(
        new FileHashError("File path is required.", {
          code: "FILE_HASH_PATH_REQUIRED",
        }),
      );

      return;
    }

    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("error", (error) => {
      reject(
        new FileHashError("Unable to read file for hashing.", {
          code: "FILE_HASH_READ_ERROR",
          cause: error,
        }),
      );
    });

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });

    stream.on("end", () => {
      resolve(hash.digest("hex").toLowerCase());
    });
  });
}
