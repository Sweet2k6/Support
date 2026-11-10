"""
BƯỚC 1b — LẤP CÁC THÁNG THIẾU ẢNH LST (NỘI SUY THEO MÙA, KRIGING AR(1) THEO THỜI GIAN)
==========================================================================================
    python -u database/etl/noi_suy_thang.py      (chạy sau nap_du_lieu.py, trước du_bao_lst.py)

Landsat chỉ có ảnh sạch mây ở khoảng một nửa số tháng. Để bản đồ và chuỗi thời gian liền mạch
từng tháng, các tháng không có ảnh được ƯỚC TÍNH (không phải quan trắc), lưu thành 1 phiên riêng
ma_loai = 'NOI_SUY' — tách bạch hoàn toàn với hiện trạng GEE (quan_trac_o).

Cách ước tính cho từng điểm (ô 480 m trong CSDL và pixel 120 m của ảnh web):
    ước tính theo mùa = khí hậu cùng tháng của điểm + dị thường ước tính
    dị thường ước tính = w_trước · dị thường lần quan trắc trước + w_sau · dị thường lần quan trắc sau
với trọng số kriging đơn giản của quá trình AR(1): tương quan dị thường giảm theo ρ^Δt (ρ = tương quan trễ 1 tháng).
Kết quả cuối = α · ước tính theo mùa + (1 − α) · nội suy tuyến tính giữa 2 lần quan trắc gần nhất; α chọn bằng
kiểm chứng (giữ được chu kỳ mùa khi khoảng trống dài, vẫn bám sát quan trắc khi khoảng trống ngắn).

Kiểm chứng: lần lượt giấu từng tháng CÓ ảnh, ước tính lại từ các tháng còn lại rồi so với ảnh thật
(RMSE, MAE, R²), đặt cạnh 2 cách đơn giản: chỉ khí hậu cùng tháng, và nội suy tuyến tính giá trị.
Kết quả ghi vào phien_du_bao.tham_so và nhat_ky_nap.

Đầu ra: phien_du_bao (NOI_SUY), phien_ky (tap='fill'), du_bao_o, thong_ke_phuong, anh_raster,
ảnh public/data/raster/noi_suy/LST_YYYY_MM.png, và cache/khi_hau_120m.npz (khí hậu pixel 120 m
dùng để hạ thang chi tiết ảnh dự báo ở bước 2).
"""
import json
import os
import shutil
import time
import warnings

from chung import CACHE, ENCODE_RANGE, PUBLIC, SCHEMA, connect, copy_rows, log_step  # noqa: I001 (phải đứng trước rasterio)

import numpy as np
import pandas as pd
from PIL import Image

warnings.filterwarnings('ignore', category=RuntimeWarning)
MAX_LAG = 24          # tìm quan trắc trước/sau trong vòng 24 tháng
MIN_MONTH_COVER = 0.05


def mi(ym, y0):
    return (int(ym[:4]) - y0) * 12 + int(ym[5:7]) - 1


# ---------------------------------------------------------------------------
# Thuật toán (dùng chung cho ô 480 m và pixel 120 m)
# ---------------------------------------------------------------------------
def climatology(sums, cnts):
    """sums/cnts: (12, N). Trả khí hậu từng tháng; tháng chưa có thì lấy TB 2 tháng kề, rồi TB chung."""
    with np.errstate(invalid='ignore', divide='ignore'):
        cl = np.where(cnts > 0, sums / np.maximum(cnts, 1), np.nan).astype('float32')
    out = cl.copy()
    for c in range(12):
        nb = np.nanmean(np.stack([cl[(c - 1) % 12], cl[(c + 1) % 12]]), axis=0)
        out[c] = np.where(np.isnan(cl[c]), nb, cl[c])
    allm = np.nanmean(cl, axis=0)
    out = np.where(np.isnan(out), allm[None, :], out)
    return out


def kriging_weights(rho, dp, dn):
    """Trọng số kriging đơn giản cho AR(1) với 1 điểm trước (cách dp) và 1 điểm sau (cách dn); dp/dn = 0 nghĩa là không có."""
    hp, hn = dp > 0, dn > 0
    rp = np.where(hp, rho ** np.maximum(dp, 1), 0.0)
    rn = np.where(hn, rho ** np.maximum(dn, 1), 0.0)
    rpn = np.where(hp & hn, rho ** (np.maximum(dp, 1) + np.maximum(dn, 1)), 0.0)
    den = 1 - rpn * rpn
    wp = np.where(hp & hn, (rp - rpn * rn) / den, rp)
    wn = np.where(hp & hn, (rn - rpn * rp) / den, rn)
    return wp.astype('float32'), wn.astype('float32')


