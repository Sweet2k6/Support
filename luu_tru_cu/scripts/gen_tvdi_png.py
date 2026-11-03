"""
Tạo ảnh PNG TVDI 2025 từ DB PostgreSQL với thang màu chuẩn PDF.
TVDI palette: #066b00 → #0bc400 → #0ce100 → #00ff00 → #ffff00 → #ffcc00 → #ff6600 → #ff0000
Range: 0.0 – 1.0
"""
import os, sys
import numpy as np
from PIL import Image

# ── DB query qua psycopg2 or pg8000 (dùng subprocess node để lấy dữ liệu) ──
import subprocess, json

SCRIPT = """
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.PGHOST, port: +process.env.PGPORT, database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
pool.query("SELECT x, y, gia_tri FROM chi_so_diem WHERE chi_so='TVDI' AND nguon='GEE' AND nam=2025").then(r => {
  process.stdout.write(JSON.stringify(r.rows));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
"""

result = subprocess.run(['node', '-e', SCRIPT], cwd=os.path.join(os.path.dirname(__file__), '..'),
                        capture_output=True, text=True, timeout=30)
rows = json.loads(result.stdout)
print(f"Got {len(rows)} TVDI points from DB")

# ── Thang màu TVDI từ PDF ─────────────────────────────
TVDI_PALETTE_HEX = ['#066b00','#0bc400','#0ce100','#00ff00','#ffff00','#ffcc00','#ff6600','#ff0000']
def hex2rgb(h):
    h = h.lstrip('#')
    return [int(h[i:i+2], 16) for i in (0, 2, 4)]
TVDI_STOPS = [hex2rgb(h) for h in TVDI_PALETTE_HEX]

def ramp_color(stops, t):
    t = max(0.0, min(1.0, t))
    x = t * (len(stops) - 1)
    i = min(int(x), len(stops) - 2)
    f = x - i
    a, b = stops[i], stops[i+1]
    return [int(a[c] + (b[c]-a[c])*f) for c in range(3)]

# ── Thông số GeoTIFF chuẩn của LST/NDVI (cùng grid) ──
# Top-left origin: lon=106.35603806333076, lat=11.161567405185055
# pixel scale: 0.002245788210298804 (cả lon lẫn lat)
# Size: 294 × 350 (width × height)
ORIGIN_LON  = 106.35603806333076
ORIGIN_LAT  = 11.161567405185055
PIXEL_SCALE = 0.002245788210298804
IMG_W, IMG_H = 294, 350
TVDI_MIN, TVDI_MAX = 0.0, 1.0

# ── Tạo ảnh RGBA ────────────────────────────────────────
canvas = np.full((IMG_H, IMG_W, 4), [255, 255, 255, 0], dtype=np.uint8)  # fully transparent

for row in rows:
    lon, lat, val = float(row['x']), float(row['y']), float(row.get('gia_tri') or 0.0)
    if val is None:
        continue
    # Chuyển tọa độ → pixel
    col_f = (lon - ORIGIN_LON) / PIXEL_SCALE
    row_f = (ORIGIN_LAT - lat)  / PIXEL_SCALE
    col_px = int(round(col_f))
    row_px = int(round(row_f))
    if not (0 <= col_px < IMG_W and 0 <= row_px < IMG_H):
        continue
    t = (val - TVDI_MIN) / (TVDI_MAX - TVDI_MIN)
    r, g, b = ramp_color(TVDI_STOPS, t)
    # Vẽ 1 pixel (cùng cỡ lưới ~2 pixel để phủ kín)
    for dr in range(-1, 2):
        for dc in range(-1, 2):
            nr, nc = row_px+dr, col_px+dc
            if 0 <= nr < IMG_H and 0 <= nc < IMG_W:
                canvas[nr, nc] = [r, g, b, 230]

out_path = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'anh_tvdi_2025_clipped.png')
Image.fromarray(canvas, 'RGBA').save(out_path, 'PNG', optimize=True)
print(f"Saved: {out_path} ({os.path.getsize(out_path)} bytes)")
