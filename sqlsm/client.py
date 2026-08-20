# -*- coding: utf-8 -*-
from __future__ import print_function

import binascii
import re
import sys
import threading
import time
from datetime import date, datetime
from datetime import time as dt_time
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
    def __init__(self, message, hint=None, retryable=False):
        # type: (str, Optional[str], bool) -> None
        super(ClientError, self).__init__(message)
        self.hint = hint
        self.retryable = bool(retryable)


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
    query_timeout: int = 300

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
    if isinstance(value, dt_time):
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
    r"EXEC|EXECUTE|GRANT|REVOKE|BACKUP|RESTORE|SHUTDOWN|XP_|SP_CONFIGURE|"
    r"SELECT|UNION|OPENROWSET|OPENDATASOURCE|WAITFOR|OPENQUERY)\b",
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


_SELECT_HEAD = re.compile(r"^(\s*SELECT\s+)(DISTINCT\s+)?", re.IGNORECASE)
_HAS_TOP = re.compile(r"^\s*SELECT\s+(DISTINCT\s+)?TOP\b", re.IGNORECASE)
_HAS_OFFSET = re.compile(r"\bOFFSET\s+\d+\s+ROWS\b|\bFETCH\s+(FIRST|NEXT)\b", re.IGNORECASE)
_SELECT_INTO = re.compile(r"^\s*SELECT\b.+\bINTO\b", re.IGNORECASE | re.DOTALL)
_SET_OP = re.compile(r"\bUNION\b|\bEXCEPT\b|\bINTERSECT\b", re.IGNORECASE)
_HAS_HINT = re.compile(r"\bOPTION\s*\(|\bFOR\s+(XML|JSON)\b", re.IGNORECASE)


def limit_select_sql(sql, max_rows):
    # type: (str, int) -> str
    text = sql or ""
    stripped = text.lstrip()
    if not stripped or not re.match(r"SELECT\b", stripped, re.IGNORECASE):
        return sql
    if _HAS_OFFSET.search(text) or _SELECT_INTO.match(text) or _SET_OP.search(text):
        return sql
    if not _HAS_TOP.match(text):
        match = _SELECT_HEAD.match(text)
        if not match:
            return sql
        text = match.group(1) + (match.group(2) or "") + ("TOP %s " % int(max_rows)) + text[match.end():]
    if _HAS_HINT.search(text):
        return text
    trimmed = text.rstrip()
    if trimmed.endswith(";"):
        trimmed = trimmed[:-1].rstrip()
    return trimmed + " OPTION (FAST %s)" % int(max_rows)


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
    if isinstance(value, dt_time):
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


_TRANSIENT = (
    "busy with results",
    "another command",
    "communication link failure",
    "physical connection is not usable",
    "connection is not available",
    "connection reset",
    "broken pipe",
    "08s01",
    "08s02",
    "10054",
    "10053",
    "tcp provider",
    "server has gone away",
    "not connected",
    "connection is closed",
    "connection broken",
    "unable to reconnect",
)


def is_cancelled(exc):
    # type: (Any) -> bool
    text = str(exc or "").lower()
    return (
        "dibatalkan" in text
        or "cancelled" in text
        or "canceled" in text
        or "hy008" in text
        or "operation canceled" in text
    )


def is_transient(exc):
    # type: (Any) -> bool
    if is_cancelled(exc):
        return False
    if isinstance(exc, ClientError) and getattr(exc, "retryable", False):
        return True
    text = str(exc or "").lower()
    if "login failed" in text or "login timeout" in text:
        return False
    return any(token in text for token in _TRANSIENT)


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
    elif is_cancelled(exc):
        hint = "Perintah dihentikan. Server tidak lagi menjalankan query itu."
    elif is_transient(exc):
        hint = "Sesi terputus atau masih sibuk. Aplikasi menyambung ulang otomatis; coba lagi jika masih gagal."
    elif "driver" in lower and "not found" in lower:
        hint = "Install ODBC Driver / SQL Server Native Client, atau pakai login SQL lewat pymssql."
    elif "adaptive server" in lower or "tds" in lower:
        hint = "Nama server/instance salah, atau protokol TDS ditolak. Coba isi port 1433 secara eksplisit."
    return text, hint