def fill_month(get_val, clim, t, T, n, rho, skip=None):
    """Ước tính tháng t từ quan trắc gần nhất trước/sau của từng điểm.
    get_val(k) -> giá trị quan trắc (n,) hoặc None; clim (12, n) khí hậu cùng tháng.
    Trả (dị thường kriging AR(1), giá trị nội suy tuyến tính, khoảng cách trước, khoảng cách sau)."""
    vp = np.full(n, np.nan, 'float32'); dp = np.zeros(n, 'int16')
    vn = np.full(n, np.nan, 'float32'); dn = np.zeros(n, 'int16')
    ap = np.zeros(n, 'float32'); an = np.zeros(n, 'float32')
    need_p = np.ones(n, bool); need_n = np.ones(n, bool)
    for d in range(1, MAX_LAG + 1):
        for k, need, val, anom, dist in ((t - d, need_p, vp, ap, dp), (t + d, need_n, vn, an, dn)):
            if not (0 <= k < T) or k == skip or not need.any():
                continue
            v = get_val(k)
            if v is None:
                continue
            ok = need & np.isfinite(v)
            val[ok] = v[ok]
            anom[ok] = v[ok] - clim[k % 12][ok]
            dist[ok] = d
            need[ok] = False
        if not need_p.any() and not need_n.any():
            break
    wp, wn = kriging_weights(rho, dp, dn)
    a_hat = wp * ap + wn * an
    both = (dp > 0) & (dn > 0)
    lin = np.where(both, vp + (vn - vp) * dp / np.maximum(dp + dn, 1), np.where(dp > 0, vp, vn)).astype('float32')
    return a_hat, lin, dp, dn


def estimate_rho(anom_of, months, n_sample):
    """Hệ số tương quan dị thường theo độ trễ k (tháng); khớp ρ^k bằng bình phương nhỏ nhất trên log."""
    ks, cs, ws = [], [], []
    ms = set(months)
    for k in range(1, 13):
        xs, ys = [], []
        for t in months:
            if t + k in ms:
                a, b = anom_of(t), anom_of(t + k)
                ok = np.isfinite(a) & np.isfinite(b)
                if ok.sum() > 100:
                    xs.append(a[ok][:n_sample]); ys.append(b[ok][:n_sample])
        if len(xs) >= 2:
            x, y = np.concatenate(xs), np.concatenate(ys)
            c = float(np.corrcoef(x, y)[0, 1])
            if c > 0.02:
                ks.append(k); cs.append(c); ws.append(len(xs))
    if not ks:
        return 0.5, {}
    corr = {int(k): round(float(c), 3) for k, c in zip(ks, cs)}
    rho = corr.get(1, float(np.exp(np.mean(np.log(cs) / np.array(ks)))))   # ρ = tương quan dị thường trễ 1 tháng
    return float(np.clip(rho, 0.05, 0.95)), corr


def scores(y, p):
    e = p - y
    ss = np.sum((y - y.mean()) ** 2)
    return {'rmse': round(float(np.sqrt(np.mean(e * e))), 3), 'mae': round(float(np.mean(np.abs(e))), 3),
            'r2': round(float(1 - np.sum(e * e) / ss), 4) if ss > 0 else None, 'bias': round(float(np.mean(e)), 3), 'n': int(len(y))}


