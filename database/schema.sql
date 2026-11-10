-- =====================================================================
--  CSDL PostgreSQL/PostGIS — GIÁM SÁT & DỰ BÁO LST · NDVI · TVDI TP.HCM
--  Schema: vientham   (tách riêng, không đụng tới các bảng cũ ở public)
--
--  Nguyên tắc thiết kế (trường hợp tổng quát):
--   • Quản lý chung cả 3 chỉ số LST, NDVI, TVDI (và mở rộng thêm chỉ số
--     khác chỉ bằng 1 dòng trong dm_chi_so).
--   • Tách bạch dữ liệu HIỆN TRẠNG (do Google Earth Engine tính) với KẾT QUẢ
--     DỰ BÁO (của mô hình học máy hoặc kịch bản giả lập):
--       - quan_trac_o  : giá trị hiện trạng GEE trên lưới ô
--       - du_bao_o     : giá trị dự báo, luôn gắn với 1 phiên dự báo
--       - phien_du_bao : mỗi lần chạy mô hình / kịch bản giả lập
--   • Dữ liệu phục vụ phân tích – thống kê: ranh giới hành chính mới
--     (168 phường/xã/đặc khu sau sáp nhập 2025), lưới ô, danh mục ảnh raster,
--     thống kê vùng theo phường, chỉ số đánh giá mô hình, ngưỡng cảnh báo,
--     thời tiết 7 ngày, nhật ký nạp dữ liệu, cùng các VIEW/FUNCTION thống kê.
--   • Hệ toạ độ lưu trữ: EPSG:4326 (WGS84). Lưới ô được dựng trên ảnh gốc
--     EPSG:32648 (UTM 48N) nên giữ thêm hàng/cột và toạ độ UTM.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

DROP SCHEMA IF EXISTS vientham CASCADE;
CREATE SCHEMA vientham;
SET search_path = vientham, public;

-- ---------------------------------------------------------------------
-- 1. DANH MỤC
-- ---------------------------------------------------------------------

-- 1.1 Chỉ số viễn thám
CREATE TABLE dm_chi_so (
    ma_chi_so      varchar(10) PRIMARY KEY,                 -- LST | NDVI | TVDI
    ten            text        NOT NULL,
    ten_day_du     text,
    don_vi         text        NOT NULL DEFAULT '',
    mo_ta          text,
    gia_tri_min    double precision NOT NULL,               -- miền giá trị hợp lệ (kiểm tra dữ liệu)
    gia_tri_max    double precision NOT NULL,
    thang_mau_min  double precision NOT NULL,               -- miền hiển thị thang màu
    thang_mau_max  double precision NOT NULL,
    bang_mau       text[]      NOT NULL,                    -- mã màu HEX theo thang màu GEE
    so_le          smallint    NOT NULL DEFAULT 2,          -- số chữ số thập phân khi hiển thị
    cao_la_xau     boolean     NOT NULL,                    -- TRUE: giá trị càng cao càng bất lợi (LST, TVDI)
    CHECK (gia_tri_min < gia_tri_max AND thang_mau_min < thang_mau_max)
);

-- 1.2 Loại dữ liệu: hiện trạng hay dự báo
CREATE TABLE dm_loai_du_lieu (
    ma_loai  varchar(12) PRIMARY KEY,                       -- GEE | NOI_SUY | MO_HINH | GIA_LAP
    ten      text NOT NULL,
    nhom     varchar(12) NOT NULL CHECK (nhom IN ('HIEN_TRANG', 'DU_BAO')),
    mo_ta    text
);

-- 1.3 Mô hình dự báo
CREATE TABLE dm_mo_hinh (
    ma_mo_hinh  varchar(20) PRIMARY KEY,                    -- LR | BAYES_RIDGE | RF | XGB | MLP | LSTM | GRU | TRANSFORMER | KHI_HAU
    ten         text NOT NULL,
    nhom        text NOT NULL,                              -- Hồi quy tuyến tính | Tập hợp cây | Mạng nơ-ron | Học sâu chuỗi | Đường cơ sở
    thu_vien    text,
    mo_ta       text,
    thu_tu      smallint NOT NULL DEFAULT 0
);

-- 1.4 Ngưỡng phân cấp & cảnh báo cho từng chỉ số
CREATE TABLE dm_nguong_canh_bao (
    ma_chi_so   varchar(10) NOT NULL REFERENCES dm_chi_so ON DELETE CASCADE,
    muc         smallint    NOT NULL,                       -- 1 = thuận lợi nhất ... 5 = bất lợi nhất
    ten_muc     text        NOT NULL,
    tu          double precision,                           -- NULL = -∞
    den         double precision,                           -- NULL = +∞ (khoảng [tu, den) )
    mau         text        NOT NULL,
    khuyen_cao  text,
    PRIMARY KEY (ma_chi_so, muc)
);

