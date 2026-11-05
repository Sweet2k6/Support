-- TRUY VẤN DEMO KHI SHOW ĐỒ ÁN · CSDL webgis · schema vientham
-- Mở: "D:\Mon_ThayTuan\PostSQL\bin\psql.exe" -h localhost -U postgres -d webgis
-- Hoặc copy từng khối vào pgAdmin > Query Tool rồi bấm F5

-- ===================== 01_postgis =====================
SELECT version();
SELECT postgis_lib_version() AS postgis, postgis_geos_version() AS geos;
SELECT extname, extversion FROM pg_extension WHERE extname LIKE 'postgis%';
\dn+ vientham

-- ===================== 02_tables =====================
\dt+ vientham.*

-- ===================== 03_bigdata =====================
SELECT relname AS bang, n_live_tup AS so_dong,
       pg_size_pretty(pg_total_relation_size(relid)) AS dung_luong
  FROM pg_stat_user_tables WHERE schemaname = 'vientham'
 ORDER BY pg_total_relation_size(relid) DESC LIMIT 8;
SELECT pg_size_pretty(pg_database_size('webgis')) AS tong_dung_luong_csdl;

-- ===================== 04_danhmuc =====================
SET search_path = vientham, public;
SELECT ma_chi_so, ten, don_vi, thang_mau_min, thang_mau_max, cao_la_xau FROM dm_chi_so;
SELECT ma_loai, ten, nhom FROM dm_loai_du_lieu;
SELECT ma_mo_hinh, ten, nhom, thu_vien FROM dm_mo_hinh ORDER BY thu_tu;

-- ===================== 05_hientrang =====================
SET search_path = vientham, public;
SELECT ma_chi_so, count(DISTINCT ma_ky) AS so_thang, min(ma_ky) AS tu_ky, max(ma_ky) AS den_ky,
       count(*) AS so_gia_tri_o
  FROM quan_trac_o GROUP BY ma_chi_so;
SELECT ma_chi_so, ma_ky, duong_dan_goc, duong_dan_web FROM anh_raster
 WHERE ma_loai = 'GEE' AND ma_chi_so = 'LST' ORDER BY ma_ky DESC LIMIT 5;

-- ===================== 06_phien =====================
SET search_path = vientham, public;
SELECT ma_phien, ma_mo_hinh, ma_loai, ten, la_mac_dinh AS mac_dinh, ky_du_bao_tu, ky_du_bao_den
  FROM phien_du_bao ORDER BY ma_phien;
SELECT ma_phien, tap, count(*) AS so_thang FROM phien_ky WHERE ma_phien = 1 GROUP BY 1, 2 ORDER BY 2;

-- ===================== 07_check =====================
SET search_path = vientham, public;
-- (Lệnh dưới đây CỐ Ý SAI, CSDL sẽ báo lỗi — không ghi gì vào bảng)
-- Thử ghi 1 phiên dự báo nhưng gắn nhãn GEE (hiện trạng) -> CSDL phải từ chối
INSERT INTO phien_du_bao (ma_mo_hinh, ma_chi_so, ma_loai, ten)
VALUES ('RF', 'LST', 'GEE', 'Thử gắn nhầm nhãn hiện trạng');
-- Thử ghi ảnh dự báo mà không gắn phiên -> cũng bị từ chối
INSERT INTO anh_raster (ma_chi_so, ma_ky, ma_loai, duong_dan_web)
VALUES ('LST', 202601, 'MO_HINH', 'x.png');

-- ===================== 08_view_gop =====================
SET search_path = vientham, public;
-- Cùng 1 ô lưới, cùng tháng: giá trị hiện trạng GEE và dự báo các mô hình (cột nhom)
SELECT nhom, ma_loai, ma_mo_hinh, ma_ky, round(gia_tri::numeric, 2) AS lst
  FROM v_gia_tri_o
 WHERE ma_o = 15887 AND ma_chi_so = 'LST'
   AND ma_ky = (SELECT max(k.ma_ky) FROM phien_ky k WHERE k.tap = 'test')
 ORDER BY nhom DESC, ma_mo_hinh;

-- ===================== 09_xephang =====================
SET search_path = vientham, public;
SELECT hang_rmse, ma_mo_hinh, ten, round(mae::numeric,3) mae, round(rmse::numeric,3) rmse,
       round(r2::numeric,4) r2, round(mape::numeric,2) mape
  FROM v_xep_hang_mo_hinh WHERE ma_chi_so = 'LST' AND ma_loai = 'MO_HINH' ORDER BY rmse;