# ---------------------------------------------------------------------------
def main():
    t0 = time.time()
    z = np.load(os.path.join(CACHE, 'cube.npz'))
    with open(os.path.join(CACHE, 'meta.json'), encoding='utf-8') as f:
        META = json.load(f)
    MA_XA = META['ma_xa']
    OV = META['overlay']
    WARD_OF = z['ward_of']
    months_s = [str(m) for m in z['LST_months']]
    vals = z['LST_vals'].astype('float32')
    NCELL = vals.shape[1]
    y0 = int(months_s[0][:4])
    ky_of = lambda i: (y0 + i // 12) * 100 + i % 12 + 1          # noqa: E731
    ym_of = lambda i: f'{y0 + i // 12}_{i % 12 + 1:02d}'          # noqa: E731

    obs_idx = [mi(m, y0) for m in months_s]
    T = max(obs_idx) + 1
    CUBE = np.full((T, NCELL), np.nan, 'float32')
    for i, v in zip(obs_idx, vals):
        CUBE[i] = v
    have = [t for t in range(T) if np.isfinite(CUBE[t]).mean() > MIN_MONTH_COVER]
    missing = [t for t in range(T) if t not in set(have)]
    print(f'LST: {len(have)} tháng có ảnh, {len(missing)} tháng thiếu trong {ym_of(0)} → {ym_of(T - 1)}', flush=True)

    # ── 1. Ô 480 m ───────────────────────────────────────────────────────────
    sums = np.zeros((12, NCELL), 'float64'); cnts = np.zeros((12, NCELL), 'float64')
    for t in have:
        ok = np.isfinite(CUBE[t])
        sums[t % 12][ok] += CUBE[t][ok]; cnts[t % 12][ok] += 1
    CL = climatology(sums, cnts)
    HAVE = set(have)
    rho, corr = estimate_rho(lambda k: CUBE[k] - CL[k % 12], have, 20000)
    print(f'ρ (tương quan dị thường 1 tháng) = {rho:.3f} · tương quan theo độ trễ {corr}', flush=True)

    # Kiểm chứng: giấu từng tháng có ảnh, ước tính lại từ các tháng còn lại
    get_cell = lambda k: CUBE[k] if k in HAVE else None   # noqa: E731
    ys, p_ks, p_cl, p_lin = [], [], [], []
    for t in have:
        y = CUBE[t]
        ok = np.isfinite(y)
        c = t % 12
        s2, n2 = sums[c].copy(), cnts[c].copy()
        s2[ok] -= y[ok]; n2[ok] -= 1
        cl_c = np.where(n2 > 0, s2 / np.maximum(n2, 1), np.nan).astype('float32')
        nb = np.nanmean(np.stack([CL[(c - 1) % 12], CL[(c + 1) % 12]]), axis=0)
        cl_c = np.where(np.isnan(cl_c), nb, cl_c)
        a_hat, lin, _, _ = fill_month(get_cell, CL, t, T, NCELL, rho, skip=t)
        pk = cl_c + a_hat
        m = ok & np.isfinite(pk) & np.isfinite(lin) & np.isfinite(cl_c)
        ys.append(y[m]); p_ks.append(pk[m]); p_cl.append(cl_c[m]); p_lin.append(lin[m])
    Y, PK, PC, PL = (np.concatenate(a) for a in (ys, p_ks, p_cl, p_lin))
    # Hệ số trộn α giữa ước tính theo mùa (khí hậu + kriging) và nội suy tuyến tính: chọn α nhỏ nhất RMSE khi giấu từng tháng
    grid = np.round(np.arange(0, 1.0001, 0.05), 2)
    rm = [float(np.sqrt(np.mean((a * PK + (1 - a) * PL - Y) ** 2))) for a in grid]
    ALPHA = float(grid[int(np.argmin(rm))])
    kiem_chung = {'ket_hop_theo_mua': scores(Y, ALPHA * PK + (1 - ALPHA) * PL), 'khi_hau_kriging': scores(Y, PK),
                  'chi_khi_hau': scores(Y, PC), 'noi_suy_tuyen_tinh': scores(Y, PL), 'he_so_tron_alpha': ALPHA,
                  'so_thang_kiem_chung': len(have)}
    print(f'Kiểm chứng giấu-từng-tháng (ô 480 m) · α = {ALPHA}:', flush=True)
    for k in ('ket_hop_theo_mua', 'khi_hau_kriging', 'chi_khi_hau', 'noi_suy_tuyen_tinh'):
        print(f'  {k:20s} RMSE {kiem_chung[k]["rmse"]:.2f} · MAE {kiem_chung[k]["mae"]:.2f} · R² {kiem_chung[k]["r2"]}', flush=True)

    fill_cell = {}
    for t in missing:
        a_hat, lin, _, _ = fill_month(get_cell, CL, t, T, NCELL, rho)
        ks_ = CL[t % 12] + a_hat
        fill_cell[t] = np.where(np.isfinite(lin), ALPHA * ks_ + (1 - ALPHA) * lin, ks_).astype('float32')

    # ── 2. Pixel 120 m của ảnh web (giải mã PNG 8-bit đã tạo ở bước 1) ──────────
    lo, hi = ENCODE_RANGE['LST']
    sc = (hi - lo) / 254
    png = {t: os.path.join(PUBLIC, 'data', 'raster', 'LST', f'LST_{ym_of(t)}.png') for t in have}
    have_px = [t for t in have if os.path.exists(png[t])]
    codes = {t: np.asarray(Image.open(png[t]), dtype='uint8') for t in have_px}
    Hh, Ww = next(iter(codes.values())).shape
    NP = Hh * Ww

    def dec(t):
        c = codes[t].reshape(-1)
        v = lo + (c.astype('float32') - 1) * sc
        v[c == 0] = np.nan
        return v
    psum = np.zeros((12, NP), 'float32'); pcnt = np.zeros((12, NP), 'float32')
    for t in have_px:
        v = dec(t); ok = np.isfinite(v)
        psum[t % 12][ok] += v[ok]; pcnt[t % 12][ok] += 1
    PCL = climatology(psum, pcnt)
    del psum
    ever = pcnt.sum(0) > 0
    del pcnt
    HAVE_PX = set(have_px)
    get_px = lambda k: dec(k) if k in HAVE_PX else None   # noqa: E731
    np.savez_compressed(os.path.join(CACHE, 'khi_hau_120m.npz'), clim=PCL.reshape(12, Hh, Ww).astype('float16'),
                        shape=np.array([Hh, Ww]))
    print(f'✓ Khí hậu pixel 120 m ({Hh}×{Ww}) → cache/khi_hau_120m.npz', flush=True)

    out_dir = os.path.join(PUBLIC, 'data', 'raster', 'noi_suy')
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)
    img_stats = {}
    for t in missing:
        a_hat, lin, dp, dn = fill_month(get_px, PCL, t, T, NP, rho)
        ks_ = PCL[t % 12] + a_hat
        v = np.where(np.isfinite(lin), ALPHA * ks_ + (1 - ALPHA) * lin, ks_)
        v[~ever] = np.nan
        enc = np.zeros(NP, 'uint8')
        ok = np.isfinite(v)
        enc[ok] = np.clip(np.round((v[ok] - lo) / (hi - lo) * 254) + 1, 1, 255).astype('uint8')
        Image.fromarray(enc.reshape(Hh, Ww), mode='L').save(os.path.join(out_dir, f'LST_{ym_of(t)}.png'), optimize=True)
        vv = v[ok]
        img_stats[t] = (float(vv.mean()), float(np.percentile(vv, 5)), float(np.percentile(vv, 95)),
                        int(np.median(np.where(dp > 0, dp, 99)[ok])), int(np.median(np.where(dn > 0, dn, 99)[ok])))
    print(f'✓ {len(missing)} ảnh nội suy 120 m → public/data/raster/noi_suy', flush=True)

    # ── 3. Ghi CSDL ──────────────────────────────────────────────────────────
    conn = connect()
    cur = conn.cursor()
    cur.execute(f"SELECT ma_phien FROM {SCHEMA}.phien_du_bao WHERE ma_loai = 'NOI_SUY'")
    old = [r[0] for r in cur.fetchall()]
    if old:
        cur.execute(f'DELETE FROM {SCHEMA}.phien_du_bao WHERE ma_phien = ANY(%s)', (old,))
    tham_so = {'rho_ar1': round(rho, 4), 'he_so_tron_alpha': ALPHA, 'tuong_quan_theo_do_tre': corr, 'kiem_chung_giau_tung_thang': kiem_chung,
               'so_thang_co_anh': len(have), 'so_thang_noi_suy': len(missing), 'do_tre_toi_da_thang': MAX_LAG}
    mo_ta = (f'Ước tính LST cho {len(missing)} tháng không có ảnh GEE sạch mây: khí hậu cùng tháng của từng điểm + dị thường '
             f'nội suy kriging AR(1) (ρ = {rho:.2f}/tháng), kết hợp với nội suy tuyến tính giữa 2 lần quan trắc gần nhất '
             f'theo tỉ lệ α = {ALPHA:.2f} (chọn bằng kiểm chứng). Kiểm chứng giấu từng tháng: RMSE {kiem_chung["ket_hop_theo_mua"]["rmse"]:.2f} °C '
             f'— chỉ khí hậu {kiem_chung["chi_khi_hau"]["rmse"]:.2f} °C, chỉ nội suy tuyến tính {kiem_chung["noi_suy_tuyen_tinh"]["rmse"]:.2f} °C. '
             f'Đây là giá trị ƯỚC TÍNH, không phải quan trắc.')
    cur.execute(f"""
        INSERT INTO {SCHEMA}.phien_du_bao (ma_mo_hinh, ma_chi_so, ma_loai, ten, ky_train_tu, ky_train_den, ky_du_bao_tu,
               ky_du_bao_den, tam_du_bao, dac_trung, tham_so, mo_ta, la_mac_dinh)
        VALUES ('NOI_SUY_MUA','LST','NOI_SUY',%s,%s,%s,%s,%s,NULL,%s,%s,%s,false) RETURNING ma_phien
    """, ('Nội suy tháng thiếu ảnh · theo mùa', ky_of(have[0]), ky_of(have[-1]), ky_of(missing[0]), ky_of(missing[-1]),
          ['khi_hau_cung_thang', 'di_thuong_lan_truoc', 'di_thuong_lan_sau', 'khoang_cach_thang'],
          json.dumps(tham_so, ensure_ascii=False), mo_ta))
    pid = cur.fetchone()[0]
    copy_rows(cur, 'phien_ky', ['ma_phien', 'ma_ky', 'tap'], [(pid, ky_of(t), 'fill') for t in missing])
    w_, s_, e_, n_ = OV['bounds']
    for t in missing:
        v = fill_cell[t]
        copy_rows(cur, 'du_bao_o', ['ma_phien', 'ma_ky', 'ma_o', 'gia_tri'],
                  ((pid, ky_of(t), i + 1, f'{x:.3f}') for i, x in enumerate(v) if np.isfinite(x)))
        df = pd.DataFrame({'w': WARD_OF, 'v': v}).dropna()
        g = df.groupby('w')['v']
        st = pd.DataFrame({'tb': g.mean(), 'sd': g.std(), 'mn': g.min(), 'mx': g.max(), 'p10': g.quantile(.1),
                           'p90': g.quantile(.9), 'n': g.size()})
        copy_rows(cur, 'thong_ke_phuong', ['ma_xa', 'ma_chi_so', 'ma_ky', 'ma_loai', 'ma_phien', 'tb', 'do_lech', 'nho_nhat',
                                            'lon_nhat', 'p10', 'p90', 'so_mau', 'ty_le_phu'],
                  ((MA_XA[w - 1], 'LST', ky_of(t), 'NOI_SUY', pid, f'{r.tb:.4f}', f'{0 if np.isnan(r.sd) else r.sd:.4f}',
                    f'{r.mn:.4f}', f'{r.mx:.4f}', f'{r.p10:.4f}', f'{r.p90:.4f}', int(r.n), '1')
                   for w, r in st.iterrows() if w > 0))
        mean, p05, p95, _, _ = img_stats[t]
        cur.execute(f"""
            INSERT INTO {SCHEMA}.anh_raster (ma_chi_so, ma_ky, ma_loai, ma_phien, nguon_anh, do_phan_giai_m, he_toa_do,
                   duong_dan_goc, duong_dan_web, rong_px, cao_px, ma_hoa_min, ma_hoa_max, pham_vi, ty_le_phu, gia_tri_tb,
                   gia_tri_p05, gia_tri_p95)
            VALUES ('LST',%s,'NOI_SUY',%s,%s,120,3857,NULL,%s,%s,%s,%s,%s,ST_MakeEnvelope(%s,%s,%s,%s,4326),1,%s,%s,%s)
        """, (ky_of(t), pid, 'Nội suy theo mùa từ ảnh GEE các tháng lân cận', f'data/raster/noi_suy/LST_{ym_of(t)}.png',
              OV['width'], OV['height'], lo, hi, w_, s_, e_, n_, mean, p05, p95))
    log_step(cur, 'noi_suy_thang_thieu', {**tham_so, 'thoi_gian_s': round(time.time() - t0, 1)})
    conn.commit()
    cur.execute('ANALYZE')
    conn.commit()
    conn.close()
    print(f'✓ Phiên nội suy #{pid}: {len(missing)} tháng · xong sau {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