-- 1.5 Kỳ thời gian (tháng) — chiều thời gian dùng chung
CREATE TABLE ky_thoi_gian (
    ma_ky     integer  PRIMARY KEY,                         -- yyyymm, vd 202604
    nam       smallint NOT NULL,
    thang     smallint NOT NULL CHECK (thang BETWEEN 1 AND 12),
    ngay_dau  date     NOT NULL,
    quy       smallint NOT NULL,
    mua       text     NOT NULL CHECK (mua IN ('Mùa khô', 'Mùa mưa')),   -- Nam Bộ: khô 12–4, mưa 5–11
    UNIQUE (nam, thang)
);

-- ---------------------------------------------------------------------
-- 2. RANH GIỚI HÀNH CHÍNH (TP.HCM mới, sau sáp nhập 01/07/2025)
-- ---------------------------------------------------------------------
CREATE TABLE ranh_gioi_tinh (
    ma_tinh        varchar(5) PRIMARY KEY,
    ten            text NOT NULL,
    ten_day_du     text,
    dien_tich_km2  numeric(10, 2),
    geom           geometry(MultiPolygon, 4326) NOT NULL,
    geom_don_gian  geometry(MultiPolygon, 4326)               -- bản đơn giản hoá để hiển thị web
);

CREATE TABLE don_vi_hanh_chinh (
    ma_xa          varchar(10) PRIMARY KEY,
    ten_xa         text NOT NULL,
    loai           text NOT NULL CHECK (loai IN ('Phường', 'Xã', 'Đặc khu')),
    ma_tinh        varchar(5) NOT NULL REFERENCES ranh_gioi_tinh,
    khu_vuc_cu     text NOT NULL,                            -- TP.HCM cũ | Bình Dương cũ | Bà Rịa – Vũng Tàu cũ
    dtich_km2      numeric(10, 2),
    dan_so         integer,
    matdo_km2      numeric(12, 2),
    sap_nhap       text,                                     -- các đơn vị cũ được sáp nhập
    tru_so         text,
    geom           geometry(MultiPolygon, 4326) NOT NULL,
    geom_don_gian  geometry(MultiPolygon, 4326),
    tam            geometry(Point, 4326)                     -- điểm đại diện (luôn nằm trong vùng)
);

-- ---------------------------------------------------------------------
-- 3. LƯỚI Ô KHÔNG GIAN (đơn vị phân tích & dự báo theo không gian)
-- ---------------------------------------------------------------------
CREATE TABLE luoi_o (
    ma_o            integer PRIMARY KEY,
    hang            integer NOT NULL,
    cot             integer NOT NULL,
    x_utm           double precision NOT NULL,                -- tâm ô, EPSG:32648
    y_utm           double precision NOT NULL,
    kinh_do         double precision NOT NULL,
    vi_do           double precision NOT NULL,
    do_phan_giai_m  real NOT NULL,
    ma_xa           varchar(10) REFERENCES don_vi_hanh_chinh,  -- phường/xã chứa tâm ô
    geom            geometry(Point, 4326) NOT NULL,
    UNIQUE (hang, cot)
);

-- ---------------------------------------------------------------------
-- 4. PHIÊN DỰ BÁO (mỗi lần chạy mô hình hoặc kịch bản giả lập)
-- ---------------------------------------------------------------------
CREATE TABLE phien_du_bao (
    ma_phien        serial PRIMARY KEY,
    ma_mo_hinh      varchar(20) NOT NULL REFERENCES dm_mo_hinh,
    ma_chi_so       varchar(10) NOT NULL REFERENCES dm_chi_so,
    ma_loai         varchar(12) NOT NULL REFERENCES dm_loai_du_lieu,
    ten             text NOT NULL,
    ky_train_tu     integer REFERENCES ky_thoi_gian,
    ky_train_den    integer REFERENCES ky_thoi_gian,
    ky_du_bao_tu    integer REFERENCES ky_thoi_gian,
    ky_du_bao_den   integer REFERENCES ky_thoi_gian,
    tam_du_bao      smallint,                                 -- số tháng dự báo trước
    dac_trung       text[],                                   -- biến đầu vào
    tham_so         jsonb,
    mo_ta           text,
    la_mac_dinh     boolean NOT NULL DEFAULT false,           -- phiên hiển thị mặc định trên web
    thoi_gian_chay  timestamptz NOT NULL DEFAULT now(),
    CHECK (ma_loai IN ('MO_HINH', 'GIA_LAP', 'NOI_SUY'))       -- phiên không bao giờ là GEE (quan trắc thật)
);

