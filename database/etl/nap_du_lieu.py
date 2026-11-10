"""
BƯỚC 1 — NẠP DỮ LIỆU HIỆN TRẠNG (GEE) VÀO CSDL PostgreSQL/PostGIS (schema vientham)
====================================================================================
    python database/etl/nap_du_lieu.py --tiff "D:/data tiff" --ref "<thư mục web nhóm>" --tu-nam 2017

  1. Tạo lại schema vientham từ database/schema.sql
  2. Nạp ranh giới TP.HCM mới (saigon.geojson) và 168 phường/xã/đặc khu (TPHCM_Phuong_Xa.geojson)
  3. Dựng lưới ô 480 m (gộp khối 16×16 pixel 30 m của ảnh GEE gốc, EPSG:32648)
  4. Với mỗi ảnh GeoTIFF LST/NDVI/TVDI từ năm --tu-nam:
       • giá trị trung bình từng ô  -> quan_trac_o
       • thống kê vùng từng phường (pixel 30 m) -> thong_ke_phuong
       • ảnh PNG 8-bit cho web (tự tạo từ chính GeoTIFF; --png-web-nhom để chép ảnh của web nhóm) -> anh_raster
  5. Lưu khối dữ liệu ô × tháng ra database/etl/cache/cube.npz cho bước dự báo
"""
import argparse
import glob
import json
import os
import re
import shutil
import time

from chung import CACHE, ENCODE_RANGE, PUBLIC, ROOT, SCHEMA, VALID_RANGE, connect, copy_rows, ky, log_step  # noqa: I001 (phải đứng trước rasterio)

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform as warp_transform, transform_bounds, transform_geom


FILE_RE = re.compile(r'(LST|NDVI|TDVI|TVDI)_HCMC_(\d{4})_(\d{2})\.tif$', re.IGNORECASE)
BLOCK = 16            # 16 × 30 m = 480 m
MIN_CELL_VALID = 0.30  # ô cần ≥ 30 % pixel hợp lệ (không mây)
MIN_WARD_COVER = 0.10  # phường cần ≥ 10 % pixel hợp lệ
WEB_RES = 120.0
DEFAULT_REF = r'D:\Mon_ThayTuan\test\Bai_Tap_Nhom_1-20260927T124749Z-1-001\Bai_Tap_Nhom_1'


def find_rasters(input_dir, tu_nam):
    found = {}
    for path in glob.glob(os.path.join(input_dir, '**', '*.tif'), recursive=True):
        m = FILE_RE.search(os.path.basename(path))
        if not m or int(m.group(2)) < tu_nam:
            continue
        idx = 'TVDI' if m.group(1).upper() == 'TDVI' else m.group(1).upper()
        found.setdefault(idx, {})[f'{m.group(2)}-{m.group(3)}'] = path
    return {k: dict(sorted(v.items())) for k, v in sorted(found.items())}


def khu_vuc_cu(ma_xa):
    """Mã đơn vị hành chính cũ: Bình Dương < 26000 ≤ Bà Rịa – Vũng Tàu < 26734 ≤ TP.HCM."""
    m = int(ma_xa)
    if m < 26000:
        return 'Bình Dương cũ'
    if m < 26734:
        return 'Bà Rịa – Vũng Tàu cũ'
    return 'TP.HCM cũ'


# ---------------------------------------------------------------------------
def tao_schema(cur):
    with open(os.path.join(ROOT, 'database', 'schema.sql'), encoding='utf-8') as f:
        cur.execute(f.read())
    print('✓ Đã tạo schema vientham')


