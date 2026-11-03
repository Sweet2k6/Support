# LST Forecast · TP.HCM

WebGIS giám sát và dự báo **nhiệt độ bề mặt đất (LST)** cho 168 phường/xã/đặc khu TP.HCM (ranh giới mới sau sáp nhập 2025), dữ liệu Google Earth Engine theo tháng từ 2020.

- **Hiện trạng**: 39 ảnh LST 30 m (2020–2026) + NDVI, TVDI làm yếu tố liên quan.
- **Dự báo theo không gian**: từng ô lưới 480 m, 6 tháng tới; so sánh Khí hậu nhiều năm, Linear Regression, Bayesian Ridge, Random Forest, XGBoost, MLP (MAE, RMSE, R², MAPE); xuất GeoTIFF `LST_forecast_YYYY_MM.tif`.
- **CSDL PostgreSQL/PostGIS** tổng quát cho cả 3 chỉ số, tách bạch hiện trạng GEE và dự báo/giả lập — xem [database/THIET_KE_CSDL.md](database/THIET_KE_CSDL.md).

## Cài đặt và chạy

Yêu cầu: Node.js 18+, PostgreSQL 14+ có PostGIS 3, Python 3.10+ (`pip install numpy pandas rasterio pillow scikit-learn xgboost psycopg2-binary`).

```bash
npm install
copy .env.example .env          # điền mật khẩu PostgreSQL, ADMIN_TOKEN

# 1. Nạp dữ liệu hiện trạng (khoảng 4 phút)
python database/etl/nap_du_lieu.py --tiff "D:/data tiff" --ref "D:/Mon_ThayTuan/test/Bai_Tap_Nhom_1-20260927T124749Z-1-001/Bai_Tap_Nhom_1"

# 2. Huấn luyện và ghi kết quả dự báo (khoảng 5–10 phút)
python -u database/etl/du_bao_lst.py

# 3. Chạy web
npm start                       # http://localhost:3000
```

Trang quản trị: `http://localhost:3000/admin?token=<ADMIN_TOKEN>`.

## Bản demo tĩnh (GitHub Pages)

Thư mục `public/` chạy được không cần server: khi mở trên `*.github.io` (hoặc thêm `?static` vào URL), web đọc dữ liệu đã xuất sẵn trong `public/data/api/` thay cho API. Sau khi đổi dữ liệu trong CSDL, xuất lại rồi đẩy nhánh `gh-pages`:

```bash
node database/xuat_ban_tinh.js
git add -A && git commit -m "Cập nhật dữ liệu demo"
git push origin main
git subtree push --prefix public origin gh-pages
```

Bản tĩnh không có trang quản trị; tra cứu tại điểm và cột 3D dùng ô lưới 480 m đã xuất (chỉ LST).

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `server.js` | API Express đọc schema `vientham` (truy vấn có tham số) |
| `public/index.html`, `css/style.css` | Giao diện |
| `public/js/app.js` | Bản đồ 2D (Leaflet), thanh thời gian, xếp hạng, các tab phân tích |
| `public/js/map3d.js` | Chế độ 3D (Three.js): khối phường cao theo LST, cột nhiệt từng ô 480 m |
| `public/data/raster/` | Ảnh PNG 8-bit mã hoá giá trị (GEE và dự báo) |
| `public/data/du_bao/` | GeoTIFF kết quả dự báo |
| `database/schema.sql` | Lược đồ CSDL |
| `database/etl/` | Script nạp dữ liệu và huấn luyện mô hình |
| `luu_tru_cu/` | File của phiên bản cũ (ranh giới 24 quận cũ…), có thể xoá |

## Lưu ý khi cài PostGIS trên Windows

Bộ cài PostGIS thường đặt biến `PROJ_LIB` trỏ vào bản PROJ cũ, làm rasterio báo *"EPSG code is unknown"*. Script ETL đã tự xử lý bằng cách dùng dữ liệu PROJ đi kèm rasterio.
