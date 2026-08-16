# -*- coding: utf-8 -*-
import json
import os
import sys
import threading
import time
import uuid
from typing import Any, Dict, Optional

from flask import Flask, g, jsonify, redirect, render_template, request, send_file, session, url_for
from itsdangerous import BadSignature, URLSafeSerializer

from sqlsm.client import (
    ClientError,
    ConnectionConfig,
    SqlServerClient,
    connect_client,
    is_cancelled,
    is_transient,
    list_odbc_drivers,
    pick_odbc_driver,
)
from sqlsm.export import cancel_job, get_job, list_jobs, start_backup, start_export, start_export_database
from sqlsm.fsutil import default_data_folder, existing_start_dir, list_folders, pick_folder
from sqlsm.profiles import STORE_DIR, delete_profile, get_profile, list_profiles, read_password, upsert_profile

ROOT = os.path.dirname(os.path.abspath(__file__))
STORE_IDLE_SEC = int(os.environ.get("SQLSM_IDLE_SEC", "7200"))


def _secret_key():
    env = os.environ.get("SQLSM_SECRET")
    if env:
        return env
    path = os.path.join(STORE_DIR, "secret")
    try:
        if os.path.isfile(path):
            raw = open(path, "rb").read().strip()
            if raw:
                return raw
        if not os.path.isdir(STORE_DIR):
            os.makedirs(STORE_DIR)
        raw = os.urandom(32)
        with open(path, "wb") as handle:
            handle.write(raw)
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
        return raw
    except Exception:
        return os.urandom(24)


app = Flask(
    __name__,
    template_folder=os.path.join(ROOT, "templates"),
    static_folder=os.path.join(ROOT, "static"),
)
app.secret_key = _secret_key()
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.jinja_env.auto_reload = True
app.jinja_env.cache = {}

STORE = {}  # type: Dict[str, Dict[str, Any]]
_STORE_LOCK = threading.RLock()
_CSRF = URLSafeSerializer(app.secret_key, salt="sqlsm-csrf")


def _csrf_token():
    # type: () -> str
    return _CSRF.dumps(_sid())


def _touch_store():
    sid = _sid()
    with _STORE_LOCK:
        store = STORE.get(sid)
        if store is not None:
            store["_last"] = time.time()


def _purge_idle_stores():
    now = time.time()
    with _STORE_LOCK:
        dead = []
        for sid, store in list(STORE.items()):
            last = float(store.get("_last") or now)
            if now - last <= STORE_IDLE_SEC:
                continue
            for item in (store.get("connections") or {}).values():
                _close_item(item)
            dead.append(sid)
        for sid in dead:
            STORE.pop(sid, None)


def _sid():
    # type: () -> str
    token = session.get("sid")
    if not token:
        token = uuid.uuid4().hex
        session["sid"] = token
    return token


def _ensure_store():
    # type: () -> Optional[Dict[str, Any]]
    sid = _sid()
    with _STORE_LOCK:
        item = STORE.get(sid)
        if not item:
            return None
        if item.get("connections") is not None:
            item["_last"] = time.time()
            return item
        if item.get("cfg"):
            cid = uuid.uuid4().hex[:12]
            migrated = {
                "connections": {
                    cid: {
                        "id": cid,
                        "cfg": item["cfg"],
                        "client": item.get("client"),
                        "backend": item.get("backend") or "",
                        "driver_name": item.get("driver_name") or "",
                    }
                },
                "active": cid,
            }
            STORE[sid] = migrated
            migrated["_last"] = time.time()
            return migrated
        return None


def _store():
    # type: () -> Optional[Dict[str, Any]]
    return _ensure_store()


def _has_connections():
    # type: () -> bool
    store = _ensure_store()
    return bool(store and store.get("connections"))


def _active_item():
    # type: () -> Optional[Dict[str, Any]]
    store = _ensure_store()
    if not store:
        return None
    return (store.get("connections") or {}).get(store.get("active"))


def _public_connection(item):
    # type: (Dict[str, Any]) -> Dict[str, Any]
    cfg = item["cfg"]  # type: ConnectionConfig
    data = cfg.public_dict()
    data["id"] = item.get("id")
    data["backend"] = item.get("backend") or ""
    data["driver_name"] = item.get("driver_name") or ""
    data["label"] = "%s · %s" % (
        data.get("display_server") or data.get("server"),
        data.get("database") or "master",
    )
    if data.get("auth") == "sql" and data.get("username"):
        data["label"] += " · " + data["username"]
    elif data.get("auth") == "windows":
        data["label"] += " · Windows"
    return data