-- tháng nào của phiên thuộc tập nào: train | val | test | future | fill (tháng được lấp bằng nội suy)
CREATE TABLE phien_ky (
    ma_phien  integer NOT NULL REFERENCES phien_du_bao ON DELETE CASCADE,
    ma_ky     integer NOT NULL REFERENCES ky_thoi_gian,
    tap       varchar(8) NOT NULL CHECK (tap IN ('train', 'val', 'test', 'future', 'fill')),
    PRIMARY KEY (ma_phien, ma_ky)
);

-- ---------------------------------------------------------------------
-- 5. DỮ LIỆU GIÁ TRỊ THEO Ô
-- ---------------------------------------------------------------------

-- 5.1 HIỆN TRẠNG do GEE tính (trung bình các pixel 30 m trong ô)
CREATE TABLE quan_trac_o (
    ma_chi_so    varchar(10) NOT NULL REFERENCES dm_chi_so,
    ma_ky        integer     NOT NULL REFERENCES ky_thoi_gian,
    ma_o         integer     NOT NULL REFERENCES luoi_o,
    gia_tri      real        NOT NULL,
    ty_le_hop_le real        NOT NULL CHECK (ty_le_hop_le > 0 AND ty_le_hop_le <= 1),  -- phần ô không bị mây/thiếu
    PRIMARY KEY (ma_chi_so, ma_ky, ma_o)
);

-- 5.2 KẾT QUẢ DỰ BÁO của mô hình hoặc giả lập
CREATE TABLE du_bao_o (
    ma_phien  integer NOT NULL REFERENCES phien_du_bao ON DELETE CASCADE,
    ma_ky     integer NOT NULL REFERENCES ky_thoi_gian,
    ma_o      integer NOT NULL REFERENCES luoi_o,
    gia_tri   real    NOT NULL,
    PRIMARY KEY (ma_phien, ma_ky, ma_o)
);

-- ---------------------------------------------------------------------
-- 6. DANH MỤC ẢNH RASTER (GeoTIFF gốc + ảnh PNG đã mã hoá cho web)
-- ---------------------------------------------------------------------
CREATE TABLE anh_raster (
    ma_anh          serial PRIMARY KEY,
    ma_chi_so       varchar(10) NOT NULL REFERENCES dm_chi_so,
    ma_ky           integer     NOT NULL REFERENCES ky_thoi_gian,
    ma_loai         varchar(12) NOT NULL REFERENCES dm_loai_du_lieu,
    ma_phien        integer REFERENCES phien_du_bao ON DELETE CASCADE,
    nguon_anh       text,                                      -- vd. Landsat 8/9 C2 L2 (GEE)
    do_phan_giai_m  real,
    he_toa_do       integer,                                   -- EPSG của ảnh gốc
    duong_dan_goc   text,                                      -- GeoTIFF
    duong_dan_web   text,                                      -- PNG 8-bit cho web (giá trị = ma_hoa_min + (px-1)*(ma_hoa_max-ma_hoa_min)/254)
    rong_px         integer,
    cao_px          integer,
    ma_hoa_min      double precision,
    ma_hoa_max      double precision,
    pham_vi         geometry(Polygon, 4326),
    ty_le_phu       real,                                      -- tỉ lệ diện tích thành phố có dữ liệu
    gia_tri_tb      real,
    gia_tri_p05     real,
    gia_tri_p95     real,
    ngay_nap        timestamptz NOT NULL DEFAULT now(),
    CHECK ((ma_loai = 'GEE') = (ma_phien IS NULL))
);
CREATE UNIQUE INDEX ux_anh_raster ON anh_raster (ma_chi_so, ma_ky, ma_loai, COALESCE(ma_phien, 0));

-- ---------------------------------------------------------------------
-- 7. THỐNG KÊ VÙNG THEO PHƯỜNG/XÃ (zonal statistics)
--    GEE: tính từ pixel 30 m gốc; dự báo: tổng hợp từ các ô lưới
-- ---------------------------------------------------------------------
CREATE TABLE thong_ke_phuong (
    id          bigserial PRIMARY KEY,
    ma_xa       varchar(10) NOT NULL REFERENCES don_vi_hanh_chinh,
    ma_chi_so   varchar(10) NOT NULL REFERENCES dm_chi_so,
    ma_ky       integer     NOT NULL REFERENCES ky_thoi_gian,
    ma_loai     varchar(12) NOT NULL REFERENCES dm_loai_du_lieu,
    ma_phien    integer REFERENCES phien_du_bao ON DELETE CASCADE,
    tb          real NOT NULL,
    do_lech     real,
    nho_nhat    real,
    lon_nhat    real,
    p10         real,
    p90         real,
    so_mau      integer,                                       -- số pixel (GEE) hoặc số ô (dự báo)
    ty_le_phu   real,
    CHECK ((ma_loai = 'GEE') = (ma_phien IS NULL))
);
CREATE UNIQUE INDEX ux_tkp ON thong_ke_phuong (ma_chi_so, ma_ky, COALESCE(ma_phien, 0), ma_xa);

