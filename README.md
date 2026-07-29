# SiBS PMS Server

Node/Express backend scaffolded to match the SiBS HRIS server environment.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The server starts on `PORT`, defaulting to `5002`.

## Available Endpoints

- `GET /`
- `GET /api/health`
- `GET /api/sample`

No business routes have been added yet.

## Databases

The backend creates two MySQL pools:

- `DB1_*`: Kronos database connection
- `DB2_*`: PMS database connection

Both pools use the same connection defaults as HRIS:

- `waitForConnections: true`
- `connectionLimit: 10`
- `queueLimit: 0`
- `connectTimeout: 10000`
- `timezone: +08:00`

## Jenkins

Jenkins expects the deploy environment file here:

```text
/var/jenkins_home/env-files/sibs-pms-server.env
```

The pipeline copies it into the workspace for `docker compose`, then removes it after the build.
