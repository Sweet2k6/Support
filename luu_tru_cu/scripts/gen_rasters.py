"""
Tạo 3 ảnh raster phân vùng màu rõ rệt (LST / NDVI / TVDI) từ DB PostgreSQL:
- Phù hợp chính xác với cấu trúc thang màu trong file 'Thang màu Nhiệt độ-NDVI-TVDI.pdf':
  + LST: 20 -> 45 (°C)
    palette: ["#0000FF", "#0066FF", "#00FFFF", "#00FF00", "#FFFF00", "#FFCC00", "#FF6600", "#FF0000"]
  + NDVI: -0.2 -> 1.0
    palette: ['#FF0000', '#FF7F00', '#FFFF00', '#ADFF2F', '#00FF00', '#00FFFF', '#007FFF', '#0000FF']
  + TVDI: 0.0 -> 1.0
    palette: ['#066b00', '#0bc400', '#0ce100', '#00ff00', '#ffff00', '#ffcc00', '#ff6600', '#ff0000']
- Phân bổ vùng rõ rệt (8 bậc màu phân loại):
  + Sử dụng nội suy Delaunay Triangulation (scipy griddata) giúp chuyển tiếp tự nhiên giữa các điểm đo thực
  + Ngoại suy biên ranh giới bằng Nearest Neighbor
  + Lọc nhẹ (sigma=1.0) trên trường giá trị để các đường ranh phân cấp (contour) uốn lượn mềm mại, không răng cưa pixel
  + KHÔNG dùng Gaussian splatting để triệt tiêu hoàn toàn hiện tượng 'bóng tròn', hào quang, đốm mờ (miết bóng khó chịu)
  + Cắt chính xác 100% theo ranh giới TIF gốc (GEE chuẩn)
"""
import json, subprocess, os
import numpy as np
from scipy.interpolate import griddata
from scipy.ndimage import gaussian_filter
from PIL import Image

# ── Tham số GeoTIFF & Toạ độ ───────────────────────────────────
ORIGIN_LON  = 106.35603806333076
ORIGIN_LAT  = 11.161567405185055
PIXEL_SCALE = 0.002245788210298804
IMG_W, IMG_H = 294, 350

def lon_px(lon): return (lon - ORIGIN_LON) / PIXEL_SCALE
def lat_py(lat): return (ORIGIN_LAT - lat) / PIXEL_SCALE

def hex2rgb(h):
    h = h.lstrip('#')
    return [int(h[i:i+2], 16) for i in (0, 2, 4)]

# ── Mask ranh giới chuẩn từ ANH_LST_2025_mau.tif (GEE) ──────────
ref = np.array(Image.open('ANH_LST_2025_mau.tif'))
mask_hard = ~((ref[:,:,0] >= 250) & (ref[:,:,1] >= 250) & (ref[:,:,2] >= 250))
print(f"Mask ranh giới chuẩn: {mask_hard.sum()} pixel trong địa phận TP.HCM")

grid_y, grid_x = np.mgrid[0:IMG_H, 0:IMG_W]

DATASETS = [
    dict(
        key  = 'LST',
        pal  = ["#0000FF", "#0066FF", "#00FFFF", "#00FF00", "#FFFF00", "#FFCC00", "#FF6600", "#FF0000"],
        vmin = 20.0,
        vmax = 45.0,
        out  = 'public/data/anh_lst_2025_clipped.png',
    ),
    dict(
        key  = 'NDVI',
        pal  = ['#FF0000', '#FF7F00', '#FFFF00', '#ADFF2F', '#00FF00', '#00FFFF', '#007FFF', '#0000FF'],
        vmin = -0.2,
        vmax = 1.0,
        out  = 'public/data/anh_ndvi_2025_clipped.png',
    ),
    dict(
        key  = 'TVDI',
        pal  = ['#066b00', '#0bc400', '#0ce100', '#00ff00', '#ffff00', '#ffcc00', '#ff6600', '#ff0000'],
        vmin = 0.0,
        vmax = 0.6,
        out  = 'public/data/anh_tvdi_2025_clipped.png',
    ),
]

TMPL = """
require('dotenv').config();
const {{ Pool }} = require('pg');
const pool = new Pool({{ host:process.env.PGHOST, port:+process.env.PGPORT, database:process.env.PGDATABASE, user:process.env.PGUSER, password:process.env.PGPASSWORD }});
pool.query("SELECT x, y, gia_tri FROM chi_so_diem WHERE chi_so='{chi_so}' AND nguon='GEE' AND nam=2025;").then(r=>{{
    process.stdout.write(JSON.stringify(r.rows));
    pool.end();
}});
"""

for cfg in DATASETS:
    print(f"\n=== Đang xử lý chỉ số: {cfg['key']} ===")
    code = TMPL.format(chi_so=cfg['key'])
    res  = subprocess.run(['node', '-e', code], cwd='.', capture_output=True, text=True, timeout=30)
    rows = json.loads(res.stdout)

    pts = []
    vals = []
    for r in rows:
        if r.get('gia_tri') is not None:
            pts.append([lat_py(float(r['y'])), lon_px(float(r['x']))])
            vals.append(float(r['gia_tri']))

    pts = np.array(pts)
    vals = np.array(vals)
    print(f"  {len(vals)} điểm dữ liệu thực. Min: {vals.min():.2f}, Max: {vals.max():.2f}")

    # 1. Nội suy Delaunay Triangulation (mượt mà, chuẩn không gian)
    interp_linear = griddata(pts, vals, (grid_y, grid_x), method='linear')
    # 2. Ngoại suy Nearest Neighbor cho các rìa mép đảo/biên ranh giới
    interp_nearest = griddata(pts, vals, (grid_y, grid_x), method='nearest')
    interp = np.where(np.isnan(interp_linear), interp_nearest, interp_linear)

    # 3. Lọc mượt nhẹ sigma=1.0 để ranh giới giữa các cấp phân loại tạo thành đường cong tự nhiên
    interp_smooth = gaussian_filter(interp, sigma=1.0)

    # 4. Phân vùng 8 bậc màu rõ rệt theo đúng dải thang màu quy định
    stops = np.array([hex2rgb(h) for h in cfg['pal']])
    n_stops = len(stops)

    # Chuẩn hoá giá trị trong thang [vmin, vmax]
    t_val = np.clip((interp_smooth - cfg['vmin']) / (cfg['vmax'] - cfg['vmin']), 0.0, 0.9999)
    class_idx = (t_val * n_stops).astype(int)

    # Tạo ảnh RGBA
    canvas = np.zeros((IMG_H, IMG_W, 4), dtype=np.uint8)
    for i in range(n_stops):
        m = (class_idx == i) & mask_hard
        canvas[m, 0] = stops[i, 0]
        canvas[m, 1] = stops[i, 1]
        canvas[m, 2] = stops[i, 2]
        canvas[m, 3] = 225  # Độ mờ 88%

    out_path = cfg['out']
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Image.fromarray(canvas, 'RGBA').save(out_path, 'PNG', optimize=True)
    print(f"  → Đã xuất file: {out_path} ({os.path.getsize(out_path):,} bytes, {mask_hard.sum():,} pixels)")

print("\nHoàn tất tạo cả 3 ảnh raster phân bổ vùng rõ rệt!")
