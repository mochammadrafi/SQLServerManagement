# -*- coding: utf-8 -*-
import csv
import gzip
import io
import json
import os
import threading
import time
import uuid
from queue import Empty, Queue
from typing import Any, Dict, List, Optional

from sqlsm.client import ClientError, ConnectionConfig, connect_client, csv_value, qident, validate_where
from sqlsm.fsutil import default_data_folder, ensure_writable_dir, safe_name

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_ROOT = os.environ.get("SQLSM_EXPORT_DIR") or default_data_folder()

_LOCK = threading.Lock()
_JOBS = {}  # type: Dict[str, "ExportJob"]
_ACTIVE = ("queued", "running", "paused", "cancelling")


def _env_int(name, default, minimum, maximum):
    raw = os.environ.get(name)
    try:
        value = int(raw) if raw not in (None, "") else default
    except (TypeError, ValueError):
        value = default
    if value < minimum:
        value = minimum
    if value > maximum:
        value = maximum
    return value


_MAX_WORKERS = _env_int("SQLSM_MAX_WORKERS", 32, 1, 128)
_MAX_JOBS = _env_int("SQLSM_MAX_JOBS", 24, 1, 200)
_MAX_TOTAL_WORKERS = _env_int("SQLSM_MAX_TOTAL_WORKERS", 64, 1, 256)
if _MAX_TOTAL_WORKERS < _MAX_WORKERS:
    _MAX_TOTAL_WORKERS = _MAX_WORKERS


def export_limits():
    return {
        "max_workers": _MAX_WORKERS,
        "max_jobs": _MAX_JOBS,
        "max_total_workers": _MAX_TOTAL_WORKERS,
    }


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
        self.pause_event = threading.Event()
        self._state_lock = threading.RLock()
        self.folder = folder
        self._part_file = ""
        self.workers = 1
        self.current_objects = []  # type: List[Dict[str, Any]]
        self.table_states = []  # type: List[Dict[str, Any]]
        self._clients = []  # type: List[Any]

    def public(self):
        # type: () -> Dict[str, Any]
        with self._state_lock:
            parts = []
            for part in self.parts:
                parts.append(
                    {
                        "name": part.get("name"),
                        "rows": part.get("rows"),
                        "bytes": part.get("bytes"),
                    }
                )
            folder = self.folder or ""
            currents = [dict(item) for item in self.current_objects]
            tables = [dict(item) for item in self.table_states]
            current_object = getattr(self, "current_object", None)
            if currents:
                current_object = ", ".join(
                    "%s.%s" % (item.get("schema"), item.get("name")) for item in currents
                )
            kind = getattr(self, "kind", "export")
            status = self.status
            return {
                "id": self.id,
                "status": status,
                "database": self.database,
                "schema": self.schema,
                "table": self.table,
                "columns": list(self.columns),
                "where": self.where,
                "kind": kind,
                "folder": os.path.basename(folder.rstrip("\\/")) if folder else "",
                "chunk_rows": self.chunk_rows,
                "chunk_bytes": self.chunk_bytes,
                "gzip": self.use_gzip,
                "nolock": self.nolock,
                "workers": self.workers,
                "row_count_estimate": self.row_count_estimate,
                "rows_written": self.rows_written,
                "bytes_written": self.bytes_written,
                "parts": parts,
                "error": self.error,
                "hint": self.hint,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "tables_total": getattr(self, "tables_total", None),
                "tables_done": getattr(self, "tables_done", None),
                "current_object": current_object,
                "current_objects": currents,
                "tables": tables,
                "can_pause": kind in ("export", "export_db") and status in ("queued", "running"),
                "can_resume": status == "paused",
                "can_cancel": status in ("queued", "running", "paused", "cancelling"),
            }

    def wait_if_paused(self):
        # type: () -> bool
        if not self.pause_event.is_set():
            return not self.cancel_event.is_set()
        with self._state_lock:
            if self.status == "running":
                self.status = "paused"
            for item in self.current_objects:
                if item.get("status") == "running":
                    item["status"] = "paused"
            for item in self.table_states:
                if item.get("status") == "running":
                    item["status"] = "paused"
        try:
            self.save_meta()
        except Exception:
            pass
        while self.pause_event.is_set() and not self.cancel_event.is_set():
            self.cancel_event.wait(0.2)
        if self.cancel_event.is_set():
            return False
        with self._state_lock:
            if self.status == "paused":
                self.status = "running"
            for item in self.current_objects:
                if item.get("status") == "paused":
                    item["status"] = "running"
            for item in self.table_states:
                if item.get("status") == "paused":
                    item["status"] = "running"
        return True

    def _clients_snapshot(self):
        with self._state_lock:
            clients = list(self._clients)
            extra = getattr(self, "_client", None)
            if extra is not None and extra not in clients:
                clients.append(extra)
            return clients

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
    job.pause_event.clear()
    for client in job._clients_snapshot():
        try:
            client.cancel_running()
        except Exception:
            pass
    with job._state_lock:
        if job.status in ("queued", "running", "paused"):
            job.status = "cancelling"
    try:
        job.save_meta()
    except Exception:
        pass
    return job


