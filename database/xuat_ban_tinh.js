/**
 * XUẤT BẢN TĨNH cho GitHub Pages (không cần Node/PostgreSQL khi xem demo)
 *   node database/xuat_ban_tinh.js            (server không cần chạy, chỉ cần CSDL)
 *
 * Gọi lại đúng các API của server.js rồi ghi kết quả ra public/data/api/*.json.
 * Khi web mở trên *.github.io (hoặc thêm ?static vào URL), app.js đọc các file này thay cho /api.
 * Riêng ô lưới 480 m được gói theo từng phường (cells/<ma_xa>.json) để phục vụ cột 3D và tra cứu điểm.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const OUT = path.join(__dirname, '..', 'public', 'data', 'api');
const PORT = 3999;
const S = 'vientham';
const pool = new Pool({ host: process.env.PGHOST, port: +process.env.PGPORT || 5432, database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });

function get(p) {
  return new Promise((res, rej) => {
    http.get(`http://localhost:${PORT}/api${p}`, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => (r.statusCode === 200 ? res(JSON.parse(b)) : rej(new Error(`${p}: ${r.statusCode} ${b}`))));
    }).on('error', rej);
  });
}
const write = (rel, obj) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
};

(async () => {
  process.env.PORT = PORT;
  process.env.LST_EXPORT = '1';               // cho phép chính máy này gọi API không cần đăng nhập (chỉ server tạm này)
  require('../server.js');                    // khởi động server tạm trên cổng 3999 để tái dùng logic API
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(OUT, { recursive: true, force: true });

  const meta = await get('/meta');
  write('meta.json', meta);
  write('wards.json', await get('/wards'));
  write('boundary.json', await get('/boundary'));
  write('series_LST.json', await get('/series?chi_so=LST'));
  write('stats_LST.json', await get('/stats?chi_so=LST'));
  for (const r of meta.runs) {
    write(`series_LST_${r.ma_phien}.json`, await get(`/series?chi_so=LST&phien=${r.ma_phien}`));
    if (r.metrics?.test) write(`compare_${r.ma_phien}.json`, await get(`/compare?phien=${r.ma_phien}`));
  }
  const wards = (await pool.query(`SELECT ma_xa FROM ${S}.don_vi_hanh_chinh ORDER BY ma_xa`)).rows.map((x) => x.ma_xa);
  for (const ma of wards) write(`ward/${ma}.json`, await get(`/ward/${ma}`));
  console.log(`✓ meta, ranh giới, chuỗi, thống kê, ${wards.length} phường`);

  // Ô lưới theo phường: toạ độ + LST hiện trạng mọi tháng + dự báo mọi phiên
  const cells = await pool.query(`SELECT ma_o, ma_xa, kinh_do, vi_do FROM ${S}.luoi_o WHERE ma_xa IS NOT NULL ORDER BY ma_xa, ma_o`);
  const obs = await pool.query(`SELECT ma_o, ma_ky, gia_tri FROM ${S}.quan_trac_o WHERE ma_chi_so = 'LST'`);
  // Bản tĩnh chỉ gói ô lưới của: mô hình được chọn (mặc định), kịch bản giả lập và phiên nội suy — giữ dung lượng nhỏ
  const keep = meta.runs.filter((r) => r.mac_dinh || r.ma_loai !== 'MO_HINH').map((r) => r.ma_phien);
  const fc = await pool.query(`SELECT d.ma_phien, d.ma_o, d.ma_ky, d.gia_tri FROM ${S}.du_bao_o d JOIN ${S}.phien_du_bao p USING (ma_phien)
                                WHERE p.ma_chi_so = 'LST' AND d.ma_phien = ANY($1)`, [keep]);
  const byWard = new Map();
  const pos = new Map();
  for (const c of cells.rows) {
    if (!byWard.has(c.ma_xa)) byWard.set(c.ma_xa, { ma_xa: c.ma_xa, o: [], gee: {}, run: {} });
    const w = byWard.get(c.ma_xa);
    pos.set(c.ma_o, [w, w.o.length]);
    w.o.push([Math.round(c.kinh_do * 1e5) / 1e5, Math.round(c.vi_do * 1e5) / 1e5]);
  }
  const put = (obj, key, w, k, v) => {
    if (!obj[key]) obj[key] = new Array(w.o.length).fill(null);
    obj[key][k] = Math.round(v * 10) / 10;
  };
  for (const x of obs.rows) { const p = pos.get(x.ma_o); if (p) put(p[0].gee, x.ma_ky, p[0], p[1], x.gia_tri); }
  for (const x of fc.rows) {
    const p = pos.get(x.ma_o); if (!p) continue;
    p[0].run[x.ma_phien] ||= {};
    put(p[0].run[x.ma_phien], x.ma_ky, p[0], p[1], x.gia_tri);
  }
  for (const w of byWard.values()) write(`cells/${w.ma_xa}.json`, w);
  console.log(`✓ ô lưới của ${byWard.size} phường`);

  const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  console.log(`Xong: ${(size(OUT) / 1048576).toFixed(1)} MB trong public/data/api`);
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