-- ---------------------------------------------------------------------
-- 8. ĐÁNH GIÁ MÔ HÌNH
-- ---------------------------------------------------------------------
CREATE TABLE danh_gia_mo_hinh (
    ma_phien  integer NOT NULL REFERENCES phien_du_bao ON DELETE CASCADE,
    tap       varchar(8) NOT NULL CHECK (tap IN ('train', 'val', 'test')),
    mae       double precision,
    rmse      double precision,
    r2        double precision,
    mape      double precision,
    bias      double precision,                               -- sai số trung bình (dự báo - thực tế)
    so_mau    integer,
    PRIMARY KEY (ma_phien, tap)
);

-- ---------------------------------------------------------------------
-- 9. THỜI TIẾT 7 NGÀY (Open-Meteo) phục vụ ước tính LST ngắn hạn
-- ---------------------------------------------------------------------
CREATE TABLE thoi_tiet_du_bao (
    id            bigserial PRIMARY KEY,
    ngay          date NOT NULL,
    kinh_do       double precision NOT NULL,
    vi_do         double precision NOT NULL,
    t_max         real,
    t_min         real,
    t_tb          real,
    buc_xa_wm2    real,
    lst_uoc_tinh  real,
    nguon         text NOT NULL DEFAULT 'open-meteo',
    thoi_diem_lay timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ngay, kinh_do, vi_do)
);

-- 9.2 DỰ BÁO LST THEO NGÀY (7 ngày, GIẢ LẬP): lấy dự báo tháng của mô hình AI cho từng phường,
--     cộng dao động ngày theo thời tiết Open-Meteo (nhiệt độ cao nhất, bức xạ). Ảnh Landsat chỉ có theo tháng
--     nên giá trị theo ngày là giả lập, luôn ghi rõ phiên dự báo tháng làm nền.
CREATE TABLE du_bao_ngay (
    id             bigserial PRIMARY KEY,
    ngay           date NOT NULL,
    ma_xa          varchar(10) REFERENCES don_vi_hanh_chinh,   -- NULL = toàn thành phố
    ma_phien_thang integer REFERENCES phien_du_bao ON DELETE CASCADE,
    lst_thang      real,                                       -- LST tháng của mô hình (nền)
    lech_ngay      real,                                       -- dao động ngày theo thời tiết (°C)
    lst            real NOT NULL,                              -- = lst_thang + lech_ngay
    lst_p10        real,
    lst_p90        real,
    t_max          real,
    buc_xa_wm2     real,
    mua_mm         real,
    nguon          text NOT NULL DEFAULT 'GIA_LAP: AI tháng + Open-Meteo',
    thoi_diem_tao  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ngay, ma_xa, ma_phien_thang)
);

-- ---------------------------------------------------------------------
-- 10. NHẬT KÝ NẠP / XỬ LÝ DỮ LIỆU
-- ---------------------------------------------------------------------
CREATE TABLE nhat_ky_nap (
    id         bigserial PRIMARY KEY,
    thoi_diem  timestamptz NOT NULL DEFAULT now(),
    buoc       text NOT NULL,
    chi_tiet   jsonb
);

-- ---------------------------------------------------------------------
-- 11. CHỈ MỤC
-- ---------------------------------------------------------------------
CREATE INDEX ix_rgt_geom      ON ranh_gioi_tinh USING gist (geom);
CREATE INDEX ix_dvhc_geom     ON don_vi_hanh_chinh USING gist (geom);
CREATE INDEX ix_dvhc_khuvuc   ON don_vi_hanh_chinh (khu_vuc_cu);
CREATE INDEX ix_luoi_geom     ON luoi_o USING gist (geom);
CREATE INDEX ix_luoi_xa       ON luoi_o (ma_xa);
CREATE INDEX ix_qto_o         ON quan_trac_o (ma_o);
CREATE INDEX ix_dbo_o         ON du_bao_o (ma_o);
CREATE INDEX ix_tkp_xa        ON thong_ke_phuong (ma_xa, ma_chi_so);
CREATE INDEX ix_anh_pham_vi   ON anh_raster USING gist (pham_vi);
CREATE INDEX ix_phien_chiso   ON phien_du_bao (ma_chi_so, ma_loai);
CREATE INDEX ix_dbn_xa_ngay   ON du_bao_ngay (ma_xa, ngay);

