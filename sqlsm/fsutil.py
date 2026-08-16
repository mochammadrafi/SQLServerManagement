# -*- coding: utf-8 -*-
import os
import re
import string

from sqlsm.client import ClientError

_UNSAFE = re.compile(r'[<>:"|?*]')


def default_data_folder():
    # type: () -> str
    if os.name == "nt":
        return "C:\\SQLSM-Data"
    return os.path.join(os.path.expanduser("~"), "sqlsm-data")


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


def list_folders(path):
    # type: (str) -> dict
    text = (path or "").strip()
    if os.name == "nt" and (not text or text == "\\"):
        drives = []
        for letter in string.ascii_uppercase:
            root = letter + ":\\"
            if os.path.isdir(root):
                drives.append({"name": letter + ":", "path": root, "kind": "drive"})
        return {"path": "", "parent": "", "entries": drives}
    if not text:
        text = os.path.expanduser("~")
    folder = normalize_dir(text)
    if not os.path.isdir(folder):
        raise ClientError("Folder tidak ditemukan.", folder)
    parent = os.path.dirname(folder.rstrip("\\/"))
    if os.name == "nt" and len(folder) <= 3 and folder[1:3] == ":\\":
        parent = ""
    entries = []
    try:
        names = os.listdir(folder)
    except Exception as exc:
        raise ClientError("Tidak bisa membaca folder.", str(exc))
    for name in sorted(names, key=lambda item: item.lower()):
        full = os.path.join(folder, name)
        if os.path.isdir(full):
            entries.append({"name": name, "path": full, "kind": "dir"})
    return {"path": folder, "parent": parent, "entries": entries}