class _LiveConn(object):
    def __init__(self, raw, backend, driver_name):
        self.raw = raw
        self.backend = backend
        self.driver_name = driver_name
        self.busy = False
        self.cursor = None
        self.spid = None
        self.cancel_event = threading.Event()


class SqlServerClient(object):
    _POOL_MAX = 2
    _CHECKOUT_SEC = 45

    def __init__(self, cfg):
        # type: (ConnectionConfig) -> None
        self.cfg = cfg
        self._lock = threading.RLock()
        self._cv = threading.Condition(self._lock)
        self._pool = []  # type: List[_LiveConn]
        self.backend = ""
        self.driver_name = ""

    def connect(self):
        # type: () -> None
        with self._lock:
            if any(item.raw is not None for item in self._pool):
                return
            live = self._open_live()
            self._pool.append(live)
            self.backend = live.backend
            self.driver_name = live.driver_name

    def close(self):
        # type: () -> None
        with self._lock:
            items = list(self._pool)
            self._pool = []
            self._cv.notify_all()
        for item in items:
            try:
                if item.raw is not None:
                    item.raw.close()
            except Exception:
                pass
            item.raw = None

    def is_open(self):
        with self._lock:
            return any(item.raw is not None for item in self._pool)

    def _open_live(self):
        # type: () -> _LiveConn
        if self.cfg.auth == "windows":
            if sys.platform != "win32":
                raise ClientError(
                    "Windows Authentication hanya tersedia di Windows.",
                    "Dari macOS/Linux pakai SQL Server Authentication (user SQL).",
                )
            return self._open_pyodbc()
        if sys.platform == "win32" and list_odbc_drivers():
            try:
                return self._open_pyodbc()
            except ClientError:
                raise
            except Exception:
                return self._open_pymssql()
        return self._open_pymssql()

    def _open_pyodbc(self):
        # type: () -> _LiveConn
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
            "APP=SQLSM",
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
            parts.append("MARS_Connection=yes")
            if self.cfg.encrypt:
                parts.append("Encrypt=yes")
                parts.append("TrustServerCertificate=yes")
            else:
                parts.append("Encrypt=no")
        conn_str = ";".join(parts) + ";"
        try:
            raw = pyodbc.connect(conn_str, autocommit=True)
        except Exception as exc:
            message, hint = explain_error(exc)
            raise ClientError(message, hint, retryable=is_transient(exc))
        timeout = int(getattr(self.cfg, "query_timeout", 300) or 0)
        raw.timeout = timeout
        return _LiveConn(raw, "pyodbc", driver)

    def placeholder(self):
        # type: () -> str
        return "%s" if self.backend == "pymssql" else "?"

    def _raw_sql(self, sql):
        # type: (str) -> str
        if self.backend == "pymssql":
            return sql.replace("%", "%%")
        return sql

    def _open_pymssql(self):
        # type: () -> _LiveConn
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
            "appname": "SQLSM",
        }
        try:
            raw = pymssql.connect(**kwargs)
            raw.autocommit(True)
        except TypeError:
            kwargs.pop("charset", None)
            kwargs.pop("appname", None)
            try:
                raw = pymssql.connect(**kwargs)
                raw.autocommit(True)
            except Exception as exc:
                message, hint = explain_error(exc)
                raise ClientError(message, hint, retryable=is_transient(exc))
        except Exception as exc:
            message, hint = explain_error(exc)
            raise ClientError(message, hint, retryable=is_transient(exc))
        return _LiveConn(raw, "pymssql", "pymssql/FreeTDS")

    def _checkout(self):
        # type: () -> _LiveConn
        deadline = time.time() + self._CHECKOUT_SEC
        with self._cv:
            while True:
                for item in self._pool:
                    if item.raw is not None and not item.busy:
                        item.busy = True
                        item.cancel_event = threading.Event()
                        item.cursor = None
                        item.spid = self._spid(item.raw) or item.spid
                        return item
                if len(self._pool) < self._POOL_MAX:
                    item = self._open_live()
                    item.busy = True
                    item.cancel_event = threading.Event()
                    item.cursor = None
                    item.spid = self._spid(item.raw)
                    self._pool.append(item)
                    self.backend = item.backend or self.backend
                    self.driver_name = item.driver_name or self.driver_name
                    return item
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise ClientError(
                        "Sesi SQL Server sedang dipakai perintah lain.",
                        "Tunggu query/export selesai, lalu coba lagi.",
                        retryable=True,
                    )
                self._cv.wait(min(1.0, remaining))

    def _checkin(self, item, discard=False):
        with self._cv:
            if discard or item.raw is None:
                try:
                    if item.raw is not None:
                        item.raw.close()
                except Exception:
                    pass
                item.raw = None
                if item in self._pool:
                    self._pool.remove(item)
            else:
                item.busy = False
            self._cv.notify()

    def _cursor(self, raw):
        if raw is None:
            raise ClientError("Belum terhubung ke SQL Server.")
        return raw.cursor()

    def _raise_sql(self, exc):
        if is_cancelled(exc):
            raise ClientError("Perintah dibatalkan.", "Server tidak lagi menjalankan query itu.")
        if isinstance(exc, ClientError):
            if not getattr(exc, "retryable", False) and is_transient(exc):
                exc.retryable = True
            raise exc
        message, hint = explain_error(exc)
        raise ClientError(message, hint, retryable=is_transient(exc))

    def _spid(self, raw):
        cursor = None
        try:
            cursor = raw.cursor()
            cursor.execute("SELECT @@SPID")
            row = cursor.fetchone()
            if not row:
                return None
            return int(row[0])
        except Exception:
            return None
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    pass

    def _throw_if_cancelled(self, item):
        if item is not None and item.cancel_event.is_set():
            raise ClientError("Perintah dibatalkan.", "Server tidak lagi menjalankan query itu.")

    def cancel_running(self):
        with self._lock:
            targets = [item for item in self._pool if item.busy]
        spids = []
        for item in targets:
            item.cancel_event.set()
            if item.cursor is not None:
                self._cancel_cursor(item.cursor)
            if item.spid:
                spids.append(item.spid)
        killed = self._kill_spids(spids)
        return {"cancelled": len(targets), "killed": killed}

    def _kill_spids(self, spids):
        unique = []
        for spid in spids:
            if spid not in unique:
                unique.append(spid)
        if not unique:
            return 0
        live = None
        killed = 0
        try:
            live = self._open_live()
            cursor = live.raw.cursor()
            try:
                for spid in unique:
                    try:
                        cursor.execute("KILL %d" % int(spid))
                        killed += 1
                    except Exception:
                        continue
            finally:
                try:
                    cursor.close()
                except Exception:
                    pass
        except Exception:
            pass
        finally:
            if live is not None and live.raw is not None:
                try:
                    live.raw.close()
                except Exception:
                    pass
        return killed

    def _cancel_cursor(self, cursor):
        try:
            cursor.cancel()
        except Exception:
            pass

    def _finish_cursor(self, cursor, cancel=False):
        if cancel:
            self._cancel_cursor(cursor)
            return
        try:
            while True:
                if getattr(cursor, "description", None):
                    while cursor.fetchmany(500):
                        pass
                if not self._nextset(cursor):
                    break
        except Exception:
            self._cancel_cursor(cursor)

    def _close_cursor(self, cursor, cancel=False):
        try:
            self._finish_cursor(cursor, cancel=cancel)
        except Exception:
            pass
        try:
            cursor.close()
        except Exception:
            pass

    def _use_database(self, cursor, database):
        if not database:
            return
        cursor.execute("USE " + qident(database))
        self._finish_cursor(cursor)

    def execute(self, sql, params=None, max_rows=1000, database=None):
        # type: (str, Optional[Any], int, Optional[str]) -> Dict[str, Any]
        sql = (sql or "").strip()
        if not sql:
            raise ClientError("SQL kosong.")
        if max_rows < 1:
            max_rows = 1
        if max_rows > 100000:
            max_rows = 100000
        last = None  # type: Optional[BaseException]
        for attempt in (0, 1):
            item = self._checkout()
            discard = False
            try:
                self._throw_if_cancelled(item)
                return self._execute_body(item, sql, params=params, max_rows=max_rows, database=database)
            except Exception as exc:
                last = exc
                if is_cancelled(exc) or item.cancel_event.is_set():
                    discard = True
                    self._raise_sql(ClientError("Perintah dibatalkan."))
                discard = is_transient(exc)
                if attempt == 0 and discard:
                    continue
                self._raise_sql(exc)
            finally:
                self._checkin(item, discard=discard)
        self._raise_sql(last or ClientError("Gagal menjalankan SQL."))

    def _execute_body(self, item, sql, params=None, max_rows=1000, database=None):
        if item.spid is None:
            item.spid = self._spid(item.raw)
        cursor = self._cursor(item.raw)
        item.cursor = cursor
        cancel_leftover = False
        try:
            self._throw_if_cancelled(item)
            self._use_database(cursor, database)
            self._throw_if_cancelled(item)
            batches = split_batches(sql)
            result_sets = []  # type: List[Dict[str, Any]]
            messages = []  # type: List[str]
            for batch in batches:
                self._throw_if_cancelled(item)
                to_run = batch if params is not None else limit_select_sql(batch, max_rows)
                if params is not None and len(batches) == 1:
                    cursor.execute(to_run, params)
                else:
                    cursor.execute(self._raw_sql(to_run))
                self._throw_if_cancelled(item)
                while True:
                    if cursor.description:
                        columns = [item[0] for item in cursor.description]
                        rows = []  # type: List[List[Any]]
                        truncated = False
                        count = 0
                        while count < max_rows:
                            self._throw_if_cancelled(item)
                            fetched = cursor.fetchmany(min(500, max_rows - count))
                            if not fetched:
                                break
                            for raw_row in fetched:
                                rows.append([json_safe(value) for value in raw_row])
                                count += 1
                                if count >= max_rows:
                                    extra = cursor.fetchmany(1)
                                    if extra:
                                        truncated = True
                                    break
                        if truncated:
                            cancel_leftover = True
                            self._cancel_cursor(cursor)
                        result_sets.append(
                            {
                                "columns": columns,
                                "rows": rows,
                                "row_count": len(rows),
                                "truncated": truncated,
                            }
                        )
                        if truncated:
                            break
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
            self._raise_sql(exc)
        finally:
            item.cursor = None
            self._close_cursor(cursor, cancel=cancel_leftover or item.cancel_event.is_set())

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
        sizes = self._database_sizes()
        for row in rows:
            key = self._as_int(row.get("database_id"))
            name = row.get("name")
            row["size_mb"] = sizes.get(key)
            if row["size_mb"] is None and name is not None:
                row["size_mb"] = sizes.get(str(name).lower())
        return rows

    def _database_sizes(self):
        # type: () -> Dict[Any, Any]
        sizes = {}  # type: Dict[Any, Any]
        try:
            size_sql = """
SELECT
    d.database_id,
    d.name,
    CAST(SUM(CAST(mf.size AS bigint)) * 8.0 / 1024 AS decimal(18, 2)) AS size_mb
FROM sys.databases AS d
LEFT JOIN sys.master_files AS mf ON mf.database_id = d.database_id
GROUP BY d.database_id, d.name
"""
            for item in self._as_dicts(self.execute(size_sql, max_rows=5000)):
                key = self._as_int(item.get("database_id"))
                mb = self._parse_size_mb(item.get("size_mb"))
                name = item.get("name")
                if mb is None:
                    continue
                if key is not None:
                    sizes[key] = mb
                if name is not None:
                    sizes[str(name).lower()] = mb
        except Exception:
            sizes = {}
        if sizes:
            return sizes
        try:
            for item in self._as_dicts(self.execute("EXEC sp_helpdb", max_rows=5000)):
                name = item.get("name")
                raw = item.get("db_size")
                if raw is None:
                    raw = item.get("size_mb")
                mb = self._parse_size_mb(raw)
                if name is not None and mb is not None:
                    sizes[str(name).lower()] = mb
        except Exception:
            pass
        return sizes

    def _parse_size_mb(self, raw):
        if raw is None or raw == "":
            return None
        text = str(raw).strip().replace(",", "")
        try:
            if text.lower().endswith("mb"):
                return float(text[:-2].strip())
            if text.lower().endswith("gb"):
                return float(text[:-2].strip()) * 1024
            if text.lower().endswith("kb"):
                return float(text[:-2].strip()) / 1024
            return float(text)
        except (TypeError, ValueError):
            return None

    def _as_int(self, value):
        try:
            if value is None or value == "":
                return None
            return int(value)
        except (TypeError, ValueError):
            try:
                return int(float(value))
            except (TypeError, ValueError):
                return None

    def list_objects(self, database, include_counts=False):
        # type: (str, bool) -> Dict[str, Any]
        self._assert_db(database)
        db = qident(database)
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
FROM {0}.sys.schemas AS s
ORDER BY s.name
""".format(db)
        object_sql = """
