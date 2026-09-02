// Starts the PMS API server and mounts all backend routes.
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
import sampleRoutes from "./routes/sample.js";
import usVisaImportRoutes from "./routes/usVisa/usVisaImports.js";
import userRoutes from "./routes/users.js";
import wfmRoutes from "./routes/wfm.js";

const app = express();

const server = http.createServer(app);

/* ================================
   ALLOWED ORIGINS
================================ */

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
  ? process.env.ALLOWED_ORIGINS
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : defaultAllowedOrigins;

/* ================================
   CORS
================================ */

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.error(
        "Blocked by CORS:",
        origin
      );

      return callback(
        new Error(
          "Not allowed by CORS"
        )
      );
    },

    credentials: true,
  })
);

/* ================================
   BODY PARSERS
================================ */

app.use(
  express.json({
    limit: "50mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);

/* ================================
   COOKIE PARSER
================================ */

app.use(cookieParser());

/* ================================
   SOCKET.IO
================================ */

export const io = new Server(
  server,
  {
    cors: {
      origin(origin, callback) {
        if (!origin) {
          return callback(
            null,
            true
          );
        }

        if (
          allowedOrigins.includes(
            origin
          )
        ) {
          return callback(
            null,
            true
          );
        }

        return callback(
          new Error(
            "Not allowed by CORS"
          )
        );
      },

      credentials: true,
    },
  }
);

io.on(
  "connection",
  (socket) => {
    console.log(
      "Socket connected:",
      socket.id
    );

    socket.on(
      "disconnect",
      () => {
        console.log(
          "Socket disconnected:",
          socket.id
        );
      }
    );
  }
);

/* ================================
   FILE UPLOADS
================================ */

const FILE_UPLOAD_ROOT =
  path.resolve(
    process.env.FILE_UPLOAD_ROOT ||
      path.join(
        process.cwd(),
        "uploads"
      )
  );

function ensureLocalDirectory(
  directoryPath,
  label
) {
  try {
    fs.mkdirSync(
      directoryPath,
      {
        recursive: true,
      }
    );

    return true;
  } catch (error) {
    console.error(
      `${label} initialization failed:`,
      {
        message:
          error.message,

        code:
          error.code,
      }
    );

    return false;
  }
}

ensureLocalDirectory(
  FILE_UPLOAD_ROOT,
  "Local upload directory"
);

app.use(
  "/uploads",
  express.static(
    FILE_UPLOAD_ROOT
  )
);

/* ================================
   API ROUTES
================================ */

/*
  Employee-related routes
*/
app.use(
  "/api/employees",
  employeeRoutes
);

/*
  PMS sample/application routes
*/
app.use(
  "/api/sample",
  sampleRoutes
);

/*
  MAIN AUTHENTICATION ROUTES

  Login:
  POST /api/users/login

  Authentication source:
  kronos_testdb

  Authorization source:
  hris_db.assigned_accounts
*/
app.use(
  "/api/users",
  userRoutes
);

/*
  WFM imported raw data metadata
*/
app.use(
  "/api/wfm",
  wfmRoutes
);

/*
  US VISA raw Excel import pipeline
*/
app.use(
  "/api/us-visa",
  usVisaImportRoutes
);

/* ================================
   ROOT
================================ */

app.get(
  "/",
  (req, res) => {
    return res.send(
      "PMS API Running"
    );
  }
);

/* ================================
   HEALTH CHECK
================================ */

app.get(
  "/api/health",
  (req, res) => {
    return res.json({
      success: true,

      message:
        "PMS API is running.",

      timestamp:
        new Date().toISOString(),
    });
  }
);

/* ================================
   404 HANDLER
================================ */

app.use(
  (req, res) => {
    return res
      .status(404)
      .json({
        success: false,

        message:
          `Route not found: ${req.method} ${req.originalUrl}`,
      });
  }
);

/* ================================
   GLOBAL ERROR HANDLER
================================ */

app.use(
  (err, req, res, _next) => {
    console.error(
      "GLOBAL SERVER ERROR:",
      err
    );

    return res
      .status(
        err.status || 500
      )
      .json({
        success: false,

        message:
          err.message ||
          "Internal server error",
      });
  }
);

/* ================================
   SERVER PORT
================================ */

const PORT =
  Number(
    process.env.PORT
  ) || 5003;

/* ================================
   START SERVER
================================ */

const startServer =
  async () => {
    try {
      /*
        db.js now checks:

        DB1 = Kronos
        DB2 = PMS
        DB3 = HRIS
      */
      await testDbConnections();

      server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
          console.error(
            `\n⚠️  Port ${PORT} is already in use by another running process.\nTo free it on Windows, run:\nStop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`
          );
        } else {
          console.error("Server error:", error.message);
        }
        process.exit(1);
      });

      server.listen(
        PORT,
        () => {
          console.log(
            `Server running on http://localhost:${PORT}`
          );
        }
      );

      const gracefulShutdown = () => {
        server.close(() => {
          process.exit(0);
        });
      };

      process.once("SIGUSR2", () => {
        server.close(() => {
          process.kill(process.pid, "SIGUSR2");
        });
      });
      process.on("SIGINT", gracefulShutdown);
      process.on("SIGTERM", gracefulShutdown);
    } catch (error) {
      console.error(
        "Failed to start server:",
        error.message
      );

      process.exit(1);
    }
  };

startServer();
