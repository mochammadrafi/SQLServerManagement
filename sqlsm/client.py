# -*- coding: utf-8 -*-
from __future__ import print_function

import binascii
import re
import sys
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

try:
    from dataclasses import dataclass
except ImportError:  # pragma: no cover
    dataclass = None  # type: ignore


PREFERRED_DRIVERS = (
    "ODBC Driver 17 for SQL Server",
    "ODBC Driver 13 for SQL Server",
    "ODBC Driver 11 for SQL Server",
    "SQL Server Native Client 11.0",
    "SQL Server Native Client 10.0",
    "SQL Server",
)

_GO_LINE = re.compile(r"^\s*GO\s*(?:--.*)?$", re.IGNORECASE)
_IDENT = re.compile(r"^[\w.\- ]+$", re.UNICODE)


class ClientError(Exception):
    def __init__(self, message, hint=None):
        # type: (str, Optional[str]) -> None
        super(ClientError, self).__init__(message)
        self.hint = hint


@dataclass
class ConnectionConfig(object):
    server: str = ""
    port: int = 1433
    instance: str = ""
    auth: str = "sql"
    username: str = ""
    password: str = ""
    database: str = "master"
    encrypt: bool = False
    login_timeout: int = 15
    query_timeout: int = 60

    def display_server(self):
        # type: () -> str
        return server_address(self)

    def public_dict(self):
        # type: () -> Dict[str, Any]
        return {
            "server": self.server,
            "port": self.port,
            "instance": self.instance,
            "auth": self.auth,
            "username": self.username if self.auth == "sql" else "",
            "database": self.database or "master",
            "encrypt": self.encrypt,
            "display_server": self.display_server(),
        }


def qident(name):
    # type: (str) -> str
    if name is None:
        raise ClientError("Nama objek kosong.")
    text = str(name).strip()
    if not text:
        raise ClientError("Nama objek kosong.")
    return "[" + text.replace("]", "]]") + "]"


def qname(*parts):
    # type: (*str) -> str
    return ".".join(qident(part) for part in parts if part)


def server_address(cfg):
    # type: (ConnectionConfig) -> str
    host = (cfg.server or "").strip()
    if not host:
        raise ClientError("Server wajib diisi.", "Contoh: localhost, 127.0.0.1, atau NAMA-SERVER")
    instance = (cfg.instance or "").strip()
    port = int(cfg.port or 1433)
    if instance and port != 1433:
        return "%s\\%s,%s" % (host, instance, port)
    if instance:
        return "%s\\%s" % (host, instance)
    if port != 1433:
        return "%s,%s" % (host, port)
    return host


def split_batches(sql):
    # type: (str) -> List[str]
    batches = []  # type: List[str]
    current = []  # type: List[str]
    for line in (sql or "").splitlines():
        if _GO_LINE.match(line):
            chunk = "\n".join(current).strip()
            if chunk:
                batches.append(chunk)
            current = []
        else:
            current.append(line)
    chunk = "\n".join(current).strip()
    if chunk:
        batches.append(chunk)
    return batches


def json_safe(value):
    # type: (Any) -> Any
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S.%f").rstrip("0").rstrip(".")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        preview = binascii.hexlify(raw[:64]).decode("ascii")
        suffix = "..." if len(raw) > 64 else ""
        return "0x" + preview + suffix
    if isinstance(value, int):
        if abs(value) > 9007199254740991:
            return str(value)
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, str):
        return value
    return str(value)


_WHERE_BAD = re.compile(
    r";|--|/\*|\bGO\b|\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|"
    r"EXEC|EXECUTE|GRANT|REVOKE|BACKUP|RESTORE|SHUTDOWN|XP_|SP_CONFIGURE)\b",
    re.I,
)


def validate_where(where):
    # type: (Optional[str]) -> str
    text = (where or "").strip()
    if not text:
        return ""
    if len(text) > 4000:
        raise ClientError("WHERE terlalu panjang.")
    if _WHERE_BAD.search(text):
        raise ClientError(
            "WHERE tidak valid.",
            "Hanya filter SELECT. Tidak boleh ada titik koma, komentar, atau perintah lain.",
        )
    return text


def csv_value(value):
    # type: (Any) -> Any
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S.%f").rstrip("0").rstrip(".")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "0x" + binascii.hexlify(bytes(value)).decode("ascii")
    return value