SELECT
    s.name AS schema_name,
    o.name AS object_name,
    CASE
        WHEN o.type = 'U' THEN 'table'
        WHEN o.type = 'V' THEN 'view'
        WHEN o.type = 'P' THEN 'procedure'
        ELSE 'function'
    END AS object_type,
    CAST(CASE WHEN o.is_ms_shipped = 1 THEN 1 ELSE 0 END AS int) AS is_system
FROM {0}.sys.objects AS o
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF')
ORDER BY 1, 3, 2
""".format(db)
        schemas = []
        try:
            schemas = self._as_dicts(self.execute(schema_sql, max_rows=5000))
        except Exception:
            schemas = []
        data = self.execute(object_sql, max_rows=50000)
        grouped = {"tables": [], "views": [], "procedures": [], "functions": []}
        key_map = {
            "table": "tables",
            "view": "views",
            "procedure": "procedures",
            "function": "functions",
        }
        metrics = {}  # type: Dict[Tuple[str, str], Dict[str, Any]]
        if include_counts:
            try:
                metrics = self.table_metrics(database)
            except Exception:
                metrics = {}
        seen_schema = set()
        for item in self._as_dicts(data):
            bucket = key_map.get(item.get("object_type") or "")
            if not bucket:
                continue
            schema = item.get("schema_name")
            name = item.get("object_name")
            seen_schema.add(schema)
            stat = metrics.get((str(schema), str(name))) if schema is not None and name is not None else None
            grouped[bucket].append(
                {
                    "schema": schema,
                    "name": name,
                    "row_count": (stat or {}).get("row_count"),
                    "size_kb": (stat or {}).get("size_kb"),
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
        metrics = self.table_metrics(database)
        result = {}  # type: Dict[Tuple[str, str], int]
        for key, item in metrics.items():
            value = item.get("row_count")
            result[key] = 0 if value is None else int(value)
        return result

    def table_metrics(self, database):
        # type: (str) -> Dict[Tuple[str, str], Dict[str, Any]]
        self._assert_db(database)
        db = qident(database)
        queries = [
            """
