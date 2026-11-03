"""Tiện ích dùng chung cho các script ETL (đọc .env, kết nối PostgreSQL, COPY nhanh).

LƯU Ý: phải import module này TRƯỚC rasterio. Máy cài PostGIS thường đặt biến PROJ_LIB/GDAL_DATA
trỏ vào bản PROJ cũ của PostGIS -> rasterio báo "EPSG code is unknown". Ở đây ép rasterio dùng
bộ dữ liệu PROJ/GDAL đi kèm chính nó.
"""
import importlib.util
import io
import json
import os
import sys

_rio = importlib.util.find_spec('rasterio')
if _rio and _rio.submodule_search_locations:
    _base = _rio.submodule_search_locations[0]
    for _var, _sub in (('PROJ_DATA', 'proj_data'), ('PROJ_LIB', 'proj_data'), ('GDAL_DATA', 'gdal_data')):
        if os.path.isdir(os.path.join(_base, _sub)):
            os.environ[_var] = os.path.join(_base, _sub)

import psycopg2  # noqa: E402

sys.stdout.reconfigure(encoding='utf-8')

ETL_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(ETL_DIR, '..', '..'))
PUBLIC = os.path.join(ROOT, 'public')
CACHE = os.path.join(ETL_DIR, 'cache')
SCHEMA = 'vientham'

# Khoảng mã hoá ảnh PNG 8-bit (giống web nhóm: 0 = không có dữ liệu, 1..255 = giá trị)
ENCODE_RANGE = {'LST': (10.0, 70.0), 'NDVI': (-1.0, 1.0), 'TVDI': (-0.4, 1.1)}
# Miền giá trị hợp lệ để loại nhiễu
VALID_RANGE = {'LST': (-10.0, 80.0), 'NDVI': (-1.0, 1.0), 'TVDI': (-0.5, 1.5)}


def load_env():
    env = {}
    path = os.path.join(ROOT, '.env')
    if os.path.exists(path):
        with open(path, encoding='utf-8-sig') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip()
    for k in ('PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def connect():
    e = load_env()
    conn = psycopg2.connect(host=e.get('PGHOST', 'localhost'), port=int(e.get('PGPORT', 5432)),
                            dbname=e.get('PGDATABASE', 'webgis'), user=e.get('PGUSER', 'postgres'),
                            password=e.get('PGPASSWORD', ''))
    conn.autocommit = False
    return conn


def copy_rows(cur, table, columns, rows):
    """COPY danh sách tuple vào bảng (nhanh hơn INSERT hàng chục lần)."""
    buf = io.StringIO()
    for r in rows:
        buf.write('\t'.join('\\N' if v is None else str(v) for v in r))
        buf.write('\n')
    buf.seek(0)
    cur.copy_expert(f'COPY {SCHEMA}.{table} ({",".join(columns)}) FROM STDIN', buf)


def log_step(cur, buoc, chi_tiet):
    cur.execute(f'INSERT INTO {SCHEMA}.nhat_ky_nap (buoc, chi_tiet) VALUES (%s, %s)',
                (buoc, json.dumps(chi_tiet, ensure_ascii=False)))


def ky(ym):
    """'2026-04' -> 202604"""
    return int(ym[:4]) * 100 + int(ym[5:7])


def ym_of(k):
    return f'{k // 100}-{k % 100:02d}'