def _client():
    # type: () -> SqlServerClient
    item = _active_item()
    if not item:
        raise ClientError("Belum terhubung ke SQL Server.", "Buka halaman koneksi dan isi data server.")
    client = item.get("client")
    if client is not None and getattr(client, "is_open", lambda: False)():
        return client
    cfg = item["cfg"]
    client = connect_client(cfg)
    with _STORE_LOCK:
        current = _active_item()
        if current and current.get("cfg") is cfg:
            current["client"] = client
            current["backend"] = client.backend
            current["driver_name"] = client.driver_name
            return client
    return client


def _close_item(item):
    # type: (Dict[str, Any]) -> None
    client = item.get("client")
    if client is None:
        return
    try:
        client.close()
    except Exception:
        pass
    item["client"] = None


def _error_payload(exc):
    # type: (BaseException) -> Any
    retryable = is_transient(exc)
    cancelled = is_cancelled(exc)
    payload = {
        "ok": False,
        "error": str(exc),
        "hint": getattr(exc, "hint", None),
        "retryable": retryable,
        "cancelled": cancelled,
    }
    if isinstance(exc, ClientError):
        return jsonify(payload), 503 if retryable else 400
    return jsonify(payload), 503 if retryable else 500


@app.before_request
def _bind_sid():
    g.sid = _sid()
    _touch_store()
    _purge_idle_stores()
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path.startswith("/api/"):
        token = request.headers.get("X-SQLSM-Token") or ""
        try:
            if _CSRF.loads(token) != _sid():
                return jsonify({"ok": False, "error": "Permintaan tidak valid.", "hint": "Refresh halaman, lalu coba lagi."}), 403
        except BadSignature:
            return jsonify({"ok": False, "error": "Permintaan tidak valid.", "hint": "Refresh halaman, lalu coba lagi."}), 403


@app.route("/")
def home_page():
    if _has_connections():
        return redirect(url_for("workspace_page"))
    return render_template("connect.html")


@app.route("/connect")
def connect_page():
    return render_template("connect.html")


@app.route("/workspace")
def workspace_page():
    if not _has_connections():
        return redirect(url_for("connect_page"))
    return render_template("workspace.html")


@app.route("/api/meta")
def api_meta():
    drivers = list_odbc_drivers()
    return jsonify(
        {
            "ok": True,
            "platform": sys.platform,
            "windows": sys.platform == "win32",
            "odbc_drivers": drivers,
            "preferred_driver": pick_odbc_driver(drivers),
            "default_folder": existing_start_dir(default_data_folder()),
            "profiles": list_profiles(),
            "csrf_token": _csrf_token(),
        }
    )


@app.route("/api/profiles")
def api_profiles():
    return jsonify({"ok": True, "profiles": list_profiles()})


@app.route("/api/profiles/<profile_id>", methods=["DELETE"])
def api_profiles_delete(profile_id):
    if not delete_profile(profile_id):
        return _error_payload(ClientError("Profil koneksi tidak ditemukan."))
    return jsonify({"ok": True, "profiles": list_profiles()})


@app.route("/api/session")
def api_session():
    store = _ensure_store()
    item = _active_item()
    if not store or not item:
        return jsonify({"ok": True, "connected": False, "connections": []})
    connections = [_public_connection(entry) for entry in (store.get("connections") or {}).values()]
    return jsonify(
        {
            "ok": True,
            "connected": True,
            "connection": _public_connection(item),
            "connection_id": item.get("id"),
            "connections": connections,
            "backend": item.get("backend") or "",
            "driver_name": item.get("driver_name") or "",
            "csrf_token": _csrf_token(),
        }
    )