def nap_ranh_gioi(cur, ref):
    with open(os.path.join(ref, 'saigon.geojson'), encoding='utf-8') as f:
        prov = json.load(f)['features'][0]
    p = prov['properties']
    cur.execute(f"""
        INSERT INTO {SCHEMA}.ranh_gioi_tinh (ma_tinh, ten, ten_day_du, dien_tich_km2, geom, geom_don_gian)
        SELECT %s, %s, %s, %s, g, ST_Multi(ST_SimplifyPreserveTopology(g, 0.0004))
          FROM (SELECT ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))) AS g) t
    """, (p.get('code', '79'), p.get('name'), p.get('fullName'), p.get('areaKm2'), json.dumps(prov['geometry'])))

    with open(os.path.join(ref, 'TPHCM_Phuong_Xa.geojson'), encoding='utf-8') as f:
        feats = json.load(f)['features']
    for ft in feats:
        q = ft['properties']
        cur.execute(f"""
            INSERT INTO {SCHEMA}.don_vi_hanh_chinh
                (ma_xa, ten_xa, loai, ma_tinh, khu_vuc_cu, dtich_km2, dan_so, matdo_km2, sap_nhap, tru_so, geom, geom_don_gian, tam)
            SELECT %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, g,
                   ST_Multi(ST_SimplifyPreserveTopology(g, 0.00015)), ST_PointOnSurface(g)
              FROM (SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 3)) AS g) t
        """, (q['ma_xa'], q['ten_xa'], q['loai'], q.get('ma_tinh', '79'), khu_vuc_cu(q['ma_xa']), q.get('dtich_km2'),
              q.get('dan_so'), q.get('matdo_km2'), q.get('sap_nhap'), q.get('tru_so'), json.dumps(ft['geometry'])))
    print(f'✓ Ranh giới tỉnh + {len(feats)} phường/xã/đặc khu')
    return feats


# ---------------------------------------------------------------------------
def block_view(a, nr, nc):
    return a[:nr * BLOCK, :nc * BLOCK].reshape(nr, BLOCK, nc, BLOCK)


def dung_luoi(cur, feats, src):
    """Gán nhãn phường cho pixel 30 m và dựng lưới ô 480 m nằm trong TP."""
    shapes = [(transform_geom('EPSG:4326', src.crs, ft['geometry']), i + 1) for i, ft in enumerate(feats)]
    labels = rasterize(shapes, out_shape=(src.height, src.width), transform=src.transform, fill=0, dtype='int16')
    nr, nc = src.height // BLOCK, src.width // BLOCK
    lb = block_view(labels, nr, nc).transpose(0, 2, 1, 3).reshape(nr, nc, BLOCK * BLOCK)
    inside = (lb > 0).mean(axis=2)
    # phường chiếm nhiều pixel nhất trong ô
    n_w = len(feats)
    counts = np.zeros((nr, nc, n_w + 1), dtype=np.int16)
    ri, ci = np.arange(nr)[:, None], np.arange(nc)[None, :]
    for k in range(BLOCK * BLOCK):
        counts[ri, ci, lb[:, :, k]] += 1      # mỗi (hàng, cột) xuất hiện đúng 1 lần mỗi vòng nên cộng trực tiếp được
    counts[:, :, 0] = 0
    major = counts.argmax(axis=2)
    keep = inside >= 0.5
    rows, cols = np.nonzero(keep)
    t = src.transform
    xs = t.c + (cols * BLOCK + BLOCK / 2) * t.a
    ys = t.f + (rows * BLOCK + BLOCK / 2) * t.e
    lons, lats = warp_transform(src.crs, 'EPSG:4326', xs.tolist(), ys.tolist())
    ward_of = major[rows, cols]
    cell_id = np.full((nr, nc), -1, dtype=np.int32)
    out = []
    for i, (r, c, x, y, lo, la, w) in enumerate(zip(rows, cols, xs, ys, lons, lats, ward_of)):
        cell_id[r, c] = i + 1
        ma_xa = feats[w - 1]['properties']['ma_xa'] if w > 0 else None
        out.append((i + 1, int(r), int(c), round(float(x), 2), round(float(y), 2), round(lo, 6), round(la, 6),
                    BLOCK * abs(t.a), ma_xa if ma_xa else None, f'SRID=4326;POINT({lo:.6f} {la:.6f})'))
    copy_rows(cur, 'luoi_o', ['ma_o', 'hang', 'cot', 'x_utm', 'y_utm', 'kinh_do', 'vi_do', 'do_phan_giai_m', 'ma_xa', 'geom'], out)
    print(f'✓ Lưới {nr}×{nc} khối → {len(out)} ô 480 m nằm trong TP.HCM')
    return labels, cell_id, rows, cols, np.array(ward_of)