-- ===================== 10_top10 =====================
SET search_path = vientham, public;
-- 10 phường/xã nóng nhất trong tháng GEE gần nhất
SELECT d.loai || ' ' || d.ten_xa AS phuong, d.khu_vuc_cu, t.ma_ky, round(t.tb::numeric, 2) AS lst_tb
  FROM thong_ke_phuong t JOIN don_vi_hanh_chinh d USING (ma_xa)
 WHERE t.ma_chi_so = 'LST' AND t.ma_loai = 'GEE'
   AND t.ma_ky = (SELECT max(ma_ky) FROM thong_ke_phuong WHERE ma_chi_so='LST' AND ma_loai='GEE')
 ORDER BY t.tb DESC LIMIT 10;

-- ===================== 11_khonggian =====================
SET search_path = vientham, public;
-- Truy vấn không gian: điểm (106.70, 10.776) nằm trong phường nào, ô lưới gần nhất cách bao xa
SELECT ma_xa, loai || ' ' || ten_xa AS phuong, round(ST_Area(geom::geography)/1e6)::int AS km2
  FROM don_vi_hanh_chinh WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(106.70, 10.776), 4326));
SELECT ma_ky, ma_loai, ma_phien, round(gia_tri::numeric,2) AS lst, round(khoang_cach_m) AS cach_m
  FROM fn_chuoi_tai_diem(106.70, 10.776, 'LST') WHERE ma_loai = 'GEE' ORDER BY ma_ky DESC LIMIT 6;
-- Thống kê trong một vùng tự vẽ (GeoJSON)
SELECT * FROM fn_thong_ke_vung('{"type":"Polygon","coordinates":[[[106.68,10.76],[106.72,10.76],[106.72,10.80],[106.68,10.80],[106.68,10.76]]]}', 'LST', 202604);

-- ===================== 12_explain =====================
SET search_path = vientham, public;
-- Truy vấn trên bảng 3,5 triệu dòng có dùng chỉ mục không, mất bao lâu?
EXPLAIN (ANALYZE, COSTS OFF, TIMING ON)
SELECT q.ma_ky, q.gia_tri FROM quan_trac_o q
 WHERE q.ma_o = (SELECT ma_o FROM luoi_o ORDER BY geom <-> ST_SetSRID(ST_MakePoint(106.70,10.776),4326) LIMIT 1)
   AND q.ma_chi_so = 'LST';

-- ===================== 13_index =====================
SELECT tablename AS bang, indexname AS chi_muc,
       CASE WHEN indexdef ILIKE '%gist%' THEN 'GiST (không gian)' ELSE 'B-tree' END AS loai
  FROM pg_indexes WHERE schemaname = 'vientham' ORDER BY 1, 2;

-- ===================== 14_views =====================
SELECT table_name AS view_thong_ke FROM information_schema.views WHERE table_schema='vientham' ORDER BY 1;
SELECT p.proname AS ham, pg_get_function_arguments(p.oid) AS tham_so
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'vientham';

-- ===================== 15_xuhuong =====================
SET search_path = vientham, public;
-- Phường tăng nhiệt nhanh nhất (độ dốc hồi quy theo năm)
SELECT d.loai||' '||d.ten_xa AS phuong, round(x.do_doc_nam::numeric,3) AS tang_c_moi_nam, round(x.r2::numeric,3) r2, x.so_thang
  FROM v_xu_huong_phuong x JOIN don_vi_hanh_chinh d USING (ma_xa)
 WHERE x.ma_chi_so='LST' AND x.so_thang>=12 ORDER BY x.do_doc_nam DESC LIMIT 8;
SELECT mua, round(avg(tb)::numeric,2) lst_tb FROM v_thong_ke_phuong_mua WHERE ma_chi_so='LST' GROUP BY mua;

-- ===================== 16_ward =====================
SET search_path = vientham, public;
SELECT ma_xa, loai, ten_xa, khu_vuc_cu, dtich_km2, dan_so, left(sap_nhap, 60) AS sap_nhap_tu,
       ST_GeometryType(geom) AS kieu_hinh_hoc, ST_SRID(geom) AS srid
  FROM don_vi_hanh_chinh ORDER BY ma_xa LIMIT 6;
SELECT loai, count(*) FROM don_vi_hanh_chinh GROUP BY loai;