SELECT
    s.name AS schema_name,
    o.name AS object_name,
    SUM(CASE WHEN p.index_id IN (0, 1) AND a.type = 1 THEN CAST(p.rows AS bigint) ELSE 0 END) AS row_count,
    SUM(CAST(a.used_pages AS bigint)) * 8 AS size_kb
FROM {0}.sys.partitions AS p
JOIN {0}.sys.allocation_units AS a ON a.container_id = p.partition_id
JOIN {0}.sys.objects AS o ON o.object_id = p.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.type = N'U'
GROUP BY s.name, o.name
""".format(db),
            """
SELECT
    s.name AS schema_name,
    o.name AS object_name,
    SUM(CASE WHEN p.index_id IN (0, 1) THEN CAST(p.row_count AS bigint) ELSE 0 END) AS row_count,
    SUM(CAST(p.used_page_count AS bigint)) * 8 AS size_kb
FROM {0}.sys.dm_db_partition_stats AS p
JOIN {0}.sys.objects AS o ON o.object_id = p.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE o.type = N'U'
GROUP BY s.name, o.name
""".format(db),
            """
SELECT
    s.name AS schema_name,
    o.name AS object_name,
    SUM(CAST(p.rows AS bigint)) AS row_count,
    CAST(NULL AS bigint) AS size_kb
