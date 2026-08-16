# -*- coding: utf-8 -*-
import os
import re
import string
import subprocess
import sys

from sqlsm.client import ClientError

_UNSAFE = re.compile(r'[<>:"|?*]')


def default_data_folder():
    # type: () -> str
    if os.name == "nt":
        return "C:\\SQLSM-Data"
    return os.path.join(os.path.expanduser("~"), "sqlsm-data")


def existing_start_dir(path=""):
    # type: (str) -> str
    text = (path or "").strip()
    if text and os.path.isdir(text):
        return os.path.abspath(text)
    fallback = default_data_folder()
    try:
        if not os.path.isdir(fallback):
            os.makedirs(fallback)
        return os.path.abspath(fallback)
    except Exception:
        home = os.path.expanduser("~")
        if os.path.isdir(home):
            return home
        return os.getcwd()


def pick_folder(start=""):
    # type: (str) -> dict
    start = existing_start_dir(start)
    if sys.platform == "darwin":
        script = (
            'POSIX path of (choose folder with prompt "Pilih folder tujuan" '
            'default location POSIX file "%s")' % start.replace('"', '\\"')
        )
        try:
            raw = subprocess.check_output(["osascript", "-e", script], stderr=subprocess.STDOUT)
        except subprocess.CalledProcessError:
            raise ClientError("Pemilihan folder dibatalkan.")
        path = raw.decode("utf-8", "replace").strip()
        if not path:
            raise ClientError("Pemilihan folder dibatalkan.")
        return {"path": os.path.abspath(path)}
    if os.name == "nt":
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$d.Description = 'Pilih folder tujuan'; "
            "$d.ShowNewFolderButton = $true; "
            "$d.SelectedPath = '%s'; "
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
            "Write-Output $d.SelectedPath } else { exit 2 }"
        ) % start.replace("'", "''")
        try:
            raw = subprocess.check_output(
                ["powershell", "-STA", "-NoProfile", "-Command", ps],
                stderr=subprocess.STDOUT,
            )
        except (subprocess.CalledProcessError, OSError):
            raise ClientError("Pemilihan folder dibatalkan.")
        lines = [line.strip() for line in raw.decode("utf-8", "replace").splitlines() if line.strip()]
        if not lines:
            raise ClientError("Pemilihan folder dibatalkan.")
        return {"path": os.path.abspath(lines[-1])}
    raise ClientError(
        "Dialog folder tidak tersedia.",
        "Ketik path foldernya langsung di kotak, misalnya %s" % start,
    )


def safe_name(name):
    # type: (str) -> str
    text = _UNSAFE.sub("_", str(name or "data").strip()) or "data"
    return text.replace("/", "_").replace("\\", "_")


def normalize_dir(path):
    # type: (str) -> str
    text = (path or "").strip()
    if not text:
        text = default_data_folder()
    return os.path.abspath(os.path.expanduser(text))


def ensure_writable_dir(path):
    # type: (str) -> str
    folder = normalize_dir(path)
    try:
        if not os.path.isdir(folder):
            os.makedirs(folder)
        probe = os.path.join(folder, ".sqlsm-write-test")
        with open(probe, "w") as handle:
            handle.write("ok")
        os.remove(probe)
    except Exception as exc:
        raise ClientError(
            "Folder tidak bisa ditulis: %s" % folder,
            "Buat foldernya dulu, atau pilih disk yang bisa diakses akun Windows / SQL Server. Detail: %s" % exc,
        )
    return folder


def folder_shortcuts():
    # type: () -> list
    home = os.path.expanduser("~")
    candidates = [
        ("Home", home),
        ("Desktop", os.path.join(home, "Desktop")),
        ("Documents", os.path.join(home, "Documents")),
        ("Data app", default_data_folder()),
    ]
    if os.name == "nt":
        for letter in string.ascii_uppercase:
            root = letter + ":\\"
            if os.path.isdir(root):
                candidates.append(("Disk " + letter, root))
    elif sys.platform == "darwin" and os.path.isdir("/Volumes"):
        candidates.append(("Volumes", "/Volumes"))
    items = []
    seen = set()
    for name, path in candidates:
        path = os.path.abspath(os.path.expanduser(path))
        if path in seen or not os.path.isdir(path):
            continue
        seen.add(path)
        items.append({"name": name, "path": path, "kind": "shortcut"})
    return items


def list_folders(path):
    # type: (str) -> dict
    text = (path or "").strip()
    if os.name == "nt" and (not text or text == "\\"):
        return {"path": "", "parent": "", "entries": folder_shortcuts()}
    if not text:
        text = existing_start_dir("")
    folder = normalize_dir(text)
    if not os.path.isdir(folder):
        folder = existing_start_dir("")
    parent = os.path.dirname(folder.rstrip("\\/"))
    if os.name == "nt" and len(folder) <= 3 and folder[1:3] == ":\\":
        parent = ""
    if sys.platform != "win32" and folder == os.path.abspath("/"):
        parent = ""
    entries = []
    try:
        names = os.listdir(folder)
    except Exception as exc:
        raise ClientError("Tidak bisa membaca folder.", str(exc))
    for name in sorted(names, key=lambda item: item.lower()):
        if name.startswith(".") and name not in (".", ".."):
            continue
        full = os.path.join(folder, name)
        if os.path.isdir(full):
            entries.append({"name": name, "path": full, "kind": "dir"})
    return {
        "path": folder,
        "parent": parent,
        "entries": entries,
        "shortcuts": folder_shortcuts(),
    }