-- ---------------------------------------------------------------------
-- 12. DỮ LIỆU DANH MỤC
-- ---------------------------------------------------------------------
INSERT INTO dm_chi_so VALUES
 ('LST',  'LST',  'Nhiệt độ bề mặt đất (Land Surface Temperature)', '°C',
  'Nhiệt độ bề mặt tính từ kênh hồng ngoại nhiệt Landsat trên Google Earth Engine',
  -10, 80, 25, 45,
  ARRAY['#0000FF','#0066FF','#00FFFF','#00FF00','#FFFF00','#FFCC00','#FF6600','#FF0000'], 2, true),
 ('NDVI', 'NDVI', 'Chỉ số khác biệt thực vật chuẩn hoá', '',
  'NDVI = (NIR − Red) / (NIR + Red); càng cao càng nhiều thực vật',
  -1, 1, -0.2, 1,
  ARRAY['#FF0000','#EF7D00','#EFEF00','#ADEF2E','#00EF00','#00EFEF','#007EFF'], 3, false),
 ('TVDI', 'TVDI', 'Chỉ số khô hạn nhiệt độ – thực vật', '',
  'TVDI tính từ không gian LST–NDVI; càng cao càng khô hạn',
  -0.5, 1.5, 0, 1,
  ARRAY['#0000FF','#0066FF','#00FFFF','#00FF00','#FFFF00','#FFCC00','#FF6600','#FF0000'], 3, true);

INSERT INTO dm_loai_du_lieu VALUES
 ('GEE',     'Hiện trạng (Google Earth Engine)', 'HIEN_TRANG', 'Giá trị quan trắc do GEE tính từ ảnh vệ tinh'),
 ('NOI_SUY', 'Nội suy tháng thiếu ảnh',          'HIEN_TRANG', 'Ước tính cho tháng không có ảnh GEE sạch mây: khí hậu cùng tháng của từng điểm + dị thường nội suy theo thời gian (kriging AR(1))'),
 ('MO_HINH', 'Dự báo của mô hình',               'DU_BAO',     'Kết quả dự báo từ mô hình học máy đã huấn luyện'),
 ('GIA_LAP', 'Kịch bản giả lập',                 'DU_BAO',     'Kết quả giả lập theo kịch bản giả định (what-if)');

INSERT INTO dm_mo_hinh VALUES
 ('KHI_HAU',     'Khí hậu nhiều năm',      'Đường cơ sở',          'NumPy',        'Lấy trung bình cùng tháng các năm trước của từng ô (mốc so sánh tối thiểu)', 0),
 ('LR',          'Linear Regression',       'Hồi quy tuyến tính',   'scikit-learn', 'Hồi quy tuyến tính bình phương nhỏ nhất', 1),
 ('BAYES_RIDGE', 'Bayesian Ridge',          'Hồi quy tuyến tính',   'scikit-learn', 'Hồi quy tuyến tính Bayes có điều chuẩn', 2),
 ('RF',          'Random Forest',           'Tập hợp cây',          'scikit-learn', 'Rừng ngẫu nhiên', 3),
 ('ET',          'Extra Trees',             'Tập hợp cây',          'scikit-learn', 'Rừng cây cực ngẫu nhiên (giảm phương sai so với Random Forest)', 4),
 ('HGB',         'Gradient Boosting',       'Tập hợp cây',          'scikit-learn', 'HistGradientBoosting: boosting trên cây với biến đã chia khoảng, nhanh trên dữ liệu lớn', 5),
 ('XGB',         'XGBoost',                 'Tập hợp cây',          'xgboost',      'Gradient boosting trên cây quyết định', 6),
 ('MLP',         'Mạng nơ-ron MLP',         'Mạng nơ-ron',          'scikit-learn', 'Mạng nơ-ron truyền thẳng nhiều lớp', 7),
 ('ENSEMBLE',    'Tổ hợp AI',               'Tổ hợp mô hình',       'scikit-learn + xgboost', 'Trung bình có trọng số của các mô hình tốt nhất trên tập kiểm định (trọng số ∝ 1/RMSE²)', 8),
 ('NOI_SUY_MUA', 'Nội suy theo mùa',        'Lấp dữ liệu',          'NumPy',        'Khí hậu cùng tháng của từng điểm + dị thường nội suy kriging AR(1) giữa hai lần quan trắc gần nhất', 9),
 ('LSTM',        'LSTM',                    'Học sâu chuỗi',        'PyTorch',      'Mạng hồi tiếp bộ nhớ dài–ngắn (chưa chạy: cần PyTorch)', 10),
 ('GRU',         'GRU',                     'Học sâu chuỗi',        'PyTorch',      'Gated Recurrent Unit (chưa chạy: cần PyTorch)', 11),
 ('TRANSFORMER', 'Transformer',             'Học sâu chuỗi',        'PyTorch',      'Mô hình chú ý (chưa chạy: cần PyTorch)', 12);