def keyset_clause(keys, values, placeholder, inclusive=False):
    # type: (List[str], List[Any], str, bool) -> Tuple[str, List[Any]]
    if not keys or len(keys) != len(values):
        raise ClientError("Kunci paging tidak lengkap.")
    parts = []  # type: List[str]
    params = []  # type: List[Any]
    last = len(keys) - 1
    for index in range(len(keys)):
        eqs = []  # type: List[str]
        for prev in range(index):
            eqs.append("%s = %s" % (qident(keys[prev]), placeholder))
            params.append(values[prev])
        op = ">=" if inclusive and index == last else ">"
        gt = "%s %s %s" % (qident(keys[index]), op, placeholder)
        params.append(values[index])
        if eqs:
            parts.append("(%s AND %s)" % (" AND ".join(eqs), gt))
        else:
            parts.append("(%s)" % gt)
    return "(" + " OR ".join(parts) + ")", params


def list_odbc_drivers():
    # type: () -> List[str]
    try:
        import pyodbc  # type: ignore
    except Exception:
        return []
    try:
        return list(pyodbc.drivers())
    except Exception:
        return []


def pick_odbc_driver(drivers=None):
    # type: (Optional[List[str]]) -> Optional[str]
    available = drivers if drivers is not None else list_odbc_drivers()
    for name in PREFERRED_DRIVERS:
        if name in available:
            return name
    for name in available:
        if "SQL Server" in name:
            return name
    return None


def explain_error(exc):
    # type: (BaseException) -> Tuple[str, Optional[str]]
    text = str(exc).strip() or exc.__class__.__name__
    lower = text.lower()
    hint = None
    if "login failed" in lower:
        hint = (
            "Cek username/password, atau ganti ke Windows Authentication. "
            "SQL Server harus Mixed Mode jika memakai login SQL (sa)."
        )
    elif "connection refused" in lower or "unavailable" in lower:
        hint = (
            "SQL Server tidak menerima koneksi. Pastikan layanan SQL Server jalan, "
            "TCP/IP enable, dan port 1433 (atau port instance) terbuka."
        )
    elif "named pipes" in lower or "error locat" in lower or "server does not exist" in lower:
        hint = (
            "Server tidak terjangkau. Pastikan SQL Server jalan, TCP 1433 terbuka, "
            "dan SQL Server Browser hidup jika memakai instance (contoh SQLEXPRESS)."
        )
    elif "hyt00" in lower or "query timeout" in lower or "timeout expired" in lower:
        hint = (
            "Query timeout, bukan gagal login. Server sibuk atau katalognya berat. "
            "Coba lagi; daftar database tetap bisa dibuka tanpa hitung ukuran file."
        )
    elif "login timeout" in lower or "connection timeout" in lower:
        hint = "Koneksi timeout. Cek firewall, IP, port, atau nama instance."
    elif "timeout" in lower or "timed out" in lower:
        hint = (
            "Timeout. Jika teksnya Query timeout expired, server lambat — bukan firewall. "
            "Jika Login timeout, cek IP, port, dan instance."
        )
    elif "ssl" in lower or "certificate" in lower or "encrypt" in lower:
        hint = "Matikan opsi Enkripsi untuk SQL Server 2012, atau pasang sertifikat TLS di server."
    elif "driver" in lower and "not found" in lower:
        hint = "Install ODBC Driver / SQL Server Native Client, atau pakai login SQL lewat pymssql."
    elif "adaptive server" in lower or "tds" in lower:
        hint = "Nama server/instance salah, atau protokol TDS ditolak. Coba isi port 1433 secara eksplisit."
    return text, hint


