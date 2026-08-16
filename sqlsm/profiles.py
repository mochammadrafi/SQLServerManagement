# -*- coding: utf-8 -*-
import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional

from sqlsm.crypto_util import decrypt_secret, encrypt_secret

STORE_DIR = os.path.join(os.path.expanduser("~"), ".sqlsm")
STORE_PATH = os.path.join(STORE_DIR, "connections.json")


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _load():
    # type: () -> List[Dict[str, Any]]
    if not os.path.isfile(STORE_PATH):
        return []
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return []
    items = data.get("profiles") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _save(items):
    # type: (List[Dict[str, Any]]) -> None
    if not os.path.isdir(STORE_DIR):
        os.makedirs(STORE_DIR)
    with open(STORE_PATH, "w", encoding="utf-8") as handle:
        json.dump({"profiles": items}, handle, ensure_ascii=False, indent=2)
    try:
        os.chmod(STORE_PATH, 0o600)
    except Exception:
        pass


def _key(item):
    return (
        str(item.get("server") or "").strip().lower(),
        str(item.get("port") or 1433),
        str(item.get("instance") or "").strip().lower(),
        str(item.get("auth") or "sql"),
        str(item.get("username") or "").strip().lower(),
        str(item.get("database") or "master").strip().lower(),
    )


def read_password(item):
    # type: (Dict[str, Any]) -> str
    raw = item.get("password") or ""
    if not raw:
        return ""
    return decrypt_secret(str(raw))


def public_profile(item):
    # type: (Dict[str, Any]) -> Dict[str, Any]
    auth = item.get("auth") or "sql"
    label = "%s · %s" % (item.get("server") or "server", item.get("database") or "master")
    if item.get("instance"):
        label = "%s\\%s · %s" % (item.get("server"), item.get("instance"), item.get("database") or "master")
    if auth == "windows":
        label += " · Windows"
    elif item.get("username"):
        label += " · " + item.get("username")
    return {
        "id": item.get("id"),
        "label": label,
        "server": item.get("server") or "",
        "port": item.get("port") or 1433,
        "instance": item.get("instance") or "",
        "auth": auth,
        "username": item.get("username") or "",
        "database": item.get("database") or "master",
        "encrypt": bool(item.get("encrypt")),
        "has_password": bool(item.get("password")),
        "remember_password": bool(item.get("remember_password")),
        "last_used": item.get("last_used") or "",
    }


def list_profiles():
    # type: () -> List[Dict[str, Any]]
    items = sorted(_load(), key=lambda item: item.get("last_used") or "", reverse=True)
    return [public_profile(item) for item in items]


def get_profile(profile_id):
    # type: (str) -> Optional[Dict[str, Any]]
    for item in _load():
        if item.get("id") == profile_id:
            return item
    return None


def upsert_profile(payload, remember_password=False):
    # type: (Dict[str, Any], bool) -> Dict[str, Any]
    items = _load()
    incoming = {
        "server": str(payload.get("server") or "").strip(),
        "port": int(payload.get("port") or 1433),
        "instance": str(payload.get("instance") or "").strip(),
        "auth": "windows" if payload.get("auth") == "windows" else "sql",
        "username": str(payload.get("username") or "").strip(),
        "database": str(payload.get("database") or "master").strip() or "master",
        "encrypt": bool(payload.get("encrypt")),
        "remember_password": bool(remember_password),
        "last_used": _now(),
    }
    password = str(payload.get("password") or "")
    match = None
    for item in items:
        if _key(item) == _key(incoming):
            match = item
            break
    if match is None:
        incoming["id"] = uuid.uuid4().hex[:12]
        if remember_password and password:
            incoming["password"] = encrypt_secret(password)
        items.insert(0, incoming)
        match = incoming
    else:
        match.update(incoming)
        if remember_password:
            if password:
                match["password"] = encrypt_secret(password)
        else:
            match.pop("password", None)
            match["remember_password"] = False
    _save(items)
    return public_profile(match)


def delete_profile(profile_id):
    # type: (str) -> bool
    items = _load()
    kept = [item for item in items if item.get("id") != profile_id]
    if len(kept) == len(items):
        return False
    _save(kept)
    return True
