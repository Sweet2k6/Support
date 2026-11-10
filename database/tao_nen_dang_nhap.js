/* =====================================================================
   Tạo dữ liệu NỀN cho trang đăng nhập: public/login-bg.json
   - Ranh giới 168 phường/xã đã làm đơn giản (Douglas–Peucker ~150 m, 4 chữ số thập phân)
   - LST trung bình từng phường theo các tháng có ảnh GEE thật (làm tròn 0,1 °C)
   Chỉ là dữ liệu tổng hợp để trang đăng nhập vẽ bản đồ mờ tự chạy; KHÔNG có tên phường,
   ô lưới, ảnh gốc hay kết quả mô hình (những thứ đó vẫn cần đăng nhập).
   Chạy sau database/xuat_ban_tinh.js:  node database/tao_nen_dang_nhap.js
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'public', 'data', 'api');
const OUT = path.join(__dirname, '..', 'public', 'login-bg.json');
const TOL = 0.0014;                          // độ (≈150 m)

function simplify(pts, tol) {               // Douglas–Peucker
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      // vòng khép kín (điểm đầu = điểm cuối): dùng khoảng cách tới điểm đầu
      const d = L < 1e-12 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const r4 = (v) => Math.round(v * 1e4) / 1e4;

const wards = JSON.parse(fs.readFileSync(path.join(API, 'wards.json'), 'utf8'));
const series = JSON.parse(fs.readFileSync(path.join(API, 'series_LST.json'), 'utf8'));

let bbox = [Infinity, Infinity, -Infinity, -Infinity];
const shapes = [];
for (const f of wards.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = [];
  for (const poly of polys) {
    const outer = simplify(poly[0], TOL);
    if (outer.length < 4) continue;
    const area = Math.abs(outer.reduce((s, p, i) => { const q = outer[(i + 1) % outer.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    if (area < 2e-6) continue;               // bỏ đảo/cồn quá nhỏ
    rings.push(outer.map(([x, y]) => [r4(x), r4(y)]));
  }
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < 106.0 || x > 108 || y < 10 || y > 11.8) continue;   // Côn Đảo ở rất xa: không tính vào khung
    bbox = [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)];
  }
  shapes[f.properties.i] = rings;
}
const out = {
  ghi_chu: 'Nền trang đăng nhập: ranh giới đơn giản hoá + LST trung bình phường theo tháng (ảnh GEE). Tạo bởi database/tao_nen_dang_nhap.js',
  bbox: bbox.map(r4),
  months: series.months,
  v: series.tb.map((row) => row.map((x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null))),
  wards: shapes.map((rings) => rings || []),
};
fs.writeFileSync(OUT, JSON.stringify(out));
const pts = out.wards.reduce((s, w) => s + w.reduce((t, r) => t + r.length, 0), 0);
console.log(`✓ ${path.relative(process.cwd(), OUT)}: ${out.wards.length} phường, ${pts} đỉnh, ${out.months.length} tháng, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