# ---------------------------------------------------------------------------
def tao_png(src, arr, valid, idx, out_path):
    """Tạo PNG 8-bit EPSG:3857 (~120 m) giống cách web nhóm đã làm — chỉ dùng khi web nhóm chưa có ảnh."""
    lo, hi = ENCODE_RANGE[idx]
    dst_t, dw, dh = calculate_default_transform(src.crs, 'EPSG:3857', src.width, src.height, *src.bounds, resolution=WEB_RES)
    src_arr = np.where(valid, arr, np.nan).astype('float32')
    dst = np.full((dh, dw), np.nan, dtype='float32')
    reproject(src_arr, dst, src_transform=src.transform, src_crs=src.crs, dst_transform=dst_t, dst_crs='EPSG:3857',
              resampling=Resampling.average, src_nodata=np.nan, dst_nodata=np.nan)
    enc = np.zeros((dh, dw), dtype='uint8')
    good = np.isfinite(dst)
    enc[good] = np.clip(np.round((dst[good] - lo) / (hi - lo) * 254) + 1, 1, 255).astype('uint8')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Image.fromarray(enc, mode='L').save(out_path, optimize=True)


def xu_ly_anh(cur, idx, ym, path, ref, labels, ward_px, feats, cell_id, rows, cols, overlay):
    with rasterio.open(path) as src:
        arr = src.read(1)
        nod = src.nodata
        lo_v, hi_v = VALID_RANGE[idx]
        valid = np.isfinite(arr) & (arr >= lo_v) & (arr <= hi_v)
        if nod is not None:
            valid &= arr != nod
        nr, nc = cell_id.shape

        # --- 1. giá trị ô 480 m
        a = np.where(valid, arr, 0).astype('float64')
        s = block_view(a, nr, nc).sum(axis=(1, 3))
        n = block_view(valid, nr, nc).sum(axis=(1, 3))
        frac = n / (BLOCK * BLOCK)
        mean = np.divide(s, n, out=np.full_like(s, np.nan), where=n > 0)
        cell_vals = np.full(len(rows), np.nan, dtype='float32')
        sel = frac[rows, cols] >= MIN_CELL_VALID
        cell_vals[sel] = mean[rows, cols][sel]
        k = ky(ym)
        copy_rows(cur, 'quan_trac_o', ['ma_chi_so', 'ma_ky', 'ma_o', 'gia_tri', 'ty_le_hop_le'],
                  ((idx, k, int(cell_id[r, c]), f'{mean[r, c]:.4f}', f'{frac[r, c]:.3f}')
                   for r, c, ok in zip(rows, cols, sel) if ok))

        # --- 2. thống kê vùng theo phường (pixel 30 m)
        in_w = valid & (labels > 0)
        lab = labels[in_w]
        vals = arr[in_w].astype('float64')
        nw = len(feats)
        cnt = np.bincount(lab, minlength=nw + 1)
        sm = np.bincount(lab, weights=vals, minlength=nw + 1)
        sq = np.bincount(lab, weights=vals * vals, minlength=nw + 1)
        # phân vị / min / max trên mẫu 60 m (lấy 1/4 pixel) cho nhanh
        sub = in_w[::2, ::2]
        lab2 = labels[::2, ::2][sub]
        val2 = arr[::2, ::2][sub]
        order = np.lexsort((val2, lab2))
        lab2, val2 = lab2[order], val2[order]
        starts = np.searchsorted(lab2, np.arange(nw + 2))
        rows_tk = []
        for w in range(1, nw + 1):
            if not cnt[w]:
                continue
            cov = cnt[w] / max(ward_px[w], 1)
            if cov < MIN_WARD_COVER:
                continue
            m = sm[w] / cnt[w]
            sd = np.sqrt(max(sq[w] / cnt[w] - m * m, 0))
            seg = val2[starts[w]:starts[w + 1]]
            if seg.size:
                mn, mx, p10, p90 = seg[0], seg[-1], np.percentile(seg, 10), np.percentile(seg, 90)
            else:
                mn = mx = p10 = p90 = m
            rows_tk.append((feats[w - 1]['properties']['ma_xa'], idx, k, 'GEE', None, f'{m:.4f}', f'{sd:.4f}', f'{mn:.4f}',
                            f'{mx:.4f}', f'{p10:.4f}', f'{p90:.4f}', int(cnt[w]), f'{min(cov, 1):.3f}'))
        copy_rows(cur, 'thong_ke_phuong', ['ma_xa', 'ma_chi_so', 'ma_ky', 'ma_loai', 'ma_phien', 'tb', 'do_lech', 'nho_nhat',
                                            'lon_nhat', 'p10', 'p90', 'so_mau', 'ty_le_phu'], rows_tk)

        # --- 3. ảnh PNG web + danh mục ảnh
        rel = f'data/raster/{idx}/{idx}_{ym.replace("-", "_")}.png'
        dst = os.path.join(PUBLIC, rel.replace('/', os.sep))
        ref_png = os.path.join(ref, 'data', 'raster', idx, os.path.basename(dst)) if ref else ''
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if ref and os.path.exists(ref_png):
            shutil.copyfile(ref_png, dst)
        else:
            tao_png(src, arr, valid, idx, dst)
        city = arr[::2, ::2][sub]
        p05, p95 = (np.percentile(city, [5, 95]) if city.size else (None, None))
        w_, s_, e_, n_ = overlay['bounds']
        lo_e, hi_e = ENCODE_RANGE[idx]
        cur.execute(f"""
            INSERT INTO {SCHEMA}.anh_raster (ma_chi_so, ma_ky, ma_loai, nguon_anh, do_phan_giai_m, he_toa_do, duong_dan_goc,
                 duong_dan_web, rong_px, cao_px, ma_hoa_min, ma_hoa_max, pham_vi, ty_le_phu, gia_tri_tb, gia_tri_p05, gia_tri_p95)
            VALUES (%s,%s,'GEE',%s,%s,%s,%s,%s,%s,%s,%s,%s,ST_MakeEnvelope(%s,%s,%s,%s,4326),%s,%s,%s,%s)
        """, (idx, k, 'Google Earth Engine (ảnh 30 m)', abs(src.transform.a), src.crs.to_epsg(), path.replace('\\', '/'), rel,
              overlay['width'], overlay['height'], lo_e, hi_e, w_, s_, e_, n_,
              float(in_w.sum() / max(ward_px[1:].sum(), 1)), float(vals.mean()) if vals.size else None,
              float(p05) if p05 is not None else None, float(p95) if p95 is not None else None))
    return cell_vals, len(rows_tk)


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description='Nạp dữ liệu hiện trạng GEE vào CSDL vientham')
    ap.add_argument('--tiff', default='D:/data tiff', help='Thư mục ảnh GeoTIFF xuất từ GEE (quét đệ quy)')
    ap.add_argument('--ref', default=DEFAULT_REF, help='Thư mục web nhóm (chứa saigon.geojson, TPHCM_Phuong_Xa.geojson, data/raster)')
    ap.add_argument('--tu-nam', type=int, default=2017)
    ap.add_argument('--png-web-nhom', action='store_true',
                    help='Chép ảnh PNG có sẵn của web nhóm thay vì tự tạo (mặc định tự tạo để khớp đúng ảnh GeoTIFF đã nạp)')
    args = ap.parse_args()

    t0 = time.time()
    rasters = find_rasters(args.tiff, args.tu_nam)
    if not rasters:
        raise SystemExit(f'Không tìm thấy ảnh GeoTIFF hợp lệ trong {args.tiff}')
    for k, v in rasters.items():
        print(f'{k}: {len(v)} ảnh ({next(iter(v))} → {list(v)[-1]})')

    conn = connect()
    cur = conn.cursor()
    tao_schema(cur)
    feats = nap_ranh_gioi(cur, args.ref)
    conn.commit()

    first = next(iter(next(iter(rasters.values())).values()))
    with rasterio.open(first) as src:
        grid_key = (src.crs.to_string(), tuple(src.transform), src.width, src.height)
        labels, cell_id, rows, cols, ward_of = dung_luoi(cur, feats, src)
        dst_t, dw, dh = calculate_default_transform(src.crs, 'EPSG:3857', src.width, src.height, *src.bounds, resolution=WEB_RES)
        bw, bs, be, bn = transform_bounds('EPSG:3857', 'EPSG:4326', dst_t.c, dst_t.f + dst_t.e * dh, dst_t.c + dst_t.a * dw, dst_t.f)
        overlay = {'width': dw, 'height': dh, 'bounds': [round(bw, 6), round(bs, 6), round(be, 6), round(bn, 6)],
                   'transform3857': list(dst_t)[:6]}
        src_transform, src_crs, src_shape = list(src.transform)[:6], src.crs.to_string(), (src.height, src.width)
    ward_px = np.bincount(labels.ravel(), minlength=len(feats) + 1)
    conn.commit()

    cube = {}
    for idx, months in rasters.items():
        vals, ms = [], []
        for ym, path in months.items():
            t1 = time.time()
            with rasterio.open(path) as s:
                if (s.crs.to_string(), tuple(s.transform), s.width, s.height) != grid_key:
                    print(f'  ! Bỏ qua {path}: lưới ảnh khác các ảnh còn lại')
                    continue
            cv, nwd = xu_ly_anh(cur, idx, ym, path, args.ref if args.png_web_nhom else None, labels, ward_px, feats, cell_id, rows, cols, overlay)
            conn.commit()
            vals.append(cv)
            ms.append(ym)
            print(f'  {idx} {ym}: {np.isfinite(cv).sum()} ô, {nwd} phường  ({time.time() - t1:.1f}s)')
        cube[idx] = (ms, np.stack(vals) if vals else np.zeros((0, len(rows)), 'float32'))

    log_step(cur, 'nap_hien_trang_gee', {
        'tu_nam': args.tu_nam, 'nguon_tiff': args.tiff, 'so_o': int(len(rows)), 'kich_thuoc_o_m': BLOCK * 30,
        'so_anh': {k: len(v[0]) for k, v in cube.items()}, 'overlay': overlay, 'thoi_gian_s': round(time.time() - t0, 1)})
    conn.commit()

    os.makedirs(CACHE, exist_ok=True)
    np.savez_compressed(os.path.join(CACHE, 'cube.npz'),
                        rows=rows, cols=cols, ward_of=ward_of, cell_shape=np.array(cell_id.shape),
                        src_transform=np.array(src_transform), src_shape=np.array(src_shape),
                        **{f'{k}_months': np.array(v[0]) for k, v in cube.items()},
                        **{f'{k}_vals': v[1] for k, v in cube.items()})
    with open(os.path.join(CACHE, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump({'overlay': overlay, 'src_crs': src_crs, 'block': BLOCK,
                   'ma_xa': [ft['properties']['ma_xa'] for ft in feats]}, f, ensure_ascii=False)

    cur.execute(f'ANALYZE')
    conn.commit()
    conn.close()
    print(f'\nXong bước 1 sau {time.time() - t0:.0f}s. Tiếp theo: python database/etl/du_bao_lst.py')


if __name__ == '__main__':
    main()