def pause_job(sid, job_id):
    # type: (str, str) -> ExportJob
    job = get_job(sid, job_id)
    if getattr(job, "kind", "export") == "backup":
        raise ClientError("Backup tidak bisa dijeda.", "Batalkan, lalu jalankan lagi jika perlu.")
    with job._state_lock:
        if job.status not in ("queued", "running"):
            raise ClientError("Job tidak bisa dijeda.", "Hanya job yang sedang berjalan yang bisa dijeda.")
        job.pause_event.set()
        job.status = "paused"
        for item in job.current_objects:
            if item.get("status") == "running":
                item["status"] = "paused"
        for item in job.table_states:
            if item.get("status") == "running":
                item["status"] = "paused"
    job.save_meta()
    return job


def resume_job(sid, job_id):
    # type: (str, str) -> ExportJob
    job = get_job(sid, job_id)
    with job._state_lock:
        if job.status != "paused":
            raise ClientError("Job tidak sedang dijeda.")
        if job.cancel_event.is_set():
            job.status = "cancelling"
        else:
            job.status = "running"
            for item in job.current_objects:
                if item.get("status") == "paused":
                    item["status"] = "running"
            for item in job.table_states:
                if item.get("status") == "paused":
                    item["status"] = "running"
        job.pause_event.clear()
    job.save_meta()
    return job


def _clamp_workers(value):
    if value is None or value == "":
        workers = 3
    else:
        try:
            workers = int(value)
        except (TypeError, ValueError):
            workers = 3
    if workers < 1:
        workers = 1
    if workers > _MAX_WORKERS:
        workers = _MAX_WORKERS
    return workers


def _active_jobs_unlocked(sid):
    return [job for job in _JOBS.values() if job.sid == sid and job.status in _ACTIVE]


def _used_workers_unlocked(sid):
    used = 0
    for job in _active_jobs_unlocked(sid):
        used += max(1, int(getattr(job, "workers", 1) or 1))
    return used


def _fit_workers(sid, requested, table_count=None):
    requested = _clamp_workers(requested)
    if table_count is not None:
        requested = max(1, min(requested, max(1, int(table_count))))
    remaining = _MAX_TOTAL_WORKERS - _used_workers_unlocked(sid)
    if remaining >= 1:
        return max(1, min(requested, remaining))
    if len(_active_jobs_unlocked(sid)) < _MAX_JOBS:
        return 1
    raise ClientError(
        "Terlalu banyak job sekaligus.",
        "Tunggu, jeda, atau batalkan sebagian. Maksimal %s job / %s worker." % (_MAX_JOBS, _MAX_TOTAL_WORKERS),
    )


def _job_folder(base, name):
    dest = ensure_writable_dir(base)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    path = os.path.join(dest, "%s_%s_%s" % (safe_name(name), stamp, uuid.uuid4().hex[:8]))
    os.makedirs(path, exist_ok=True)
    return path


