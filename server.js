/**
 * LST Forecast · TP.HCM — máy chủ WebGIS
 * Node.js + Express + PostgreSQL/PostGIS (schema "vientham", xem database/schema.sql)
 *
 *   Hiện trạng (GEE)  : quan_trac_o, thong_ke_phuong (ma_loai='GEE'), anh_raster
 *   Tháng thiếu ảnh   : phiên ma_loai='NOI_SUY' (ước tính, tách khỏi quan trắc)
 *   Dự báo / giả lập  : phien_du_bao, du_bao_o, thong_ke_phuong (ma_phien), danh_gia_mo_hinh
 *   Dự báo theo ngày  : du_bao_ngay (giả lập = dự báo tháng của AI + thời tiết Open-Meteo)
 *   Hành chính mới    : ranh_gioi_tinh, don_vi_hanh_chinh (168 phường/xã/đặc khu)
 *
 * Mọi truy vấn đều dùng tham số ($1, $2…) — không ghép chuỗi đầu vào người dùng vào SQL.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');

const S = 'vientham';
const PORT = Number(process.env.PORT) || 3000;

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

const num = (v, d = null) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const INDICES = ['LST', 'NDVI', 'TVDI'];
const idxOf = (v) => (INDICES.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : 'LST');
const r = (v, d = 3) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);

const app = express();
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// Xác thực + phân quyền (đặt TRƯỚC express.static để chặn cả file dữ liệu). Xem server_auth.js
const auth = require('./server_auth')(app, pool);

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) {
    if (p.endsWith('.tif')) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`);
    if (p.includes(`${path.sep}raster${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// ─── Bộ nhớ đệm ───────────────────────────────────────────────────────────
const cache = new Map();
async function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

// ─── Health ───────────────────────────────────────────────────────────────
app.get('/api/health', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT split_part(version(), ' ', 2) AS pg, PostGIS_Lib_Version() AS postgis,
    EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS schema_ok`, [S]);
  res.json({ ok: true, ...rows[0] });
}));

// ─── Metadata: chỉ số, thang màu, ngưỡng, ảnh GEE, phiên dự báo + đánh giá ───
async function loadMeta() {
  const [ci, ng, gee, runs, ev, pk, rs, bb, tinh] = await Promise.all([
    pool.query(`SELECT * FROM ${S}.dm_chi_so ORDER BY ma_chi_so`),
    pool.query(`SELECT * FROM ${S}.dm_nguong_canh_bao ORDER BY ma_chi_so, muc`),
    pool.query(`SELECT ma_chi_so, ma_ky, duong_dan_web, gia_tri_tb, gia_tri_p05, gia_tri_p95, ty_le_phu,
                       rong_px, cao_px, ma_hoa_min, ma_hoa_max,
                       ST_XMin(pham_vi) w, ST_YMin(pham_vi) s, ST_XMax(pham_vi) e, ST_YMax(pham_vi) n
                  FROM ${S}.anh_raster WHERE ma_loai = 'GEE' ORDER BY ma_chi_so, ma_ky`),
    pool.query(`SELECT p.*, m.ten AS ten_mo_hinh, m.nhom, m.thu_vien, m.thu_tu, l.ten AS ten_loai
                  FROM ${S}.phien_du_bao p JOIN ${S}.dm_mo_hinh m USING (ma_mo_hinh)
                  JOIN ${S}.dm_loai_du_lieu l USING (ma_loai)
                 ORDER BY p.ma_loai, m.thu_tu`),
    pool.query(`SELECT * FROM ${S}.danh_gia_mo_hinh`),
    pool.query(`SELECT * FROM ${S}.phien_ky ORDER BY ma_phien, ma_ky`),
    pool.query(`SELECT ma_phien, ma_ky, duong_dan_web, duong_dan_goc, gia_tri_tb, gia_tri_p05, gia_tri_p95
                  FROM ${S}.anh_raster WHERE ma_phien IS NOT NULL ORDER BY ma_phien, ma_ky`),
    pool.query(`SELECT ST_XMin(e) w, ST_YMin(e) s, ST_XMax(e) e, ST_YMax(e) n FROM (SELECT ST_Extent(geom) e FROM ${S}.luoi_o) t`),
    pool.query(`SELECT t.ten_day_du, t.dien_tich_km2, (SELECT count(*) FROM ${S}.don_vi_hanh_chinh)::int so_xa,
                       (SELECT count(*) FROM ${S}.luoi_o)::int so_o,
                       (SELECT min(do_phan_giai_m) FROM ${S}.luoi_o) o_m FROM ${S}.ranh_gioi_tinh t LIMIT 1`),
  ]);
  const indices = {};
  for (const c of ci.rows) {
    indices[c.ma_chi_so] = {
      ma: c.ma_chi_so, ten: c.ten, ten_day_du: c.ten_day_du, don_vi: c.don_vi, mo_ta: c.mo_ta,
      min: c.thang_mau_min, max: c.thang_mau_max, palette: c.bang_mau, so_le: c.so_le, cao_la_xau: c.cao_la_xau,
      nguong: ng.rows.filter((n) => n.ma_chi_so === c.ma_chi_so)
        .map((n) => ({ muc: n.muc, ten: n.ten_muc, tu: n.tu, den: n.den, mau: n.mau, khuyen_cao: n.khuyen_cao })),
      gee: [],
    };
  }
  let overlay = null;
  for (const g of gee.rows) {
    const ix = indices[g.ma_chi_so];
    if (!ix) continue;
    ix.encode = [g.ma_hoa_min, g.ma_hoa_max];
    ix.gee.push({ ky: g.ma_ky, url: g.duong_dan_web, tb: r(g.gia_tri_tb), p05: r(g.gia_tri_p05), p95: r(g.gia_tri_p95), phu: r(g.ty_le_phu) });
    if (!overlay) overlay = { width: g.rong_px, height: g.cao_px, bounds: [g.w, g.s, g.e, g.n] };
  }
  const metrics = {};
  for (const e of ev.rows) (metrics[e.ma_phien] ??= {})[e.tap] = { mae: r(e.mae), rmse: r(e.rmse), r2: r(e.r2, 4), mape: r(e.mape), bias: r(e.bias), n: e.so_mau };
  const runList = runs.rows.map((p) => {
    const taps = Object.fromEntries(pk.rows.filter((k) => k.ma_phien === p.ma_phien).map((k) => [k.ma_ky, k.tap]));
    return {
      ma_phien: p.ma_phien, ma_mo_hinh: p.ma_mo_hinh, ten_mo_hinh: p.ten_mo_hinh, nhom: p.nhom, thu_vien: p.thu_vien,
      ma_chi_so: p.ma_chi_so, ma_loai: p.ma_loai, ten_loai: p.ten_loai, ten: p.ten, mac_dinh: p.la_mac_dinh,
      mo_ta: p.mo_ta, dac_trung: p.dac_trung, tham_so: p.tham_so, tam_du_bao: p.tam_du_bao,
      ky_train: [p.ky_train_tu, p.ky_train_den], ky_du_bao: [p.ky_du_bao_tu, p.ky_du_bao_den],
      metrics: metrics[p.ma_phien] || {},
      months: rs.rows.filter((m) => m.ma_phien === p.ma_phien).map((m) => ({
        ky: m.ma_ky, tap: taps[m.ma_ky] || null, url: m.duong_dan_web, tif: m.duong_dan_goc,
        tb: r(m.gia_tri_tb), p05: r(m.gia_tri_p05), p95: r(m.gia_tri_p95),
      })),
    };
  });
  const b = bb.rows[0];
  return {
    indices, overlay, runs: runList,
    home: b ? [[b.s, b.w], [b.n, b.e]] : null,
    tinh: tinh.rows[0] || null,
  };
}
app.get('/api/meta', wrap(async (req, res) => res.json(await cached('meta', loadMeta))));

// ─── Ranh giới tỉnh ───────────────────────────────────────────────────────
app.get('/api/boundary', wrap(async (req, res) => {
  const data = await cached('boundary', async () => {
    const { rows } = await pool.query(`SELECT ma_tinh, ten_day_du, ST_AsGeoJSON(geom_don_gian, 5)::json AS g FROM ${S}.ranh_gioi_tinh`);
    return { type: 'FeatureCollection', features: rows.map((x) => ({ type: 'Feature', properties: { ma_tinh: x.ma_tinh, ten: x.ten_day_du }, geometry: x.g })) };
  });
  res.json(data);
}));

// ─── 168 phường/xã ────────────────────────────────────────────────────────
app.get('/api/wards', wrap(async (req, res) => {
  const data = await cached('wards', async () => {
    const { rows } = await pool.query(`
      SELECT d.ma_xa, d.ten_xa, d.loai, d.khu_vuc_cu, d.dtich_km2::float, d.dan_so, d.matdo_km2::float, d.sap_nhap, d.tru_so,
             ST_X(d.tam) lon, ST_Y(d.tam) lat, ST_AsGeoJSON(d.geom_don_gian, 5)::json g,
             (SELECT count(*) FROM ${S}.luoi_o l WHERE l.ma_xa = d.ma_xa)::int so_o
        FROM ${S}.don_vi_hanh_chinh d ORDER BY d.ma_xa`);
    return {
      type: 'FeatureCollection',
      features: rows.map((x, i) => ({
        type: 'Feature', id: i,
        properties: { i, ma_xa: x.ma_xa, ten_xa: x.ten_xa, loai: x.loai, khu_vuc: x.khu_vuc_cu, dtich_km2: x.dtich_km2,
          dan_so: x.dan_so, matdo_km2: x.matdo_km2, sap_nhap: x.sap_nhap, tru_so: x.tru_so, tam: [r(x.lon, 5), r(x.lat, 5)], so_o: x.so_o },
        geometry: x.g,
      })),
    };
  });
  res.json(data);
}));

// ─── Ma trận giá trị phường × tháng (GEE hoặc 1 phiên dự báo) ─────────────
app.get('/api/series', wrap(async (req, res) => {
  const idx = idxOf(req.query.chi_so);
  const phien = num(req.query.phien);
  const key = `series:${idx}:${phien ?? 'GEE'}`;
  const data = await cached(key, async () => {
    const [w, v] = await Promise.all([
      pool.query(`SELECT ma_xa FROM ${S}.don_vi_hanh_chinh ORDER BY ma_xa`),
      pool.query(`SELECT ma_ky, ma_xa, tb, p90, ty_le_phu FROM ${S}.thong_ke_phuong
                   WHERE ma_chi_so = $1 AND ${phien === null ? `ma_loai = 'GEE'` : 'ma_phien = $2'}
                   ORDER BY ma_ky`, phien === null ? [idx] : [idx, phien]),
    ]);
    const pos = new Map(w.rows.map((x, i) => [x.ma_xa, i]));
    const months = [...new Set(v.rows.map((x) => x.ma_ky))];
    const mpos = new Map(months.map((m, i) => [m, i]));
    const tb = months.map(() => new Array(w.rows.length).fill(null));
    const p90 = months.map(() => new Array(w.rows.length).fill(null));
    for (const x of v.rows) {
      const i = pos.get(x.ma_xa), j = mpos.get(x.ma_ky);
      tb[j][i] = r(x.tb); p90[j][i] = r(x.p90);
    }
    return { chi_so: idx, phien, months, tb, p90 };
  });
  res.json(data);
}));

// ─── Chi tiết 1 phường/xã ────────────────────────────────────────────────
app.get('/api/ward/:ma_xa', wrap(async (req, res) => {
  const ma = String(req.params.ma_xa);
  const info = await pool.query(`SELECT ma_xa, ten_xa, loai, khu_vuc_cu, dtich_km2::float, dan_so, matdo_km2::float, sap_nhap, tru_so,
      (SELECT count(*) FROM ${S}.luoi_o l WHERE l.ma_xa = d.ma_xa)::int so_o FROM ${S}.don_vi_hanh_chinh d WHERE ma_xa = $1`, [ma]);
  if (!info.rows.length) return res.status(404).json({ error: 'Không tìm thấy phường/xã ' + ma });
  const [gee, fc, trend, mua] = await Promise.all([
    pool.query(`SELECT ma_chi_so, ma_ky, tb, do_lech, nho_nhat, lon_nhat, p10, p90, ty_le_phu FROM ${S}.thong_ke_phuong
                 WHERE ma_xa = $1 AND ma_loai = 'GEE' ORDER BY ma_chi_so, ma_ky`, [ma]),
    pool.query(`SELECT t.ma_phien, t.ma_ky, t.tb, t.p10, t.p90, k.tap FROM ${S}.thong_ke_phuong t
                  LEFT JOIN ${S}.phien_ky k ON k.ma_phien = t.ma_phien AND k.ma_ky = t.ma_ky
                 WHERE t.ma_xa = $1 AND t.ma_phien IS NOT NULL ORDER BY t.ma_phien, t.ma_ky`, [ma]),
    pool.query(`SELECT ma_chi_so, do_doc_nam, r2, so_thang FROM ${S}.v_xu_huong_phuong WHERE ma_xa = $1`, [ma]),
    pool.query(`SELECT ma_chi_so, mua, tb FROM ${S}.v_thong_ke_phuong_mua WHERE ma_xa = $1`, [ma]),
  ]);
  const series = { LST: [], NDVI: [], TVDI: [] };
  for (const g of gee.rows) series[g.ma_chi_so]?.push({ ky: g.ma_ky, tb: r(g.tb), sd: r(g.do_lech), min: r(g.nho_nhat), max: r(g.lon_nhat), p10: r(g.p10), p90: r(g.p90), phu: r(g.ty_le_phu) });
  const du_bao = {};
  for (const f of fc.rows) (du_bao[f.ma_phien] ??= []).push({ ky: f.ma_ky, tb: r(f.tb), p10: r(f.p10), p90: r(f.p90), tap: f.tap });
  const xu_huong = Object.fromEntries(trend.rows.map((t) => [t.ma_chi_so, { do_doc_nam: r(t.do_doc_nam, 4), r2: r(t.r2), so_thang: Number(t.so_thang) }]));
  const theo_mua = {};
  for (const m of mua.rows) (theo_mua[m.ma_chi_so] ??= {})[m.mua] = r(m.tb);
  res.json({ info: info.rows[0], series, du_bao, xu_huong, theo_mua });
}));

// ─── Ô lưới 480 m của 1 phường (cột 3D) ───────────────────────────────────
app.get('/api/cells', wrap(async (req, res) => {
  const ma = String(req.query.ma_xa || '');
  const ky = num(req.query.ky);
  const phien = num(req.query.phien);
  const idx = idxOf(req.query.chi_so);
  if (!ma || !ky) return res.status(400).json({ error: 'Thiếu ma_xa hoặc ky' });
  const q = phien === null
    ? pool.query(`SELECT l.kinh_do, l.vi_do, q.gia_tri FROM ${S}.luoi_o l
                    JOIN ${S}.quan_trac_o q ON q.ma_o = l.ma_o AND q.ma_chi_so = $3 AND q.ma_ky = $2
                   WHERE l.ma_xa = $1`, [ma, ky, idx])
    : pool.query(`SELECT l.kinh_do, l.vi_do, d.gia_tri FROM ${S}.luoi_o l
                    JOIN ${S}.du_bao_o d ON d.ma_o = l.ma_o AND d.ma_phien = $3 AND d.ma_ky = $2
                   WHERE l.ma_xa = $1`, [ma, ky, phien]);
  const { rows } = await q;
  res.json({ ma_xa: ma, ky, phien, cells: rows.map((x) => [r(x.kinh_do, 5), r(x.vi_do, 5), r(x.gia_tri, 2)]) });
}));

// ─── Tra cứu tại 1 điểm (ô lưới gần nhất) ────────────────────────────────
app.get('/api/point', wrap(async (req, res) => {
  const lon = num(req.query.lon), lat = num(req.query.lat);
  if (lon === null || lat === null) return res.status(400).json({ error: 'Thiếu lon/lat' });
  const near = await pool.query(`
    SELECT l.ma_o, l.kinh_do, l.vi_do, l.ma_xa,
           ST_Distance(l.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS kc
      FROM ${S}.luoi_o l ORDER BY l.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`, [lon, lat]);
  const o = near.rows[0];
  if (!o) return res.status(404).json({ error: 'Chưa có lưới dữ liệu' });
  const [ward, gee, fc] = await Promise.all([
    pool.query(`SELECT ma_xa, ten_xa, loai, khu_vuc_cu FROM ${S}.don_vi_hanh_chinh
                 WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1`, [lon, lat]),
    pool.query(`SELECT ma_chi_so, ma_ky, gia_tri FROM ${S}.quan_trac_o WHERE ma_o = $1 ORDER BY ma_chi_so, ma_ky`, [o.ma_o]),
    pool.query(`SELECT ma_phien, ma_ky, gia_tri FROM ${S}.du_bao_o WHERE ma_o = $1 ORDER BY ma_phien, ma_ky`, [o.ma_o]),
  ]);
  const series = { LST: [], NDVI: [], TVDI: [] };
  for (const g of gee.rows) series[g.ma_chi_so]?.push([g.ma_ky, r(g.gia_tri)]);
  const du_bao = {};
  for (const f of fc.rows) (du_bao[f.ma_phien] ??= []).push([f.ma_ky, r(f.gia_tri)]);
  res.json({
    ma_o: o.ma_o, kinh_do: o.kinh_do, vi_do: o.vi_do, khoang_cach_m: Math.round(o.kc),
    ward: ward.rows[0] || null, series, du_bao,
    ngoai_vung: o.kc > 1500,
  });
}));

// ─── Thống kê tổng hợp (tab Thống kê) ─────────────────────────────────────
app.get('/api/stats', wrap(async (req, res) => {
  const idx = idxOf(req.query.chi_so);
  const data = await cached(`stats:${idx}`, async () => {
    const [city, kv, mua, trend, nam] = await Promise.all([
      pool.query(`SELECT ma_ky, ma_loai, ma_phien, tb, phuong_thap_nhat, phuong_cao_nhat FROM ${S}.v_thong_ke_thanh_pho_thang
                   WHERE ma_chi_so = $1 ORDER BY ma_ky`, [idx]),
      pool.query(`SELECT khu_vuc_cu, ma_ky, tb FROM ${S}.v_thong_ke_khu_vuc WHERE ma_chi_so = $1 AND ma_loai = 'GEE' ORDER BY ma_ky`, [idx]),
      pool.query(`SELECT k.nam, k.mua, avg(t.tb) tb FROM ${S}.thong_ke_phuong t JOIN ${S}.ky_thoi_gian k USING (ma_ky)
                   WHERE t.ma_chi_so = $1 AND t.ma_loai = 'GEE' GROUP BY k.nam, k.mua ORDER BY k.nam`, [idx]),
      pool.query(`SELECT x.ma_xa, d.ten_xa, d.loai, x.do_doc_nam, x.r2 FROM ${S}.v_xu_huong_phuong x
                    JOIN ${S}.don_vi_hanh_chinh d USING (ma_xa) WHERE x.ma_chi_so = $1 AND x.so_thang >= 12
                   ORDER BY x.do_doc_nam DESC`, [idx]),
      pool.query(`SELECT nam, khu_vuc_cu, avg(tb) tb FROM ${S}.v_thong_ke_phuong_nam WHERE ma_chi_so = $1 GROUP BY nam, khu_vuc_cu ORDER BY nam`, [idx]),
    ]);
    const cityGee = city.rows.filter((x) => x.ma_loai === 'GEE').map((x) => ({ ky: x.ma_ky, tb: r(x.tb), lo: r(x.phuong_thap_nhat), hi: r(x.phuong_cao_nhat) }));
    const cityRuns = {};
    for (const x of city.rows.filter((y) => y.ma_phien !== null)) (cityRuns[x.ma_phien] ??= []).push({ ky: x.ma_ky, tb: r(x.tb) });
    const khuVuc = {};
    for (const x of kv.rows) (khuVuc[x.khu_vuc_cu] ??= []).push({ ky: x.ma_ky, tb: r(x.tb) });
    const namKv = {};
    for (const x of nam.rows) (namKv[x.khu_vuc_cu] ??= []).push({ nam: x.nam, tb: r(x.tb) });
    return {
      chi_so: idx, city: cityGee, city_runs: cityRuns, khu_vuc: khuVuc, nam_khu_vuc: namKv,
      mua: mua.rows.map((x) => ({ nam: x.nam, mua: x.mua, tb: r(x.tb) })),
      xu_huong: trend.rows.map((x) => ({ ma_xa: x.ma_xa, ten: `${x.loai} ${x.ten_xa}`, slope: r(x.do_doc_nam, 4), r2: r(x.r2) })),
    };
  });
  res.json(data);
}));

// ─── Đối chiếu dự báo – thực tế (biểu đồ phân tán) ───────────────────────
app.get('/api/compare', wrap(async (req, res) => {
  const phien = num(req.query.phien);
  if (phien === null) return res.status(400).json({ error: 'Thiếu phien' });
  const data = await cached(`cmp:${phien}`, async () => {
    const { rows } = await pool.query(`
      SELECT ma_ky, du_bao, thuc_te FROM ${S}.v_so_sanh_du_bao
       WHERE ma_phien = $1 AND tap = 'test' AND (ma_o % 9) = 0`, [phien]);
    return { phien, diem: rows.map((x) => [x.ma_ky, r(x.thuc_te, 2), r(x.du_bao, 2)]) };
  });
  res.json(data);
}));

// ─── Thống kê vùng tự vẽ (dùng hàm fn_thong_ke_vung trong CSDL) ──────────
app.post('/api/region', wrap(async (req, res) => {
  const g = req.body?.geometry;
  const ky = num(req.body?.ky);
  const phien = num(req.body?.phien);
  if (!g || !ky) return res.status(400).json({ error: 'Thiếu geometry hoặc ky' });
  const idx = idxOf(req.body?.chi_so);
  const { rows } = await pool.query(`SELECT * FROM ${S}.fn_thong_ke_vung($1, $2, $3, $4)`, [JSON.stringify(g), idx, ky, phien]);
  const x = rows[0] || {};
  res.json({ so_o: Number(x.so_o || 0), tb: r(x.tb), min: r(x.nho_nhat), max: r(x.lon_nhat), sd: r(x.do_lech) });
}));

// ─── Dự báo thời tiết 7 ngày (Open-Meteo) → ước tính LST ngắn hạn ─────────
/** LST ≈ T_không khí + 3.5 + 0.008·bức xạ (W/m²) — hệ số kinh nghiệm cho đô thị nhiệt đới. */
const estimateLST = (t, solar) => (t === null || t === undefined ? null : Math.round((t + 3.5 + 0.008 * (solar || 0)) * 100) / 100);

