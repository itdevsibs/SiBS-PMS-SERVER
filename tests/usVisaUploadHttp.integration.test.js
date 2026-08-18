import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";

process.env.JWT_ADMIN_SECRET ||= "test-admin-secret";
process.env.JWT_SECRET ||= "test-employee-secret";
process.env.US_VISA_IMPORT_MAX_FILE_SIZE_MB = "0.001";

const [
  { default: authMiddleware },
  { requireRole },
  { usVisaUploadMiddleware },
] = await Promise.all([
  import("../src/middleware/authMiddleware.js"),
  import("../src/middleware/roleMiddleware.js"),
  import("../src/middleware/usVisaUploadMiddleware.js"),
]);

function createToken(adminAccess) {
  return jwt.sign(
    {
      id: 1,
      username: "tester",
      role: adminAccess === 9 ? "wfm" : "agent",
      tokenType: "admin",
      adminAccess,
    },
    process.env.JWT_ADMIN_SECRET,
    {
      expiresIn: "5m",
    },
  );
}

function createApp(handler) {
  const app = express();

  app.post(
    "/upload",
    authMiddleware,
    requireRole([9]),
    usVisaUploadMiddleware,
    handler,
  );

  return app;
}

async function createTempFile(extension, content) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "us-visa-upload-"));
  const filePath = path.join(dir, `sample${extension}`);

  await fsp.writeFile(filePath, content);

  return {
    dir,
    filePath,
  };
}

test("missing file returns FILE_REQUIRED", async () => {
  const app = createApp((_req, res) => res.json({ success: true }));
  const response = await request(app)
    .post("/upload")
    .set("Authorization", `Bearer ${createToken(9)}`)
    .field("importProfileId", "HERO_SKILL_STATISTICS_INBOUND")
    .expect(400);

  assert.equal(response.body.success, false);
  assert.equal(response.body.code, "FILE_REQUIRED");
});

test("wrong extension returns INVALID_FILE_TYPE", async () => {
  const { dir, filePath } = await createTempFile(".txt", "not xlsx");

  try {
    const app = createApp((_req, res) => res.json({ success: true }));
    const response = await request(app)
      .post("/upload")
      .set("Authorization", `Bearer ${createToken(9)}`)
      .attach("file", filePath)
      .expect(400);

    assert.equal(response.body.code, "INVALID_FILE_TYPE");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("oversized file returns FILE_TOO_LARGE", async () => {
  const { dir, filePath } = await createTempFile(".xlsx", Buffer.alloc(4096));

  try {
    const app = createApp((_req, res) => res.json({ success: true }));
    const response = await request(app)
      .post("/upload")
      .set("Authorization", `Bearer ${createToken(9)}`)
      .attach("file", filePath)
      .expect(413);

    assert.equal(response.body.code, "FILE_TOO_LARGE");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("non-WFM user cannot upload", async () => {
  const app = createApp((_req, res) => res.json({ success: true }));
  const response = await request(app)
    .post("/upload")
    .set("Authorization", `Bearer ${createToken(1)}`)
    .field("importProfileId", "HERO_SKILL_STATISTICS_INBOUND")
    .expect(403);

  assert.equal(response.body.success, false);
});

test("temporary file cleanup after success", async () => {
  const { dir, filePath } = await createTempFile(".xlsx", "small");
  let uploadedPath = "";
  const app = createApp(async (req, res) => {
    uploadedPath = req.file.path;
    await fsp.rm(req.file.path, { force: true });
    res.json({ success: true });
  });

  try {
    await request(app)
      .post("/upload")
      .set("Authorization", `Bearer ${createToken(9)}`)
      .attach("file", filePath)
      .expect(200);

    assert.equal(fs.existsSync(uploadedPath), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("temporary file cleanup after failure", async () => {
  const { dir, filePath } = await createTempFile(".xlsx", "small");
  let uploadedPath = "";
  const app = createApp(async (req, res) => {
    uploadedPath = req.file.path;
    await fsp.rm(req.file.path, { force: true });
    res.status(500).json({ success: false });
  });

  try {
    await request(app)
      .post("/upload")
      .set("Authorization", `Bearer ${createToken(9)}`)
      .attach("file", filePath)
      .expect(500);

    assert.equal(fs.existsSync(uploadedPath), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