class SqlServerClient(object):
    def __init__(self, cfg):
        # type: (ConnectionConfig) -> None
        self.cfg = cfg
        self._conn = None
        self.backend = ""
        self.driver_name = ""

    def connect(self):
        # type: () -> None
        if self.cfg.auth == "windows":
            if sys.platform != "win32":
                raise ClientError(
                    "Windows Authentication hanya tersedia di Windows.",
                    "Dari macOS/Linux pakai SQL Server Authentication (user SQL).",
                )
            self._connect_pyodbc()
            return
        if sys.platform == "win32" and list_odbc_drivers():
            try:
                self._connect_pyodbc()
                return
            except ClientError:
                raise
            except Exception:
                self._connect_pymssql()
                return
        self._connect_pymssql()

    def close(self):
        # type: () -> None
        conn = self._conn
        self._conn = None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _connect_pyodbc(self):
        # type: () -> None
        try:
            import pyodbc  # type: ignore
        except Exception:
            raise ClientError(
                "Modul pyodbc tidak tersedia.",
                "Jalankan: pip install pyodbc",
            )
        driver = pick_odbc_driver()
        if not driver:
            raise ClientError(
                "Tidak ada ODBC driver SQL Server.",
                "Di Windows Server 2012 biasanya sudah ada 'SQL Server' atau "
                "'SQL Server Native Client 11.0'. Install Native Client jika kosong.",
            )
        parts = [
            "DRIVER={%s}" % driver,
            "SERVER=%s" % server_address(self.cfg),
            "DATABASE=%s" % (self.cfg.database or "master"),
            "Connection Timeout=%s" % int(self.cfg.login_timeout),
        ]
        if self.cfg.auth == "windows":
            parts.append("Trusted_Connection=yes")
        else:
            if not (self.cfg.username or "").strip():
                raise ClientError("Username SQL wajib diisi.")
            parts.append("UID=%s" % self.cfg.username.strip())
            parts.append("PWD=%s" % (self.cfg.password or ""))
        modern_driver = driver.startswith("ODBC Driver") or "Native Client" in driver
        if modern_driver:
            if self.cfg.encrypt:
                parts.append("Encrypt=yes")
                parts.append("TrustServerCertificate=yes")
            else:
                parts.append("Encrypt=no")
        conn_str = ";".join(parts) + ";"
        try:
            self._conn = pyodbc.connect(conn_str, autocommit=True)
        except Exception as exc:
            message, hint = explain_error(exc)
            raise ClientError(message, hint)
        timeout = int(getattr(self.cfg, "query_timeout", 300) or 0)
        self._conn.timeout = timeout
        self.backend = "pyodbc"
        self.driver_name = driver

    def placeholder(self):
        # type: () -> str
        return "%s" if self.backend == "pymssql" else "?"

    def _raw_sql(self, sql):
        # type: (str) -> str
        if self.backend == "pymssql":
            return sql.replace("%", "%%")
        return sql

    def _connect_pymssql(self):
        # type: () -> None
        try:
            import pymssql  # type: ignore
        except Exception:
            raise ClientError(
                "Modul pymssql tidak tersedia.",
                "Jalankan: pip install pymssql",
            )
        if not (self.cfg.username or "").strip():
            raise ClientError("Username SQL wajib diisi untuk koneksi tanpa ODBC.")
        host = (self.cfg.server or "").strip()
        instance = (self.cfg.instance or "").strip()
        server = ("%s\\%s" % (host, instance)) if instance else host
        kwargs = {
            "server": server,
            "port": int(self.cfg.port or 1433),
            "user": self.cfg.username.strip(),
            "password": self.cfg.password or "",
            "database": self.cfg.database or "master",
            "login_timeout": int(self.cfg.login_timeout),
            "timeout": int(getattr(self.cfg, "query_timeout", 300) or 0),
            "charset": "UTF-8",
        }
        try:
            self._conn = pymssql.connect(**kwargs)
            self._conn.autocommit(True)
        except TypeError:
            # Older pymssql builds may not accept charset/login_timeout together.
            kwargs.pop("charset", None)
            try:
                self._conn = pymssql.connect(**kwargs)
                self._conn.autocommit(True)
            except Exception as exc:
                message, hint = explain_error(exc)
                raise ClientError(message, hint)
        except Exception as exc:
            message, hint = explain_error(exc)
            raise ClientError(message, hint)
        self.backend = "pymssql"
        self.driver_name = "pymssql/FreeTDS"

    def _cursor(self):
        if self._conn is None:
            raise ClientError("Belum terhubung ke SQL Server.")
        return self._conn.cursor()

    def execute(self, sql, params=None, max_rows=1000, database=None):
        # type: (str, Optional[Any], int, Optional[str]) -> Dict[str, Any]
        sql = (sql or "").strip()
        if not sql:
            raise ClientError("SQL kosong.")
        if max_rows < 1:
            max_rows = 1
        if max_rows > 10000:
            max_rows = 10000
        cursor = self._cursor()
        try:
            if database:
                cursor.execute("USE " + qident(database))
            batches = split_batches(sql)
            result_sets = []  # type: List[Dict[str, Any]]
            messages = []  # type: List[str]
            for batch in batches:
                if params is not None and len(batches) == 1:
                    cursor.execute(batch, params)
                else:
                    cursor.execute(self._raw_sql(batch))
                while True:
                    if cursor.description:
                        columns = [item[0] for item in cursor.description]
                        rows = []  # type: List[List[Any]]
                        truncated = False
                        count = 0
                        while count < max_rows:
                            batch = cursor.fetchmany(min(500, max_rows - count))
                            if not batch:
                                break
                            for raw in batch:
                                rows.append([json_safe(value) for value in raw])
                                count += 1
                                if count >= max_rows:
                                    extra = cursor.fetchmany(1)
                                    if extra:
                                        truncated = True
                                    break
                        result_sets.append(
                            {
                                "columns": columns,
                                "rows": rows,
                                "row_count": len(rows),
                                "truncated": truncated,
                            }
                        )
                    else:
                        affected = cursor.rowcount
                        if affected is not None and affected >= 0:
                            messages.append("Selesai. Baris terpengaruh: %s" % affected)
                    if not self._nextset(cursor):
                        break
            if not result_sets and not messages:
                messages.append("Perintah selesai tanpa result set.")
            return {
                "result_sets": result_sets,
                "messages": messages,
                "database": database or self.cfg.database or "master",
            }
        except ClientError:
            raise
        except Exception as exc:
            message, hint = explain_error(exc)
            raise ClientError(message, hint)
        finally:
            try:
                cursor.close()
            except Exception:
                pass

    def _nextset(self, cursor):
        try:
            return bool(cursor.nextset())
        except Exception:
            return False

    def server_info(self):
        # type: () -> Dict[str, Any]
        sql = """
SELECT
    CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) AS machine_name,
    CAST(SERVERPROPERTY('ServerName') AS nvarchar(128)) AS server_name,
    CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version,
    CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS product_level,
    CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
    CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
    CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS collation,
    CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS int) AS windows_auth_only,
    @@VERSION AS version_string,
    SUSER_SNAME() AS login_name,
    DB_NAME() AS current_database
"""
        data = self.execute(sql, max_rows=1)
        row = self._first_row(data)
        return row

    def list_databases(self):
        # type: () -> List[Dict[str, Any]]
        sql = """
SELECT
    d.name,
    d.database_id,
    d.state_desc,
    d.compatibility_level,
    d.collation_name,
    d.recovery_model_desc
FROM sys.databases AS d
ORDER BY d.name
"""
        rows = self._as_dicts(self.execute(sql, max_rows=5000))
        sizes = {}  # type: Dict[Any, Any]
        try:
            size_sql = """
SELECT database_id, CAST(SUM(size) * 8.0 / 1024 AS decimal(18, 2)) AS size_mb
FROM sys.master_files
GROUP BY database_id
"""
            for item in self._as_dicts(self.execute(size_sql, max_rows=5000)):
                sizes[item.get("database_id")] = item.get("size_mb")
        except Exception:
            sizes = {}
        for row in rows:
            row["size_mb"] = sizes.get(row.get("database_id"))
        return rows

    def list_objects(self, database):
        # type: (str) -> Dict[str, Any]
        self._assert_db(database)
        schema_sql = """
SELECT
    s.name AS schema_name,
    CASE
        WHEN s.name IN (
            'sys', 'INFORMATION_SCHEMA', 'guest',
            'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
            'db_backupoperator', 'db_datareader', 'db_datawriter',
            'db_denydatareader', 'db_denydatawriter'
        ) THEN 1 ELSE 0
                    END AS is_system
FROM sys.schemas AS s
ORDER BY s.name
"""
        object_sql = """
SELECT
    SCHEMA_NAME(o.schema_id) AS schema_name,
    o.name AS object_name,
    CASE
        WHEN o.type = 'U' THEN 'table'
        WHEN o.type = 'V' THEN 'view'
        WHEN o.type = 'P' THEN 'procedure'
        ELSE 'function'
    END AS object_type,
    CAST(CASE WHEN o.is_ms_shipped = 1 THEN 1 ELSE 0 END AS int) AS is_system
FROM sys.objects AS o
WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF')
ORDER BY 1, 3, 2
"""
        schemas = self._as_dicts(self.execute(schema_sql, max_rows=5000, database=database))
        data = self.execute(object_sql, max_rows=50000, database=database)
        grouped = {"tables": [], "views": [], "procedures": [], "functions": []}
        key_map = {
            "table": "tables",
            "view": "views",
            "procedure": "procedures",
            "function": "functions",
        }
        counts = {}  # type: Dict[Tuple[str, str], Any]
        try:
            counts = self.table_row_counts(database)
        except Exception:
            counts = {}
        seen_schema = set()
        for item in self._as_dicts(data):
            bucket = key_map.get(item.get("object_type") or "")
            if not bucket:
                continue
            schema = item.get("schema_name")
            name = item.get("object_name")
            seen_schema.add(schema)
            grouped[bucket].append(
                {
                    "schema": schema,
                    "name": name,
                    "row_count": counts.get((schema, name)),
                    "is_system": bool(item.get("is_system")),
                }
            )
        schema_list = []
        for item in schemas:
            schema_list.append(
                {
                    "name": item.get("schema_name"),
                    "is_system": bool(item.get("is_system")),
                }
            )
        for name in sorted(seen_schema):
            if name and not any(entry.get("name") == name for entry in schema_list):
                schema_list.append({"name": name, "is_system": False})
        return {"schemas": schema_list, "objects": grouped}

    def table_row_counts(self, database):
        # type: (str) -> Dict[Tuple[str, str], int]
        self._assert_db(database)
        sql = """
SELECT
    s.name AS schema_name,
    o.name AS object_name,
    SUM(CAST(p.row_count AS bigint)) AS row_count
FROM sys.dm_db_partition_stats AS p
JOIN sys.objects AS o ON o.object_id = p.object_id
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE p.index_id IN (0, 1) AND o.type = 'U'
GROUP BY s.name, o.name
"""
        data = self.execute(sql, max_rows=10000, database=database)
        result = {}  # type: Dict[Tuple[str, str], int]
        for item in self._as_dicts(data):
            key = (item.get("schema_name"), item.get("object_name"))
            value = item.get("row_count")
            try:
                result[key] = int(value) if value is not None else 0
            except (TypeError, ValueError):
                result[key] = 0
        return result

    def list_columns(self, database, schema, table):
        # type: (str, str, str) -> List[Dict[str, Any]]
        self._assert_db(database)
        ph = self.placeholder()
        sql = """
SELECT
    c.ORDINAL_POSITION AS ordinal,
    c.COLUMN_NAME AS name,
    c.DATA_TYPE AS data_type,
    c.CHARACTER_MAXIMUM_LENGTH AS max_length,
    c.NUMERIC_PRECISION AS numeric_precision,
    c.NUMERIC_SCALE AS numeric_scale,
    c.IS_NULLABLE AS is_nullable,
    c.COLUMN_DEFAULT AS column_default
FROM INFORMATION_SCHEMA.COLUMNS AS c
WHERE c.TABLE_SCHEMA = {0} AND c.TABLE_NAME = {0}
ORDER BY c.ORDINAL_POSITION
""".format(ph)
        data = self.execute(sql, params=(schema, table), max_rows=2000, database=database)
        return self._as_dicts(data)

    def list_sessions(self):
        # type: () -> List[Dict[str, Any]]
        sql = """
SELECT
    s.session_id,
    s.login_name,
    s.host_name,
    s.program_name,
    s.status,
    DB_NAME(s.database_id) AS database_name,
    s.cpu_time,
    s.memory_usage,
    s.login_time
FROM sys.dm_exec_sessions AS s
WHERE s.is_user_process = 1
ORDER BY s.session_id
"""
        data = self.execute(sql, max_rows=2000)
        return self._as_dicts(data)

    def preview_table(self, database, schema, table, top=200):
        # type: (str, str, str, int) -> Dict[str, Any]
        page = self.page_table(database, schema, table, page_size=top)
        return {
            "result_sets": [
                {
                    "columns": page["columns"],
                    "rows": page["rows"],
                    "row_count": len(page["rows"]),
                    "truncated": page.get("has_more", False),
                }
            ],
            "messages": [],
            "database": database,
        }

    def table_stats(self, database, schema, table):
        # type: (str, str, str) -> Dict[str, Any]
        self._assert_db(database)
        keys = self.key_columns(database, schema, table)
        ph = self.placeholder()
        sql = """
SELECT SUM(CAST(p.row_count AS bigint)) AS row_count
FROM sys.dm_db_partition_stats AS p
JOIN sys.objects AS o ON o.object_id = p.object_id
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {0} AND o.name = {0} AND p.index_id IN (0, 1)
""".format(ph)
        row_count = None
        try:
            data = self.execute(sql, params=(schema, table), max_rows=1, database=database)
            first = self._as_dicts(data)
            if first and first[0].get("row_count") is not None:
                row_count = int(first[0]["row_count"])
        except Exception:
            row_count = None
        return {
            "database": database,
            "schema": schema,
            "name": table,
            "row_count": row_count,
            "keys": keys,
            "paging": "keyset" if keys else "offset",
        }

    def key_columns(self, database, schema, table):
        # type: (str, str, str) -> List[str]
        self._assert_db(database)
        ph = self.placeholder()
        sql = """
SELECT TOP 1
    i.index_id,
    i.is_primary_key,
    i.type AS index_type
FROM sys.indexes AS i
JOIN sys.objects AS o ON o.object_id = i.object_id
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {0} AND o.name = {0}
  AND i.is_hypothetical = 0
  AND (
        i.is_primary_key = 1
        OR i.type = 1
        OR EXISTS (
            SELECT 1 FROM sys.columns AS c
            WHERE c.object_id = i.object_id AND c.is_identity = 1
        )
      )
ORDER BY i.is_primary_key DESC, CASE WHEN i.type = 1 THEN 0 ELSE 1 END, i.index_id
""".format(ph)
        chosen = self.execute(sql, params=(schema, table), max_rows=1, database=database)
        rows = self._as_dicts(chosen)
        if rows:
            col_sql = """
SELECT c.name AS name, ic.key_ordinal
FROM sys.indexes AS i
JOIN sys.index_columns AS ic
    ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns AS c
    ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN sys.objects AS o ON o.object_id = i.object_id
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {0} AND o.name = {0} AND i.index_id = {0}
  AND ic.is_included_column = 0
ORDER BY ic.key_ordinal
""".format(ph)
            data = self.execute(
                col_sql,
                params=(schema, table, rows[0].get("index_id")),
                max_rows=32,
                database=database,
            )
            names = [item.get("name") for item in self._as_dicts(data) if item.get("name")]
            if names:
                return names
        ident_sql = """
SELECT c.name AS name
FROM sys.columns AS c
JOIN sys.objects AS o ON o.object_id = c.object_id
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {0} AND o.name = {0} AND c.is_identity = 1
""".format(ph)
        ident = self.execute(ident_sql, params=(schema, table), max_rows=1, database=database)
        ident_rows = self._as_dicts(ident)
        if ident_rows and ident_rows[0].get("name"):
            return [ident_rows[0]["name"]]
        return []

    def page_table(self, database, schema, table, page_size=200, after=None, seek=None, offset=0):
        # type: (str, str, str, int, Optional[Dict[str, Any]], Optional[Dict[str, Any]], int) -> Dict[str, Any]
        self._assert_db(database)
        page_size = int(page_size or 200)
        if page_size < 1:
            page_size = 1
        if page_size > 1000:
            page_size = 1000
        offset = int(offset or 0)
        if offset < 0:
            offset = 0
        keys = self.key_columns(database, schema, table)
        ph = self.placeholder()
        params = []  # type: List[Any]
        where_sql = ""
        paging = "keyset" if keys else "offset"
        if keys and (after or seek):
            source = after or seek
            values = [source.get(key) for key in keys]
            if any(value is None for value in values):
                raise ClientError(
                    "Nilai kunci paging tidak lengkap.",
                    "Isi semua kolom kunci: %s" % ", ".join(keys),
                )
            clause, clause_params = keyset_clause(keys, values, ph, inclusive=bool(seek) and not after)
            where_sql = " WHERE " + clause
            params.extend(clause_params)
            sql = "SELECT TOP %s * FROM %s%s ORDER BY %s" % (
                page_size,
                qname(schema, table),
                where_sql,
                ", ".join(qident(key) for key in keys),
            )
        elif keys:
            sql = "SELECT TOP %s * FROM %s ORDER BY %s" % (
                page_size,
                qname(schema, table),
                ", ".join(qident(key) for key in keys),
            )
        else:
            paging = "offset"
            if offset > 100000:
                raise ClientError(
                    "OFFSET terlalu dalam untuk tabel tanpa kunci.",
                    "Tambahkan primary key / identity, atau pakai Export. "
                    "OFFSET besar pada 100 juta baris akan sangat lambat.",
                )
            sql = "SELECT * FROM %s ORDER BY (SELECT NULL) OFFSET %s ROWS FETCH NEXT %s ROWS ONLY" % (
                qname(schema, table),
                offset,
                page_size,
            )
        data = self.execute(sql, params=params or None, max_rows=page_size, database=database)
        first = data["result_sets"][0] if data.get("result_sets") else {"columns": [], "rows": []}
        columns = first.get("columns") or []
        rows = first.get("rows") or []
        last_key = None
        if rows and keys:
            last_key = {}
            lower_map = {str(name).lower(): index for index, name in enumerate(columns)}
            for key in keys:
                index = lower_map.get(str(key).lower())
                last_key[key] = rows[-1][index] if index is not None else None
        return {
            "columns": columns,
            "rows": rows,
            "page_size": page_size,
            "keys": keys,
            "paging": paging,
            "last_key": last_key,
            "has_more": len(rows) >= page_size,
            "offset": offset,
            "sql": sql,
        }

    def iter_table_rows(self, database, schema, table, columns, where="", order_keys=None, nolock=True, batch_size=2000):
        self._assert_db(database)
        if not columns:
            raise ClientError("Pilih minimal satu kolom untuk export.")
        where_sql = validate_where(where)
        table_sql = qname(schema, table)
        if nolock:
            table_sql += " WITH (NOLOCK)"
        sql = "SELECT %s FROM %s" % (", ".join(qident(col) for col in columns), table_sql)
        if where_sql:
            sql += " WHERE (%s)" % where_sql
        if order_keys:
            sql += " ORDER BY " + ", ".join(qident(key) for key in order_keys)
        cursor = self._cursor()
        try:
            if database:
                cursor.execute("USE " + qident(database))
            cursor.execute(self._raw_sql(sql))
            if not cursor.description:
                return
            while True:
                raw_rows = cursor.fetchmany(int(batch_size))
                if not raw_rows:
                    break
                yield raw_rows
        except ClientError:
            raise
        except Exception as exc:
            message, hint = explain_error(exc)
            raise ClientError(message, hint)
        finally:
            try:
                cursor.close()
            except Exception:
                pass

    def select_script(self, schema, table, page_size=200, keys=None):
        # type: (str, str, int, Optional[List[str]]) -> str
        sql = "SELECT TOP %s *\nFROM %s" % (int(page_size), qname(schema, table))
        if keys:
            sql += "\nORDER BY " + ", ".join(qident(key) for key in keys)
        return sql + ";"

    def _assert_db(self, database):
        # type: (str) -> None
        name = (database or "").strip()
        if not name:
            raise ClientError("Database wajib dipilih.")
        if not _IDENT.match(name):
            raise ClientError("Nama database tidak valid.")

    def _as_dicts(self, data):
        # type: (Dict[str, Any]) -> List[Dict[str, Any]]
        if not data.get("result_sets"):
            return []
        first = data["result_sets"][0]
        columns = first["columns"]
        rows = []
        for row in first["rows"]:
            item = {}
            for index, column in enumerate(columns):
                item[column] = row[index] if index < len(row) else None
            rows.append(item)
        return rows

    def _first_row(self, data):
        # type: (Dict[str, Any]) -> Dict[str, Any]
        rows = self._as_dicts(data)
        if not rows:
            raise ClientError("SQL Server tidak mengembalikan informasi server.")
        return rows[0]


def connect_client(cfg):
    # type: (ConnectionConfig) -> SqlServerClient
    client = SqlServerClient(cfg)
    client.connect()
    return client