async function fetchWeather(lon, lat) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,shortwave_radiation_sum,precipitation_sum' +
    '&timezone=Asia%2FHo_Chi_Minh&forecast_days=7';
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error('Open-Meteo trả lỗi ' + resp.status);
  const { daily } = await resp.json();
  const rows = daily.time.map((d, i) => {
    const solar = ((daily.shortwave_radiation_sum?.[i] || 0) * 1e6) / 86400; // MJ/m²/ngày → W/m² trung bình ngày
    return {
      ngay: d, t_max: daily.temperature_2m_max[i], t_min: daily.temperature_2m_min[i], t_tb: daily.temperature_2m_mean[i],
      buc_xa: Math.round(solar), mua_mm: daily.precipitation_sum?.[i] ?? null,
      lst: estimateLST(daily.temperature_2m_max[i], solar),
    };
  });
  for (const x of rows) {
    await pool.query(`
      INSERT INTO ${S}.thoi_tiet_du_bao (ngay, kinh_do, vi_do, t_max, t_min, t_tb, buc_xa_wm2, lst_uoc_tinh)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (ngay, kinh_do, vi_do) DO UPDATE SET t_max = EXCLUDED.t_max, t_min = EXCLUDED.t_min, t_tb = EXCLUDED.t_tb,
        buc_xa_wm2 = EXCLUDED.buc_xa_wm2, lst_uoc_tinh = EXCLUDED.lst_uoc_tinh, thoi_diem_lay = now()`,
    [x.ngay, lon, lat, x.t_max, x.t_min, x.t_tb, x.buc_xa, x.lst]);
  }
  return rows;
}