@app.route("/api/connect", methods=["POST"])
def api_connect():
    payload = request.get_json(silent=True) or {}
    try:
        port = int(payload.get("port") or 1433)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Port tidak valid.", "hint": "Port default SQL Server adalah 1433."}), 400
    password = str(payload.get("password") or "")
    if not password and payload.get("profile_id"):
        saved = get_profile(str(payload.get("profile_id")))
        if saved:
            password = read_password(saved)
    cfg = ConnectionConfig(
        server=str(payload.get("server") or "").strip(),
        port=port,
        instance=str(payload.get("instance") or "").strip(),
        auth="windows" if payload.get("auth") == "windows" else "sql",
        username=str(payload.get("username") or "").strip(),
        password=password,
        database=str(payload.get("database") or "master").strip() or "master",
        encrypt=bool(payload.get("encrypt")),
    )
    try:
        client = connect_client(cfg)
        info = client.server_info()
    except ClientError as exc:
        return _error_payload(exc)
    except Exception as exc:
        return _error_payload(exc)
    sid = _sid()
    cid = uuid.uuid4().hex[:12]
    with _STORE_LOCK:
        store = STORE.get(sid)
        if store is None or store.get("connections") is None:
            store = {"connections": {}, "active": None}
            STORE[sid] = store
        store["connections"][cid] = {
            "id": cid,
            "cfg": cfg,
            "client": client,
            "backend": client.backend,
            "driver_name": client.driver_name,
        }
        store["active"] = cid
        item = store["connections"][cid]
        store["_last"] = time.time()
    try:
        upsert_profile(
            {
                "server": cfg.server,
                "port": cfg.port,
                "instance": cfg.instance,
                "auth": cfg.auth,
                "username": cfg.username,
                "password": cfg.password,
                "database": cfg.database,
                "encrypt": cfg.encrypt,
            },
            remember_password=bool(payload.get("remember_password")),
        )
    except Exception:
        pass
    return jsonify(
        {
            "ok": True,
            "connection": _public_connection(item),
            "connection_id": cid,
            "connections": [_public_connection(entry) for entry in store["connections"].values()],
            "server": info,
            "backend": client.backend,
            "driver_name": client.driver_name,
        }
    )


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    payload = request.get_json(silent=True) or {}
    sid = _sid()
    with _STORE_LOCK:
        store = _ensure_store()
        if not store:
            return jsonify({"ok": True, "connected": False, "connections": []})
        close_all = bool(payload.get("all"))
        target = str(payload.get("id") or store.get("active") or "").strip()
        remaining = dict(store.get("connections") or {})
        if close_all:
            for item in list(remaining.values()):
                _close_item(item)
            remaining = {}
        elif target and target in remaining:
            _close_item(remaining[target])
            remaining.pop(target, None)
        store["connections"] = remaining
        if remaining:
            if store.get("active") not in remaining:
                store["active"] = next(iter(remaining.keys()))
            item = remaining[store["active"]]
            store["_last"] = time.time()
            return jsonify(
                {
                    "ok": True,
                    "connected": True,
                    "connection": _public_connection(item),
                    "connection_id": item.get("id"),
                    "connections": [_public_connection(entry) for entry in remaining.values()],
                }
            )
        for job in list_jobs(sid):
            if job.get("status") in ("queued", "running", "cancelling"):
                try:
                    cancel_job(sid, job["id"])
                except Exception:
                    pass
        STORE.pop(sid, None)
    return jsonify({"ok": True, "connected": False, "connections": []})


@app.route("/api/connections/switch", methods=["POST"])
def api_connections_switch():
    payload = request.get_json(silent=True) or {}
    cid = str(payload.get("id") or "").strip()
    store = _ensure_store()
    if not store or cid not in (store.get("connections") or {}):
        return _error_payload(ClientError("Koneksi tidak ditemukan.", "Pilih koneksi yang masih aktif, atau buat yang baru."))
    store["active"] = cid
    item = store["connections"][cid]
    return jsonify(
        {
            "ok": True,
            "connection": _public_connection(item),
            "connection_id": cid,
            "connections": [_public_connection(entry) for entry in store["connections"].values()],
            "backend": item.get("backend") or "",
            "driver_name": item.get("driver_name") or "",
        }
    )


@app.route("/api/server")
def api_server():
    try:
        client = _client()
        sessions = []
        sessions_error = None
        try:
            sessions = client.list_sessions()
        except Exception as exc:
            sessions_error = str(exc)
        return jsonify(
            {
                "ok": True,
                "server": client.server_info(),
                "sessions": sessions,
                "sessions_error": sessions_error,
                "backend": client.backend,
                "driver_name": client.driver_name,
            }
        )
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/databases")
def api_databases():
    try:
        return jsonify({"ok": True, "databases": _client().list_databases()})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/objects")