INSERT INTO dm_nguong_canh_bao VALUES
 ('LST', 1, 'Mát',       NULL, 30,  '#0066FF', 'Nhiệt độ bề mặt dễ chịu'),
 ('LST', 2, 'Ấm',        30,   35,  '#00C853', 'Bình thường'),
 ('LST', 3, 'Nóng',      35,   40,  '#FFCC00', 'Hạn chế hoạt động ngoài trời buổi trưa'),
 ('LST', 4, 'Rất nóng',  40,   45,  '#FF6600', 'Tránh nắng 11h–15h, bổ sung nước, tăng cây xanh'),
 ('LST', 5, 'Cực nóng',  45,   NULL,'#FF0000', 'Nguy cơ sốc nhiệt; cần giải pháp làm mát đô thị'),
 ('NDVI',1, 'Thực vật dày',          0.6, NULL, '#00EF00', NULL),
 ('NDVI',2, 'Thực vật trung bình',   0.4, 0.6,  '#ADEF2E', NULL),
 ('NDVI',3, 'Thực vật thưa',         0.2, 0.4,  '#EFEF00', NULL),
 ('NDVI',4, 'Đô thị / đất trống',    0,   0.2,  '#EF7D00', 'Thiếu mảng xanh'),
 ('NDVI',5, 'Mặt nước',              NULL,0,    '#007EFF', NULL),
 ('TVDI',1, 'Rất ẩm',     NULL, 0.2, '#0066FF', NULL),
 ('TVDI',2, 'Ẩm',         0.2,  0.4, '#00FFFF', NULL),
 ('TVDI',3, 'Bình thường',0.4,  0.6, '#FFFF00', NULL),
 ('TVDI',4, 'Khô hạn',    0.6,  0.8, '#FF6600', 'Theo dõi thiếu nước'),
 ('TVDI',5, 'Hạn nặng',   0.8,  NULL,'#FF0000', 'Nguy cơ hạn');

INSERT INTO ky_thoi_gian (ma_ky, nam, thang, ngay_dau, quy, mua)
SELECT (y * 100 + m), y, m, make_date(y, m, 1), (m - 1) / 3 + 1,
       CASE WHEN m IN (12, 1, 2, 3, 4) THEN 'Mùa khô' ELSE 'Mùa mưa' END
  FROM generate_series(2015, 2030) y, generate_series(1, 12) m;

-- ---------------------------------------------------------------------
-- 13. VIEW PHỤC VỤ PHÂN TÍCH – THỐNG KÊ
-- ---------------------------------------------------------------------

-- 13.1 Bảng hợp nhất mọi giá trị theo ô, phân biệt hiện trạng / dự báo
CREATE VIEW v_gia_tri_o AS
SELECT q.ma_chi_so, q.ma_ky, k.nam, k.thang, q.ma_o, 'GEE'::varchar(12) AS ma_loai,
       'HIEN_TRANG'::varchar(12) AS nhom, NULL::integer AS ma_phien, NULL::varchar(20) AS ma_mo_hinh,
       q.gia_tri, l.geom
  FROM quan_trac_o q JOIN ky_thoi_gian k USING (ma_ky) JOIN luoi_o l USING (ma_o)
UNION ALL
SELECT p.ma_chi_so, d.ma_ky, k.nam, k.thang, d.ma_o, p.ma_loai, ld.nhom, d.ma_phien, p.ma_mo_hinh,
       d.gia_tri, l.geom
  FROM du_bao_o d JOIN phien_du_bao p USING (ma_phien) JOIN dm_loai_du_lieu ld ON ld.ma_loai = p.ma_loai
  JOIN ky_thoi_gian k USING (ma_ky) JOIN luoi_o l USING (ma_o);

-- 13.2 Thống kê toàn thành phố theo tháng (hiện trạng + dự báo)
CREATE VIEW v_thong_ke_thanh_pho_thang AS
SELECT t.ma_chi_so, t.ma_ky, k.nam, k.thang, k.mua, t.ma_loai, t.ma_phien,
       sum(t.tb * t.so_mau) / NULLIF(sum(t.so_mau), 0) AS tb,
       min(t.tb) AS phuong_thap_nhat, max(t.tb) AS phuong_cao_nhat,
       count(*) AS so_phuong
  FROM thong_ke_phuong t JOIN ky_thoi_gian k USING (ma_ky)
 GROUP BY t.ma_chi_so, t.ma_ky, k.nam, k.thang, k.mua, t.ma_loai, t.ma_phien;

