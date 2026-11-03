"""
BƯỚC 2 — DỰ BÁO LST THEO KHÔNG GIAN (từng ô 480 m) & SO SÁNH MÔ HÌNH
=====================================================================
    python -u database/etl/du_bao_lst.py          (chạy sau nap_du_lieu.py; chạy lại sẽ thay kết quả cũ)

Bài toán: đứng ở đầu tháng O, chỉ dùng dữ liệu GEE TRƯỚC tháng O để dự báo LST của TỪNG Ô
cho 6 tháng O … O+5 (dự báo theo không gian, không phải 1 giá trị trung bình).

    train : mốc O = 01, 04, 07, 10 các năm 2021–2024 (tháng mục tiêu < 01/2025)
    val   : O = 01/2025 và 07/2025 (mục tiêu: cả năm 2025)
    test  : O = 01/2026  → dùng dữ liệu đến 12/2025 dự báo 1–6/2026 (đúng ví dụ của đề)
    future: O = tháng ngay sau ảnh LST cuối cùng → 6 tháng tới

Cách mô hình hoá: LST(ô, t) = khí hậu cùng tháng của ô + phần lệch.
Các mô hình học phần lệch từ các đặc trưng dị thường (lần quan trắc gần nhất, 12 tháng gần đây,
NDVI/TVDI, mùa, tầm dự báo). Đường cơ sở "Khí hậu nhiều năm" = phần lệch bằng 0.
Cách này tránh việc mô hình học thuộc mức nhiệt riêng của từng tháng huấn luyện (quá khớp).

Đánh giá: MAE, RMSE, R², MAPE, bias trên từng ô có quan trắc + R² không gian (sau khi bỏ trung bình
toàn TP của từng tháng — đo khả năng dự báo đúng PHÂN BỐ nóng/mát).
Kết quả: du_bao_o, thong_ke_phuong, anh_raster, danh_gia_mo_hinh, phien_ky + file
public/data/du_bao/<MÔ_HÌNH>/LST_forecast_YYYY_MM.tif (GeoTIFF) và PNG cho web.
Kèm 1 phiên GIẢ LẬP: kịch bản phủ xanh, dùng hệ số LST–NDVI thực nghiệm đo từ dữ liệu GEE.
"""
import json
import os
import shutil
import time
import warnings

from chung import CACHE, ENCODE_RANGE, PUBLIC, SCHEMA, connect, copy_rows, log_step  # noqa: I001 (phải đứng trước rasterio)

import numpy as np
import pandas as pd
import rasterio
from PIL import Image
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import BayesianRidge, LinearRegression
from sklearn.metrics import r2_score
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

try:
    from xgboost import XGBRegressor
except ImportError:          # không có xgboost thì bỏ qua mô hình này
    XGBRegressor = None

warnings.filterwarnings('ignore', category=RuntimeWarning)
Y0 = 2020
H = 6
RNG = np.random.default_rng(42)
FEATURES = ['lst_khi_hau_cung_thang', 'lst_tb_o', 'bien_do_mua_o', 'di_thuong_lan_gan_nhat', 'so_thang_tu_lan_gan_nhat',
            'di_thuong_tb_12_thang', 'di_thuong_tp_gan_nhat', 'di_thuong_rieng_o', 'ndvi_lech_tb', 'ndvi_khi_hau_cung_thang',
            'tvdi_lech_tb', 'so_nam_khi_hau', 'sin_thang', 'cos_thang', 'tam_du_bao']


def mi(ym):
    return (int(ym[:4]) - Y0) * 12 + int(ym[5:7]) - 1