def api_objects():
    database = (request.args.get("database") or "").strip()
    include_counts = (request.args.get("counts") or "").lower() in ("1", "true", "yes")
    try:
        catalog = _client().list_objects(database, include_counts=include_counts)
        return jsonify(
            {
                "ok": True,
                "database": database,
                "schemas": catalog.get("schemas") or [],
                "objects": catalog.get("objects") or {},
            }
        )
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/columns")
def api_columns():
    database = (request.args.get("database") or "").strip()
    schema = (request.args.get("schema") or "").strip()
    table = (request.args.get("table") or "").strip()
    try:
        return jsonify(
            {
                "ok": True,
                "columns": _client().list_columns(database, schema, table),
            }
        )
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/table/stats")
def api_table_stats():
    database = (request.args.get("database") or "").strip()
    schema = (request.args.get("schema") or "").strip()
    table = (request.args.get("table") or "").strip()
    try:
        return jsonify({"ok": True, **_client().table_stats(database, schema, table)})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/table/page")
def api_table_page():
    database = (request.args.get("database") or "").strip()
    schema = (request.args.get("schema") or "").strip()
    table = (request.args.get("table") or "").strip()
    try:
        page_size = int(request.args.get("page_size") or 200)
    except (TypeError, ValueError):
        page_size = 200
    try:
        offset = int(request.args.get("offset") or 0)
    except (TypeError, ValueError):
        offset = 0
    after = request.args.get("after")
    seek = request.args.get("seek")
    after_obj = None
    seek_obj = None
    if after:
        try:
            after_obj = json.loads(after)
        except Exception:
            return jsonify({"ok": False, "error": "Parameter after tidak valid.", "hint": None}), 400
    if seek:
        try:
            seek_obj = json.loads(seek)
        except Exception:
            return jsonify({"ok": False, "error": "Parameter seek tidak valid.", "hint": None}), 400
    try:
        started = time.time()
        data = _client().page_table(
            database,
            schema,
            table,
            page_size=page_size,
            after=after_obj,
            seek=seek_obj,
            offset=offset,
        )
        data["elapsed_ms"] = int((time.time() - started) * 1000)
        return jsonify({"ok": True, **data})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/export", methods=["POST"])
def api_export_start():
    payload = request.get_json(silent=True) or {}
    item = _active_item()
    if not item:
        return _error_payload(ClientError("Belum terhubung ke SQL Server."))
    try:
        chunk_rows = int(payload.get("chunk_rows") or 0)
    except (TypeError, ValueError):
        chunk_rows = 0
    try:
        chunk_bytes = int(payload.get("chunk_bytes") or 0)
    except (TypeError, ValueError):
        chunk_bytes = 0
    try:
        job = start_export(
            sid=_sid(),
            cfg=item["cfg"],
            database=str(payload.get("database") or "").strip(),
            schema=str(payload.get("schema") or "").strip(),
            table=str(payload.get("table") or "").strip(),
            columns=list(payload.get("columns") or []),
            where=str(payload.get("where") or ""),
            chunk_rows=chunk_rows,
            chunk_bytes=chunk_bytes,
            use_gzip=bool(payload.get("gzip", True)),
            nolock=bool(payload.get("nolock", True)),
            folder=str(payload.get("folder") or ""),
        )
        return jsonify({"ok": True, "job": job.public()})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/export/database", methods=["POST"])
def api_export_database():
    payload = request.get_json(silent=True) or {}
    item = _active_item()
    if not item:
        return _error_payload(ClientError("Belum terhubung ke SQL Server."))
    try:
        chunk_rows = int(payload.get("chunk_rows") or 0)
    except (TypeError, ValueError):
        chunk_rows = 0
    try:
        chunk_bytes = int(payload.get("chunk_bytes") or 0)
    except (TypeError, ValueError):
        chunk_bytes = 0
    tables = []
    for entry in payload.get("tables") or []:
        if not isinstance(entry, dict):
            continue
        schema = str(entry.get("schema") or "").strip()
        name = str(entry.get("name") or "").strip()
        if schema and name:
            tables.append({"schema": schema, "name": name})
    try:
        job = start_export_database(
            sid=_sid(),
            cfg=item["cfg"],
            database=str(payload.get("database") or "").strip(),
            tables=tables,
            include_views=bool(payload.get("include_views")),
            include_system=bool(payload.get("include_system")),
            chunk_rows=chunk_rows,
            chunk_bytes=chunk_bytes,
            use_gzip=bool(payload.get("gzip", True)),
            nolock=bool(payload.get("nolock", True)),
            folder=str(payload.get("folder") or ""),
        )
        return jsonify({"ok": True, "job": job.public()})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/exports")