-- 13.3 Trung bình năm theo phường (hiện trạng)
CREATE VIEW v_thong_ke_phuong_nam AS
SELECT t.ma_xa, d.ten_xa, d.loai, d.khu_vuc_cu, t.ma_chi_so, k.nam,
       avg(t.tb) AS tb, min(t.tb) AS thang_thap_nhat, max(t.tb) AS thang_cao_nhat, count(*) AS so_thang
  FROM thong_ke_phuong t JOIN ky_thoi_gian k USING (ma_ky) JOIN don_vi_hanh_chinh d USING (ma_xa)
 WHERE t.ma_loai = 'GEE'
 GROUP BY t.ma_xa, d.ten_xa, d.loai, d.khu_vuc_cu, t.ma_chi_so, k.nam;

-- 13.4 So sánh mùa khô – mùa mưa theo phường (hiện trạng)
CREATE VIEW v_thong_ke_phuong_mua AS
SELECT t.ma_xa, t.ma_chi_so, k.mua, avg(t.tb) AS tb, count(*) AS so_thang
  FROM thong_ke_phuong t JOIN ky_thoi_gian k USING (ma_ky)
 WHERE t.ma_loai = 'GEE'
 GROUP BY t.ma_xa, t.ma_chi_so, k.mua;

-- 13.5 Xu hướng tuyến tính theo phường (đơn vị/năm), dùng hồi quy regr_slope
CREATE VIEW v_xu_huong_phuong AS
SELECT t.ma_xa, t.ma_chi_so,
       regr_slope(t.tb, k.nam + (k.thang - 0.5) / 12.0) AS do_doc_nam,
       regr_r2(t.tb, k.nam + (k.thang - 0.5) / 12.0)    AS r2,
       count(*) AS so_thang
  FROM thong_ke_phuong t JOIN ky_thoi_gian k USING (ma_ky)
 WHERE t.ma_loai = 'GEE'
 GROUP BY t.ma_xa, t.ma_chi_so;

-- 13.6 Thống kê theo khu vực cũ (TP.HCM cũ / Bình Dương cũ / Bà Rịa – Vũng Tàu cũ)
CREATE VIEW v_thong_ke_khu_vuc AS
SELECT d.khu_vuc_cu, t.ma_chi_so, t.ma_ky, t.ma_loai, t.ma_phien,
       sum(t.tb * t.so_mau) / NULLIF(sum(t.so_mau), 0) AS tb, count(*) AS so_phuong
  FROM thong_ke_phuong t JOIN don_vi_hanh_chinh d USING (ma_xa)
 GROUP BY d.khu_vuc_cu, t.ma_chi_so, t.ma_ky, t.ma_loai, t.ma_phien;

-- 13.7 Đối chiếu dự báo với hiện trạng tại từng ô (chỉ các tháng có cả hai)
CREATE VIEW v_so_sanh_du_bao AS
SELECT p.ma_phien, p.ma_mo_hinh, p.ma_chi_so, d.ma_ky, pk.tap, d.ma_o,
       d.gia_tri AS du_bao, q.gia_tri AS thuc_te, d.gia_tri - q.gia_tri AS sai_so
  FROM du_bao_o d
  JOIN phien_du_bao p USING (ma_phien)
  JOIN phien_ky pk ON pk.ma_phien = d.ma_phien AND pk.ma_ky = d.ma_ky
  JOIN quan_trac_o q ON q.ma_chi_so = p.ma_chi_so AND q.ma_ky = d.ma_ky AND q.ma_o = d.ma_o;

-- 13.8 Phân cấp cảnh báo phường theo ngưỡng (mọi tháng, mọi nguồn)
CREATE VIEW v_canh_bao_phuong AS
SELECT t.ma_xa, t.ma_chi_so, t.ma_ky, t.ma_loai, t.ma_phien, t.tb, n.muc, n.ten_muc, n.mau, n.khuyen_cao
  FROM thong_ke_phuong t
  JOIN dm_nguong_canh_bao n ON n.ma_chi_so = t.ma_chi_so
   AND (n.tu IS NULL OR t.tb >= n.tu) AND (n.den IS NULL OR t.tb < n.den);

-- 13.9 Xếp hạng chỉ tiêu đánh giá mô hình trên tập kiểm tra
CREATE VIEW v_xep_hang_mo_hinh AS
SELECT p.ma_phien, p.ma_chi_so, p.ma_loai, m.ma_mo_hinh, m.ten, m.nhom, e.mae, e.rmse, e.r2, e.mape, e.bias,
       rank() OVER (PARTITION BY p.ma_chi_so ORDER BY e.rmse) AS hang_rmse
  FROM phien_du_bao p JOIN dm_mo_hinh m USING (ma_mo_hinh)
  JOIN danh_gia_mo_hinh e ON e.ma_phien = p.ma_phien AND e.tap = 'test';