def _register_job(sid, job, workers=1, table_count=None):
    requested = _clamp_workers(workers)
    with _LOCK:
        if len(_active_jobs_unlocked(sid)) >= _MAX_JOBS:
            raise ClientError(
                "Terlalu banyak job sekaligus.",
                "Maksimal %s job berjalan. Tunggu atau batalkan sebagian." % _MAX_JOBS,
            )
        if getattr(job, "kind", "export") == "backup":
            for other in _active_jobs_unlocked(sid):
                if getattr(other, "kind", "") == "backup" and other.database == job.database:
                    raise ClientError(
                        "Backup %s masih berjalan." % job.database,
                        "SQL Server tidak bisa dua backup database yang sama sekaligus.",
                    )
        fitted = _fit_workers(sid, requested, table_count=table_count)
        job.workers = fitted
        _JOBS[job.id] = job
    if fitted < requested:
        extra = "Worker dipangkas dari %s ke %s supaya tidak melebihi slot koneksi." % (requested, fitted)
        job.hint = ("%s %s" % (job.hint, extra)).strip() if job.hint else extra
    return fitted


def _connect_export(cfg):
    export_cfg = ConnectionConfig(**cfg.__dict__)
    export_cfg.query_timeout = 86400
    last = None  # type: Optional[Exception]
    for attempt in range(4):
        try:
            return connect_client(export_cfg)
        except Exception as exc:
            last = exc
            if attempt >= 3:
                break
            time.sleep(0.35 * (attempt + 1))
    if isinstance(last, ClientError):
        raise last
    raise ClientError(str(last) if last else "Gagal membuka koneksi export.")


def _table_key(schema, name):
    return (str(schema or ""), str(name or ""))


def _mark_table(job, schema, name, **fields):
    key = _table_key(schema, name)
    with job._state_lock:
        for item in job.table_states:
            if _table_key(item.get("schema"), item.get("name")) == key:
                item.update(fields)
                return item
    return None


def _set_current(job, schema, name, rows_written=0, status="running"):
    key = _table_key(schema, name)
    with job._state_lock:
        for item in job.current_objects:
            if _table_key(item.get("schema"), item.get("name")) == key:
                item["rows_written"] = rows_written
                item["status"] = status
                return
        job.current_objects.append(
            {
                "schema": schema,
                "name": name,
                "rows_written": rows_written,
                "status": status,
            }
        )


def _clear_current(job, schema, name):
    key = _table_key(schema, name)
    with job._state_lock:
        job.current_objects = [
            item
            for item in job.current_objects
            if _table_key(item.get("schema"), item.get("name")) != key
        ]


def _add_progress(job, schema, name, rows):
    if not rows:
        return
    key = _table_key(schema, name)
    with job._state_lock:
        job.rows_written += rows
        for item in job.table_states:
            if _table_key(item.get("schema"), item.get("name")) == key:
                item["rows_written"] = int(item.get("rows_written") or 0) + rows
                break
        for item in job.current_objects:
            if _table_key(item.get("schema"), item.get("name")) == key:
                item["rows_written"] = int(item.get("rows_written") or 0) + rows
                break


def _bump_tables_done(job):
    with job._state_lock:
        job.tables_done = int(job.tables_done or 0) + 1


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
    dest = _job_folder(folder or EXPORT_ROOT, table)
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
    try:
        _register_job(sid, job, workers=1)
    except Exception:
        try:
            os.rmdir(dest)
        except Exception:
            pass
        raise
    job.save_meta()
    thread = threading.Thread(target=_run_job, args=(job,), name="export-" + job.id)
    thread.daemon = True
    thread.start()
    return job


def _purge_jobs():
    with _LOCK:
        finished = [
            (job_id, job)
            for job_id, job in _JOBS.items()
            if job.status in ("done", "error", "cancelled")
        ]
        if len(finished) <= 80:
            return
        finished.sort(key=lambda item: item[1].finished_at or "")
        for job_id, _job in finished[:-80]:
            _JOBS.pop(job_id, None)