def api_exports():
    return jsonify({"ok": True, "jobs": list_jobs(_sid())})


@app.route("/api/export/<job_id>")
def api_export_status(job_id):
    try:
        return jsonify({"ok": True, "job": get_job(_sid(), job_id).public()})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/export/<job_id>/cancel", methods=["POST"])
def api_export_cancel(job_id):
    try:
        return jsonify({"ok": True, "job": cancel_job(_sid(), job_id).public()})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/export/<job_id>/parts/<name>")
def api_export_part(job_id, name):
    try:
        job = get_job(_sid(), job_id)
        path = job.part_path(name)
        download_name = "%s_%s" % (job.table, name)
        return send_file(path, as_attachment=True, download_name=download_name)
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/fs")
def api_fs():
    try:
        return jsonify({"ok": True, **list_folders(request.args.get("path") or "")})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/fs/pick", methods=["POST"])
def api_fs_pick():
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify({"ok": True, **pick_folder(str(payload.get("path") or ""))})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/backup", methods=["POST"])
def api_backup_start():
    payload = request.get_json(silent=True) or {}
    item = _active_item()
    if not item:
        return _error_payload(ClientError("Belum terhubung ke SQL Server."))
    try:
        chunk_bytes = int(payload.get("chunk_bytes") or 0)
    except (TypeError, ValueError):
        chunk_bytes = 0
    try:
        job = start_backup(
            sid=_sid(),
            cfg=item["cfg"],
            database=str(payload.get("database") or "").strip(),
            folder=str(payload.get("folder") or ""),
            chunk_bytes=chunk_bytes,
            compress=bool(payload.get("compress", True)),
        )
        return jsonify({"ok": True, "job": job.public()})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/preview")
def api_preview():
    database = (request.args.get("database") or "").strip()
    schema = (request.args.get("schema") or "").strip()
    table = (request.args.get("table") or "").strip()
    try:
        top = int(request.args.get("top") or 200)
    except (TypeError, ValueError):
        top = 200
    try:
        started = time.time()
        data = _client().preview_table(database, schema, table, top=top)
        stats = _client().table_stats(database, schema, table)
        data["elapsed_ms"] = int((time.time() - started) * 1000)
        data["sql"] = _client().select_script(
            schema, table, database=database, keys=stats.get("keys"), page_size=top
        )
        return jsonify({"ok": True, **data})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/script/select")
def api_script_select():
    schema = (request.args.get("schema") or "").strip()
    table = (request.args.get("table") or "").strip()
    try:
        return jsonify({"ok": True, "sql": _client().select_script(schema, table, database=request.args.get("database") or None)})
    except Exception as exc:
        return _error_payload(exc)


@app.route("/api/cancel", methods=["POST"])
def api_cancel():
    cancelled = 0
    item = _active_item()
    client = item.get("client") if item else None
    if client is not None:
        try:
            result = client.cancel_running()
            cancelled += int(result.get("cancelled") or 0)
        except Exception:
            pass
    return jsonify({"ok": True, "cancelled": cancelled})


@app.route("/api/query", methods=["POST"])
def api_query():
    payload = request.get_json(silent=True) or {}
    sql = str(payload.get("sql") or "")
    database = str(payload.get("database") or "").strip() or None
    try:
        max_rows = int(payload.get("max_rows") or 1000)
    except (TypeError, ValueError):
        max_rows = 1000
    try:
        started = time.time()
        data = _client().execute(sql, max_rows=max_rows, database=database)
        data["elapsed_ms"] = int((time.time() - started) * 1000)
        return jsonify({"ok": True, **data})
    except Exception as exc:
        return _error_payload(exc)


def main():
    host = os.environ.get("SQLSM_HOST", "127.0.0.1")
    port = int(os.environ.get("SQLSM_PORT", "5050"))
    if host not in ("127.0.0.1", "localhost", "::1") and os.environ.get("SQLSM_ALLOW_REMOTE") != "1":
        print("PERINGATAN: SQLSM_HOST=%s bukan loopback. Set SQLSM_ALLOW_REMOTE=1 jika memang sengaja." % host)
    print("")
    print("SQL Server Management")
    print("Buka di browser: http://%s:%s" % (host, port))
    print("Tekan Ctrl+C untuk berhenti.")
    print("")
    app.run(host=host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
