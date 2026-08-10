import "dotenv/config";

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";

import { testDbConnections } from "./config/db.js";
import employeeRoutes from "./routes/employees.js";
import loginRoutes from "./routes/login.js";
import sampleRoutes from "./routes/sample.js";
import userRoutes from "./routes/users.js";

const app = express();
const server = http.createServer(app);

const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  : defaultAllowedOrigins;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.error("Blocked by CORS:", origin);

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(
  express.json({
    limit: "50mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  }),
);

app.use(cookieParser());

export const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

const FILE_UPLOAD_ROOT = path.resolve(
  process.env.FILE_UPLOAD_ROOT || path.join(process.cwd(), "uploads"),
);

function ensureLocalDirectory(directoryPath, label) {
  try {
    fs.mkdirSync(directoryPath, {
      recursive: true,
    });

    return true;
  } catch (error) {
    console.error(`${label} initialization failed:`, {
      message: error.message,
      code: error.code,
    });

    return false;
  }
}

ensureLocalDirectory(FILE_UPLOAD_ROOT, "Local upload directory");

app.use("/uploads", express.static(FILE_UPLOAD_ROOT));

app.use("/api/employees", employeeRoutes);
app.use("/api/login", loginRoutes);
app.use("/api/sample", sampleRoutes);
app.use("/api/users", userRoutes);

app.get("/", (req, res) => {
  return res.send("PMS API Running");
});

app.get("/api/health", (req, res) => {
  return res.json({
    success: true,
    message: "PMS API is running.",
    timestamp: new Date().toISOString(),
  });
});

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, _next) => {
  console.error("GLOBAL SERVER ERROR:", err);

  return res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

const PORT = Number(process.env.PORT) || 5003;

const startServer = async () => {
  try {
    await testDbConnections();

    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();
