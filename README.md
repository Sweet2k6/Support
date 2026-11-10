# LST Forecast · TP.HCM

WebGIS giám sát và dự báo **nhiệt độ bề mặt đất (LST)** cho 168 phường/xã/đặc khu TP.HCM (ranh giới mới sau sáp nhập 2025), dữ liệu Google Earth Engine theo tháng từ 2017.

- **Hiện trạng**: 58 ảnh LST 30 m có ảnh sạch mây (4/2017–8/2026) + NDVI, TVDI làm yếu tố liên quan.
- **Tháng thiếu ảnh**: 58 tháng không có ảnh sạch mây được **ước tính** (khí hậu cùng tháng của từng điểm + dị thường kriging AR(1), kết hợp nội suy tuyến tính theo tỉ lệ chọn bằng kiểm chứng), lưu tách riêng (`ma_loai = 'NOI_SUY'`) và luôn ghi rõ là ước tính trên web.
- **Dự báo theo tháng (AI)**: từng ô lưới 480 m, **12 tháng tới**; so sánh Khí hậu nhiều năm, Linear Regression, Bayesian Ridge, Random Forest, Extra Trees, Gradient Boosting, XGBoost, MLP và **Tổ hợp AI** (MAE, RMSE, R², R² không gian, RMSE theo tầm dự báo, khoảng tin cậy 80 %); xuất GeoTIFF `LST_forecast_YYYY_MM.tif`.
- **Dự báo theo ngày (7 ngày, giả lập)**: dự báo tháng của mô hình AI + dao động ngày theo thời tiết Open-Meteo, lưu ở bảng `du_bao_ngay`.
- **CSDL PostgreSQL/PostGIS** tổng quát cho cả 3 chỉ số, tách bạch hiện trạng GEE, tháng nội suy và dự báo/giả lập — xem [database/THIET_KE_CSDL.md](database/THIET_KE_CSDL.md).

Giao diện: bản đồ 2D (Pixel hoặc tô màu theo phường, màu chuyển mượt khi chạy thời gian), 3D (tìm phường, nâng phường lên với cột nhiệt từng ô, so sánh nhiều phường), chế độ sáng/tối, 6 thang màu LST, dùng được trên điện thoại.

## Cài đặt và chạy

Yêu cầu: Node.js 18+, PostgreSQL 14+ có PostGIS 3, Python 3.10+ (`pip install numpy pandas scipy rasterio pillow scikit-learn xgboost psycopg2-binary`).

```bash
npm install
copy .env.example .env          # điền mật khẩu PostgreSQL, ADMIN_USER / ADMIN_PASSWORD, SESSION_SECRET

# 1. Nạp dữ liệu hiện trạng từ 2017 (khoảng 7 phút)
python database/etl/nap_du_lieu.py --tiff "D:/data tiff" --ref "D:/Mon_ThayTuan/test/Bai_Tap_Nhom_1-20260927T124749Z-1-001/Bai_Tap_Nhom_1"

# 2. Lấp các tháng thiếu ảnh (khoảng 2 phút)
python -u database/etl/noi_suy_thang.py

# 3. Huấn luyện và ghi kết quả dự báo 12 tháng (khoảng 20 phút)
python -u database/etl/du_bao_lst.py

# 4. Chạy web
npm start                       # http://localhost:3000
```

Trang quản trị: `http://localhost:3000/admin` (đăng nhập bằng tài khoản quản trị).

## Bản demo tĩnh (GitHub Pages)

Thư mục `public/` chạy được không cần server: khi mở trên `*.github.io` (hoặc thêm `?static` vào URL), web đọc dữ liệu đã xuất sẵn trong `public/data/api/` thay cho API. Dự báo 7 ngày ở bản tĩnh được tính ngay trên trình duyệt (cùng công thức). Sau khi đổi dữ liệu trong CSDL, xuất lại rồi đẩy nhánh `gh-pages`:

```bash
node database/xuat_ban_tinh.js
git add -A && git commit -m "Cập nhật dữ liệu demo"
git push origin main
git subtree push --prefix public origin gh-pages
```

Bản tĩnh không có trang quản trị; tra cứu tại điểm và cột 3D dùng ô lưới 480 m đã xuất (mô hình được chọn, kịch bản giả lập và tháng nội suy).

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `server.js` | API Express đọc schema `vientham` (truy vấn có tham số), gồm `/api/daily` (dự báo 7 ngày) |
| `server_auth.js` | Đăng nhập, phân quyền admin/người dùng |
| `public/index.html`, `css/style.css` | Giao diện (biến màu cho chế độ sáng/tối, bố cục điện thoại) |
| `public/js/app.js` | Bản đồ 2D (Leaflet), thanh thời gian, xếp hạng, các tab phân tích |
| `public/js/map3d.js` | Chế độ 3D (Three.js): khối phường cao theo LST, nâng phường + cột nhiệt từng ô, so sánh nhiều phường |
| `public/js/settings.js` | Cài đặt dùng chung: giao diện sáng/tối, thang màu LST, tuỳ chọn bản đồ |
| `public/data/raster/` | Ảnh PNG 8-bit mã hoá giá trị (GEE, nội suy, dự báo) |
| `public/data/du_bao/` | GeoTIFF kết quả dự báo |
| `database/schema.sql` | Lược đồ CSDL |
| `database/etl/` | `nap_du_lieu.py` (nạp GEE) · `noi_suy_thang.py` (lấp tháng thiếu) · `du_bao_lst.py` (mô hình AI) |
| `luu_tru_cu/` | File của phiên bản cũ (ranh giới 24 quận cũ…), có thể xoá |

## Lưu ý khi cài PostGIS trên Windows

Bộ cài PostGIS thường đặt biến `PROJ_LIB` trỏ vào bản PROJ cũ, làm rasterio báo *"EPSG code is unknown"*. Script ETL đã tự xử lý bằng cách dùng dữ liệu PROJ đi kèm rasterio.
