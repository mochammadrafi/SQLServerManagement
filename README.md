# SQL Server Management

Lightweight SQL Server admin tool for **Windows Server 2012 / SQL Server 2012+**.

It is a local Flask app (Python 3.8) that opens in the browser. Use it when full SSMS is too heavy, missing, or confusing.

## What it does

- Connect with Windows Authentication or SQL Server Authentication
- Browse databases, tables, views, procedures, and functions
- Open tables with **100 million+ rows** without loading them into memory
- Fast row counts from partition stats (not `COUNT(*)`)
- Keyset paging (PK / clustered / identity), virtualized result grid
- Async CSV/gzip export in chunks, with progress, pause/resume, cancel, and per-part download
- Database export with parallel workers (default 3, up to 32) and live per-table status
- Multiple export jobs can run at the same time (backups of the same database stay exclusive)
- Database backup to `.bak` (async job; restore wizard not included yet)
- Run SQL (F5 / Ctrl+Enter), including `GO` batches
- Show server version, edition, collation, and active sessions

The process listens on `127.0.0.1:5050` by default. Passwords stay in memory unless you enable **Remember password** on connect (stored encrypted in `~/.sqlsm/connections.json` using the local app secret).

## Why this stack

| Constraint | Choice |
|---|---|
| Windows Server 2012 (not R2) | Python **3.8.10** (last official installer for that OS) |
| Windows Server 2012 R2 | Python 3.8–3.10 |
| Browser on 2012 | Chrome 109 or Firefox ESR. Not Internet Explorer |
| SQL client | `pyodbc` + Native Client / ODBC on Windows; `pymssql` fallback |

Do not use current Node/Electron or .NET 6+ builds on Server 2012. They need a newer OS.

## Install on Windows Server 2012

1. Install [Python 3.8.10](https://www.python.org/downloads/release/python-3810/). Check **Add Python to PATH**.
2. Copy this folder to the server.
3. Double-click `start.bat`.

First run creates `.venv` and installs packages. Then it opens `http://127.0.0.1:5050`.

Manual install:

```bat
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-windows.txt
.venv\Scripts\python.exe run.py
```

If `pyodbc` / `pymssql` fail, install `requirements.txt` first, then retry the driver packages. SQL Authentication needs at least one of those drivers.

## Install on macOS (dev)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install pymssql
.venv/bin/python run.py
```

Windows Authentication is Windows-only. From macOS use a SQL login. `pymssql` needs a current wheel for your Python; the UI still starts without it.

## Connect

| Field | Typical value |
|---|---|
| Server | `localhost` if SQL Server is on the same machine |
| Port | `1433` |
| Instance | `SQLEXPRESS` only if you use a named instance |
| Windows Auth | Use when the current Windows login already has a SQL login/role |
| SQL Auth | `sa` or another SQL login. SQL Server must be in Mixed Mode |
| Database | `master` is fine for the first connection |
| TLS | Leave off for SQL Server 2012 unless you configured certificates |

### SQL Server 2012 must allow TCP

On the database server:

1. SQL Server Configuration Manager → **SQL Server Network Configuration** → **Protocols**
2. Enable **TCP/IP**
3. Restart the SQL Server service
4. For a named instance, start **SQL Server Browser**
5. Open TCP **1433** (or the instance port) in Windows Firewall if you connect remotely

Mixed Mode (for `sa`):

1. SSMS or this app once you are in with Windows Auth
2. Server properties → Security → **SQL Server and Windows Authentication mode**
3. Restart SQL Server
4. Enable the `sa` login if it is disabled

## Usage

1. Connect.
2. Click a database in Object Explorer.
3. Click a table. Only one page loads (default 200 rows), even if the table has 100 million rows.
4. Use **Berikutnya**, jump by key, or filter with WHERE. Filtered pages and exports skip `ORDER BY` so the first matching rows stream immediately on 100M+ tables. Do not `SELECT *` the whole table.
5. **Export tabel** writes CSV/gzip in the background (default 1 million rows per file). Download each part from **Export** in the header. Pause, resume, or cancel from that panel. You can start several exports at once. Database export can run several tables at once (default 3 workers, up to 32; the app lowers the count if connection slots are full). In Browse, sort tables by name, row count, or size.
6. Double-click a cell for the full value.

Excel cannot open 100 million rows (limit 1,048,576). Use CSV/gzip. A full export can be tens of GB and run for hours; filter with WHERE when you can. Ad-hoc `SELECT` without `TOP` is limited to 1000 rows on the server.

`DELETE` / `UPDATE` / `DROP` run as written. There is no undo.

Export files are written under the default data folder above (or `SQLSM_EXPORT_DIR`). Keep disk free. Export uses a separate SQL connection and `NOLOCK` by default so the browse UI stays usable.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SQLSM_HOST` | `127.0.0.1` | Bind address. Keep loopback on a server |
| `SQLSM_PORT` | `5050` | HTTP port |
| `SQLSM_SECRET` | random file in `~/.sqlsm/secret` | Flask session key and password encryption |
| `SQLSM_IDLE_SEC` | `7200` | Close idle SQL connections after N seconds |
| `SQLSM_ALLOW_REMOTE` | unset | Set to `1` to allow non-loopback bind without startup warning |
| `SQLSM_EXPORT_DIR` | `~/sqlsm-data` (macOS) / `C:\SQLSM-Data` (Windows) | Folder for CSV/gzip parts and backup files |
| `SQLSM_MAX_WORKERS` | `32` | Max worker threads per database export |
| `SQLSM_MAX_JOBS` | `24` | Max concurrent export/backup jobs per session |
| `SQLSM_MAX_TOTAL_WORKERS` | `64` | Max export connections across all running jobs |

## Layout

```
run.py                 entry point
start.bat              Windows launcher
sqlsm/app.py           HTTP routes
sqlsm/client.py        SQL Server access, keyset paging
sqlsm/export.py        async chunked CSV export
sqlsm/templates/       connect + workspace
sqlsm/static/          CSS / JS
```

## Limits (v0.1)

- Local tool, not a multi-user service
- Browse and ad-hoc query never materialize the full 100 million rows
- Ad-hoc SELECT is capped at 1000 rows; use table pager + export for full data
- Deep `OFFSET` on a heap (no PK/identity) is rejected past 100,000 rows
- Concurrent exports are allowed; worker count is clamped so SQL connections stay within limits. Two backups of the same database at once are blocked.
- Restore from `.bak` wizard not included yet; no job agent or security editor
- Do not expose the HTTP port to the network