def ky_of(i):
    return (Y0 + i // 12) * 100 + i % 12 + 1


def ym_of(i):
    return f'{Y0 + i // 12}_{i % 12 + 1:02d}'


# ---------------------------------------------------------------------------
# Dữ liệu
# ---------------------------------------------------------------------------
z = np.load(os.path.join(CACHE, 'cube.npz'))
with open(os.path.join(CACHE, 'meta.json'), encoding='utf-8') as f:
    META = json.load(f)
ROWS, COLS, WARD_OF = z['rows'], z['cols'], z['ward_of']
NR, NC = (int(v) for v in z['cell_shape'])
NCELL = len(ROWS)
T_ALL = mi('2027-12') + 1
A = {}
for k in ('LST', 'NDVI', 'TVDI'):
    arr = np.full((T_ALL, NCELL), np.nan, 'float32')
    for m, v in zip(z[f'{k}_months'], z[f'{k}_vals']):
        if str(m) >= f'{Y0}-01':
            arr[mi(str(m))] = v
    A[k] = arr
LST_MONTHS = [i for i in range(T_ALL) if np.isfinite(A['LST'][i]).sum() > 0.05 * NCELL]
LAST_LST = LST_MONTHS[-1]


def nanmean0(x):
    return np.nanmean(x, axis=0) if len(x) else np.full(NCELL, np.nan, 'float32')


def fill(a, b):
    return np.where(np.isnan(a), b, a)


def last_obs(arr, o):
    sub = arr[:o]
    valid = ~np.isnan(sub)
    has = valid.any(0)
    li = o - 1 - valid[::-1].argmax(0)
    val = sub[np.clip(li, 0, None), np.arange(NCELL)]
    return np.where(has, val, np.nan), np.where(has, li, -1)


def climatology(arr, o):
    """Trung bình cùng tháng (theo ô) từ dữ liệu trước tháng o; thiếu thì lấy 2 tháng kề."""
    out = np.full((12, NCELL), np.nan, 'float32')
    cnt = np.zeros((12, NCELL), 'float32')
    for c in range(12):
        idx = list(range(c, o, 12))
        if idx:
            out[c] = nanmean0(arr[idx])
            cnt[c] = np.isfinite(arr[idx]).sum(0)
    nb = out.copy()
    for c in range(12):
        nb[c] = fill(out[c], nanmean0(np.stack([out[(c - 1) % 12], out[(c + 1) % 12]])))
    return nb, cnt


def context(o):
    """Các đại lượng chỉ dùng thông tin TRƯỚC tháng o (không rò rỉ dữ liệu tương lai)."""
    L, N, V = A['LST'], A['NDVI'], A['TVDI']
    cm = nanmean0(L[:o])
    cm = fill(cm, np.nanmean(cm))
    cl, ccnt = climatology(L, o)
    cl = np.where(np.isnan(cl), cm[None, :], cl)
    anom = L[:o] - cl[np.arange(o) % 12]                    # dị thường của mọi tháng đã quan trắc
    la, li = last_obs(anom, o)
    la = fill(la, 0)
    li = np.where(li < 0, o - 12, li)
    a12 = fill(nanmean0(anom[max(0, o - 12):o]), 0)
    lm = max(t for t in LST_MONTHS if t < o)
    city_anom = float(np.nanmean(anom[lm]))
    nm = fill(nanmean0(N[:o]), np.nanmean(nanmean0(N[:o])))
    nl, _ = last_obs(N, o)
    ncl, _ = climatology(N, o)
    ncl = np.where(np.isnan(ncl), nm[None, :], ncl)
    tm = fill(nanmean0(V[:o]), np.nanmean(nanmean0(V[:o])))
    tl, _ = last_obs(V, o)
    return dict(cm=cm, cl=cl, ccnt=ccnt, la=la, li=li, a12=a12, city_anom=city_anom,
                nl=fill(nl, nm), nm=nm, ncl=ncl, tl=fill(tl, tm), tm=tm)


def features(ctx, o, t):
    c, h = t % 12, t - o
    one = np.ones(NCELL, 'float32')
    cols = [ctx['cl'][c], ctx['cm'], ctx['cl'][c] - ctx['cm'], ctx['la'], (t - ctx['li']).astype('float32'),
            ctx['a12'], one * ctx['city_anom'], ctx['la'] - ctx['city_anom'], ctx['nl'] - ctx['nm'], ctx['ncl'][c],
            ctx['tl'] - ctx['tm'], ctx['ccnt'][c], one * np.sin(2 * np.pi * c / 12), one * np.cos(2 * np.pi * c / 12), one * h]
    return np.column_stack(cols).astype('float32')


def dataset(origins):
    Xs, ys, ts = [], [], []
    for o in origins:
        ctx = context(o)
        for t in range(o, o + H):
            y = A['LST'][t]
            ok = np.isfinite(y)
            if ok.sum() < 0.05 * NCELL:
                continue
            Xs.append(features(ctx, o, t)[ok])
            ys.append(y[ok])
            ts.append(np.full(ok.sum(), t))
    return np.concatenate(Xs), np.concatenate(ys), np.concatenate(ts)


def metrics(y, p, t=None):
    e = p - y
    out = dict(mae=float(np.mean(np.abs(e))), rmse=float(np.sqrt(np.mean(e * e))), r2=float(r2_score(y, p)),
               mape=float(np.mean(np.abs(e) / np.maximum(np.abs(y), 1e-6)) * 100), bias=float(np.mean(e)), so_mau=int(len(y)))
    if t is not None:      # R² không gian: bỏ trung bình toàn TP của từng tháng
        ya, pa = y.astype('float64').copy(), p.astype('float64').copy()
        for m in np.unique(t):
            s = t == m
            ya[s] -= ya[s].mean()
            pa[s] -= pa[s].mean()
        out['r2_khong_gian'] = float(r2_score(ya, pa))
    return out


# ---------------------------------------------------------------------------
# Mô hình (học phần lệch so với khí hậu cùng tháng của ô)
# ---------------------------------------------------------------------------
class KhiHau:
    """Đường cơ sở: dự báo = LST khí hậu cùng tháng của chính ô đó (phần lệch = 0)."""
    def fit(self, X, r):
        return self

    def predict(self, X):
        return np.zeros(len(X), 'float32')


def make_models():
    m = {
        'KHI_HAU': (lambda: KhiHau(), None),
        'LR': (lambda: make_pipeline(StandardScaler(), LinearRegression()), None),
        'BAYES_RIDGE': (lambda: make_pipeline(StandardScaler(), BayesianRidge()), None),
        'RF': (lambda: RandomForestRegressor(n_estimators=80, max_depth=12, min_samples_leaf=60, max_features=0.5,
                                             n_jobs=-1, random_state=42), 300_000),
        'MLP': (lambda: make_pipeline(StandardScaler(), MLPRegressor(hidden_layer_sizes=(32, 16), alpha=0.5, batch_size=1024,
                                                                     learning_rate_init=2e-3, early_stopping=True, n_iter_no_change=5,
                                                                     max_iter=40, random_state=42)), 150_000),
    }
    if XGBRegressor is not None:
        m['XGB'] = (lambda: XGBRegressor(n_estimators=300, max_depth=5, learning_rate=0.05, subsample=0.7, colsample_bytree=0.8,
                                         min_child_weight=50, reg_lambda=5.0, tree_method='hist', n_jobs=-1, random_state=42), None)
    order = ['KHI_HAU', 'LR', 'BAYES_RIDGE', 'RF', 'XGB', 'MLP']
    return {k: m[k] for k in order if k in m}


class Wrapped:
    """pred = khí hậu cùng tháng (cột 0) + phần lệch mô hình dự báo."""
    def __init__(self, est):
        self.est = est

    def predict(self, X):
        return (X[:, 0] + self.est.predict(X)).astype('float32')


def fit(factory, sub, X, y):
    r = y - X[:, 0]
    if sub and len(y) > sub:
        i = RNG.choice(len(y), sub, replace=False)
        X, r = X[i], r[i]
    return Wrapped(factory().fit(X, r))


def importance(model):
    est = model.est
    est = est[-1] if hasattr(est, 'steps') else est
    if hasattr(est, 'feature_importances_'):
        v = np.asarray(est.feature_importances_, float)
    elif hasattr(est, 'coef_'):
        v = np.abs(np.asarray(est.coef_, float))
    else:
        return None
    v = v / v.sum() if v.sum() else v
    return {f: round(float(x), 4) for f, x in sorted(zip(FEATURES, v), key=lambda q: -q[1])}


def lst_ndvi_slope():
    """Hệ số dLST/dNDVI thực nghiệm: hồi quy chéo giữa các ô cho từng tháng có cả LST và NDVI (±1 tháng)."""
    slopes = []
    for t in LST_MONTHS:
        y = A['LST'][t]
        x = None
        for d in (0, -1, 1):
            if 0 <= t + d < T_ALL and np.isfinite(A['NDVI'][t + d]).sum() > 0.5 * NCELL:
                x = A['NDVI'][t + d]
                break
        if x is None:
            continue
        ok = np.isfinite(x) & np.isfinite(y) & (x > 0)      # bỏ mặt nước (NDVI ≤ 0)
        if ok.sum() > 1000:
            slopes.append(np.polyfit(x[ok], y[ok], 1)[0])
    return float(np.median(slopes)), len(slopes)


# ---------------------------------------------------------------------------
# Ghi kết quả
# ---------------------------------------------------------------------------
OV = META['overlay']
SRC_T = Affine(*z['src_transform'][:6])
GRID_T = Affine(SRC_T.a * META['block'], 0, SRC_T.c, 0, SRC_T.e * META['block'], SRC_T.f)
OV_T = Affine(*OV['transform3857'])
MA_XA = META['ma_xa']


def write_raster(vals, folder, t):
    grid = np.full((NR, NC), np.nan, 'float32')
    grid[ROWS, COLS] = vals
    tif_rel = f'data/du_bao/{folder}/LST_forecast_{ym_of(t)}.tif'
    png_rel = f'data/raster/du_bao/{folder}/LST_{ym_of(t)}.png'
    tif = os.path.join(PUBLIC, tif_rel.replace('/', os.sep))
    png = os.path.join(PUBLIC, png_rel.replace('/', os.sep))
    os.makedirs(os.path.dirname(tif), exist_ok=True)
    os.makedirs(os.path.dirname(png), exist_ok=True)
    with rasterio.open(tif, 'w', driver='GTiff', height=NR, width=NC, count=1, dtype='float32', crs=META['src_crs'],
                       transform=GRID_T, nodata=-9999, compress='deflate') as d:
        d.write(np.where(np.isnan(grid), -9999, grid).astype('float32'), 1)
        d.update_tags(chi_so='LST', don_vi='do C', thang=ym_of(t), thu_muc=folder)
    dst = np.full((OV['height'], OV['width']), np.nan, 'float32')
    reproject(grid, dst, src_transform=GRID_T, src_crs=META['src_crs'], dst_transform=OV_T, dst_crs='EPSG:3857',
              resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan)
    lo, hi = ENCODE_RANGE['LST']
    enc = np.zeros(dst.shape, 'uint8')
    ok = np.isfinite(dst)
    enc[ok] = np.clip(np.round((dst[ok] - lo) / (hi - lo) * 254) + 1, 1, 255).astype('uint8')
    Image.fromarray(enc, mode='L').save(png, optimize=True)
    return tif_rel, png_rel


def clear_old(cur):
    cur.execute(f"SELECT ma_phien FROM {SCHEMA}.phien_du_bao WHERE ma_chi_so = 'LST'")
    ids = [r[0] for r in cur.fetchall()]
    if ids:
        cur.execute(f'DELETE FROM {SCHEMA}.du_bao_o WHERE ma_phien = ANY(%s)', (ids,))
        cur.execute(f'DELETE FROM {SCHEMA}.thong_ke_phuong WHERE ma_phien = ANY(%s)', (ids,))
        cur.execute(f'DELETE FROM {SCHEMA}.anh_raster WHERE ma_phien = ANY(%s)', (ids,))
        cur.execute(f'DELETE FROM {SCHEMA}.phien_du_bao WHERE ma_phien = ANY(%s)', (ids,))
    cur.execute(f"SELECT setval(pg_get_serial_sequence('{SCHEMA}.phien_du_bao', 'ma_phien'), "
                f"COALESCE((SELECT max(ma_phien) FROM {SCHEMA}.phien_du_bao), 0) + 1, false)")
    for sub in ('du_bao', os.path.join('raster', 'du_bao')):
        shutil.rmtree(os.path.join(PUBLIC, 'data', sub), ignore_errors=True)
    print(f'Đã xoá {len(ids)} phiên dự báo LST cũ')


def save_run(cur, code, loai, ten, preds, taps, evals, tham_so, mo_ta, folder, default=False):
    months = sorted(preds)
    cur.execute(f"""
        INSERT INTO {SCHEMA}.phien_du_bao (ma_mo_hinh, ma_chi_so, ma_loai, ten, ky_train_tu, ky_train_den, ky_du_bao_tu,
               ky_du_bao_den, tam_du_bao, dac_trung, tham_so, mo_ta, la_mac_dinh)
        VALUES (%s,'LST',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING ma_phien
    """, (code, loai, ten, ky_of(0), ky_of(mi('2025-12')), ky_of(months[0]), ky_of(months[-1]), H, FEATURES,
          json.dumps(tham_so, ensure_ascii=False), mo_ta, default))
    pid = cur.fetchone()[0]
    copy_rows(cur, 'phien_ky', ['ma_phien', 'ma_ky', 'tap'], [(pid, ky_of(t), tap) for t, tap in sorted(taps.items())])
    for tap, e in evals.items():
        cur.execute(f'INSERT INTO {SCHEMA}.danh_gia_mo_hinh VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                    (pid, tap, e['mae'], e['rmse'], e['r2'], e['mape'], e['bias'], e['so_mau']))
    for t in months:
        v = preds[t]
        copy_rows(cur, 'du_bao_o', ['ma_phien', 'ma_ky', 'ma_o', 'gia_tri'],
                  ((pid, ky_of(t), i + 1, f'{x:.3f}') for i, x in enumerate(v)))
        df = pd.DataFrame({'w': WARD_OF, 'v': v})
        g = df.groupby('w')['v']
        st = pd.DataFrame({'tb': g.mean(), 'sd': g.std(), 'mn': g.min(), 'mx': g.max(), 'p10': g.quantile(.1),
                           'p90': g.quantile(.9), 'n': g.size()})
        copy_rows(cur, 'thong_ke_phuong', ['ma_xa', 'ma_chi_so', 'ma_ky', 'ma_loai', 'ma_phien', 'tb', 'do_lech', 'nho_nhat',
                                            'lon_nhat', 'p10', 'p90', 'so_mau', 'ty_le_phu'],
                  ((MA_XA[w - 1], 'LST', ky_of(t), loai, pid, f'{r.tb:.4f}', f'{0 if np.isnan(r.sd) else r.sd:.4f}',
                    f'{r.mn:.4f}', f'{r.mx:.4f}', f'{r.p10:.4f}', f'{r.p90:.4f}', int(r.n), '1')
                   for w, r in st.iterrows() if w > 0))
        tif_rel, png_rel = write_raster(v, folder, t)
        w_, s_, e_, n_ = OV['bounds']
        lo, hi = ENCODE_RANGE['LST']
        p05, p95 = np.percentile(v, [5, 95])
        cur.execute(f"""
            INSERT INTO {SCHEMA}.anh_raster (ma_chi_so, ma_ky, ma_loai, ma_phien, nguon_anh, do_phan_giai_m, he_toa_do,
                   duong_dan_goc, duong_dan_web, rong_px, cao_px, ma_hoa_min, ma_hoa_max, pham_vi, ty_le_phu, gia_tri_tb,
                   gia_tri_p05, gia_tri_p95)
            VALUES ('LST',%s,%s,%s,%s,480,32648,%s,%s,%s,%s,%s,%s,ST_MakeEnvelope(%s,%s,%s,%s,4326),1,%s,%s,%s)
        """, (ky_of(t), loai, pid, ten, tif_rel, png_rel, OV['width'], OV['height'], lo, hi, w_, s_, e_, n_,
              float(np.mean(v)), float(p05), float(p95)))
    return pid


# ---------------------------------------------------------------------------
def main():
    t0 = time.time()
    train_o = [mi(f'{y}-{m:02d}') for y in range(2021, 2025) for m in (1, 4, 7, 10) if mi(f'{y}-{m:02d}') + H <= mi('2025-01')]
    val_o = [mi('2025-01'), mi('2025-07')]
    test_o = mi('2026-01')
    fut_o = LAST_LST + 1
    print(f'Ô lưới: {NCELL} · tháng LST có dữ liệu: {len(LST_MONTHS)} · ảnh cuối {ym_of(LAST_LST)}', flush=True)

    Xtr, ytr, ttr = dataset(train_o)
    Xva, yva, tva = dataset(val_o)
    Xte, yte, tte = dataset([test_o])
    print(f'Mẫu: train {len(ytr):,} · val {len(yva):,} · test {len(yte):,}', flush=True)
    X_trva, y_trva = np.concatenate([Xtr, Xva]), np.concatenate([ytr, yva])
    X_all, y_all = np.concatenate([X_trva, Xte]), np.concatenate([y_trva, yte])

    ctx_te, ctx_fu = context(test_o), context(fut_o)
    te_months = list(range(test_o, test_o + H))
    fu_months = list(range(fut_o, fut_o + H))
    taps = {t: 'train' for t in sorted(set(ttr.tolist()))}
    taps.update({t: 'val' for t in range(mi('2025-01'), mi('2025-12') + 1)})
    taps.update({t: 'test' for t in te_months})
    taps.update({t: 'future' for t in fu_months})

    results = {}
    for code, (factory, sub) in make_models().items():
        t1 = time.time()
        m_a = fit(factory, sub, Xtr, ytr)                         # huấn luyện trên train
        ev = {'train': metrics(ytr, m_a.predict(Xtr)), 'val': metrics(yva, m_a.predict(Xva), tva)}
        m_b = fit(factory, sub, X_trva, y_trva)                   # train+val (dữ liệu đến 12/2025) → 1–6/2026
        ev['test'] = metrics(yte, m_b.predict(Xte), tte)
        preds = {t: m_b.predict(features(ctx_te, test_o, t)) for t in te_months}
        m_c = fit(factory, sub, X_all, y_all)                     # toàn bộ → 6 tháng tới
        preds.update({t: m_c.predict(features(ctx_fu, fut_o, t)) for t in fu_months})
        results[code] = dict(ev=ev, preds=preds, model=m_c, imp=importance(m_c) if code != 'KHI_HAU' else None)
        print(f'  {code:12s} train {ev["train"]["rmse"]:.2f} · val {ev["val"]["rmse"]:.2f} · test RMSE {ev["test"]["rmse"]:.2f} '
              f'R² {ev["test"]["r2"]:.3f} R²kg {ev["test"]["r2_khong_gian"]:.3f}  ({time.time() - t1:.0f}s)', flush=True)

    ml = [k for k in results if k != 'KHI_HAU']
    best = min(ml, key=lambda k: results[k]['ev']['test']['rmse'])
    print(f'→ Mô hình học máy tốt nhất trên tập test: {best}', flush=True)

    conn = connect()
    cur = conn.cursor()
    clear_old(cur)
    conn.commit()
    names = dict(KHI_HAU='Khí hậu nhiều năm', LR='Linear Regression', BAYES_RIDGE='Bayesian Ridge', RF='Random Forest',
                 XGB='XGBoost', MLP='Mạng nơ-ron MLP')
    mo_ta = (f'Dự báo LST từng ô 480 m, tầm {H} tháng: LST = khí hậu cùng tháng của ô + phần lệch do mô hình học. '
             f'Huấn luyện trên các mốc 2021–2024 (đánh giá val = 2025), huấn luyện lại với dữ liệu đến 12/2025 để dự báo '
             f'1–6/2026 (test), rồi với toàn bộ dữ liệu đến {ym_of(LAST_LST).replace("_", "/")} để dự báo 6 tháng tới.')
    for code, r in results.items():
        ts = {'so_mau_train': int(len(ytr)), 'so_o': NCELL, 'muc_do_quan_trong': r['imp'],
              'r2_khong_gian_test': round(r['ev']['test']['r2_khong_gian'], 4),
              'r2_khong_gian_val': round(r['ev']['val']['r2_khong_gian'], 4)}
        save_run(cur, code, 'MO_HINH', f'LST · {names[code]}', r['preds'], taps, r['ev'], ts,
                 mo_ta if code != 'KHI_HAU' else 'Đường cơ sở: LST trung bình cùng tháng các năm trước của từng ô.', code, code == best)
        conn.commit()
        print(f'  ✓ đã ghi {code}', flush=True)

    # Phiên GIẢ LẬP: kịch bản phủ xanh — tăng NDVI 0.15 ở ô đô thị (NDVI < 0.3),
    # ΔLST = β·ΔNDVI với β là hệ số LST–NDVI thực nghiệm đo từ ảnh GEE 2020–2026.
    beta, n_slope = lst_ndvi_slope()
    urban = ctx_fu['nl'] < 0.3
    d_ndvi = np.where(urban, 0.15, 0.0).astype('float32')
    sim = {t: (results[best]['preds'][t] + beta * d_ndvi).astype('float32') for t in fu_months}
    diff_city = float(np.mean(beta * d_ndvi))
    diff_urban = float(beta * 0.15)
    save_run(cur, best, 'GIA_LAP', f'Giả lập phủ xanh · {names[best]}', sim, {t: 'future' for t in fu_months}, {},
             {'kich_ban': 'NDVI +0.15 tại các ô đô thị (NDVI < 0.3)', 'he_so_lst_ndvi': round(beta, 3),
              'so_thang_uoc_luong_he_so': n_slope, 'so_o_tac_dong': int(urban.sum()),
              'chenh_lech_tb_c': round(diff_city, 3), 'chenh_lech_o_do_thi_c': round(diff_urban, 3)},
             f'Kịch bản giả định (what-if): lấy dự báo {names[best]} rồi áp dụng ΔLST = β·ΔNDVI với β = {beta:.2f} °C/đơn vị NDVI '
             f'(hồi quy chéo LST–NDVI trên {n_slope} tháng ảnh GEE). Không phải quan trắc, không phải dự báo chính thức.',
             f'GIA_LAP_{best}')
    log_step(cur, 'du_bao_lst', {'mo_hinh': list(results), 'tot_nhat': best, 'thoi_gian_s': round(time.time() - t0, 1),
                                 'test': {k: v['ev']['test'] for k, v in results.items()},
                                 'gia_lap': {'beta': beta, 'chenh_lech_tb_c': diff_city}})
    conn.commit()
    cur.execute('ANALYZE')
    conn.commit()
    conn.close()
    print(f'✓ Giả lập phủ xanh: β = {beta:.2f} °C/NDVI · ô đô thị {diff_urban:+.2f} °C · TB toàn TP {diff_city:+.2f} °C')
    print(f'Xong bước 2 sau {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
