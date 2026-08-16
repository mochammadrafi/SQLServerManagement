#!/bin/sh
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -U pip
  .venv/bin/pip install -r requirements.txt
  .venv/bin/pip install pymssql || echo "pymssql belum terpasang. UI tetap jalan; koneksi SQL butuh driver."
fi

.venv/bin/python run.py