FROM {0}.sys.partitions AS p
JOIN {0}.sys.objects AS o ON o.object_id = p.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE p.index_id IN (0, 1) AND o.type = N'U'
GROUP BY s.name, o.name
""".format(db),
        ]
        last_error = None
        for sql in queries:
            try:
                data = self.execute(sql, max_rows=100000)
                result = {}  # type: Dict[Tuple[str, str], Dict[str, Any]]
                for item in self._as_dicts(data):
                    schema = item.get("schema_name")
                    name = item.get("object_name")
                    if schema is None or name is None:
                        continue
                    rows = self._as_int(item.get("row_count"))
                    size_kb = self._as_int(item.get("size_kb"))
                    result[(str(schema), str(name))] = {
                        "row_count": 0 if rows is None else rows,
                        "size_kb": size_kb,
                    }
                if result:
                    return result
            except Exception as exc:
                last_error = exc
                continue
        if last_error:
            raise last_error
        return {}

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
FROM {0}.INFORMATION_SCHEMA.COLUMNS AS c
WHERE c.TABLE_SCHEMA = {1} AND c.TABLE_NAME = {1}
ORDER BY c.ORDINAL_POSITION
""".format(qident(database), ph)
        data = self.execute(sql, params=(schema, table), max_rows=2000)
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
        db = qident(database)
        queries = [
            """
SELECT SUM(CAST(p.rows AS bigint)) AS row_count
FROM {0}.sys.partitions AS p
JOIN {0}.sys.objects AS o ON o.object_id = p.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {1} AND o.name = {1} AND p.index_id IN (0, 1)
""".format(db, ph),
            """
SELECT SUM(CAST(p.row_count AS bigint)) AS row_count
FROM {0}.sys.dm_db_partition_stats AS p
JOIN {0}.sys.objects AS o ON o.object_id = p.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {1} AND o.name = {1} AND p.index_id IN (0, 1)
""".format(db, ph),
        ]
        row_count = None
        for sql in queries:
            try:
                data = self.execute(sql, params=(schema, table), max_rows=1)
                first = self._as_dicts(data)
                if first and first[0].get("row_count") is not None:
                    row_count = self._as_int(first[0]["row_count"])
                    if row_count is not None:
                        break
            except Exception:
                continue
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
        db = qident(database)
        sql = """
SELECT TOP 1
    i.index_id,
    i.is_primary_key,
    i.type AS index_type
FROM {0}.sys.indexes AS i
JOIN {0}.sys.objects AS o ON o.object_id = i.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {1} AND o.name = {1}
  AND i.is_hypothetical = 0
  AND (
        i.is_primary_key = 1
        OR i.type = 1
        OR EXISTS (
            SELECT 1 FROM {0}.sys.columns AS c
            WHERE c.object_id = i.object_id AND c.is_identity = 1
        )
      )
ORDER BY i.is_primary_key DESC, CASE WHEN i.type = 1 THEN 0 ELSE 1 END, i.index_id
""".format(db, ph)
        chosen = self.execute(sql, params=(schema, table), max_rows=1)
        rows = self._as_dicts(chosen)
        if rows:
            col_sql = """
SELECT c.name AS name, ic.key_ordinal
FROM {0}.sys.indexes AS i
JOIN {0}.sys.index_columns AS ic
    ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN {0}.sys.columns AS c
    ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN {0}.sys.objects AS o ON o.object_id = i.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {1} AND o.name = {1} AND i.index_id = {1}
  AND ic.is_included_column = 0
ORDER BY ic.key_ordinal
""".format(db, ph)
            data = self.execute(
                col_sql,
                params=(schema, table, rows[0].get("index_id")),
                max_rows=32,
            )
            names = [item.get("name") for item in self._as_dicts(data) if item.get("name")]
            if names:
                return names
        ident_sql = """
SELECT c.name AS name
FROM {0}.sys.columns AS c
JOIN {0}.sys.objects AS o ON o.object_id = c.object_id
JOIN {0}.sys.schemas AS s ON s.schema_id = o.schema_id
WHERE s.name = {1} AND o.name = {1} AND c.is_identity = 1
""".format(db, ph)
        ident = self.execute(ident_sql, params=(schema, table), max_rows=1)
        ident_rows = self._as_dicts(ident)
        if ident_rows and ident_rows[0].get("name"):
            return [ident_rows[0]["name"]]
        return []

    def page_table(self, database, schema, table, page_size=200, after=None, seek=None, offset=0, where=""):
        # type: (str, str, str, int, Optional[Dict[str, Any]], Optional[Dict[str, Any]], int, str) -> Dict[str, Any]
        self._assert_db(database)
        page_size = int(page_size or 200)
        if page_size < 1:
            page_size = 1
        if page_size > 1000:
            page_size = 1000
        offset = int(offset or 0)
        if offset < 0:
            offset = 0
        user_where = validate_where(where)
        keys = self.key_columns(database, schema, table)
        ph = self.placeholder()
        params = []  # type: List[Any]
        table_sql = qname(database, schema, table) + " WITH (NOLOCK)"
        parts = []  # type: List[str]
        if user_where:
            parts.append("(%s)" % user_where)
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
            parts.append("(%s)" % clause)
            params.extend(clause_params)
        where_sql = (" WHERE " + " AND ".join(parts)) if parts else ""
        if user_where and not after and not seek:
            sql = "SELECT TOP %s * FROM %s%s OPTION (FAST %s)" % (
                page_size,
                table_sql,
                where_sql,
                page_size,
            )
            paging = "filter"
        elif keys:
            sql = "SELECT TOP %s * FROM %s%s ORDER BY %s OPTION (FAST %s)" % (
                page_size,
                table_sql,
                where_sql,
                ", ".join(qident(key) for key in keys),
                page_size,
            )
        else:
            paging = "offset"
            if offset > 100000:
                raise ClientError(
                    "OFFSET terlalu dalam untuk tabel tanpa kunci.",
                    "Tambahkan primary key / identity, atau pakai Export. "
                    "OFFSET besar pada 100 juta baris akan sangat lambat.",
                )
            sql = "SELECT * FROM %s%s ORDER BY (SELECT NULL) OFFSET %s ROWS FETCH NEXT %s ROWS ONLY" % (
                table_sql,
                where_sql,
                offset,
                page_size,
            )
        data = self.execute(sql, params=params or None, max_rows=page_size)
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

    def iter_table_rows(self, database, schema, table, columns, where="", order_keys=None, nolock=True, batch_size=10000, after=None):
        self._assert_db(database)
        if not columns:
            raise ClientError("Pilih minimal satu kolom untuk export.")
        where_sql = validate_where(where)
        table_sql = qname(database, schema, table)
        if nolock:
            table_sql += " WITH (NOLOCK)"
        fetch_n = int(batch_size or 10000)
        if fetch_n < 1:
            fetch_n = 1
        keys = [key for key in (order_keys or []) if key]
        after = after if isinstance(after, dict) and after else None
        params = []  # type: List[Any]
        clauses = []  # type: List[str]
        if where_sql:
            clauses.append("(%s)" % where_sql)
        if after and keys:
            values = [after.get(key) for key in keys]
            if any(value is None or value == "" for value in values):
                after = None
            else:
                clause, clause_params = keyset_clause(keys, values, self.placeholder())
                clauses.append(clause)
                params.extend(clause_params)
        sql = "SELECT %s FROM %s" % (", ".join(qident(col) for col in columns), table_sql)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        # Full dump / resume: ORDER BY key so a dropped connection can continue.
        # Filtered first-page export keeps FAST and skips sort.
        if keys and (after or not where_sql):
            sql += " ORDER BY " + ", ".join(qident(key) for key in keys)
        elif where_sql and not after:
            sql += " OPTION (FAST %s)" % fetch_n
        item = self._checkout()
        discard = False
        cursor = self._cursor(item.raw)
        item.cursor = cursor
        try:
            cursor.arraysize = fetch_n
        except Exception:
            pass
        if item.spid is None:
            item.spid = self._spid(item.raw)
        try:
            self._throw_if_cancelled(item)
            if params:
                cursor.execute(sql, params)
            else:
                cursor.execute(self._raw_sql(sql))
            self._throw_if_cancelled(item)
            if not cursor.description:
                return
            while True:
                self._throw_if_cancelled(item)
                raw_rows = cursor.fetchmany(fetch_n)
                if not raw_rows:
                    break
                yield raw_rows
        except Exception as exc:
            discard = is_cancelled(exc) or is_transient(exc)
            if isinstance(exc, ClientError):
                raise
            self._raise_sql(exc)
        finally:
            item.cursor = None
            self._close_cursor(cursor, cancel=item.cancel_event.is_set())
            self._checkin(item, discard=discard)

    def select_script(self, schema, table, page_size=200, keys=None, database=None):
        # type: (str, str, int, Optional[List[str]], Optional[str]) -> str
        if database:
            source = qname(database, schema, table)
        else:
            source = qname(schema, table)
        sql = "SELECT TOP %s *\nFROM %s" % (int(page_size), source)
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
        columns = [str(name).lower() if name is not None else "" for name in first["columns"]]
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
