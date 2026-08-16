# -*- coding: utf-8 -*-
import csv
import gzip
import io
import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from sqlsm.client import ClientError, ConnectionConfig, connect_client, csv_value, qident, validate_where
from sqlsm.fsutil import default_data_folder, ensure_writable_dir, safe_name

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_ROOT = os.environ.get("SQLSM_EXPORT_DIR") or default_data_folder()

_LOCK = threading.Lock()
_JOBS = {}  # type: Dict[str, "ExportJob"]


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


class ExportJob(object):
    def __init__(self, sid, cfg, database, schema, table, columns, where, chunk_rows, chunk_bytes, use_gzip, nolock, row_count, folder):
        self.id = uuid.uuid4().hex
        self.kind = "export"
        self.sid = sid
        self.cfg = cfg
        self.database = database
        self.schema = schema
        self.table = table
        self.columns = list(columns)
        self.where = where or ""
        self.chunk_rows = int(chunk_rows or 0)
        self.chunk_bytes = int(chunk_bytes or 0)
        self.use_gzip = bool(use_gzip)
        self.nolock = bool(nolock)
        self.row_count_estimate = row_count
        self.status = "queued"
        self.rows_written = 0
        self.bytes_written = 0
        self.parts = []  # type: List[Dict[str, Any]]
        self.error = None
        self.hint = None
        self.started_at = None
        self.finished_at = None
        self.cancel_event = threading.Event()
        self.folder = folder
        self._part_file = ""

    def public(self):
        # type: () -> Dict[str, Any]
        return {
            "id": self.id,
            "status": self.status,
            "database": self.database,
            "schema": self.schema,
            "table": self.table,
            "columns": self.columns,
            "where": self.where,
            "kind": getattr(self, "kind", "export"),
            "folder": self.folder,
            "chunk_rows": self.chunk_rows,
            "chunk_bytes": self.chunk_bytes,
            "gzip": self.use_gzip,
            "nolock": self.nolock,
            "row_count_estimate": self.row_count_estimate,
            "rows_written": self.rows_written,
            "bytes_written": self.bytes_written,
            "parts": list(self.parts),
            "error": self.error,
            "hint": self.hint,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }

    def save_meta(self):
        path = os.path.join(self.folder, "meta.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(self.public(), handle, ensure_ascii=False, indent=2)

    def part_path(self, name):
        # type: (str) -> str
        if not name or "/" in name or "\\" in name or ".." in name:
            raise ClientError("Nama file export tidak valid.")
        path = os.path.join(self.folder, name)
        if not os.path.isfile(path):
            raise ClientError("File export tidak ditemukan.")
        return path


def list_jobs(sid):
    # type: (str) -> List[Dict[str, Any]]
    with _LOCK:
        return [job.public() for job in _JOBS.values() if job.sid == sid]


def get_job(sid, job_id):
    # type: (str, str) -> ExportJob
    with _LOCK:
        job = _JOBS.get(job_id)
    if job is None or job.sid != sid:
        raise ClientError("Job export tidak ditemukan.")
    return job


def cancel_job(sid, job_id):
    # type: (str, str) -> ExportJob
    job = get_job(sid, job_id)
    job.cancel_event.set()
    if job.status in ("queued", "running"):
        job.status = "cancelling"
        job.save_meta()
    return job


def start_export(sid, cfg, database, schema, table, columns, where="", chunk_rows=0, chunk_bytes=0, use_gzip=True, nolock=True, folder=""):
    where = validate_where(where)
    chunk_rows = int(chunk_rows or 0)
    chunk_bytes = int(chunk_bytes or 0)
    if chunk_rows < 0:
        chunk_rows = 0
    if chunk_rows > 5000000:
        chunk_rows = 5000000
    if chunk_bytes < 0:
        chunk_bytes = 0
    if chunk_bytes and chunk_bytes < 64 * 1024 * 1024:
        raise ClientError("Ukuran pecahan terlalu kecil.", "Minimum 64 MB supaya tidak menghasilkan ribuan file.")
    active = [job for job in _JOBS.values() if job.sid == sid and job.status in ("queued", "running", "cancelling")]
    if active:
        raise ClientError(
            "Masih ada export yang berjalan.",
            "Tunggu selesai atau batalkan dulu. Satu export penuh 100 juta baris sudah membebani server.",
        )
    probe_cfg = ConnectionConfig(**cfg.__dict__)
    probe = connect_client(probe_cfg)
    try:
        allowed = [item.get("name") for item in probe.list_columns(database, schema, table)]
        allowed_map = {str(name).lower(): name for name in allowed if name}
        picked = []
        for name in columns or allowed:
            real = allowed_map.get(str(name).lower())
            if not real:
                raise ClientError("Kolom tidak ada di tabel: %s" % name)
            picked.append(real)
        if not picked:
            raise ClientError("Pilih minimal satu kolom untuk export.")
        stats = probe.table_stats(database, schema, table)
        keys = stats.get("keys") or []
    finally:
        probe.close()
    dest = ensure_writable_dir(folder or EXPORT_ROOT)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(dest, "%s_%s" % (safe_name(table), stamp))
    os.makedirs(dest, exist_ok=True)
    job = ExportJob(
        sid=sid,
        cfg=cfg,
        database=database,
        schema=schema,
        table=table,
        columns=picked,
        where=where,
        chunk_rows=chunk_rows,
        chunk_bytes=chunk_bytes,
        use_gzip=use_gzip,
        nolock=nolock,
        row_count=stats.get("row_count"),
        folder=dest,
    )
    job._order_keys = keys  # type: ignore
    with _LOCK:
        _JOBS[job.id] = job
    job.save_meta()
    thread = threading.Thread(target=_run_job, args=(job,), name="export-" + job.id)
    thread.daemon = True
    thread.start()
    return job


def _run_job(job):
    # type: (ExportJob) -> None
    job.status = "running"
    job.started_at = _now()
    job.save_meta()
    export_cfg = ConnectionConfig(**job.cfg.__dict__)
    export_cfg.query_timeout = 86400
    client = None
    writer = None  # type: Optional[Any]
    handle = None
    part_index = 0
    part_rows = 0
    try:
        client = connect_client(export_cfg)
        order_keys = getattr(job, "_order_keys", None) or None
        for raw_rows in client.iter_table_rows(
            job.database,
            job.schema,
            job.table,
            job.columns,
            where=job.where,
            order_keys=order_keys,
            nolock=job.nolock,
            batch_size=2000,
        ):
            if job.cancel_event.is_set():
                job.status = "cancelled"
                job.finished_at = _now()
                job.save_meta()
                return
            for raw in raw_rows:
                if writer is None:
                    part_index += 1
                    writer, handle, part_name = _open_part(job, part_index)
                    writer.writerow(job.columns)
                    part_rows = 0
                writer.writerow([csv_value(value) for value in raw])
                part_rows += 1
                job.rows_written += 1
                rotate = False
                if job.chunk_rows and part_rows >= job.chunk_rows:
                    rotate = True
                elif job.chunk_bytes and part_rows % 2000 == 0:
                    handle.flush()
                    if os.path.isfile(job._part_file) and os.path.getsize(job._part_file) >= job.chunk_bytes:
                        rotate = True
                if rotate:
                    _close_part(job, handle, part_name, part_rows)
                    writer = None
                    handle = None
                    job.save_meta()
        if writer is not None:
            _close_part(job, handle, part_name, part_rows)
        if job.cancel_event.is_set():
            job.status = "cancelled"
        else:
            job.status = "done"
            if job.rows_written == 0:
                part_index = 1
                writer, handle, part_name = _open_part(job, part_index)
                writer.writerow(job.columns)
                _close_part(job, handle, part_name, 0)
        job.finished_at = _now()
        job.save_meta()
    except ClientError as exc:
        job.status = "error"
        job.error = str(exc)
        job.hint = exc.hint
        job.finished_at = _now()
        job.save_meta()
    except Exception as exc:
        job.status = "error"
        job.error = str(exc)
        job.finished_at = _now()
        job.save_meta()
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


class _HandleStack(object):
    def __init__(self, *handles):
        self.handles = handles

    def flush(self):
        for handle in self.handles:
            if hasattr(handle, "flush"):
                handle.flush()

    def close(self):
        for handle in reversed(self.handles):
            try:
                handle.close()
            except Exception:
                pass


def _open_part(job, part_index):
    ext = ".csv.gz" if job.use_gzip else ".csv"
    name = "%s_part-%05d%s" % (safe_name(job.table), part_index, ext)
    path = os.path.join(job.folder, name)
    job._part_file = path
    if job.use_gzip:
        raw = open(path, "wb")
        gz = gzip.GzipFile(filename=name, mode="wb", fileobj=raw, compresslevel=6)
        text = io.TextIOWrapper(gz, encoding="utf-8-sig", newline="")
        return csv.writer(text), _HandleStack(text, gz, raw), name
    text = io.open(path, "w", encoding="utf-8-sig", newline="")
    return csv.writer(text), _HandleStack(text), name


def _close_part(job, handle, name, rows):
    try:
        handle.flush()
        handle.close()
    except Exception:
        pass
    path = os.path.join(job.folder, name)
    size = os.path.getsize(path) if os.path.isfile(path) else 0
    job.bytes_written += size
    job.parts.append({"name": name, "rows": rows, "bytes": size, "path": path})


def start_backup(sid, cfg, database, folder="", chunk_bytes=0, compress=True):
    database = (database or "").strip()
    if not database:
        raise ClientError("Pilih database untuk backup.")
    dest = ensure_writable_dir(folder or EXPORT_ROOT)
    active = [job for job in _JOBS.values() if job.sid == sid and job.status in ("queued", "running", "cancelling")]
    if active:
        raise ClientError("Masih ada job yang berjalan.", "Tunggu selesai atau batalkan dulu.")
    probe = connect_client(ConnectionConfig(**cfg.__dict__))
    size_bytes = 0
    try:
        for item in probe.list_databases():
            if item.get("name") == database:
                try:
                    size_bytes = int(float(item.get("size_mb") or 0) * 1024 * 1024)
                except (TypeError, ValueError):
                    size_bytes = 0
                break
    finally:
        probe.close()
    chunk_bytes = int(chunk_bytes or 0)
    if chunk_bytes and chunk_bytes < 64 * 1024 * 1024:
        raise ClientError("Ukuran pecahan terlalu kecil.", "Minimum 64 MB.")
    if chunk_bytes and size_bytes:
        parts_n = int((size_bytes + chunk_bytes - 1) / chunk_bytes)
    elif chunk_bytes:
        parts_n = 4
    else:
        parts_n = 1
    if parts_n < 1:
        parts_n = 1
    if parts_n > 64:
        parts_n = 64
    stamp = time.strftime("%Y%m%d_%H%M%S")
    files = [
        os.path.join(dest, "%s_%s_%02d.bak" % (safe_name(database), stamp, index + 1))
        for index in range(parts_n)
    ]
    job = ExportJob(
        sid=sid,
        cfg=cfg,
        database=database,
        schema="",
        table=database,
        columns=[],
        where="",
        chunk_rows=0,
        chunk_bytes=chunk_bytes,
        use_gzip=False,
        nolock=False,
        row_count=None,
        folder=dest,
    )
    job.kind = "backup"
    job._backup_files = files  # type: ignore
    job._backup_compress = bool(compress)  # type: ignore
    with _LOCK:
        _JOBS[job.id] = job
    job.save_meta()
    thread = threading.Thread(target=_run_backup, args=(job,), name="backup-" + job.id)
    thread.daemon = True
    thread.start()
    return job


def _run_backup(job):
    job.status = "running"
    job.started_at = _now()
    job.save_meta()
    files = getattr(job, "_backup_files", []) or []
    disks = ", ".join("DISK = N'%s'" % path.replace("'", "''") for path in files)
    options = ["INIT", "STATS = 10"]
    if getattr(job, "_backup_compress", True):
        options.append("COMPRESSION")
    sql = "BACKUP DATABASE %s TO %s WITH %s" % (qident(job.database), disks, ", ".join(options))
    cfg = ConnectionConfig(**job.cfg.__dict__)
    cfg.query_timeout = 86400
    client = None
    try:
        client = connect_client(cfg)
        client.execute(sql, max_rows=1, database="master")
        if job.cancel_event.is_set():
            job.status = "cancelled"
        else:
            job.status = "done"
            for path in files:
                name = os.path.basename(path)
                size = os.path.getsize(path) if os.path.isfile(path) else 0
                job.bytes_written += size
                job.parts.append({"name": name, "rows": 0, "bytes": size, "path": path})
        job.finished_at = _now()
        job.save_meta()
    except ClientError as exc:
        if "COMPRESSION" in str(exc).upper() or "compress" in str(exc).lower():
            try:
                sql = "BACKUP DATABASE %s TO %s WITH INIT, STATS = 10" % (qident(job.database), disks)
                if client is None:
                    client = connect_client(cfg)
                client.execute(sql, max_rows=1, database="master")
                job.status = "done"
                for path in files:
                    name = os.path.basename(path)
                    size = os.path.getsize(path) if os.path.isfile(path) else 0
                    job.bytes_written += size
                    job.parts.append({"name": name, "rows": 0, "bytes": size, "path": path})
                job.finished_at = _now()
                job.save_meta()
                return
            except Exception:
                pass
        job.status = "error"
        job.error = str(exc)
        job.hint = exc.hint or (
            "Folder harus bisa ditulis oleh akun layanan SQL Server, bukan hanya user Windows Anda."
        )
        job.finished_at = _now()
        job.save_meta()
    except Exception as exc:
        job.status = "error"
        job.error = str(exc)
        job.finished_at = _now()
        job.save_meta()
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
