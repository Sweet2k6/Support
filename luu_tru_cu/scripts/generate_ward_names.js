const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.PGHOST,
  port: +process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

const districtsGeo = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/hcm_districts.geojson'), 'utf8'));

// Official wards by district
const districtWards = {
  'Quận 1': ['Phường Bến Nghé', 'Phường Bến Thành', 'Phường Đa Kao', 'Phường Tân Định', 'Phường Cầu Ông Lãnh', 'Phường Cô Giang', 'Phường Cầu Kho', 'Phường Nguyễn Cư Trinh', 'Phường Phạm Ngũ Lão', 'Phường Nguyễn Thái Bình'],
  'Quận 3': ['Phường Võ Thị Sáu', 'Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 14'],
  'Quận 4': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 6', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16', 'Phường 18'],
  'Quận 5': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14'],
  'Quận 6': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14'],
  'Quận 7': ['Phường Tân Thuận Đông', 'Phường Tân Thuận Tây', 'Phường Tân Kiểng', 'Phường Tân Hưng', 'Phường Bình Thuận', 'Phường Tân Quy', 'Phường Phú Thuận', 'Phường Tân Phú', 'Phường Tân Phong', 'Phường Phú Mỹ'],
  'Quận 8': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16'],
  'Quận 10': ['Phường 1', 'Phường 2', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15'],
  'Quận 11': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16'],
  'Quận 12': ['Phường Thạnh Xuân', 'Phường Thạnh Lộc', 'Phường Hiệp Thành', 'Phường Thới An', 'Phường Tân Chánh Hiệp', 'Phường An Phú Đông', 'Phường Tân Thới Hiệp', 'Phường Trung Mỹ Tây', 'Phường Tân Hưng Thuận', 'Phường Đông Hưng Thuận', 'Phường Tân Thới Nhất'],
  'Quận Bình Thạnh': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 17', 'Phường 19', 'Phường 21', 'Phường 22', 'Phường 24', 'Phường 25', 'Phường 26', 'Phường 27', 'Phường 28'],
  'Quận Gò Vấp': ['Phường 1', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15', 'Phường 16', 'Phường 17'],
  'Quận Phú Nhuận': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 13', 'Phường 15', 'Phường 17'],
  'Quận Tân Bình': ['Phường 1', 'Phường 2', 'Phường 3', 'Phường 4', 'Phường 5', 'Phường 6', 'Phường 7', 'Phường 8', 'Phường 9', 'Phường 10', 'Phường 11', 'Phường 12', 'Phường 13', 'Phường 14', 'Phường 15'],
  'Quận Tân Phú': ['Phường Tân Sơn Nhì', 'Phường Tây Thạnh', 'Phường Sơn Kỳ', 'Phường Tân Quý', 'Phường Tân Thành', 'Phường Phú Thọ Hòa', 'Phường Phú Thạnh', 'Phường Phú Trung', 'Phường Hòa Thạnh', 'Phường Hiệp Tân', 'Phường Tân Thới Hòa'],
  'Quận Bình Tân': ['Phường Bình Hưng Hòa', 'Phường Bình Hưng Hòa A', 'Phường Bình Hưng Hòa B', 'Phường Bình Trị Đông', 'Phường Bình Trị Đông A', 'Phường Bình Trị Đông B', 'Phường Tân Tạo', 'Phường Tân Tạo A', 'Phường An Lạc', 'Phường An Lạc A'],
  'TP. Thủ Đức (Khu Quận 2)': ['Phường Thảo Điền', 'Phường An Phú', 'Phường An Khánh', 'Phường Bình An', 'Phường Bình Trưng Đông', 'Phường Bình Trưng Tây', 'Phường Cát Lái', 'Phường Thạnh Mỹ Lợi'],
  'TP. Thủ Đức (Khu Quận 9)': ['Phường Hiệp Phú', 'Phường Long Bình', 'Phường Long Phước', 'Phường Long Thạnh Mỹ', 'Phường Long Trường', 'Phường Phú Hữu', 'Phường Phước Bình', 'Phường Phước Long A', 'Phường Phước Long B', 'Phường Trường Thạnh', 'Phường Tăng Nhơn Phú A', 'Phường Tăng Nhơn Phú B'],
  'TP. Thủ Đức (Khu Thủ Đức)': ['Phường Bình Chiểu', 'Phường Bình Thọ', 'Phường Hiệp Bình Chánh', 'Phường Hiệp Bình Phước', 'Phường Linh Chiểu', 'Phường Linh Đông', 'Phường Linh Tây', 'Phường Linh Trung', 'Phường Linh Xuân', 'Phường Tam Bình', 'Phường Tam Phú', 'Phường Trường Thọ'],
  'Huyện Củ Chi': ['Thị trấn Củ Chi', 'Xã An Nhơn Tây', 'Xã An Phú', 'Xã Bình Mỹ', 'Xã Hòa Phú', 'Xã Nhuận Đức', 'Xã Phạm Văn Cội', 'Xã Phú Hòa Đông', 'Xã Phú Mỹ Hưng', 'Xã Phước Hiệp', 'Xã Phước Thạnh', 'Xã Phước Vĩnh An', 'Xã Tân An Hội', 'Xã Tân Phú Trung', 'Xã Tân Thạnh Đông', 'Xã Tân Thạnh Tây', 'Xã Tân Thông Hội', 'Xã Thái Mỹ', 'Xã Trung An', 'Xã Trung Lập Hạ', 'Xã Trung Lập Thượng'],
  'Huyện Hóc Môn': ['Thị trấn Hóc Môn', 'Xã Bà Điểm', 'Xã Đông Thạnh', 'Xã Nhị Bình', 'Xã Tân Hiệp', 'Xã Tân Thới Nhì', 'Xã Tân Xuân', 'Xã Thới Tam Thôn', 'Xã Trung Chánh', 'Xã Xuân Thới Đông', 'Xã Xuân Thới Sơn', 'Xã Xuân Thới Thượng'],
  'Huyện Bình Chánh': ['Thị trấn Tân Túc', 'Xã An Phú Tây', 'Xã Bình Chánh', 'Xã Bình Hưng', 'Xã Bình Lợi', 'Xã Đa Phước', 'Xã Hưng Long', 'Xã Lê Minh Xuân', 'Xã Phạm Văn Hai', 'Xã Phong Phú', 'Xã Quy Đức', 'Xã Tân Kiên', 'Xã Tân Nhựt', 'Xã Tân Quý Tây', 'Xã Vĩnh Lộc A', 'Xã Vĩnh Lộc B'],
  'Huyện Nhà Bè': ['Thị trấn Nhà Bè', 'Xã Hiệp Phước', 'Xã Long Thới', 'Xã Nhơn Đức', 'Xã Phú Xuân', 'Xã Phước Kiển', 'Xã Phước Lộc'],
  'Huyện Cần Giờ': ['Thị trấn Cần Thạnh', 'Xã An Thới Đông', 'Xã Bình Khánh', 'Xã Long Hòa', 'Xã Lý Nhơn', 'Xã Tam Thôn Hiệp', 'Xã Thạnh An']
};

function ptInPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function findDistrictForPoint(lon, lat) {
  // First check exact polygon inclusion
  for (const f of districtsGeo.features) {
    const g = f.geometry;
    if (g.type === 'Polygon') {
      if (ptInPolygon([lon, lat], g.coordinates[0])) return f.properties.ten;
    } else if (g.type === 'MultiPolygon') {
      for (const p of g.coordinates) {
        if (ptInPolygon([lon, lat], p[0])) return f.properties.ten;
      }
    }
  }

  // If outside polygon boundary, find nearest district centroid
  let best = 'Quận 1', minDist = Infinity;
  for (const f of districtsGeo.features) {
    const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    let sumLon = 0, sumLat = 0;
    for (let i = 0; i < ring.length; i++) {
      sumLon += ring[i][0];
      sumLat += ring[i][1];
    }
    const cLon = sumLon / ring.length;
    const cLat = sumLat / ring.length;
    const d = Math.hypot(lon - cLon, lat - cLat);
    if (d < minDist) {
      minDist = d;
      best = f.properties.ten;
    }
  }
  return best;
}

async function main() {
  const { rows } = await pool.query(`
    SELECT
      ROUND(lst.x::numeric, 2) AS lon_grid,
      ROUND(lst.y::numeric, 2) AS lat_grid,
      ROUND(AVG(lst.gia_tri)::numeric, 2) AS lst_avg
    FROM chi_so_diem lst
    WHERE lst.chi_so = 'LST' AND lst.nam = 2026
    GROUP BY ROUND(lst.x::numeric,2), ROUND(lst.y::numeric,2)
    ORDER BY lst_avg DESC
    LIMIT 200
  `);

  console.log(`Processing ${rows.length} grid clusters...`);

  const lookup = {};
  const districtCounts = {};

  for (const row of rows) {
    const lon = parseFloat(row.lon_grid);
    const lat = parseFloat(row.lat_grid);
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;

    const district = findDistrictForPoint(lon, lat);
    districtCounts[district] = (districtCounts[district] || 0) + 1;
    const idx = districtCounts[district] - 1;

    const wards = districtWards[district] || ['Khu trung tâm'];
    const wardName = wards[idx % wards.length] || `Khu vực ${idx + 1}`;

    lookup[key] = {
      ten: wardName,
      quan: district,
      lon: lon,
      lat: lat
    };
  }

  fs.writeFileSync(
    path.join(__dirname, '../public/data/ward_names_lookup.json'),
    JSON.stringify(lookup, null, 2),
    'utf8'
  );

  console.log(`Saved ${Object.keys(lookup).length} mappings to public/data/ward_names_lookup.json!`);
  await pool.end();
}

main().catch(console.error);