def start_export_database(sid, cfg, database, tables=None, include_views=False, include_system=False, chunk_rows=0, chunk_bytes=0, use_gzip=True, nolock=True, folder="", workers=3):
    database = (database or "").strip()
    if not database:
        raise ClientError("Pilih database untuk export.")
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
    probe = connect_client(ConnectionConfig(**cfg.__dict__))
    try:
        catalog = probe.list_objects(database, include_counts=True)
        available = []
        for item in catalog.get("objects", {}).get("tables") or []:
            available.append(item)
        if include_views:
            for item in catalog.get("objects", {}).get("views") or []:
                available.append(item)
        by_key = {}
        for item in available:
            key = (item.get("schema"), item.get("name"))
            by_key[key] = item
        picked = []
        if tables:
            for item in tables:
                schema = str((item or {}).get("schema") or "").strip()
                name = str((item or {}).get("name") or "").strip()
                found = by_key.get((schema, name))
                if not found:
                    raise ClientError("Tabel tidak ada di database: %s.%s" % (schema, name))
                picked.append(found)
        else:
            for key in sorted(by_key.keys()):
                item = by_key[key]
                if not include_system and item.get("is_system"):
                    continue
                picked.append(item)
        if not picked:
            raise ClientError("Tidak ada tabel yang bisa di-export.", "Pilih minimal satu tabel.")
        estimate = 0
        has_estimate = False
        for item in picked:
            if item.get("row_count") is not None:
                estimate += int(item.get("row_count") or 0)
                has_estimate = True
    finally:
        probe.close()
    dest = _job_folder(folder or EXPORT_ROOT, database)
    job = ExportJob(
        sid=sid,
        cfg=cfg,
        database=database,
        schema="",
        table=database,
        columns=[],
        where="",
        chunk_rows=chunk_rows,
        chunk_bytes=chunk_bytes,
        use_gzip=use_gzip,
        nolock=nolock,
        row_count=estimate if has_estimate else None,
        folder=dest,
    )
    job.kind = "export_db"
    job.tables_total = len(picked)
    job.tables_done = 0
    job.current_object = None
    job._tables = [
        {
            "schema": item.get("schema"),
            "name": item.get("name"),
            "row_count": item.get("row_count"),
            "size_kb": item.get("size_kb"),
        }
        for item in picked
    ]
    job.table_states = [
        {
            "schema": item.get("schema"),
            "name": item.get("name"),
            "status": "queued",
            "rows_written": 0,
            "row_count": item.get("row_count"),
            "size_kb": item.get("size_kb"),
            "error": None,
        }
        for item in job._tables
    ]
    try:
        _register_job(sid, job, workers=workers, table_count=len(picked))
    except Exception:
        try:
            os.rmdir(dest)
        except Exception:
            pass
        raise
    job.save_meta()
    thread = threading.Thread(target=_run_db_export, args=(job,), name="export-db-" + job.id)
    thread.daemon = True
    thread.start()
    return job


def _run_db_export(job):
    # type: (ExportJob) -> None
    job.status = "running"
    job.started_at = _now()
    job.save_meta()
    tables = list(getattr(job, "_tables", []) or [])
    work = Queue()
    for item in tables:
        work.put(item)
    worker_errors = []  # type: List[Exception]
    error_lock = threading.Lock()
    workers_n = max(1, min(int(job.workers or 1), len(tables) or 1))
    job.workers = workers_n

    def worker(index):
        client = None
        try:
            if index:
                time.sleep(min(0.03 * index, 1.5))
            if job.cancel_event.is_set():
                return
            client = _connect_export(job.cfg)
            with job._state_lock:
                job._clients.append(client)
            while True:
                if job.cancel_event.is_set():
                    break
                if not job.wait_if_paused():
                    break
                try:
                    item = work.get_nowait()
                except Empty:
                    break
                try:
                    _export_one_table(job, client, item)
                finally:
                    work.task_done()
        except Exception as exc:
            with error_lock:
                worker_errors.append(exc)
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass

    threads = []
    for index in range(workers_n):
        thread = threading.Thread(target=worker, args=(index,), name="export-db-%s-%s" % (job.id, index + 1))
        thread.daemon = True
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join()
    with job._state_lock:
        leftover_error = str(worker_errors[0]) if worker_errors else "Tidak selesai."
        for item in job.table_states:
            if item.get("status") in ("queued", "running", "paused"):
                if job.cancel_event.is_set():
                    item["status"] = "cancelled"
                else:
                    item["status"] = "error"
                    if not item.get("error"):
                        item["error"] = leftover_error
        failed = [item for item in job.table_states if item.get("status") == "error"]
        if job.cancel_event.is_set():
            job.status = "cancelled"
            job.error = None
        elif failed and not job.tables_done:
            job.status = "error"
            first = failed[0]
            job.error = first.get("error") or (str(worker_errors[0]) if worker_errors else "Export database gagal.")
        else:
            job.status = "done"
            if failed:
                names = ["%s.%s" % (item.get("schema"), item.get("name")) for item in failed[:8]]
                extra = " dan %s tabel lain" % (len(failed) - 8) if len(failed) > 8 else ""
                job.error = "Selesai dengan %s tabel gagal: %s%s" % (len(failed), ", ".join(names), extra)
            job.current_object = None
            job.current_objects = []
        job.finished_at = _now()
    try:
        job.save_meta()
    except Exception:
        pass
    _purge_jobs()


