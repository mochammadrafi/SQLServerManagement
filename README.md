# SQL Server Management

Local SQL Server admin console. Same job as before: connect, browse, query, export, backup.

The stack is **Node.js 18 only** — Fastify 4 API + Vite 5 / React 18 / Tailwind 3 UI in the same phosphor/navy chrome as OSINT. It is built for **Windows Server 2012 R2**, which cannot run Node 20+.

## What it does

- Connect with SQL Authentication (Windows Authentication on Windows via `msnodesqlv8` if installed)
- Browse databases, tables, views, procedures, and functions
- Open large tables one page at a time (keyset paging, no full-table load)
- Run SQL (`F5` / `Ctrl+Enter`), including `GO` batches
- Async CSV/gzip export with pause / resume / cancel
- Database export and `.bak` backup jobs
- Saved connection profiles in `~/.sqlsm/connections.json`

## Stack

| Layer | Choice |
|---|---|
| UI | Vite 5 + React 18 + Tailwind 3 + TanStack Table |
| API | Fastify 4 + TypeScript 5.4 |
| SQL | `mssql` 11 (Tedious). Optional `msnodesqlv8` on Windows for integrated auth |
| Runtime | Node.js **18.x** (18.0.0 through 18.20.x) |
| Session | HTTP cookie + CSRF header |

Default ports: API `127.0.0.1:8000`, UI dev `127.0.0.1:5173` (proxies `/api`).

## Install

Use **Node.js 18 x64**. Node 20+ dropped Windows Server 2012 R2.

- Recommended: [Node 18.20.8 MSI](https://nodejs.org/dist/v18.20.8/node-v18.20.8-x64.msi) (last 18 LTS)
- Minimum: [Node 18.0.0](https://nodejs.org/dist/v18.0.0/node-v18.0.0-x64.msi)

Browser on 2012 R2: Chrome 109 or Firefox ESR. Not Internet Explorer.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens on `http://127.0.0.1:8000`.

Production (API serves the built UI):

```bash
npm install
npm run build
npm start
```

Or double-click `start.bat` / run `start.sh`.

## Connect

| Field | Typical value |
|---|---|
| Server | `localhost` if SQL Server is on this machine |
| Port | `1433` |
| Instance | `SQLEXPRESS` only for a named instance |
| SQL Auth | `sa` or another SQL login. Server must be Mixed Mode |
| Windows Auth | Windows only |
| TLS | Leave off for SQL Server 2012 unless certificates are configured |

From macOS/Linux use a SQL login. Tedious talks TDS directly; no ODBC/Python driver is required.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SQLSM_HOST` | `127.0.0.1` | Bind address |
| `SQLSM_PORT` | `8000` | HTTP port |
| `SQLSM_SECRET` | file in `~/.sqlsm/secret` | Session + password encryption |
| `SQLSM_IDLE_SEC` | `7200` | Drop idle SQL sessions after N seconds |
| `SQLSM_ALLOW_REMOTE` | unset | Set `1` to bind a non-loopback host |
| `SQLSM_EXPORT_DIR` | `~/sqlsm-data` or `C:\SQLSM-Data` | Export / backup folder |

Passwords stay in memory unless **Remember password** is checked.

## Layout

```
server/src     Fastify API, SQL client, export jobs
web/src        React console
start.sh       local launcher
start.bat      Windows launcher
```

`DELETE` / `UPDATE` / `DROP` run as written. There is no undo. Do not expose the HTTP port to the network.