-- ---------------------------------------------------------------------
-- 14. HÀM TIỆN ÍCH
-- ---------------------------------------------------------------------

-- 14.1 Tra cứu chuỗi thời gian tại một toạ độ (ô gần nhất), cả hiện trạng và dự báo
CREATE FUNCTION fn_chuoi_tai_diem(p_lon double precision, p_lat double precision, p_chi_so varchar DEFAULT 'LST')
RETURNS TABLE (ma_o integer, khoang_cach_m double precision, ma_ky integer, ma_loai varchar, ma_phien integer, gia_tri real)
LANGUAGE sql STABLE AS $$
    WITH o AS (
        SELECT l.ma_o, ST_Distance(l.geom::geography, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography) AS kc
          FROM vientham.luoi_o l
         ORDER BY l.geom <-> ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)
         LIMIT 1
    )
    SELECT o.ma_o, o.kc, q.ma_ky, 'GEE'::varchar, NULL::integer, q.gia_tri
      FROM o JOIN vientham.quan_trac_o q ON q.ma_o = o.ma_o AND q.ma_chi_so = p_chi_so
    UNION ALL
    SELECT o.ma_o, o.kc, d.ma_ky, p.ma_loai, d.ma_phien, d.gia_tri
      FROM o JOIN vientham.du_bao_o d ON d.ma_o = o.ma_o
      JOIN vientham.phien_du_bao p ON p.ma_phien = d.ma_phien AND p.ma_chi_so = p_chi_so
    ORDER BY 3, 4, 5;
$$;

-- 14.2 Thống kê một chỉ số trong vùng bất kỳ (GeoJSON), một tháng, hiện trạng hoặc theo phiên dự báo
CREATE FUNCTION fn_thong_ke_vung(p_geojson text, p_chi_so varchar, p_ky integer, p_phien integer DEFAULT NULL)
RETURNS TABLE (so_o bigint, tb double precision, nho_nhat real, lon_nhat real, do_lech double precision)
LANGUAGE sql STABLE AS $$
    WITH vung AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(p_geojson), 4326) AS g),
    o AS (SELECT l.ma_o FROM vientham.luoi_o l, vung WHERE ST_Intersects(l.geom, vung.g)),
    v AS (
        SELECT q.gia_tri FROM vientham.quan_trac_o q JOIN o USING (ma_o)
         WHERE p_phien IS NULL AND q.ma_chi_so = p_chi_so AND q.ma_ky = p_ky
        UNION ALL
        SELECT d.gia_tri FROM vientham.du_bao_o d JOIN o USING (ma_o)
         WHERE p_phien IS NOT NULL AND d.ma_phien = p_phien AND d.ma_ky = p_ky
    )
    SELECT count(*), avg(gia_tri), min(gia_tri), max(gia_tri), stddev_samp(gia_tri) FROM v;
$$;

-- 14.3 Phân cấp một giá trị theo ngưỡng của chỉ số
CREATE FUNCTION fn_phan_cap(p_chi_so varchar, p_gia_tri double precision)
RETURNS TABLE (muc smallint, ten_muc text, mau text)
LANGUAGE sql STABLE AS $$
    SELECT n.muc, n.ten_muc, n.mau FROM vientham.dm_nguong_canh_bao n
     WHERE n.ma_chi_so = p_chi_so AND (n.tu IS NULL OR p_gia_tri >= n.tu) AND (n.den IS NULL OR p_gia_tri < n.den)
     LIMIT 1;
$$;

COMMENT ON SCHEMA vientham IS 'CSDL giám sát & dự báo LST/NDVI/TVDI TP.HCM (ranh giới mới 168 phường/xã)';
COMMENT ON TABLE quan_trac_o IS 'Dữ liệu HIỆN TRẠNG do Google Earth Engine tính, tổng hợp theo ô lưới';
COMMENT ON TABLE du_bao_o    IS 'Kết quả DỰ BÁO (mô hình hoặc giả lập), luôn gắn với một phiên dự báo';
COMMENT ON TABLE phien_du_bao IS 'Mỗi lần chạy mô hình/kịch bản/nội suy: cấu hình, kỳ huấn luyện, kỳ dự báo';
COMMENT ON TABLE du_bao_ngay IS 'Dự báo LST 7 ngày (GIẢ LẬP): dự báo tháng của mô hình AI + dao động ngày theo thời tiết Open-Meteo';