def _export_one_table(job, client, item):
    schema = item.get("schema")
    table = item.get("name")
    _mark_table(job, schema, table, status="running", error=None)
    _set_current(job, schema, table, rows_written=0, status="running")
    try:
        if job.cancel_event.is_set():
            _mark_table(job, schema, table, status="cancelled")
            return
        if not job.wait_if_paused():
            _mark_table(job, schema, table, status="cancelled")
            return
        columns = [col.get("name") for col in client.list_columns(job.database, schema, table)]
        columns = [name for name in columns if name]
        if not columns:
            _mark_table(job, schema, table, status="done")
            _bump_tables_done(job)
            return
        stats = client.table_stats(job.database, schema, table)
        prefix = "%s.%s" % (safe_name(schema), safe_name(table))
        _export_current(
            job,
            client,
            schema,
            table,
            columns,
            stats.get("keys") or [],
            prefix,
            "",
        )
        if job.cancel_event.is_set():
            _mark_table(job, schema, table, status="cancelled")
        else:
            _mark_table(job, schema, table, status="done")
            _bump_tables_done(job)
    except ClientError as exc:
        if job.cancel_event.is_set() or "dibatalkan" in str(exc).lower():
            _mark_table(job, schema, table, status="cancelled")
        else:
            _mark_table(job, schema, table, status="error", error=str(exc))
    except Exception as exc:
        if job.cancel_event.is_set() or "dibatalkan" in str(exc).lower():
            _mark_table(job, schema, table, status="cancelled")
        else:
            _mark_table(job, schema, table, status="error", error=str(exc))
    finally:
        _clear_current(job, schema, table)
        try:
            job.save_meta()
        except Exception:
            pass


def _export_current(job, client, schema=None, table=None, columns=None, order_keys=None, file_prefix=None, where=None):
    schema = job.schema if schema is None else schema
    table = job.table if table is None else table
    columns = list(job.columns if columns is None else columns)
    if order_keys is None:
        order_keys = getattr(job, "_order_keys", None) or None
    if file_prefix is None:
        file_prefix = getattr(job, "_file_prefix", None) or safe_name(table)
    if where is None:
        where = job.where
    writer = None  # type: Optional[Any]
    handle = None
    part_index = 0
    part_rows = 0
    part_name = ""
    part_file = ""
    wrote_rows = 0
    pending = 0
    try:
        for raw_rows in client.iter_table_rows(
            job.database,
            schema,
            table,
            columns,
            where=where,
            order_keys=order_keys or None,
            nolock=job.nolock,
            batch_size=2000,
        ):
            if job.cancel_event.is_set():
                break
            if not job.wait_if_paused():
                break
            for raw in raw_rows:
                if job.cancel_event.is_set():
                    break
                if writer is None:
                    part_index += 1
                    writer, handle, part_name, part_file = _open_part(job, part_index, file_prefix)
                    writer.writerow(columns)
                    part_rows = 0
                writer.writerow([csv_value(value) for value in raw])
                part_rows += 1
                wrote_rows += 1
                pending += 1
                if pending >= 50:
                    _add_progress(job, schema, table, pending)
                    pending = 0
                rotate = False
                if job.chunk_rows and part_rows >= job.chunk_rows:
                    rotate = True
                elif job.chunk_bytes and part_rows % 500 == 0:
                    handle.flush()
                    if os.path.isfile(part_file) and os.path.getsize(part_file) >= job.chunk_bytes:
                        rotate = True
                if rotate:
                    if pending:
                        _add_progress(job, schema, table, pending)
                        pending = 0
                    _close_part(job, handle, part_name, part_rows)
                    writer = None
                    handle = None
                    part_name = ""
                    part_file = ""
                    job.save_meta()
            if pending:
                _add_progress(job, schema, table, pending)
                pending = 0
        if pending:
            _add_progress(job, schema, table, pending)
            pending = 0
        if writer is not None and not job.cancel_event.is_set():
            _close_part(job, handle, part_name, part_rows)
            writer = None
            handle = None
        if wrote_rows == 0 and not job.cancel_event.is_set():
            writer, handle, part_name, part_file = _open_part(job, 1, file_prefix)
            writer.writerow(columns)
            _close_part(job, handle, part_name, 0)
            writer = None
            handle = None
    finally:
        if pending:
            _add_progress(job, schema, table, pending)
        if writer is not None and handle is not None:
            if job.cancel_event.is_set():
                _discard_open_part(handle, part_file)
            else:
                _close_part(job, handle, part_name, part_rows)