// ─── Dự báo LST THEO NGÀY (7 ngày, GIẢ LẬP) ──────────────────────────────
// Landsat chỉ cho ảnh theo tháng nên dự báo ngày là GIẢ LẬP: lấy dự báo THÁNG của mô hình AI tốt nhất cho
// từng phường rồi cộng dao động ngày theo thời tiết Open-Meteo so với chuẩn khí hậu tháng:
//   lệch(ngày) = 1,0·(T_max ngày − T_max chuẩn tháng) + 0,010·(bức xạ ngày − TB bức xạ 7 ngày) − 0,05·min(mưa, 40 mm)
// T_max chuẩn: trung bình nhiệt độ cao nhất ngày theo tháng ở TP.HCM (trạm Tân Sơn Nhất, xấp xỉ chuẩn 1991–2020).
const TMAX_NORMAL = [31.6, 32.7, 33.9, 34.6, 34.0, 32.4, 31.8, 31.8, 31.3, 31.2, 31.0, 30.8];
const DAILY_COEF = { t_max: 1.0, buc_xa: 0.010, mua: -0.05, mua_tran_mm: 40 };
const CITY = { lat: 10.78, lon: 106.70 };
const todayVN = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
function dailyOffsets(days) {
  const rad = days.map((d) => d.buc_xa ?? 0);
  const rm = rad.reduce((a, b) => a + b, 0) / Math.max(rad.length, 1);
  return days.map((d) => {
    const m = +d.ngay.slice(5, 7);
    const v = DAILY_COEF.t_max * ((d.t_max ?? TMAX_NORMAL[m - 1]) - TMAX_NORMAL[m - 1])
      + DAILY_COEF.buc_xa * ((d.buc_xa ?? rm) - rm)
      + DAILY_COEF.mua * Math.min(d.mua_mm ?? 0, DAILY_COEF.mua_tran_mm);
    return Math.max(-6, Math.min(6, Math.round(v * 100) / 100));
  });
}
/** Thời tiết giả lập khi không gọi được Open-Meteo: chuẩn khí hậu + dao động xác định theo ngày (không ngẫu nhiên mỗi lần gọi). */
function simulatedWeather(start) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start + 'T12:00:00+07:00'); d.setDate(d.getDate() + i);
    const ngay = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    const m = +ngay.slice(5, 7), seed = +ngay.replace(/-/g, '');
    const w = Math.sin(seed * 12.9898) * 43758.5453, n = w - Math.floor(w) - 0.5;
    out.push({ ngay, t_max: Math.round((TMAX_NORMAL[m - 1] + n * 2.4) * 10) / 10, t_min: Math.round((TMAX_NORMAL[m - 1] - 8 + n) * 10) / 10,
      buc_xa: Math.round(190 + n * 60), mua_mm: Math.max(0, Math.round((n + 0.1) * 20 * 10) / 10) });
  }
  return out;
}
let dailyBusy = null;                                   // tránh tính trùng khi nhiều người mở cùng lúc
async function buildDaily() {
  const meta = await cached('meta', loadMeta);
  const best = meta.runs.find((x) => x.mac_dinh && x.ma_loai === 'MO_HINH') || meta.runs.find((x) => x.ma_loai === 'MO_HINH');
  if (!best) { const e = new Error('Chưa có phiên dự báo tháng. Chạy python database/etl/du_bao_lst.py'); e.status = 404; throw e; }
  const day0 = todayVN();
  const key = `daily:${day0}:${best.ma_phien}`;
  const hit = cache.get(key);
  if (hit && hit.t > Date.now()) return hit.v;

  let nguon = 'Open-Meteo', wx;
  try {
    wx = (await fetchWeather(CITY.lon, CITY.lat)).map((x) => ({ ngay: x.ngay, t_max: x.t_max, t_min: x.t_min, buc_xa: x.buc_xa, mua_mm: x.mua_mm }));
  } catch (e) {
    const c = await pool.query(`SELECT ngay::text, t_max, t_min, buc_xa_wm2 AS buc_xa FROM ${S}.thoi_tiet_du_bao
      WHERE kinh_do = $1 AND vi_do = $2 AND ngay >= $3::date ORDER BY ngay LIMIT 7`, [CITY.lon, CITY.lat, day0]);
    if (c.rows.length >= 7) { wx = c.rows.map((x) => ({ ...x, mua_mm: 0 })); nguon = 'Open-Meteo (bộ nhớ đệm CSDL)'; }
    else { wx = simulatedWeather(day0); nguon = 'thời tiết giả lập theo chuẩn khí hậu (không gọi được Open-Meteo)'; }
  }
  wx = wx.slice(0, 7);
  const lech = dailyOffsets(wx);
  const fut = best.months.filter((m) => m.tap === 'future');
  const pickMonth = (ky) => {
    if (best.months.some((m) => m.ky === ky)) return ky;
    const all = best.months.map((m) => m.ky);
    return all.reduce((a, b) => (Math.abs(b - ky) < Math.abs(a - ky) ? b : a), all[0]);
  };
  const kys = wx.map((d) => pickMonth(+d.ngay.slice(0, 4) * 100 + +d.ngay.slice(5, 7)));
  const [w, v] = await Promise.all([
    pool.query(`SELECT ma_xa FROM ${S}.don_vi_hanh_chinh ORDER BY ma_xa`),
    pool.query(`SELECT ma_xa, ma_ky, tb FROM ${S}.thong_ke_phuong WHERE ma_phien = $1 AND ma_ky = ANY($2)`, [best.ma_phien, [...new Set(kys)]]),
  ]);
  const pos = new Map(w.rows.map((x, i) => [x.ma_xa, i]));
  const byKy = {};
  for (const x of v.rows) (byKy[x.ma_ky] ??= new Array(w.rows.length).fill(null))[pos.get(x.ma_xa)] = x.tb;
  const bands = best.tham_so?.khoang_du_bao_80?.phuong || [];
  const days = wx.map((d, i) => {
    const mItem = best.months.find((m) => m.ky === kys[i]);
    const h = Math.max(0, fut.findIndex((m) => m.ky === kys[i]));
    const b = bands[h] || [-2, 2];
    const spread = 0.6 + 0.15 * i;                         // bất định thời tiết tăng theo số ngày
    const base = mItem?.tb ?? null;
    return { ngay: d.ngay, ky: kys[i], t_max: d.t_max, t_min: d.t_min, buc_xa: d.buc_xa, mua_mm: d.mua_mm ?? null, lech: lech[i],
      lst_thang: r(base, 2), lst: base === null ? null : r(base + lech[i], 2),
      p10: base === null ? null : r(base + lech[i] + b[0] - spread, 2), p90: base === null ? null : r(base + lech[i] + b[1] + spread, 2) };
  });
  const wards = days.map((d, i) => (byKy[d.ky] || []).map((x) => (x === null ? null : r(x + lech[i], 2))));
  // Lưu vào CSDL (bảng du_bao_ngay) để tra cứu lại: 1 dòng toàn TP + 1 dòng mỗi phường cho mỗi ngày
  try {
    const rows = [];
    days.forEach((d, i) => {
      rows.push([d.ngay, null, d.lst_thang, d.lech, d.lst, d.p10, d.p90, d.t_max, d.buc_xa, d.mua_mm]);
      w.rows.forEach((x, k) => { const val = wards[i][k]; if (val !== null) rows.push([d.ngay, x.ma_xa, r(byKy[d.ky][k], 3), d.lech, val, null, null, d.t_max, d.buc_xa, d.mua_mm]); });
    });
    const col = (j) => rows.map((x) => x[j]);
    await pool.query(`DELETE FROM ${S}.du_bao_ngay WHERE ma_phien_thang = $1 AND ngay = ANY($2::date[])`, [best.ma_phien, days.map((d) => d.ngay)]);
    await pool.query(`INSERT INTO ${S}.du_bao_ngay (ngay, ma_xa, ma_phien_thang, lst_thang, lech_ngay, lst, lst_p10, lst_p90, t_max, buc_xa_wm2, mua_mm, nguon)
      SELECT u.ngay, u.ma_xa, $1, u.lt, u.le, u.ls, u.p1, u.p9, u.tx, u.bx, u.mm, $2
        FROM unnest($3::date[], $4::varchar[], $5::real[], $6::real[], $7::real[], $8::real[], $9::real[], $10::real[], $11::real[], $12::real[])
          AS u(ngay, ma_xa, lt, le, ls, p1, p9, tx, bx, mm)`,
    [best.ma_phien, `GIA_LAP: ${best.ten_mo_hinh} (tháng) + ${nguon}`, col(0), col(1), col(2), col(3), col(4), col(5), col(6), col(7), col(8), col(9)]);
  } catch (e) { console.warn('[daily] không lưu được du_bao_ngay:', e.message); }
  const out = {
    nguon, cap_nhat: new Date().toISOString(), loai: 'GIA_LAP',
    phien: { ma_phien: best.ma_phien, ten: best.ten, ten_mo_hinh: best.ten_mo_hinh },
    vi_tri: CITY, he_so: { ...DAILY_COEF, tmax_chuan: TMAX_NORMAL }, days, wards,
  };
  cache.set(key, { t: Date.now() + 3 * 3600e3, v: out });
  return out;
}
app.get('/api/daily', wrap(async (req, res) => {
  try {
    dailyBusy ||= buildDaily().finally(() => { dailyBusy = null; });
    res.json(await dailyBusy);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

app.get('/api/weather', wrap(async (req, res) => {
  const lat = Math.round((num(req.query.lat, 10.776)) * 100) / 100;
  const lon = Math.round((num(req.query.lon, 106.70)) * 100) / 100;
  const c = await pool.query(`
    SELECT ngay::text, t_max, t_min, t_tb, buc_xa_wm2 AS buc_xa, lst_uoc_tinh AS lst FROM ${S}.thoi_tiet_du_bao
     WHERE kinh_do = $1 AND vi_do = $2 AND ngay >= CURRENT_DATE AND thoi_diem_lay > now() - interval '3 hours'
     ORDER BY ngay LIMIT 7`, [lon, lat]);
  if (c.rows.length >= 6) return res.json({ nguon: 'bộ nhớ đệm CSDL', lat, lon, ngay: c.rows });
  try {
    res.json({ nguon: 'Open-Meteo', lat, lon, ngay: await fetchWeather(lon, lat) });
  } catch (e) {
    if (c.rows.length) return res.json({ nguon: 'bộ nhớ đệm (cũ)', lat, lon, ngay: c.rows });
    res.status(502).json({ error: 'Không lấy được dự báo thời tiết: ' + e.message });
  }
}));

// ─── Quản trị (xác thực/phân quyền nằm trong server_auth.js) ───────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/admin/summary', wrap(async (req, res) => {
  const tables = ['dm_chi_so', 'dm_loai_du_lieu', 'dm_mo_hinh', 'dm_nguong_canh_bao', 'ky_thoi_gian', 'ranh_gioi_tinh',
    'don_vi_hanh_chinh', 'luoi_o', 'phien_du_bao', 'phien_ky', 'quan_trac_o', 'du_bao_o', 'anh_raster',
    'thong_ke_phuong', 'danh_gia_mo_hinh', 'thoi_tiet_du_bao', 'du_bao_ngay', 'nhat_ky_nap'];
  const counts = await pool.query(`SELECT c.relname AS bang, c.reltuples::bigint AS uoc_luong,
      pg_total_relation_size(c.oid) AS dung_luong, obj_description(c.oid) AS mo_ta
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY($2)`, [S, tables]);
  const exact = await Promise.all(tables.map((t) => pool.query(`SELECT count(*)::bigint n FROM ${S}.${t}`).then((x) => [t, Number(x.rows[0].n)])));
  const ex = Object.fromEntries(exact);
  const log = await pool.query(`SELECT id, thoi_diem, buoc, chi_tiet FROM ${S}.nhat_ky_nap ORDER BY id DESC LIMIT 20`);
  const views = await pool.query(`SELECT table_name FROM information_schema.views WHERE table_schema = $1 ORDER BY 1`, [S]);
  const size = await pool.query(`SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) s FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`, [S]);
  res.json({
    bang: tables.map((t) => {
      const c = counts.rows.find((x) => x.bang === t) || {};
      return { bang: t, so_dong: ex[t], dung_luong: Number(c.dung_luong || 0), mo_ta: c.mo_ta || null };
    }),
    view: views.rows.map((x) => x.table_name), tong_dung_luong: size.rows[0].s, nhat_ky: log.rows,
  });
}));

app.post('/api/admin/reload', (req, res) => {
  cache.clear();
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API ' + req.path }));
app.use((err, req, res, next) => {
  console.error('[lỗi]', req.method, req.originalUrl, '-', err.message);
  const missing = err.code === '42P01' || err.code === '3F000';
  res.status(missing ? 503 : 500).json({
    error: missing ? 'CSDL chưa có schema vientham. Chạy: python database/etl/nap_du_lieu.py' : err.message,
  });
});

(async () => {
  try {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM ${S}.don_vi_hanh_chinh`);
    console.log(`[db] ${process.env.PGDATABASE}@${process.env.PGHOST} · schema ${S} · ${rows[0].n} phường/xã`);
  } catch (e) {
    console.error('[db] Chưa sẵn sàng:', e.message);
  }
  app.listen(PORT, () => console.log(`[web] http://localhost:${PORT}`));
  // tính sẵn dự báo 7 ngày (gọi Open-Meteo + ghi du_bao_ngay) để người dùng mở tab 7 ngày là có ngay
  if (process.env.LST_EXPORT !== '1') setTimeout(() => buildDaily().then(() => console.log('[daily] đã tính sẵn dự báo 7 ngày')).catch((e) => console.warn('[daily]', e.message)), 3000);
})();
