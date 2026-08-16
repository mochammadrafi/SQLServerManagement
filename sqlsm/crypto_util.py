# -*- coding: utf-8 -*-
import base64
import hashlib
import os

_PREFIX = "enc:v1:"
_STORE_DIR = os.path.join(os.path.expanduser("~"), ".sqlsm")


def _derive_key():
    path = os.path.join(_STORE_DIR, "secret")
    raw = b""
    if os.path.isfile(path):
        try:
            raw = open(path, "rb").read().strip()
        except Exception:
            raw = b""
    if not raw:
        raw = os.urandom(32)
    return hashlib.sha256(raw).digest()


def encrypt_secret(text):
    # type: (str) -> str
    if not text:
        return ""
    key = _derive_key()
    data = text.encode("utf-8")
    out = bytearray()
    for index, byte in enumerate(data):
        out.append(byte ^ key[index % len(key)])
    return _PREFIX + base64.urlsafe_b64encode(bytes(out)).decode("ascii")


def decrypt_secret(blob):
    # type: (str) -> str
    if not blob:
        return ""
    text = str(blob)
    if not text.startswith(_PREFIX):
        return text
    key = _derive_key()
    try:
        data = base64.urlsafe_b64decode(text[len(_PREFIX) :].encode("ascii"))
    except Exception:
        return ""
    out = bytearray()
    for index, byte in enumerate(data):
        out.append(byte ^ key[index % len(key)])
    return bytes(out).decode("utf-8")