def _run_job(job):
    # type: (ExportJob) -> None
    job.status = "running"
    job.started_at = _now()
    _set_current(job, job.schema, job.table, rows_written=0, status="running")
    job.save_meta()
    client = None
    try:
        client = _connect_export(job.cfg)
        job._client = client
        with job._state_lock:
            if client not in job._clients:
                job._clients.append(client)
        _export_current(
            job,
            client,
            job.schema,
            job.table,
            job.columns,
            getattr(job, "_order_keys", None) or [],
            getattr(job, "_file_prefix", None) or safe_name(job.table),
            job.where,
        )
        if job.cancel_event.is_set():
            job.status = "cancelled"
        else:
            job.status = "done"
        job.finished_at = _now()
        job.save_meta()
    except ClientError as exc:
        if job.cancel_event.is_set() or "dibatalkan" in str(exc).lower():
            job.status = "cancelled"
            job.error = None
        else:
            job.status = "error"
            job.error = str(exc)
            job.hint = exc.hint
        job.finished_at = _now()
        job.save_meta()
    except Exception as exc:
        job.status = "cancelled" if job.cancel_event.is_set() else "error"
        job.error = None if job.cancel_event.is_set() else str(exc)
        job.finished_at = _now()
        job.save_meta()
    finally:
        _clear_current(job, job.schema, job.table)
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
        _purge_jobs()


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


def _open_part(job, part_index, file_prefix=None):
    ext = ".csv.gz" if job.use_gzip else ".csv"
    prefix = file_prefix or getattr(job, "_file_prefix", None) or safe_name(job.table)
    name = "%s_part-%05d%s" % (prefix, part_index, ext)
    path = os.path.join(job.folder, name)
    job._part_file = path
    if job.use_gzip:
        raw = open(path, "wb")
        gz = gzip.GzipFile(filename=name, mode="wb", fileobj=raw, compresslevel=6)
        text = io.TextIOWrapper(gz, encoding="utf-8-sig", newline="")
        return csv.writer(text), _HandleStack(text, gz, raw), name, path
    text = io.open(path, "w", encoding="utf-8-sig", newline="")
    return csv.writer(text), _HandleStack(text), name, path


def _close_part(job, handle, name, rows):
    try:
        handle.flush()
        handle.close()
    except Exception:
        pass
    path = os.path.join(job.folder, name)
    size = os.path.getsize(path) if os.path.isfile(path) else 0
    with job._state_lock:
        job.bytes_written += size
        job.parts.append({"name": name, "rows": rows, "bytes": size, "path": path})


def _discard_open_part(handle, path):
    # type: (Any, str) -> None
    if handle is not None:
        try:
            handle.flush()
            handle.close()
        except Exception:
            pass
    if not path:
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
    except Exception:
        pass


def start_backup(sid, cfg, database, folder="", chunk_bytes=0, compress=True):
    database = (database or "").strip()
    if not database:
        raise ClientError("Pilih database untuk backup.")
    dest = ensure_writable_dir(folder or EXPORT_ROOT)
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
    suffix = uuid.uuid4().hex[:8]
    files = [
        os.path.join(dest, "%s_%s_%s_%02d.bak" % (safe_name(database), stamp, suffix, index + 1))
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
    _register_job(sid, job, workers=1)
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
        job._client = client
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
        if job.cancel_event.is_set() or "dibatalkan" in str(exc).lower():
            job.status = "cancelled"
            job.error = None
            job.finished_at = _now()
            job.save_meta()
            return
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
        if job.cancel_event.is_set() or "dibatalkan" in str(exc).lower():
            job.status = "cancelled"
            job.error = None
        else:
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
        _purge_jobs()
