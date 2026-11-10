/* =====================================================================
   LST Forecast · TP.HCM — bản đồ 2D, thời gian, xếp hạng, phân tích
   Leaflet + Chart.js · dữ liệu từ API Express/PostGIS (schema vientham)
   Ba chế độ xem: Hiện trạng (ảnh GEE + tháng nội suy) · Dự báo 12 tháng (AI) · Dự báo 7 ngày (giả lập)
   Hai kiểu lớp nhiệt: Pixel (ảnh) · Phường (tô màu trung bình phường, chuyển màu mượt theo thời gian)
   ===================================================================== */
(() => {
  'use strict';

  // ───────────────────────── Tiện ích ─────────────────────────
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isNum = (v) => v !== null && v !== undefined && Number.isFinite(+v);
  const fmt = (v, d = 1) => (isNum(v) ? (+v).toLocaleString('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const SET = window.LSTSettings || { get: () => ({ palette: 'gee', showFill: true, motion: true }), palette: () => ['#0000FF', '#0066FF', '#00FFFF', '#00FF00', '#FFFF00', '#FFCC00', '#FF6600', '#FF0000'], on() {}, theme: () => 'light', open() {}, setAccount() {} };
  const sysReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionOK = () => !sysReduce && SET.get().motion !== false;
  const isMobile = () => window.innerWidth <= 820;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* bỏ qua */ } };

  const Y0 = 2017;
  const kyY = (k) => Math.floor(k / 100);
  const kyM = (k) => k % 100;
  const kyIdx = (k) => (kyY(k) - Y0) * 12 + kyM(k) - 1;
  const idxKy = (i) => (Y0 + Math.floor(i / 12)) * 100 + (i % 12) + 1;
  const kyText = (k) => `Tháng ${kyM(k)}/${kyY(k)}`;
  const kyShort = (k) => `${kyM(k)}/${kyY(k)}`;
  const isDry = (k) => [12, 1, 2, 3, 4].includes(kyM(k));
  const TAP_TEXT = { train: 'huấn luyện', val: 'kiểm định', test: 'kiểm tra', future: 'dự báo tương lai', fill: 'nội suy' };
  const WD = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const WDS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const dateOf = (s) => new Date(s + 'T12:00:00+07:00');
  const dayText = (s) => { const d = dateOf(s); return `${WD[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; };
  const dayShort = (s) => { const d = dateOf(s); return `${WDS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`; };

  // Hệ số giả lập dự báo ngày (giống server.js — dùng khi chạy bản tĩnh không có máy chủ)
  const TMAX_NORMAL = [31.6, 32.7, 33.9, 34.6, 34.0, 32.4, 31.8, 31.8, 31.3, 31.2, 31.0, 30.8];
  const DAILY_COEF = { t_max: 1.0, buc_xa: 0.010, mua: -0.05, mua_tran_mm: 40 };

  // ── Chế độ tĩnh (GitHub Pages): đọc dữ liệu xuất sẵn ở data/api thay cho máy chủ ──
  const STATIC = /github\.io$/.test(location.hostname) || location.protocol === 'file:' || new URLSearchParams(location.search).has('static');
  const jcache = new Map();
  const getJson = (rel) => {
    if (!jcache.has(rel)) {
      jcache.set(rel, fetch('data/api/' + rel).then((r) => { if (!r.ok) throw new Error(`Không có dữ liệu ${rel}`); return r.json(); }));
      jcache.get(rel).catch(() => jcache.delete(rel));
    }
    return jcache.get(rel);
  };
  function inRing(x, y, ring) {
    let ins = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  async function wardAt(lon, lat) {
    const w = await getJson('wards.json');
    return w.features.find((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      return polys.some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)));
    }) || null;
  }
  async function openMeteo(lat, lon) {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,shortwave_radiation_sum,precipitation_sum&timezone=Asia%2FHo_Chi_Minh&forecast_days=7`);
    if (!r.ok) throw new Error('Open-Meteo trả lỗi ' + r.status);
    const { daily } = await r.json();
    return daily.time.map((d, i) => {
      const solar = ((daily.shortwave_radiation_sum[i] || 0) * 1e6) / 86400;
      const t = daily.temperature_2m_max[i];
      return { ngay: d, t_max: t, t_min: daily.temperature_2m_min[i], t_tb: daily.temperature_2m_mean[i], buc_xa: Math.round(solar), mua_mm: daily.precipitation_sum?.[i] ?? 0, lst: Math.round((t + 3.5 + 0.008 * solar) * 100) / 100 };
    });
  }
  /** Dự báo 7 ngày giả lập ở bản tĩnh: cùng công thức với /api/daily của máy chủ */
  async function staticDaily() {
    const meta = await getJson('meta.json');
    const best = meta.runs.find((x) => x.mac_dinh && x.ma_loai === 'MO_HINH') || meta.runs.find((x) => x.ma_loai === 'MO_HINH');
    const series = await getJson(`series_LST_${best.ma_phien}.json`);
    let wx, nguon = 'Open-Meteo';
    try { wx = (await openMeteo(10.78, 106.70)).slice(0, 7); } catch {
      nguon = 'thời tiết giả lập theo chuẩn khí hậu';
      const t0 = new Date();
      wx = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(t0); d.setDate(d.getDate() + i);
        const ngay = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }), m = +ngay.slice(5, 7);
        return { ngay, t_max: TMAX_NORMAL[m - 1], t_min: TMAX_NORMAL[m - 1] - 8, buc_xa: 190, mua_mm: 0 };
      });
    }
    const rm = wx.reduce((a, d) => a + (d.buc_xa || 0), 0) / wx.length;
    const fut = best.months.filter((m) => m.tap === 'future');
    const bands = best.tham_so?.khoang_du_bao_80?.phuong || [];
    const pick = (ky) => (best.months.some((m) => m.ky === ky) ? ky : best.months.map((m) => m.ky).reduce((a, b) => (Math.abs(b - ky) < Math.abs(a - ky) ? b : a)));
    const days = wx.map((d, i) => {
      const m = +d.ngay.slice(5, 7), ky = pick(+d.ngay.slice(0, 4) * 100 + m);
      const lech = Math.round(clamp(DAILY_COEF.t_max * (d.t_max - TMAX_NORMAL[m - 1]) + DAILY_COEF.buc_xa * ((d.buc_xa || 0) - rm) + DAILY_COEF.mua * Math.min(d.mua_mm || 0, DAILY_COEF.mua_tran_mm), -6, 6) * 100) / 100;
      const it = best.months.find((x) => x.ky === ky), h = Math.max(0, fut.findIndex((x) => x.ky === ky)), b = bands[h] || [-2, 2], sp = 0.6 + 0.15 * i;
      const base = it?.tb ?? null;
      return { ngay: d.ngay, ky, t_max: d.t_max, t_min: d.t_min, buc_xa: d.buc_xa, mua_mm: d.mua_mm, lech, lst_thang: base, lst: base === null ? null : base + lech, p10: base === null ? null : base + lech + b[0] - sp, p90: base === null ? null : base + lech + b[1] + sp };
    });
    const wards = days.map((d) => { const j = series.months.indexOf(d.ky); return j < 0 ? [] : series.tb[j].map((v) => (v === null ? null : Math.round((v + d.lech) * 100) / 100)); });
    return { nguon, loai: 'GIA_LAP', phien: { ma_phien: best.ma_phien, ten: best.ten, ten_mo_hinh: best.ten_mo_hinh }, he_so: { ...DAILY_COEF, tmax_chuan: TMAX_NORMAL }, days, wards };
  }
  async function staticApi(path) {
    const u = new URL(path, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    const p = u.pathname;
    if (p === '/health') return { ok: true, pg: 'bản tĩnh', postgis: 'xuất từ PostGIS', schema_ok: true, static: true };
    if (p === '/meta') return getJson('meta.json');
    if (p === '/wards') return getJson('wards.json');
    if (p === '/boundary') return getJson('boundary.json');
    if (p === '/series') return getJson(q.phien ? `series_LST_${q.phien}.json` : 'series_LST.json');
    if (p === '/stats') return getJson('stats_LST.json');
    if (p === '/compare') return getJson(`compare_${q.phien}.json`);
    if (p === '/daily') return staticDaily();
    if (p.startsWith('/ward/')) return getJson(`ward/${decodeURIComponent(p.slice(6))}.json`);
    if (p === '/cells') {
      const c = await getJson(`cells/${q.ma_xa}.json`).catch(() => null);
      const vals = c && (q.phien ? c.run[q.phien]?.[q.ky] : c.gee[q.ky]);
      return { cells: c && vals ? c.o.map((o, k) => [o[0], o[1], vals[k]]).filter((x) => x[2] !== null) : [] };
    }
    if (p === '/point') {
      const lon = +q.lon, lat = +q.lat;
      const f = await wardAt(lon, lat);
      if (!f) return { ngoai_vung: true, ward: null };
      const c = await getJson(`cells/${f.properties.ma_xa}.json`).catch(() => null);
      if (!c) return { ngoai_vung: true, ward: { ma_xa: f.properties.ma_xa, ten_xa: f.properties.ten_xa, loai: f.properties.loai } };
      let best = 0, bd = Infinity;
      c.o.forEach(([x, y], k) => { const d = (x - lon) ** 2 + (y - lat) ** 2; if (d < bd) { bd = d; best = k; } });
      const pick = (obj) => Object.keys(obj).map(Number).sort((a, b) => a - b).filter((ky) => obj[ky][best] !== null).map((ky) => [ky, obj[ky][best]]);
      const [x, y] = c.o[best];
      return {
        kinh_do: x, vi_do: y, khoang_cach_m: Math.round(Math.sqrt(bd) * 111000), ngoai_vung: false,
        ward: { ma_xa: f.properties.ma_xa, ten_xa: f.properties.ten_xa, loai: f.properties.loai, khu_vuc_cu: f.properties.khu_vuc },
        series: { LST: pick(c.gee), NDVI: [], TVDI: [] },
        du_bao: Object.fromEntries(Object.entries(c.run).map(([pid, o]) => [pid, pick(o)])),
      };
    }
    if (p === '/weather') return { nguon: 'Open-Meteo', ngay: await openMeteo(q.lat, q.lon) };
    throw new Error('Bản demo tĩnh không hỗ trợ ' + p);
  }

  async function api(path, opts) {
    if (STATIC) return staticApi(path);
    const res = await fetch('/api' + path, opts);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { window.Auth.signOut(); throw new Error('Phiên đăng nhập đã hết hạn'); }
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  function toast(msg, type = 'info', ms = 3800) {
    const icon = { ok: 'fa-circle-check', err: 'fa-circle-exclamation', info: 'fa-circle-info' }[type];
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
  }

  function animateNumber(el, to, dec = 1, suffix = '') {
    if (!el) return;
    if (!isNum(to)) { el.innerHTML = '–'; delete el.dataset.v; return; }
    const from = isNum(el.dataset.v) ? +el.dataset.v : to;
    el.dataset.v = to;
    if (!motionOK() || Math.abs(to - from) < 1e-9) { el.innerHTML = fmt(to, dec) + suffix; return; }
    const t0 = performance.now(), dur = 550;
    const step = (now) => {
      if (+el.dataset.v !== to) return;              // đã có giá trị mới hơn
      const p = clamp((now - t0) / dur, 0, 1), e = 1 - (1 - p) ** 3;
      el.innerHTML = fmt(from + (to - from) * e, dec) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ───────────────────────── Bus sự kiện (dùng chung với 3D) ─────────────────────────
  const bus = {
    h: {},
    on(e, f) { (this.h[e] ||= []).push(f); },
    emit(e, ...a) { (this.h[e] || []).forEach((f) => { try { f(...a); } catch (err) { console.error(err); } }); },
  };

  // ───────────────────────── Trạng thái ─────────────────────────
  const S = {
    meta: null, wards: null, N: 0, province: null,
    gee: null, runSeries: {}, wardCache: new Map(), fillRun: null, daily: null, dayI: 0,
    mode: 'gee', runId: null, cmp: 'pred', base: 'google', outline: true, opacity: 0.85, view: lsGet('lst.view', 'pixel'),
    frames: [], frameI: 0, ky: null, V: null, Vdisp: null,
    thr: 40, sortDesc: true, region: '', filter: '',
    selected: null, hover: null, point: null,
    playing: false, timer: null, tab: 'overview', tucked: lsGet('lst.tucked', null),
  };
  if (S.view !== 'ward') S.view = 'pixel';

  // ───────────────────────── Thang màu (theo Cài đặt) ─────────────────────────
  const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  let LST = { min: 25, max: 45, palette: SET.palette(), encode: [10, 70], nguong: [], gee: [] };
  let PAL = LST.palette.map(hexToRgb);
  const ERR = { min: -5, max: 5, palette: ['#1d4ed8', '#60a5fa', '#f1f5f9', '#f87171', '#b91c1c'] };
  const ERR_PAL = ERR.palette.map(hexToRgb);
  function rampAt(pal, t) {
    t = clamp(t, 0, 1);
    const x = t * (pal.length - 1), i = Math.min(Math.floor(x), pal.length - 2), f = x - i;
    return [0, 1, 2].map((j) => Math.round(pal[i][j] + (pal[i + 1][j] - pal[i][j]) * f));
  }
  const colorAt = (v) => (isNum(v) ? rampAt(PAL, (v - LST.min) / (LST.max - LST.min)) : null);
  const errAt = (v) => (isNum(v) ? rampAt(ERR_PAL, (v - ERR.min) / (ERR.max - ERR.min)) : null);
  const css = (c) => (c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#cbd5e1');
  const levelOf = (v) => (isNum(v) ? LST.nguong.find((n) => (n.tu === null || v >= n.tu) && (n.den === null || v < n.den)) : null);
  const textOn = (c) => (c && (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) < 140 ? '#fff' : '#0f172a');
  function niceTicks(lo, hi, target = 5) {
    const raw = (hi - lo) / target, p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  // ───────────────────────── Bản đồ ─────────────────────────
  // zoomSnap = 1: luôn ở mức zoom nguyên → ô bản đồ hiển thị đúng điểm ảnh, chữ sắc nét (không bị kéo giãn mờ)
  const map = L.map('map', { zoomControl: false, preferCanvas: false, zoomSnap: 1, zoomDelta: 1, wheelPxPerZoomLevel: 80, minZoom: 8, maxZoom: 18, tap: true })
    .setView([10.85, 106.75], 9);
  map.createPane('raster').style.zIndex = 350;
  map.createPane('mask').style.zIndex = 380;
  map.getPane('mask').style.pointerEvents = 'none';
  L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 130 }).addTo(map);

  // 2 lớp nền: Google Map (mặc định) và Vệ tinh. Màn hình mật độ cao dùng ô scale=2 cho nét.
  const HIDPI = (window.devicePixelRatio || 1) > 1.2;
  const gTile = (lyrs, cls) => L.tileLayer(`https://mt{s}.google.com/vt/lyrs=${lyrs}&hl=vi&x={x}&y={y}&z={z}${HIDPI ? '&scale=2' : ''}`,
    { subdomains: '0123', maxZoom: 20, attribution: '© Google', keepBuffer: 4, className: cls, detectRetina: false });
  const BASES = { google: [gTile('m', 'base-road')], sat: [gTile('y', 'base-sat')] };
  function setBase(key) {
    if (!BASES[key]) key = 'google';
    Object.values(BASES).flat().forEach((l) => map.hasLayer(l) && map.removeLayer(l));
    BASES[key].forEach((l) => l.addTo(map));
    S.base = key;
    $$('#baseSeg button').forEach((b) => b.classList.toggle('on', b.dataset.base === key));
    styleWards();
  }

  // Hai lớp ảnh để chuyển cảnh mờ dần (crossfade)
  const imgLayers = [null, null];
  let imgFront = 0;
  const EMPTY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  let wardLayer = null;
  const wardPaths = [];
  let pickMarker = null;
  let maskLayer = null;

  // ───────────────────────── Giải mã ảnh PNG 8-bit → giá trị thật ─────────────────────────
  const imgCache = new Map();
  async function decodePng(url, encode) {
    if (imgCache.has(url)) return imgCache.get(url);
    const p = (async () => {
      const im = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('Không tải được ảnh ' + url));
        i.src = url;
      });
      const cv = document.createElement('canvas');
      cv.width = im.width; cv.height = im.height;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0);
      const d = cx.getImageData(0, 0, cv.width, cv.height).data;
      const [lo, hi] = encode, sc = (hi - lo) / 254;
      const vals = new Float32Array(cv.width * cv.height);
      for (let i = 0, j = 0; j < vals.length; i += 4, j++) { const e = d[i]; vals[j] = e ? lo + (e - 1) * sc : NaN; }
      return { w: cv.width, h: cv.height, vals };
    })();
    imgCache.set(url, p);
    p.catch(() => imgCache.delete(url));
    while (imgCache.size > 36) imgCache.delete(imgCache.keys().next().value);
    return p;
  }
  const pxCanvas = document.createElement('canvas');
  function colorize(img, colorFn, lo, hi) {
    pxCanvas.width = img.w; pxCanvas.height = img.h;
    const cx = pxCanvas.getContext('2d');
    const out = cx.createImageData(img.w, img.h), d = out.data;
    const LUT = 512, lut = new Uint8Array(LUT * 3);
    for (let i = 0; i < LUT; i++) lut.set(colorFn(lo + (hi - lo) * i / (LUT - 1)), i * 3);
    const span = hi - lo;
    for (let i = 0, j = 0; i < img.vals.length; i++, j += 4) {
      const v = img.vals[i];
      if (v !== v) continue;
      const t = clamp(Math.round((v - lo) / span * (LUT - 1)), 0, LUT - 1) * 3;
      d[j] = lut[t]; d[j + 1] = lut[t + 1]; d[j + 2] = lut[t + 2]; d[j + 3] = 240;
    }
    cx.putImageData(out, 0, 0);
    return new Promise((res) => pxCanvas.toBlob((b) => res(URL.createObjectURL(b)), 'image/png'));
  }

  // ───────────────────────── Nguồn dữ liệu theo khung hiện tại ─────────────────────────
  const run = () => S.meta?.runs.find((r) => r.ma_phien === S.runId) || null;
  const bestRun = () => S.meta?.runs.find((r) => r.mac_dinh && r.ma_loai === 'MO_HINH') || S.meta?.runs.find((r) => r.ma_loai === 'MO_HINH') || null;
  const geeItem = (ky) => LST.gee?.find((g) => g.ky === ky) || null;
  const fillItem = (ky) => S.fillRun?.months.find((m) => m.ky === ky) || null;
  const runItem = (ky, r = run()) => r?.months.find((m) => m.ky === ky) || null;
  const hasObs = (ky) => !!geeItem(ky);
  const isFill = (ky) => !geeItem(ky) && !!fillItem(ky);
  const showFill = () => SET.get().showFill !== false && !!S.fillRun;
  const wardIndex = new Map();
  const day = () => (S.mode === 'day' && S.daily ? S.daily.days[S.dayI] : null);

  function matrixRow(series, ky) {
    if (!series) return null;
    const j = series.months.indexOf(ky);
    return j >= 0 ? series.tb[j] : null;
  }
  async function ensureRunSeries(id) {
    if (id === null || id === undefined) return null;
    if (!S.runSeries[id]) S.runSeries[id] = await api(`/series?chi_so=LST&phien=${id}`);
    return S.runSeries[id];
  }
  async function ensureDaily() {
    if (!S.daily) {
      S.daily = await api('/daily');
      if (S.daily?.phien?.ma_phien) ensureRunSeries(S.daily.phien.ma_phien).catch(() => {});
    }
    return S.daily;
  }
  const toF32 = (arr) => (arr ? Float32Array.from(arr, (v) => (v === null ? NaN : v)) : new Float32Array(S.N).fill(NaN));
  /** Giá trị trung bình 168 phường tại khung hiện tại theo chế độ hiển thị */
  function currentValues() {
    const ky = S.ky;
    if (S.mode === 'day') return toF32(S.daily?.wards[S.dayI]);
    const obs = matrixRow(S.gee, ky);
    if (S.mode === 'gee') return obs ? toF32(obs) : toF32(matrixRow(S.runSeries[S.fillRun?.ma_phien], ky));
    const pred = matrixRow(S.runSeries[S.runId], ky);
    const P = toF32(pred);
    if (S.cmp === 'obs' && obs) return toF32(obs);
    if (S.cmp === 'err' && obs) return P.map((v, i) => (obs[i] === null ? NaN : v - obs[i]));
    return P;
  }
  const errMode = () => S.mode === 'run' && S.cmp === 'err' && hasObs(S.ky);
  const valColor = (v) => (errMode() ? errAt(v) : colorAt(v));

  // ───────────────────────── Lớp phường/xã (ranh giới + tô màu) ─────────────────────────
  function buildWardLayer() {
    wardLayer = L.geoJSON(S.wards, {
      renderer: L.svg({ padding: 0.4 }),
      style: () => ({ className: 'ward', weight: 0.7, color: '#ffffff', fillOpacity: 0, fillColor: '#000' }),
      onEachFeature: (f, layer) => {
        wardPaths[f.properties.i] = layer;
        layer.on({
          mouseover: (e) => { S.hover = f.properties.i; styleWard(f.properties.i); showTip(e); },
          mousemove: showTip,
          mouseout: () => { const i = S.hover; S.hover = null; if (i !== null) styleWard(i); hideTip(); },
          click: (e) => { L.DomEvent.stopPropagation(e); selectWard(f.properties.i, { fly: false }); pickPoint(e.latlng.lat, e.latlng.lng, { keepWard: true }); },
        });
      },
    }).addTo(map);
  }
  const wardFill = (v) => (isNum(v) ? css(valColor(v)) : '#94a3b8');
  function styleWard(i) {
    const layer = wardPaths[i];
    if (!layer || !S.V) return;
    const v = S.V[i];
    const err = errMode();
    const over = !err && S.mode !== 'day' && isNum(v) && v >= S.thr;
    const dark = S.base === 'sat' || SET.theme() === 'dark';
    const choro = S.view === 'ward';
    const shown = S.Vdisp ? S.Vdisp[i] : v;
    let st = {
      fillColor: choro ? wardFill(shown) : '#000',
      fillOpacity: choro ? (isNum(shown) ? S.opacity * 0.92 : 0.22) : 0,
      color: choro ? (dark ? 'rgba(15,23,42,.55)' : 'rgba(255,255,255,.75)') : (dark ? 'rgba(255,255,255,.8)' : 'rgba(15,23,42,.5)'),
      weight: S.outline ? (choro ? 0.7 : 0.6) : 0,
      opacity: 1,
    };
    if (over) st = { ...st, color: '#991b1b', weight: S.outline ? 1.6 : 1.2 };
    if (S.hover === i) st = { ...st, color: dark ? '#ffffff' : '#0f172a', weight: 2.6 };
    if (S.selected === i) st = { ...st, color: '#f59e0b', weight: 3.4 };
    layer.setStyle(st);
    if (S.selected === i || S.hover === i) layer.bringToFront();
  }
  function styleWards() { for (let i = 0; i < S.N; i++) styleWard(i); }

  // Chuyển màu mượt giữa 2 khung (chế độ tô màu phường): nội suy giá trị từng phường theo thời gian thực
  let wardAnimRaf = 0;
  function paintWardFills(V, final) {
    for (let i = 0; i < S.N; i++) {
      const layer = wardPaths[i];
      if (!layer || !layer._path) continue;
      const c = wardFill(V[i]);
      layer._path.setAttribute('fill', c);
      if (final) layer.options.fillColor = c;
    }
  }
  function animateWards(from, to, dur) {
    cancelAnimationFrame(wardAnimRaf);
    if (S.view !== 'ward') { S.Vdisp = to; return; }
    if (!from || from.length !== to.length || dur < 30 || !motionOK()) { S.Vdisp = to; styleWards(); return; }
    const t0 = performance.now();
    const cur = new Float32Array(to.length);
    const step = (now) => {
      const p = clamp((now - t0) / dur, 0, 1);
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      for (let i = 0; i < to.length; i++) {
        const a = from[i], b = to[i];
        cur[i] = a !== a ? b : b !== b ? b : a + (b - a) * e;
      }
      S.Vdisp = cur;
      paintWardFills(cur, false);
      if (p < 1) wardAnimRaf = requestAnimationFrame(step);
      else { S.Vdisp = to; styleWards(); }
    };
    wardAnimRaf = requestAnimationFrame(step);
  }

  function addProvince() {
    if (!S.province) return;
    const holes = [];
    S.province.features.forEach((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach((p) => holes.push(p[0].map(([x, y]) => [y, x])));
    });
    const world = [[-89, -179], [-89, 179], [89, 179], [89, -179]];
    // phủ rất nhẹ bên ngoài TP để làm nổi vùng dữ liệu nhưng KHÔNG làm mờ bản đồ
    maskLayer = L.polygon([world, ...holes], { pane: 'mask', stroke: false, fillColor: '#0f172a', fillOpacity: 0.06, interactive: false }).addTo(map);
    L.geoJSON(S.province, { pane: 'mask', interactive: false, style: { color: '#0f172a', weight: 1.8, opacity: 0.85, fill: false } }).addTo(map);
  }

  // ───────────────────────── Lớp ảnh pixel ─────────────────────────
  let pxToken = 0;
  S.px = null;
  let busyTimer = 0;
  function busy(on, text) {
    clearTimeout(busyTimer);
    if (text) $('#busyT').textContent = text;
    if (!on) { $('#busy').hidden = true; return; }
    busyTimer = setTimeout(() => { $('#busy').hidden = false; }, S.playing ? 900 : 220);   // chỉ hiện khi chờ lâu
  }
  function fadeMs() { return S.playing && motionOK() ? Math.min(+$('#speedSel').value * 0.85, 1700) : (motionOK() ? 450 : 0); }
  function pixelSource(ky) {
    if (S.mode === 'day') { const r = S.meta.runs.find((x) => x.ma_phien === S.daily?.phien?.ma_phien); return runItem(ky, r)?.url || null; }
    if (S.mode === 'gee') return (geeItem(ky) || fillItem(ky))?.url || null;
    const g = geeItem(ky), f = runItem(ky);
    if (S.cmp === 'obs' && g) return g.url;
    return f?.url || null;
  }
  async function updatePixels() {
    const tok = ++pxToken;
    const ky = S.ky;
    let url = null, img = null, err = false;
    try {
      busy(true, 'Đang giải mã ảnh nhiệt…');
      const g = geeItem(ky), f = S.mode === 'run' ? runItem(ky) : null;
      if (S.mode === 'run' && S.cmp === 'err' && g && f) {
        const [a, b] = await Promise.all([decodePng(f.url, LST.encode), decodePng(g.url, LST.encode)]);
        const vals = new Float32Array(a.vals.length);
        for (let i = 0; i < vals.length; i++) vals[i] = a.vals[i] - b.vals[i];
        img = { w: a.w, h: a.h, vals };
        err = true;
      } else {
        const src = pixelSource(ky);
        if (!src) throw new Error('Không có ảnh cho ' + frameText());
        img = await decodePng(src, LST.encode);
        const d = day();
        if (d && isNum(d.lech)) {                                // 7 ngày: ảnh tháng của AI + dao động ngày
          const vals = new Float32Array(img.vals.length);
          for (let i = 0; i < vals.length; i++) vals[i] = img.vals[i] + d.lech;
          img = { w: img.w, h: img.h, vals };
        }
      }
      if (tok !== pxToken) return;
      url = err ? await colorize(img, errAt, ERR.min, ERR.max) : await colorize(img, colorAt, LST.min, LST.max);
      if (tok !== pxToken) { URL.revokeObjectURL(url); return; }
      S.px = { ...img, err };
      $('#map').style.setProperty('--fade', fadeMs() + 'ms');
      const back = 1 - imgFront;
      const layer = imgLayers[back];
      const old = layer._lstUrl;
      await new Promise((res) => {
        const t = setTimeout(res, 1200);
        layer.once('load', () => { clearTimeout(t); res(); });
        layer.setUrl(url);
      });
      layer._lstUrl = url;
      if (tok !== pxToken) return;
      layer.getElement()?.classList.toggle('smooth', err);
      const op = S.view === 'pixel' ? S.opacity : 0;
      layer.setOpacity(op);
      imgLayers[imgFront].setOpacity(0);
      imgFront = back;
      if (old) setTimeout(() => URL.revokeObjectURL(old), fadeMs() + 600);
      prefetchNext();
    } catch (e) {
      console.error(e);
      if (tok === pxToken) toast(e.message, 'err');
    } finally {
      if (tok === pxToken) busy(false);
    }
  }
  function prefetchNext() {
    if (!S.frames.length) return;
    const nxt = S.frames[(S.frameI + 1) % S.frames.length];
    const ky = S.mode === 'day' ? S.daily?.days[nxt]?.ky : nxt;
    const src = ky ? pixelSource(ky) : null;
    if (src) decodePng(src, LST.encode).catch(() => {});
  }
  function pixelAt(latlng) {
    if (!S.px || !S.meta.overlay) return NaN;
    const [w, s, e, n] = S.meta.overlay.bounds;
    const P = (lat, lng) => L.CRS.EPSG3857.project(L.latLng(lat, lng));
    const p = P(latlng.lat, latlng.lng), nw = P(n, w), se = P(s, e);
    const col = Math.floor((p.x - nw.x) / (se.x - nw.x) * S.px.w);
    const row = Math.floor((nw.y - p.y) / (nw.y - se.y) * S.px.h);
    if (col < 0 || row < 0 || col >= S.px.w || row >= S.px.h) return NaN;
    return S.px.vals[row * S.px.w + col];
  }
  function setView(v) {
    if (v !== 'ward') v = 'pixel';
    S.view = v;
    lsSet('lst.view', v);
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    $('#map').style.setProperty('--fade', (motionOK() ? 420 : 0) + 'ms');
    imgLayers[imgFront]?.setOpacity(v === 'pixel' ? S.opacity : 0);
    S.Vdisp = S.V;
    styleWards();
    renderLegend();
  }

  // ───────────────────────── Tooltip & ô đọc giá trị ─────────────────────────
  const tip = $('#tip');
  function showTip(e) {
    const i = S.hover;
    if (i === null || i === undefined || isMobile()) return;
    const p = S.wards.features[i].properties;
    const v = S.V?.[i];
    const err = errMode();
    const pv = S.view === 'pixel' ? pixelAt(e.latlng) : NaN;
    const lv = err ? null : levelOf(v);
    const rank = rankOf(i);
    tip.innerHTML = `
      <h4>${esc(p.loai)} ${esc(p.ten_xa)}</h4>
      <div class="sub">${esc(p.khu_vuc)}${rank ? ` · hạng ${rank.r}/${rank.n}` : ''}</div>
      <div class="r"><span>${err ? 'Sai số TB phường' : 'TB phường/xã'}</span><b>${err ? signed(v) : fmt(v, 2)} °C</b></div>
      ${isNum(pv) ? `<div class="r"><span>Tại con trỏ</span><b>${err ? signed(pv) : fmt(pv, 1)} °C</b></div>` : ''}
      ${lv ? `<span class="lvl" style="background:${lv.mau}">${esc(lv.ten)}</span>` : ''}
      ${S.mode === 'gee' && isFill(S.ky) ? '<span class="est"><i class="fa-solid fa-circle-info"></i> Tháng không có ảnh — giá trị nội suy</span>' : ''}
      ${S.mode === 'day' ? '<span class="est"><i class="fa-solid fa-flask"></i> Dự báo ngày giả lập</span>' : ''}`;
    const pt = map.mouseEventToContainerPoint(e.originalEvent);
    const W = map.getSize().x;
    tip.style.left = pt.x + 'px';
    tip.style.top = pt.y + 'px';
    tip.style.transform = pt.x > W - 260 ? 'translate(calc(-100% - 16px), 16px)' : 'translate(16px, 16px)';
    tip.hidden = false;
  }
  function hideTip() { tip.hidden = true; }
  const signed = (v, d = 2) => (isNum(v) ? (v > 0 ? '+' : '') + fmt(v, d) : '–');

  map.on('mousemove', (e) => {
    $('#roXY').textContent = `${e.latlng.lat.toFixed(4)}°B · ${e.latlng.lng.toFixed(4)}°Đ`;
    const v = S.view === 'pixel' ? pixelAt(e.latlng) : (S.hover !== null ? S.V?.[S.hover] : NaN);
    const err = errMode();
    $('#roVal').innerHTML = isNum(v) ? `${err ? 'Sai số ' + signed(v, 1) : 'LST ' + fmt(v, 1)} °C` : '&nbsp;';
    legendMarker(v);
  });
  map.on('mouseout', () => { $('#roXY').textContent = 'Di chuột lên bản đồ để xem giá trị'; $('#roVal').innerHTML = '&nbsp;'; legendMarker(NaN); hideTip(); });
  map.on('click', (e) => {
    if (isMobile() && drawerOpen()) { closeDrawer(); return; }    // điện thoại: chạm bản đồ để thu tấm trượt
    pickPoint(e.latlng.lat, e.latlng.lng);
  });

  // ───────────────────────── Chú giải ─────────────────────────
  function renderLegend() {
    const err = errMode();
    const lo = err ? ERR.min : LST.min, hi = err ? ERR.max : LST.max;
    $('#lgTitle').textContent = err ? 'Sai số °C' : 'LST °C';
    $('#lgBar').style.background = `linear-gradient(0deg, ${(err ? ERR.palette : LST.palette).join(', ')})`;
    $('#lgTicks').innerHTML = niceTicks(lo, hi, 5).map((t) => `<span style="bottom:${(t - lo) / (hi - lo) * 100}%">${err && t > 0 ? '+' : ''}${t}</span>`).join('');
    $('#lgLow').textContent = err ? 'Dự báo thấp hơn' : 'Mát';
    $('#lgHigh').textContent = err ? 'Dự báo cao hơn' : 'Nóng';
    let sub;
    if (S.view === 'ward') sub = 'TB phường/xã';
    else if (S.mode === 'day') sub = 'AI tháng + thời tiết';
    else if (S.mode === 'gee') sub = isFill(S.ky) ? 'nội suy 120 m' : 'ảnh GEE 30 m';
    else sub = S.cmp === 'obs' && hasObs(S.ky) ? 'ảnh GEE 30 m' : 'dự báo AI 120 m';
    $('#lgSub').textContent = sub;
  }
  function legendMarker(v) {
    const m = $('#lgMarker');
    if (!isNum(v)) { m.classList.remove('on'); return; }
    const err = errMode();
    const lo = err ? ERR.min : LST.min, hi = err ? ERR.max : LST.max;
    m.style.bottom = clamp((v - lo) / (hi - lo), 0, 1) * 100 + '%';
    $('#lgMarkerV').textContent = (err ? signed(v, 1) : fmt(v, 1)) + '°';
    m.classList.add('on');
  }

  // ───────────────────────── Khung thời gian ─────────────────────────
  function buildFrames() {
    if (S.mode === 'day') S.frames = S.daily ? S.daily.days.map((_, i) => i) : [];
    else if (S.mode === 'gee') {
      const ks = new Set(LST.gee.map((g) => g.ky));
      if (showFill()) S.fillRun.months.forEach((m) => ks.add(m.ky));
      S.frames = [...ks].sort((a, b) => a - b);
    } else S.frames = run()?.months.map((m) => m.ky) || [];
  }
  async function setFrame(i, opts = {}) {
    if (!S.frames.length) return;
    S.frameI = (i + S.frames.length) % S.frames.length;
    if (S.mode === 'day') { S.dayI = S.frames[S.frameI]; S.ky = S.daily.days[S.dayI].ky; }
    else S.ky = S.frames[S.frameI];
    await render(opts);
  }
  function stepFrame(d) { stop(); setFrame(S.frameI + d); }
  function play() {
    if (S.playing || S.frames.length < 2) return;
    S.playing = true;
    $('#tlPlay').classList.add('playing');
    $('#tlPlay').innerHTML = '<i class="fa-solid fa-pause"></i>';
    bus.emit('play', true);
    const tick = async () => {
      if (!S.playing) return;
      const t0 = performance.now();
      await setFrame(S.frameI + 1, { fromPlay: true });
      if (S.playing) S.timer = setTimeout(tick, Math.max(60, +$('#speedSel').value - (performance.now() - t0)));
    };
    S.timer = setTimeout(tick, 250);
  }
  function stop() {
    if (!S.playing) return;
    S.playing = false;
    clearTimeout(S.timer);
    $('#tlPlay').classList.remove('playing');
    $('#tlPlay').innerHTML = '<i class="fa-solid fa-play"></i>';
    bus.emit('play', false);
  }
  const frameText = () => (S.mode === 'day' && day() ? dayText(day().ngay) : kyText(S.ky));
  const frameShort = () => (S.mode === 'day' && day() ? dayShort(day().ngay) : kyShort(S.ky));

  // Thanh sọc nhiệt (tháng) hoặc 7 ô ngày
  function buildStripes() {
    const box = $('#stripes');
    box.classList.toggle('days', S.mode === 'day');
    if (S.mode === 'day') {
      const dd = S.daily?.days || [];
      box.innerHTML = dd.map((d, i) => {
        const c = colorAt(d.lst);
        return `<button class="d" data-day="${i}" style="background-color:${css(c)};color:${textOn(c)};text-shadow:none" title="${esc(dayText(d.ngay))} · LST ${fmt(d.lst, 1)} °C (giả lập)"><span>${dayShort(d.ngay)}</span><b>${fmt(d.lst, 1)}°</b></button>`;
      }).join('');
      $('#tlAxis').innerHTML = `<span style="left:0">Dự báo theo ngày · giả lập từ AI tháng (${esc(S.daily?.phien?.ten_mo_hinh || '')}) + thời tiết ${esc(S.daily?.nguon || '')}</span>`;
      $('#tlKey').innerHTML = '<span class="k-fc"></span>Giả lập theo ngày';
      markStripes();
      return;
    }
    $('#tlKey').innerHTML = '<span class="k-obs"></span>Quan trắc<span class="k-fill"></span>Nội suy<span class="k-fc"></span>Dự báo';
    const r = S.meta.runs.find((x) => x.ma_phien === S.runId);
    const all = [...LST.gee.map((g) => g.ky), ...(S.fillRun ? S.fillRun.months.map((m) => m.ky) : []), ...(r ? r.months.map((m) => m.ky) : [])];
    const first = Math.min(...all.map(kyIdx)), last = Math.max(...all.map(kyIdx));
    const fillOn = showFill();
    let html = '';
    for (let i = first; i <= last; i++) {
      const ky = idxKy(i);
      const g = geeItem(ky), f = r ? runItem(ky, r) : null, fl = fillItem(ky);
      const cls = ['m'];
      let bg = '';
      let title = kyText(ky);
      if (f && S.mode === 'run') {
        cls.push('fc');
        bg = css(colorAt(f.tb));
        title += ` · dự báo ${fmt(f.tb, 1)} °C (${TAP_TEXT[f.tap] || ''})`;
        if (g) { cls.push('obs-too'); title += ` · GEE ${fmt(g.tb, 1)} °C`; }
      } else if (g) {
        cls.push('obs');
        bg = css(colorAt(g.tb));
        title += ` · ảnh GEE ${fmt(g.tb, 1)} °C`;
      } else if (fl && fillOn) {
        cls.push('fill');
        bg = css(colorAt(fl.tb));
        title += ` · nội suy ${fmt(fl.tb, 1)} °C (không có ảnh sạch mây)`;
      } else if (f) {
        cls.push('fc');
        bg = css(colorAt(f.tb));
        title += ` · dự báo ${fmt(f.tb, 1)} °C`;
      } else title += ' · không có ảnh (mây/thiếu dữ liệu)';
      if (kyM(ky) === 1) cls.push('yr');
      const obsColor = g && f ? `--obs-color:${css(colorAt(g.tb))};` : '';
      html += `<div class="${cls.join(' ')}" data-ky="${ky}" style="--i:${i - first};${bg ? `background-color:${bg};` : ''}${obsColor}" title="${esc(title)}"></div>`;
    }
    box.innerHTML = html + '<div class="now-flag" id="nowFlag"></div>';
    const n = last - first + 1;
    let ax = '';
    for (let y = kyY(idxKy(first)); y <= kyY(idxKy(last)); y++) {
      const pos = ((y - Y0) * 12 - first) / n * 100;
      if (pos >= -1 && pos <= 95) ax += `<span style="left:${Math.max(0, pos)}%">${isMobile() ? "'" + String(y).slice(2) : y}</span>`;
    }
    $('#tlAxis').innerHTML = ax;
    markStripes();
  }
  function markStripes() {
    if (S.mode === 'day') {
      $$('#stripes .d').forEach((el) => el.classList.toggle('cur', +el.dataset.day === S.dayI));
      return;
    }
    const set = new Set(S.frames);
    let cur = null;
    $$('#stripes .m').forEach((el) => {
      const k = +el.dataset.ky;
      el.classList.toggle('cur', k === S.ky);
      el.classList.toggle('dim', (el.classList.contains('obs') || el.classList.contains('fc') || el.classList.contains('fill')) && !set.has(k));
      if (k === S.ky) cur = el;
    });
    const flag = $('#nowFlag');
    if (cur && flag) {
      flag.textContent = kyShort(S.ky);
      const W = $('#stripes').offsetWidth;
      flag.style.left = clamp(cur.offsetLeft + cur.offsetWidth / 2, 22, W - 22) + 'px';
    }
  }
  $('#stripes').addEventListener('click', async (e) => {
    const dEl = e.target.closest('.d');
    if (dEl) { stop(); const i = S.frames.indexOf(+dEl.dataset.day); if (i >= 0) await setFrame(i); return; }
    const el = e.target.closest('.m');
    if (!el) return;
    const ky = +el.dataset.ky;
    stop();
    if (S.frames.includes(ky)) await gotoKy(ky);                       // tháng thuộc chế độ đang xem
    else if (S.mode === 'gee' && runItem(ky)) await setMode('run', { ky }); // tháng chỉ có dự báo
    else if (S.mode === 'run' && (geeItem(ky) || (showFill() && fillItem(ky)))) await setMode('gee', { ky }); // tháng hiện trạng / nội suy
  });
  async function gotoKy(ky) {
    const i = S.frames.indexOf(ky);
    if (i >= 0) await setFrame(i);
  }

  // ───────────────────────── Vẽ lại toàn bộ theo khung hiện tại ─────────────────────────
  async function render(opts = {}) {
    if (S.mode === 'run') await ensureRunSeries(S.runId);
    if (S.mode === 'gee' && isFill(S.ky)) await ensureRunSeries(S.fillRun.ma_phien);
    const prevDisp = S.Vdisp && S.Vdisp.length === S.N ? Float32Array.from(S.Vdisp) : null;
    S.V = currentValues();
    animateWards(prevDisp, S.V, opts.fromPlay ? fadeMs() : (motionOK() ? 520 : 0));
    if (S.view !== 'ward') styleWards();
    updatePixels();
    renderTitle();
    renderLegend();
    renderNow();
    renderThreshold();
    renderRank();
    markStripes();
    $('#cmpSeg').hidden = S.simple || !(S.mode === 'run' && hasObs(S.ky) && run()?.ma_loai === 'MO_HINH');
    if (!opts.fromPlay && S.tab === 'stats') renderStatsTab();
    if (S.selected !== null) updateWardLive();
    bus.emit('frame', { ky: S.ky, V: S.V, err: errMode() });
  }

  function sourceLabel() {
    if (S.mode === 'day') return '<span class="chip day dot">Dự báo ngày · giả lập</span>';
    if (S.mode === 'gee') return isFill(S.ky) ? '<span class="chip fill dot">Nội suy · ước tính</span>' : '<span class="chip gee dot">Hiện trạng · GEE</span>';
    const r = run();
    if (!r) return '';
    if (S.simple) return '<span class="chip run dot">Dự báo AI</span>';
    const it = runItem(S.ky);
    const tap = it?.tap ? ` · ${TAP_TEXT[it.tap]}` : '';
    if (r.ma_loai === 'GIA_LAP') return `<span class="chip sim dot">Giả lập · ${esc(r.ten_mo_hinh)}</span>`;
    return `<span class="chip run dot">Dự báo · ${esc(r.ten_mo_hinh)}${tap}</span>`;
  }
  function renderTitle() {
    const r = run();
    let p = `<b>${esc(frameText())}</b>`;
    if (S.mode === 'day') p += ` · dự báo tháng của <b>${esc(S.daily?.phien?.ten_mo_hinh || 'AI')}</b> cộng dao động theo thời tiết (${esc(S.daily?.nguon || '')})`;
    else if (S.mode === 'gee') p += isFill(S.ky) ? ' · không có ảnh sạch mây — ước tính theo mùa từ các tháng có ảnh lân cận' : ' · hiện trạng từ ảnh Google Earth Engine';
    else if (r) {
      const it = runItem(S.ky);
      const what = S.cmp === 'obs' && hasObs(S.ky) ? 'ảnh GEE thực tế để đối chiếu' : S.cmp === 'err' && hasObs(S.ky) ? 'sai số dự báo so với GEE' : (r.ma_loai === 'GIA_LAP' ? `kịch bản giả lập (${esc(r.ten_mo_hinh)})` : `dự báo ${esc(r.ten_mo_hinh)}`);
      p += ` · ${what}${!S.simple && it?.tap ? ` · tập ${TAP_TEXT[it.tap]}` : ''}`;
    }
    const el = $('#mapTitleP');
    el.innerHTML = p;
    el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
  }

  function cityMean() {
    if (S.mode === 'day') return day()?.lst;
    if (S.mode === 'gee') return (geeItem(S.ky) || fillItem(S.ky))?.tb;
    if (S.cmp === 'obs' && hasObs(S.ky)) return geeItem(S.ky)?.tb;
    return runItem(S.ky)?.tb;
  }
  /** Trung bình nhiều năm cùng tháng (chỉ ảnh GEE thật), bỏ tháng đang xem */
  function climate(ky) {
    const xs = LST.gee.filter((g) => kyM(g.ky) === kyM(ky) && g.ky !== ky).map((g) => g.tb);
    return xs.length ? { tb: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null;
  }
  /** Khoảng tin cậy 80 % của trung bình TP cho tháng dự báo (từ sai số tập kiểm định theo tầm) */
  function runBand(ky, r = run()) {
    const it = runItem(ky, r);
    const b = r?.tham_so?.khoang_du_bao_80?.phuong;
    if (!it || !b || it.tap !== 'future') return null;
    const h = r.months.filter((m) => m.tap === 'future').findIndex((m) => m.ky === ky);
    const q = b[h];
    return q ? [it.tb + q[0], it.tb + q[1]] : null;
  }
  function renderNow() {
    $('#nowMonth').textContent = frameText();
    $('#nowSrc').innerHTML = sourceLabel();
    const s = $('#nowSeason');
    s.textContent = isDry(S.ky) ? 'Mùa khô' : 'Mùa mưa';
    s.classList.toggle('wet', !isDry(S.ky));
    const err = errMode();
    const mean = err ? meanOf(S.V) : cityMean();
    const sw = isNum(mean) ? css(err ? errAt(mean) : colorAt(mean)) : 'var(--line-2)';
    $('#nowSwatch').style.background = sw;
    $('#miniSw').style.background = sw;
    $('#miniMonth').textContent = frameShort();
    $('#miniVal').textContent = isNum(mean) ? `${err ? signed(mean, 1) : fmt(mean, 1)}°C` : '–';
    $('#kpiMeanK').textContent = err ? 'Sai số TB (dự báo − GEE)' : 'Trung bình toàn TP';
    $('#kpiDeltaK').textContent = err ? 'RMSE tập kiểm tra' : S.mode === 'day' ? 'Lệch so với dự báo tháng' : 'So với cùng kỳ';
    $('#kpiHotK').textContent = err ? 'Dự báo cao hơn thực tế nhiều nhất' : 'Phường/xã nóng nhất';
    animateNumber($('#kpiMean'), mean, 1, ' <small>°C</small>');
    const wx = $('#dayWx');
    wx.hidden = S.mode !== 'day';
    if (S.mode === 'day') {
      const d = day();
      wx.innerHTML = d ? `<span><i class="fa-solid fa-temperature-high"></i>Không khí ${fmt(d.t_max, 0)}°/${fmt(d.t_min, 0)}°</span>
        <span><i class="fa-solid fa-sun"></i>${fmt(d.buc_xa, 0)} W/m²</span><span><i class="fa-solid fa-cloud-rain"></i>${fmt(d.mua_mm, 1)} mm</span>` : '';
      $('#kpiMeanSub').textContent = d && isNum(d.p10) ? `khoảng 80%: ${fmt(d.p10, 1)}–${fmt(d.p90, 1)} °C` : '';
      $('#kpiDelta').innerHTML = d ? `<span class="${d.lech >= 0 ? 'up' : 'down'}">${d.lech >= 0 ? '▲' : '▼'} ${fmt(Math.abs(d.lech), 1)}</span> <small>°C</small>` : '–';
      $('#kpiDeltaSub').textContent = d ? `dự báo tháng ${kyShort(d.ky)}: ${fmt(d.lst_thang, 1)} °C` : '';
    } else if (err) {
      const r = run();
      $('#kpiMeanSub').textContent = 'trung bình các phường';
      $('#kpiDelta').innerHTML = `${fmt(r?.metrics?.test?.rmse, 2)} <small>°C</small>`;
      $('#kpiDeltaSub').textContent = `${r?.ten_mo_hinh || ''} · từng ô`;
    } else {
      const g = S.mode === 'gee' ? (geeItem(S.ky) || fillItem(S.ky)) : (S.cmp === 'obs' && hasObs(S.ky) ? geeItem(S.ky) : runItem(S.ky));
      const band = S.mode === 'run' ? runBand(S.ky) : null;
      $('#kpiMeanSub').textContent = band ? `khoảng 80%: ${fmt(band[0], 1)}–${fmt(band[1], 1)} °C` : (g && isNum(g.p05) ? `5–95%: ${fmt(g.p05, 1)}–${fmt(g.p95, 1)} °C` : '');
      const c = climate(S.ky);
      if (c && isNum(mean)) {
        const dlt = mean - c.tb;
        $('#kpiDelta').innerHTML = `<span class="${dlt >= 0 ? 'up' : 'down'}">${dlt >= 0 ? '▲' : '▼'} ${fmt(Math.abs(dlt), 1)}</span> <small>°C</small>`;
        $('#kpiDeltaSub').textContent = `TB tháng ${kyM(S.ky)} của ${c.n} năm có ảnh`;
      } else {
        $('#kpiDelta').textContent = '–';
        $('#kpiDeltaSub').textContent = `chưa có tháng ${kyM(S.ky)} năm khác để so`;
      }
    }
    let hi = -1, hv = -Infinity;
    S.V.forEach((v, i) => { if (isNum(v) && v > hv) { hv = v; hi = i; } });
    const hot = $('#kpiHot');
    if (hi >= 0) {
      const p = S.wards.features[hi].properties;
      hot.textContent = `${p.loai} ${p.ten_xa}`;
      hot.dataset.i = hi;
      $('#kpiHotSub').textContent = `${err ? 'sai số ' + signed(hv, 1) : fmt(hv, 1)} °C · ${p.khu_vuc}`;
    } else { hot.textContent = '–'; delete hot.dataset.i; $('#kpiHotSub').innerHTML = '&nbsp;'; }
  }
  const meanOf = (V) => { let s = 0, n = 0; V.forEach((v) => { if (isNum(v)) { s += v; n++; } }); return n ? s / n : NaN; };

  // Thẻ thông tin kéo ra / thu vào (mép trái)
  function setTucked(on, save = true) {
    S.tucked = !!on;
    $('#nowCard').classList.toggle('tucked', S.tucked);
    $('#nowMini').classList.toggle('gone', !S.tucked);
    $('#edgeTab').classList.toggle('out', S.tucked);
    $('#edgeTab').setAttribute('aria-expanded', String(!S.tucked));
    $('#edgeTab').title = S.tucked ? 'Mở thẻ thông tin' : 'Thu gọn thẻ thông tin';
    if (save) lsSet('lst.tucked', S.tucked);
  }
  $('#edgeTab').addEventListener('click', () => setTucked(!S.tucked));
  $('#nowMini').addEventListener('click', () => setTucked(false));

  function renderThreshold() {
    const err = errMode();
    $('#thrVal').textContent = `${fmt(S.thr, 1)} °C`;
    $('#classBar').classList.toggle('off', err);
    $('#classLeg').classList.toggle('off', err);
    if (err) { $('#thrText').innerHTML = 'Đang xem sai số. Ngưỡng cảnh báo áp dụng khi xem Dự báo hoặc Thực tế GEE.'; }
    else {
      let n = 0, area = 0, total = 0, valid = 0;
      S.V.forEach((v, i) => {
        const a = S.wards.features[i].properties.dtich_km2 || 0;
        if (isNum(v)) { valid++; total += a; if (v >= S.thr) { n++; area += a; } }
      });
      $('#thrText').innerHTML = `<b>${n}</b> / ${valid} phường/xã có LST trung bình ≥ ${fmt(S.thr, 1)} °C, chiếm <b>${fmt(total ? area / total * 100 : 0, 0)}%</b> diện tích có dữ liệu.`;
    }
    const counts = LST.nguong.map(() => 0);
    let tot = 0;
    if (!err) S.V.forEach((v) => { const k = LST.nguong.findIndex((n) => (n.tu === null || v >= n.tu) && (n.den === null || v < n.den)); if (isNum(v) && k >= 0) { counts[k]++; tot++; } });
    $('#classBar').innerHTML = LST.nguong.map((n, k) => `<i style="width:${tot ? counts[k] / tot * 100 : 0}%;background:${n.mau}" title="${esc(n.ten)}: ${counts[k]}"></i>`).join('');
    $('#classLeg').innerHTML = LST.nguong.map((n, k) => `<span><i style="background:${n.mau}"></i>${esc(n.ten)} ${counts[k]}</span>`).join('');
  }

  // ───────────────────────── Xếp hạng ─────────────────────────
  let rankCache = null;
  function computeRank() {
    const ids = [...Array(S.N).keys()].filter((i) => isNum(S.V[i]));
    ids.sort((a, b) => S.V[b] - S.V[a]);
    const r = new Int16Array(S.N).fill(0);
    ids.forEach((i, j) => { r[i] = j + 1; });
    rankCache = { ky: S.ky, V: S.V, r, n: ids.length, order: ids };
  }
  function rankOf(i) {
    if (!rankCache || rankCache.V !== S.V) computeRank();
    return rankCache.r[i] ? { r: rankCache.r[i], n: rankCache.n } : null;
  }
  function renderRank() {
    computeRank();
    const err = errMode();
    let ids = rankCache.order.slice();
    if (!S.sortDesc) ids.reverse();
    const q = fold(S.filter);
    ids = ids.filter((i) => {
      const p = S.wards.features[i].properties;
      return (!S.region || p.khu_vuc === S.region) && (!q || fold(`${p.loai} ${p.ten_xa}`).includes(q));
    });
    const vals = rankCache.order.map((i) => S.V[i]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    $('#rankList').innerHTML = ids.map((i) => {
      const p = S.wards.features[i].properties, v = S.V[i];
      const w = hi > lo ? 12 + (v - lo) / (hi - lo) * 88 : 50;
      const over = !err && v >= S.thr;
      return `<button class="rank-row${over ? ' over' : ''}${S.selected === i ? ' sel' : ''}" data-i="${i}" role="listitem">
        <span class="rk">${rankCache.r[i]}</span>
        <span class="nm"><b>${esc(p.loai)} ${esc(p.ten_xa)}</b><small>${esc(p.khu_vuc)}</small></span>
        <span class="vv"><b>${err ? signed(v) : fmt(v, 2)}°</b><i style="width:${w}%;background:${css(err ? errAt(v) : colorAt(v))}"></i></span>
      </button>`;
    }).join('') || '<div class="empty"><p>Không có phường/xã khớp bộ lọc.</p></div>';
    $('#rankCount').textContent = `${ids.length} / ${rankCache.n} phường/xã có dữ liệu`;
    $('#rankSort span').textContent = S.sortDesc ? (err ? 'Sai số lớn nhất' : 'Nóng nhất') : (err ? 'Sai số nhỏ nhất' : 'Mát nhất');
  }
  $('#rankList').addEventListener('click', (e) => {
    const b = e.target.closest('.rank-row');
    if (b) selectWard(+b.dataset.i, { fly: true });
  });
  $('#rankSort').addEventListener('click', () => {
    S.sortDesc = !S.sortDesc;
    $('#rankSort i').className = `fa-solid ${S.sortDesc ? 'fa-arrow-down-wide-short' : 'fa-arrow-up-wide-short'}`;
    renderRank();
  });
  $('#rankFilter').addEventListener('input', debounce((e) => { S.filter = e.target.value; renderRank(); }, 120));
  $('#regionSel').addEventListener('change', (e) => { S.region = e.target.value; renderRank(); });
  $('#kpiHot').addEventListener('click', (e) => { if (e.currentTarget.dataset.i) selectWard(+e.currentTarget.dataset.i, { fly: true }); });
  $('#thrRange').addEventListener('input', (e) => {
    S.thr = +e.target.value;
    renderThreshold(); styleWards(); renderRank();
    bus.emit('thr', S.thr);
  });
  $('#btnCsv').addEventListener('click', () => {
    computeRank();
    const head = 'hang,ma_xa,loai,ten_xa,khu_vuc_cu,thoi_gian,nguon,lst_tb_c\n';
    const src = S.mode === 'gee' ? (isFill(S.ky) ? 'NOI_SUY' : 'GEE') : S.mode === 'day' ? `GIA_LAP_NGAY:${S.daily?.phien?.ten_mo_hinh}` : `${run()?.ma_loai}:${run()?.ma_mo_hinh}${S.cmp !== 'pred' ? ':' + S.cmp : ''}`;
    const when = S.mode === 'day' ? day()?.ngay : kyShort(S.ky);
    const rows = rankCache.order.map((i) => {
      const p = S.wards.features[i].properties;
      return [rankCache.r[i], p.ma_xa, p.loai, `"${p.ten_xa}"`, `"${p.khu_vuc}"`, when, src, S.V[i].toFixed(3)].join(',');
    });
    download(`xep_hang_lst_${S.mode === 'day' ? day()?.ngay : S.ky}.csv`, '﻿' + head + rows.join('\n'), 'text/csv');
  });
  function download(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ───────────────────────── Chọn phường / điểm ─────────────────────────
  function selectWard(i, opts = {}) {
    const prev = S.selected;
    S.selected = i;
    if (prev !== null && prev !== i) styleWard(prev);
    if (i === null) { renderWardTab(); bus.emit('select', null); renderRank(); return; }
    styleWard(i);
    $$('#rankList .rank-row').forEach((r) => r.classList.toggle('sel', +r.dataset.i === i));
    const row = $(`#rankList .rank-row[data-i="${i}"]`);
    row?.scrollIntoView({ block: 'nearest', behavior: motionOK() ? 'smooth' : 'auto' });
    if (S.point && S.point.ward?.ma_xa !== S.wards.features[i].properties.ma_xa) clearPoint();
    const wasOpen = drawerOpen();
    showTab('ward');
    if (!opts.noDrawer) openRight();
    renderWardTab();
    if (opts.fly !== false) {
      // nếu ngăn kéo vừa mở thì đợi bản đồ co lại xong mới bay tới, tránh lệch tâm
      setTimeout(() => {
        const b = wardPaths[i]?.getBounds();
        if (b?.isValid() && S.selected === i) map.flyToBounds(b, { ...fitPad(), maxZoom: 14, duration: motionOK() ? 0.9 : 0 });
      }, wasOpen || overlayDrawer() ? 0 : 440);
    }
    if (!opts.from3d) bus.emit('select', i);
  }

  async function pickPoint(lat, lon, opts = {}) {
    try {
      const d = await api(`/point?lat=${lat}&lon=${lon}`);
      if (d.ngoai_vung && !d.ward) { toast('Vị trí nằm ngoài vùng có dữ liệu của TP.HCM.', 'info'); return; }
      S.point = { ...d, lat, lon };
      const icon = L.divIcon({ className: 'pick-marker', html: '<div class="ring"></div><div class="core"></div>', iconSize: [0, 0] });
      if (pickMarker) pickMarker.setLatLng([lat, lon]);
      else pickMarker = L.marker([lat, lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
      if (!opts.keepWard && d.ward) {
        const i = wardIndex.get(d.ward.ma_xa);
        if (i !== undefined) { selectWard(i, { fly: !!opts.fly }); return; }
      }
      if (S.selected !== null) renderWardTab();
    } catch (e) { toast('Không tra cứu được điểm: ' + e.message, 'err'); }
  }
  function clearPoint() {
    S.point = null;
    if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
  }

  // ───────────────────────── Biểu đồ (màu theo chủ đề sáng/tối) ─────────────────────────
  function chartTheme() {
    const dark = SET.theme() === 'dark';
    Chart.defaults.color = dark ? '#a9b8d0' : '#475569';
    Chart.defaults.borderColor = dark ? 'rgba(148,163,184,.16)' : '#e2e8f0';
  }
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation.duration = motionOK() ? 650 : 0;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15,23,42,.94)';
  Chart.defaults.plugins.tooltip.padding = 9;
  Chart.defaults.plugins.tooltip.cornerRadius = 9;
  chartTheme();
  const charts = {};
  function chart(id, cfg) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const el = document.getElementById(id);
    if (!el) return null;
    charts[id] = new Chart(el, cfg);
    return charts[id];
  }
  // vạch đánh dấu tháng đang xem trên trục X
  const nowLine = {
    id: 'nowLine',
    afterDatasetsDraw(c, args, o) {
      if (o?.index === undefined || o.index < 0) return;
      const x = c.scales.x.getPixelForValue(o.index);
      const { top, bottom } = c.chartArea;
      const g = c.ctx;
      g.save(); g.strokeStyle = SET.theme() === 'dark' ? 'rgba(226,232,240,.6)' : 'rgba(15,23,42,.55)'; g.setLineDash([4, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.restore();
    },
  };
  function monthAxis(fromKy, toKy) {
    const out = [];
    for (let i = kyIdx(fromKy); i <= kyIdx(toKy); i++) out.push(idxKy(i));
    return out;
  }
  const FIRST_KY = () => Math.min(...LST.gee.map((g) => g.ky), ...(S.fillRun ? S.fillRun.months.map((m) => m.ky) : [999999]));

  // ───────────────────────── Tab: Phường/Xã ─────────────────────────
  async function renderWardTab() {
    const box = $('#tab-ward');
    if (S.selected === null) {
      box.innerHTML = `<div class="empty"><div class="ic"><i class="fa-solid fa-hand-pointer"></i></div>
        <h3>Chọn một phường/xã</h3>
        <p>Nhấp vào bản đồ, chọn trong bảng xếp hạng hoặc gõ tên vào ô tìm kiếm để xem diễn biến nhiệt độ bề mặt từ 2017 và kết quả dự báo.</p>
        <button class="btn" id="btnHotEmpty"><i class="fa-solid fa-fire"></i>Xem phường nóng nhất</button></div>`;
      $('#btnHotEmpty')?.addEventListener('click', () => $('#kpiHot').click());
      return;
    }
    const p = S.wards.features[S.selected].properties;
    let d = S.wardCache.get(p.ma_xa);
    if (!d) {
      box.innerHTML = `<div class="empty"><div class="ic"><i class="fa-solid fa-circle-notch fa-spin"></i></div><h3>${esc(p.loai)} ${esc(p.ten_xa)}</h3><p>Đang tải số liệu…</p></div>`;
      try { d = await api(`/ward/${encodeURIComponent(p.ma_xa)}`); S.wardCache.set(p.ma_xa, d); }
      catch (e) { box.innerHTML = `<div class="empty"><h3>Không tải được số liệu</h3><p>${esc(e.message)}</p></div>`; return; }
      if (S.wards.features[S.selected]?.properties.ma_xa !== p.ma_xa) return;
    }
    const tr = d.xu_huong?.LST;
    const mua = d.theo_mua?.LST || {};
    const runR = S.mode === 'run' ? run() : bestRun();
    const fc = d.du_bao?.[runR?.ma_phien] || [];
    const fill = (S.fillRun && d.du_bao?.[S.fillRun.ma_phien]) || [];
    const hasData = d.series.LST.length > 0;
    box.innerHTML = `
      <button class="mini-btn back" id="wBack" type="button"><i class="fa-solid fa-arrow-left"></i>Về xếp hạng</button>
      <div class="w-head">
        <div class="ic" id="wIc"><i class="fa-solid fa-location-dot"></i></div>
        <div style="min-width:0">
          <h3>${esc(p.loai)} ${esc(p.ten_xa)}</h3>
          <p>${esc(p.khu_vuc)} · mã ${esc(p.ma_xa)}</p>
        </div>
        <div class="acts">
          <button class="icon-btn" id="wFly" title="Phóng tới phường này"><i class="fa-solid fa-magnifying-glass-location"></i></button>
          <button class="icon-btn" id="w3d" title="Xem 3D (nâng phường lên)"><i class="fa-solid fa-cube"></i></button>
          <button class="icon-btn" id="wCsv" title="Tải chuỗi số liệu CSV"><i class="fa-solid fa-download"></i></button>
        </div>
      </div>
      ${hasData ? `
      <div class="w-kpis">
        <div class="w-kpi"><div class="k" id="wNowK">${esc(frameShort())}</div><div class="v" id="wNow">–</div><div class="s" id="wNowS">&nbsp;</div></div>
        <div class="w-kpi"><div class="k">Xếp hạng nóng</div><div class="v" id="wRank">–</div><div class="s" id="wRankS">trong toàn TP</div></div>
        <div class="w-kpi"><div class="k">Xu hướng ${kyY(FIRST_KY())}–${String(kyY(LST.gee.at(-1).ky)).slice(2)}</div><div class="v ${tr?.do_doc_nam > 0 ? 'up' : 'down'}">${tr ? signed(tr.do_doc_nam, 2) : '–'}<small> °C/năm</small></div><div class="s">${tr ? `hồi quy ${tr.so_thang} tháng có ảnh` : ''}</div></div>
      </div>
      <div class="sec-h">Diễn biến LST theo tháng <span>dải mờ: 10–90% pixel · chấm vàng: nội suy</span></div>
      <div class="chart-box lg"><canvas id="cWard"></canvas></div>
      <div class="w-kpis" style="margin-top:10px">
        <div class="w-kpi"><div class="k">TB mùa khô</div><div class="v">${fmt(mua['Mùa khô'], 1)}<small> °C</small></div><div class="s">tháng 12–4</div></div>
        <div class="w-kpi"><div class="k">TB mùa mưa</div><div class="v">${fmt(mua['Mùa mưa'], 1)}<small> °C</small></div><div class="s">tháng 5–11</div></div>
        <div class="w-kpi"><div class="k">Chênh mùa</div><div class="v">${isNum(mua['Mùa khô']) && isNum(mua['Mùa mưa']) ? signed(mua['Mùa khô'] - mua['Mùa mưa'], 1) : '–'}<small> °C</small></div><div class="s">khô − mưa</div></div>
      </div>
      <div class="sec-h">Cây xanh và khô hạn <span>NDVI · TVDI trung bình phường</span></div>
      <div class="chart-box sm"><canvas id="cWardEnv"></canvas></div>
      <p class="note">LST thường tăng khi NDVI (mảng xanh) giảm và TVDI (khô hạn) tăng.</p>` : `
      <div class="callout warn"><b>Không có dữ liệu ảnh.</b> ${esc(p.loai)} ${esc(p.ten_xa)} nằm ngoài vùng phủ ảnh Google Earth Engine nên chưa có số liệu LST.</div>`}
      ${S.point && S.point.ward?.ma_xa === p.ma_xa ? `
      <div class="sec-h">Tại điểm đã chọn <span>ô 480 m gần nhất · ${S.point.vi_do.toFixed(4)}, ${S.point.kinh_do.toFixed(4)}</span></div>
      <div class="chart-box sm"><canvas id="cPoint"></canvas></div>` : ''}
      <div class="sec-h">Thông tin hành chính</div>
      <table class="info-t">
        <tr><td>Loại đơn vị</td><td>${esc(p.loai)}</td></tr>
        <tr><td>Diện tích</td><td>${fmt(p.dtich_km2, 2)} km²</td></tr>
        <tr><td>Dân số</td><td>${isNum(p.dan_so) ? (+p.dan_so).toLocaleString('vi-VN') + ' người' : '–'}</td></tr>
        <tr><td>Mật độ</td><td>${isNum(p.matdo_km2) ? Math.round(p.matdo_km2).toLocaleString('vi-VN') + ' người/km²' : '–'}</td></tr>
        <tr><td>Số ô lưới 480 m</td><td>${p.so_o}</td></tr>
        <tr><td>Hình thành từ</td><td>${esc(p.sap_nhap || '–')}</td></tr>
        <tr><td>Trụ sở</td><td>${esc(p.tru_so || '–')}</td></tr>
      </table>`;
    box.classList.remove('anim'); void box.offsetWidth; box.classList.add('anim');
    $('#wBack').onclick = () => showTab('overview');
    $('#wFly').onclick = () => selectWard(S.selected, { fly: true });
    $('#w3d').onclick = () => { bus.emit('open3d', S.selected); };
    $('#wCsv').onclick = () => {
      const rows = ['thang,nguon,chi_so,tb,p10,p90'];
      for (const k of ['LST', 'NDVI', 'TVDI']) d.series[k].forEach((x) => rows.push([kyShort(x.ky), 'GEE', k, x.tb, x.p10 ?? '', x.p90 ?? ''].join(',')));
      for (const [pid, arr] of Object.entries(d.du_bao)) {
        const rr = S.meta.runs.find((x) => x.ma_phien === +pid);
        arr.forEach((x) => rows.push([kyShort(x.ky), `${rr?.ma_loai}:${rr?.ma_mo_hinh}:${x.tap || ''}`, 'LST', x.tb, x.p10, x.p90].join(',')));
      }
      download(`lst_${p.ma_xa}_${fold(p.ten_xa).replace(/\s+/g, '_')}.csv`, '﻿' + rows.join('\n'), 'text/csv');
    };
    if (!hasData) return;
    updateWardLive();

    // Biểu đồ chuỗi tháng: GEE + dải p10–p90 + nội suy + dự báo phiên đang chọn
    const lastKy = Math.max(d.series.LST.at(-1)?.ky || 0, fc.at(-1)?.ky || 0);
    const axis = monthAxis(Math.min(FIRST_KY(), d.series.LST[0]?.ky || 999999), lastKy);
    const at = (arr, key) => { const m = new Map(arr.map((x) => [x.ky, x[key]])); return axis.map((k) => m.get(k) ?? null); };
    chart('cWard', {
      type: 'line',
      data: {
        labels: axis.map(kyShort),
        datasets: [
          { label: 'P90', data: at(d.series.LST, 'p90'), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(239,68,68,.12)', spanGaps: true },
          { label: 'P10', data: at(d.series.LST, 'p10'), borderWidth: 0, pointRadius: 0, fill: false, spanGaps: true },
          { label: 'GEE (TB phường)', data: at(d.series.LST, 'tb'), borderColor: '#dc2626', backgroundColor: '#dc2626', borderWidth: 2, pointRadius: 2.2, tension: 0.25, spanGaps: true },
          { label: 'Nội suy', data: at(fill, 'tb'), borderColor: '#d97706', backgroundColor: 'rgba(0,0,0,0)', borderWidth: 1.5, pointRadius: 2.6, pointStyle: 'circle', showLine: false },
          { label: runR ? runR.ten_mo_hinh : 'Dự báo', data: at(fc, 'tb'), borderColor: '#4f46e5', backgroundColor: '#4f46e5', borderDash: [6, 4], borderWidth: 2, pointRadius: 2.2, tension: 0.25, spanGaps: true },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { filter: (it) => !it.text.startsWith('P') } },
          tooltip: { filter: (it) => it.raw !== null && !it.dataset.label.startsWith('P'), callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } },
          nowLine: { index: axis.indexOf(S.ky) },
        },
        scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 14 }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } },
      },
      plugins: [nowLine],
    });
    const env = monthAxis(Math.min(d.series.NDVI[0]?.ky || 999999, d.series.TVDI[0]?.ky || 999999, FIRST_KY()), Math.max(d.series.NDVI.at(-1)?.ky || 201701, d.series.TVDI.at(-1)?.ky || 201701));
    const at2 = (arr) => { const m = new Map(arr.map((x) => [x.ky, x.tb])); return env.map((k) => m.get(k) ?? null); };
    chart('cWardEnv', {
      type: 'line',
      data: {
        labels: env.map(kyShort),
        datasets: [
          { label: 'NDVI', data: at2(d.series.NDVI), borderColor: '#16a34a', backgroundColor: '#16a34a', pointRadius: 1.5, borderWidth: 1.8, spanGaps: true, yAxisID: 'y' },
          { label: 'TVDI', data: at2(d.series.TVDI), borderColor: '#d97706', backgroundColor: '#d97706', pointRadius: 1.5, borderWidth: 1.8, spanGaps: true, yAxisID: 'y' },
        ],
      },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 14 }, grid: { display: false } }, y: { suggestedMin: 0, suggestedMax: 0.8 } } },
    });
    if (S.point && S.point.ward?.ma_xa === p.ma_xa) {
      const pt = S.point;
      const pf = pt.du_bao?.[runR?.ma_phien] || [];
      const pAxis = monthAxis(Math.min(pt.series.LST[0]?.[0] || 999999, FIRST_KY()), Math.max(pt.series.LST.at(-1)?.[0] || 201701, pf.at(-1)?.[0] || 201701));
      const pm = (arr) => { const m = new Map(arr); return pAxis.map((k) => m.get(k) ?? null); };
      chart('cPoint', {
        type: 'line',
        data: {
          labels: pAxis.map(kyShort),
          datasets: [
            { label: 'GEE tại ô', data: pm(pt.series.LST), borderColor: SET.theme() === 'dark' ? '#e2e8f0' : '#0f172a', backgroundColor: SET.theme() === 'dark' ? '#e2e8f0' : '#0f172a', pointRadius: 2, borderWidth: 1.6, spanGaps: true },
            { label: 'Dự báo tại ô', data: pm(pf), borderColor: '#4f46e5', backgroundColor: '#4f46e5', borderDash: [5, 4], pointRadius: 2, borderWidth: 1.6, spanGaps: true },
          ],
        },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 1)} °C` } }, nowLine: { index: pAxis.indexOf(S.ky) } }, scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 14 }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } } },
        plugins: [nowLine],
      });
    }
  }
  /** Cập nhật nhanh các số liệu phụ thuộc thời gian mà không vẽ lại cả tab */
  function updateWardLive() {
    if (S.selected === null || !$('#wNow')) return;
    const v = S.V[S.selected];
    const err = errMode();
    const lv = err ? null : levelOf(v);
    const src = S.mode === 'day' ? 'giả lập' : S.mode === 'gee' ? (isFill(S.ky) ? 'nội suy' : 'GEE') : (S.cmp === 'obs' && hasObs(S.ky) ? 'GEE' : run()?.ma_mo_hinh || '');
    $('#wNowK').textContent = `${frameShort()} · ${src}`;
    animateNumber($('#wNow'), v, err ? 2 : 1, err ? ' <small>°C sai số</small>' : ' <small>°C</small>');
    $('#wNowS').textContent = lv ? lv.ten : (isNum(v) ? '' : 'không có số liệu');
    const ic = $('#wIc');
    if (ic) ic.style.background = lv ? lv.mau : 'linear-gradient(135deg,#2563eb,#4f46e5)';
    const rk = rankOf(S.selected);
    $('#wRank').innerHTML = rk ? `${rk.r}<small> / ${rk.n}</small>` : '–';
    for (const id of ['cWard', 'cPoint']) {
      if (!charts[id]) continue;
      charts[id].options.plugins.nowLine = { index: charts[id].data.labels.indexOf(kyShort(S.ky)) };
      charts[id].update('none');
    }
  }

  // ───────────────────────── Tab: Mô hình ─────────────────────────
  const FEAT = {
    lst_khi_hau_cung_thang: 'LST khí hậu cùng tháng', lst_tb_o: 'LST trung bình của ô', bien_do_mua_o: 'Biên độ mùa của ô',
    di_thuong_lan_gan_nhat: 'Dị thường lần gần nhất', so_thang_tu_lan_gan_nhat: 'Số tháng từ lần gần nhất', di_thuong_tb_12_thang: 'Dị thường TB 12 tháng',
    di_thuong_tp_gan_nhat: 'Dị thường toàn TP gần nhất', di_thuong_tp_3_lan: 'Dị thường TP 3 lần gần nhất', di_thuong_rieng_o: 'Dị thường riêng của ô',
    di_thuong_lan_can_5x5: 'Dị thường 5×5 ô lân cận', xu_the_o_nam: 'Xu thế nóng lên của ô', xu_the_dong_gop: 'Đóng góp xu thế',
    ndvi_lech_tb: 'NDVI lệch trung bình', ndvi_khi_hau_cung_thang: 'NDVI khí hậu cùng tháng', tvdi_lech_tb: 'TVDI lệch trung bình',
    so_nam_khi_hau: 'Số năm khí hậu', sin_thang: 'Mùa (sin tháng)', cos_thang: 'Mùa (cos tháng)', tam_du_bao: 'Tầm dự báo (tháng)',
  };
  function renderModelTab() {
    const box = $('#tab-model');
    const runs = S.meta.runs.filter((r) => r.ma_loai === 'MO_HINH');
    const sims = S.meta.runs.filter((r) => r.ma_loai === 'GIA_LAP');
    if (!runs.length) { box.innerHTML = '<div class="empty"><h3>Chưa có kết quả mô hình</h3><p>Chạy <code>python database/etl/du_bao_lst.py</code> để huấn luyện và ghi kết quả.</p></div>'; return; }
    const best = bestRun();
    const cur = run()?.ma_loai === 'MO_HINH' ? run() : best;
    const testMonths = cur.months.filter((m) => m.tap === 'test').map((m) => kyShort(m.ky));
    const futMonths = cur.months.filter((m) => m.tap === 'future').map((m) => kyShort(m.ky));
    const imp = cur.tham_so?.muc_do_quan_trong;
    const base = runs.find((r) => r.ma_mo_hinh === 'KHI_HAU');
    const gain = base && best ? (1 - best.metrics.test?.rmse / base.metrics.test?.rmse) * 100 : null;
    const ens = runs.find((r) => r.ma_mo_hinh === 'ENSEMBLE');
    const fr = S.fillRun, kc = fr?.tham_so?.kiem_chung_giau_tung_thang;
    box.innerHTML = `
      <div class="callout info"><b>Bài toán:</b> dùng ảnh GEE <b>thật</b> đến hết tháng trước để dự báo LST <b>từng ô 480 m</b> cho <b>12 tháng tới</b>.
        Huấn luyện 2018–2024 · kiểm định 2025 (chọn mô hình) · kiểm tra: dữ liệu đến 12/2025 → dự báo ${testMonths[0] || '1/2026'}–${testMonths.at(-1) || ''} · tương lai: ${futMonths[0] || ''}–${futMonths.at(-1) || ''}.</div>
      ${best ? `<div class="w-kpis" style="margin-top:12px">
        <div class="w-kpi"><div class="k">Mô hình chọn</div><div class="v" style="font-size:15px">${esc(best.ten_mo_hinh)}</div><div class="s">thấp nhất RMSE kiểm định</div></div>
        <div class="w-kpi"><div class="k">RMSE kiểm tra</div><div class="v">${fmt(best.metrics.test?.rmse, 2)}<small> °C</small></div><div class="s">khí hậu: ${fmt(base?.metrics.test?.rmse, 2)} °C</div></div>
        <div class="w-kpi"><div class="k">Tốt hơn đường cơ sở</div><div class="v ${gain > 0 ? 'down' : 'up'}">${gain === null ? '–' : signed(gain, 0) + '%'}</div><div class="s">giảm sai số RMSE</div></div>
      </div>` : ''}
      <div class="sec-h">So sánh các mô hình <span>nhấp để xem trên bản đồ</span></div>
      <div style="overflow-x:auto"><table class="tbl" id="mTbl">
        <thead><tr><th>Mô hình</th><th title="RMSE tập kiểm định 2025 (dùng để chọn mô hình)">RMSE val</th><th>MAE</th><th>RMSE</th><th>R²</th><th title="R² sau khi bỏ trung bình toàn TP của từng tháng">R² KG</th></tr></thead>
        <tbody>${runs.map((r) => {
          const t = r.metrics.test || {}, v = r.metrics.val || {};
          return `<tr class="pick${r.ma_phien === cur.ma_phien ? ' on' : ''}" data-id="${r.ma_phien}">
            <td><b>${esc(r.ten_mo_hinh)}</b>${r === best ? ' <span class="chip best">chọn</span>' : ''}<span class="grp">${esc(r.nhom)}</span></td>
            <td class="${r === best ? 'good' : ''}">${fmt(v.rmse, 2)}</td><td>${fmt(t.mae, 2)}</td><td>${fmt(t.rmse, 2)}</td><td>${fmt(t.r2, 3)}</td><td>${fmt(r.tham_so?.r2_khong_gian_test, 3)}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="note">MAE, RMSE (°C), R² tính trên từng ô có ảnh GEE của tập kiểm tra 2026 (${(runs[0].metrics.test?.n || 0).toLocaleString('vi-VN')} giá trị). Mô hình được <b>chọn theo tập kiểm định 2025</b> để không “nhìn trộm” tập kiểm tra. <b>R² KG</b> (không gian) cho biết mô hình dự báo đúng chỗ nào nóng hơn, chỗ nào mát hơn.</p>
      ${ens?.tham_so?.thanh_phan ? `<div class="callout"><b><i class="fa-solid fa-layer-group"></i> Tổ hợp AI</b> = ${Object.values(ens.tham_so.thanh_phan).map((x) => `${esc(x.ten)} (${fmt(x.trong_so * 100, 0)}%)`).join(' + ')} · trọng số ∝ 1/RMSE² trên tập kiểm định.</div>` : ''}
      <div class="sec-h">RMSE theo tập dữ liệu <span>°C · thấp hơn là tốt hơn</span></div>
      <div class="chart-box"><canvas id="cRmse"></canvas></div>
      <div class="sec-h">Sai số theo tầm dự báo <span>${esc(cur.ten_mo_hinh)} · RMSE °C theo số tháng tới</span></div>
      <div class="chart-box sm"><canvas id="cHorizon"></canvas></div>
      <div class="sec-h">Thực tế và dự báo · ${esc(cur.ten_mo_hinh)} <span>mẫu ô của tập kiểm tra</span></div>
      <div class="chart-box lg"><canvas id="cScatter"></canvas></div>
      ${imp ? `<div class="sec-h">Mức độ quan trọng của biến <span>${esc(cur.ten_mo_hinh)}</span></div>
      <div class="bars">${Object.entries(imp).slice(0, 8).map(([k, v], i, arr) => `<div class="b"><span title="${esc(k)}">${esc(FEAT[k] || k)}</span><i style="width:${arr[0][1] ? v / arr[0][1] * 100 : 0}%"></i><b>${fmt(v * 100, 1)}%</b></div>`).join('')}</div>` : ''}
      ${kc ? `<div class="callout fill" style="margin-top:14px"><b><i class="fa-solid fa-wand-sparkles"></i> Lấp ${fr.months.length} tháng thiếu ảnh</b><br>${esc(fr.mo_ta || '')}
        <table class="tbl" style="margin-top:8px"><thead><tr><th>Cách ước tính (giấu từng tháng có ảnh)</th><th>RMSE</th><th>MAE</th></tr></thead><tbody>
        <tr><td><b>Kết hợp theo mùa (đang dùng)</b></td><td class="good">${fmt(kc.ket_hop_theo_mua?.rmse, 2)}</td><td>${fmt(kc.ket_hop_theo_mua?.mae, 2)}</td></tr>
        <tr><td>Chỉ nội suy tuyến tính</td><td>${fmt(kc.noi_suy_tuyen_tinh?.rmse, 2)}</td><td>${fmt(kc.noi_suy_tuyen_tinh?.mae, 2)}</td></tr>
        <tr><td>Chỉ khí hậu cùng tháng</td><td>${fmt(kc.chi_khi_hau?.rmse, 2)}</td><td>${fmt(kc.chi_khi_hau?.mae, 2)}</td></tr></tbody></table></div>` : ''}
      <div class="sec-h">Tải kết quả GeoTIFF <span>${esc(cur.ten_mo_hinh)} · lưới 480 m · EPSG:32648</span></div>
      ${S.me && S.me.role !== 'admin' ? '<p class="note"><i class="fa-solid fa-lock"></i> Tải GeoTIFF dành cho quản trị viên.</p>' : `<div class="dl">${cur.months.map((m) => `<a class="btn" href="${esc(m.tif)}" download title="${TAP_TEXT[m.tap] || ''}"><i class="fa-solid fa-file-arrow-down"></i>${esc(m.tif.split('/').pop())}</a>`).join('')}</div>`}
      ${sims.map((s) => `<div class="callout sim" style="margin-top:14px"><b><i class="fa-solid fa-flask"></i> ${esc(s.ten)}</b><br>
        ${esc(s.tham_so?.kich_ban || '')} · ${(s.tham_so?.so_o_tac_dong || 0).toLocaleString('vi-VN')} ô chịu tác động ·
        thay đổi LST trung bình toàn TP <b>${signed(s.tham_so?.chenh_lech_tb_c, 2)} °C</b>. ${esc(s.mo_ta || '')}
        <div style="margin-top:8px"><button class="btn" data-sim="${s.ma_phien}"><i class="fa-solid fa-map"></i>Xem trên bản đồ</button></div></div>`).join('')}`;
    box.classList.remove('anim'); void box.offsetWidth; box.classList.add('anim');
    $$('#mTbl tr.pick').forEach((tr) => tr.addEventListener('click', () => chooseRun(+tr.dataset.id)));
    $$('[data-sim]', box).forEach((b) => b.addEventListener('click', () => chooseRun(+b.dataset.sim)));
    chart('cRmse', {
      type: 'bar',
      data: {
        labels: runs.map((r) => r.ten_mo_hinh),
        datasets: [
          { label: 'Huấn luyện', data: runs.map((r) => r.metrics.train?.rmse), backgroundColor: '#cbd5e1', borderRadius: 4 },
          { label: 'Kiểm định 2025', data: runs.map((r) => r.metrics.val?.rmse), backgroundColor: '#93c5fd', borderRadius: 4 },
          { label: 'Kiểm tra 2026', data: runs.map((r) => r.metrics.test?.rmse), backgroundColor: '#4f46e5', borderRadius: 4 },
        ],
      },
      options: { scales: { x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 0, autoSkip: false, font: { size: 9.5 } } }, y: { beginAtZero: true } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } } } },
    });
    const bh = cur.tham_so?.rmse_theo_tam, bb = base?.tham_so?.rmse_theo_tam;
    if (bh) {
      chart('cHorizon', {
        type: 'line',
        data: {
          labels: bh.val.map((_, k) => `+${k + 1}`),
          datasets: [
            { label: 'Kiểm định 2025', data: bh.val, borderColor: '#2563eb', backgroundColor: '#2563eb', pointRadius: 2.5, tension: 0.3 },
            { label: 'Kiểm tra 2026', data: bh.test, borderColor: '#4f46e5', backgroundColor: '#4f46e5', pointRadius: 2.5, tension: 0.3, spanGaps: true },
            ...(bb ? [{ label: 'Khí hậu (kiểm tra)', data: bb.test, borderColor: '#94a3b8', borderDash: [4, 3], pointRadius: 0, tension: 0.3, spanGaps: true }] : []),
          ],
        },
        options: { interaction: { mode: 'index', intersect: false }, scales: { x: { title: { display: true, text: 'tháng tới' }, grid: { display: false } }, y: { beginAtZero: false } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } } } },
      });
    }
    api(`/compare?phien=${cur.ma_phien}`).then((cmp) => {
      if (!$('#cScatter')) return;
      const months = [...new Set(cmp.diem.map((x) => x[0]))];
      const cols = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#be185d', '#65a30d'];
      const all = cmp.diem.flatMap((x) => [x[1], x[2]]);
      const lo = Math.floor(Math.min(...all)), hi = Math.ceil(Math.max(...all));
      chart('cScatter', {
        type: 'scatter',
        data: {
          datasets: [
            ...months.map((m, k) => ({ label: kyShort(m), data: cmp.diem.filter((x) => x[0] === m).map((x) => ({ x: x[1], y: x[2] })), backgroundColor: cols[k % cols.length] + '55', pointRadius: 1.6, borderWidth: 0 })),
            { label: 'y = x', type: 'line', data: [{ x: lo, y: lo }, { x: hi, y: hi }], borderColor: SET.theme() === 'dark' ? '#e2e8f0' : '#0f172a', borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 },
          ],
        },
        options: {
          animation: false,
          scales: { x: { min: lo, max: hi, title: { display: true, text: 'GEE thực tế (°C)' } }, y: { min: lo, max: hi, title: { display: true, text: 'Dự báo (°C)' } } },
          plugins: { tooltip: { callbacks: { label: (c) => `GEE ${fmt(c.raw.x, 1)}° · dự báo ${fmt(c.raw.y, 1)}°` } } },
        },
      });
    }).catch((e) => toast('Không tải được dữ liệu đối chiếu: ' + e.message, 'err'));
  }

  // ───────────────────────── Tab: Thống kê ─────────────────────────
  let statsData = null;
  async function renderStatsTab() {
    const box = $('#tab-stats');
    if (!statsData) {
      box.innerHTML = '<div class="empty"><div class="ic"><i class="fa-solid fa-circle-notch fa-spin"></i></div><p>Đang tổng hợp thống kê…</p></div>';
      try { statsData = await api('/stats?chi_so=LST'); } catch (e) { box.innerHTML = `<div class="empty"><h3>Lỗi thống kê</h3><p>${esc(e.message)}</p></div>`; return; }
    }
    const st = statsData;
    const r = (S.mode === 'run' ? run() : null) || bestRun();
    const fc = st.city_runs[r?.ma_phien] || [];
    const fl = (S.fillRun && st.city_runs[S.fillRun.ma_phien]) || [];
    const lastKy = Math.max(st.city.at(-1)?.ky || 0, fc.at(-1)?.ky || 0);
    const axis = monthAxis(Math.min(st.city[0]?.ky || 999999, fl[0]?.ky || 999999), lastKy);
    const mp = (arr) => { const m = new Map(arr.map((x) => [x.ky, x.tb])); return axis.map((k) => m.get(k) ?? null); };
    const bandLo = axis.map((k) => { const b = runBand(k, r); return b ? b[0] : null; });
    const bandHi = axis.map((k) => { const b = runBand(k, r); return b ? b[1] : null; });
    const regions = Object.keys(st.nam_khu_vuc);
    const years = [...new Set(Object.values(st.nam_khu_vuc).flat().map((x) => x.nam))].sort();
    const vals = [...S.V].filter(isNum);
    const err = errMode();
    const binLo = err ? -6 : Math.floor(Math.min(...vals)), binHi = err ? 6 : Math.ceil(Math.max(...vals));
    const bins = []; for (let b = binLo; b < binHi; b++) bins.push(b);
    const hist = bins.map((b) => vals.filter((v) => v >= b && v < b + 1).length);
    const up = st.xu_huong.slice(0, 8), down = st.xu_huong.slice(-5).reverse();
    const y0 = kyY(st.city[0]?.ky || 201701), y1 = kyY(st.city.at(-1)?.ky || 202601);
    box.innerHTML = `
      <div class="sec-h">LST trung bình toàn thành phố <span>theo tháng · °C · dải: khoảng tin cậy 80%</span></div>
      <div class="chart-box lg"><canvas id="sCity"></canvas></div>
      <div class="sec-h">Theo khu vực cũ <span>trung bình năm (ảnh GEE)</span></div>
      <div class="chart-box"><canvas id="sRegion"></canvas></div>
      <div class="sec-h">Mùa khô và mùa mưa <span>trung bình các phường</span></div>
      <div class="chart-box"><canvas id="sSeason"></canvas></div>
      <div class="sec-h">Phân bố LST các phường · ${esc(frameShort())} <span>${err ? 'sai số' : 'số phường theo khoảng 1 °C'}</span></div>
      <div class="chart-box sm"><canvas id="sHist"></canvas></div>
      <div class="sec-h">Nóng lên nhanh nhất <span>°C/năm · hồi quy ${y0}–${y1}</span></div>
      <div class="bars" id="sUp">${up.map((x) => `<div class="b"><span>${esc(x.ten)}</span><i style="width:${clamp(x.slope / (up[0].slope || 1), 0.03, 1) * 100}%;background:linear-gradient(90deg,#fb923c,#dc2626)"></i><b>${signed(x.slope, 2)}</b></div>`).join('')}</div>
      <div class="sec-h">Ít tăng nhất / đang giảm</div>
      <div class="bars">${down.map((x) => `<div class="b"><span>${esc(x.ten)}</span><i style="width:${clamp(Math.abs(x.slope) / (Math.abs(down[0].slope) || 1), 0.03, 1) * 100}%;background:linear-gradient(90deg,#60a5fa,#2563eb)"></i><b>${signed(x.slope, 2)}</b></div>`).join('')}</div>
      <p class="note">Xu hướng tính bằng hàm <code>regr_slope</code> trong view <code>v_xu_huong_phuong</code> trên các tháng có ảnh GEE thật (không dùng tháng nội suy).</p>`;
    box.classList.remove('anim'); void box.offsetWidth; box.classList.add('anim');
    $$('#sUp .b').forEach((b, k) => b.addEventListener('click', () => { const i = wardIndex.get(up[k].ma_xa); if (i !== undefined) selectWard(i, { fly: true }); }));
    chart('sCity', {
      type: 'line',
      data: {
        labels: axis.map(kyShort),
        datasets: [
          { label: 'Khoảng 80% (cao)', data: bandHi, borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(79,70,229,.14)', spanGaps: false },
          { label: 'Khoảng 80% (thấp)', data: bandLo, borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false },
          { label: 'GEE hiện trạng', data: mp(st.city), borderColor: '#dc2626', backgroundColor: '#dc2626', pointRadius: 2.2, borderWidth: 2, spanGaps: true, tension: 0.25 },
          { label: 'Nội suy', data: mp(fl), borderColor: '#d97706', backgroundColor: 'rgba(0,0,0,0)', pointRadius: 2.4, borderWidth: 1.4, showLine: false },
          { label: r ? r.ten : 'Dự báo', data: mp(fc), borderColor: '#4f46e5', backgroundColor: '#4f46e5', borderDash: [6, 4], pointRadius: 2.2, borderWidth: 2, spanGaps: true, tension: 0.25 },
        ],
      },
      options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { filter: (it) => !it.text.startsWith('Khoảng') } }, nowLine: { index: axis.indexOf(S.ky) }, tooltip: { filter: (it) => it.raw !== null, callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } } }, scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkipPadding: 14 }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } } },
      plugins: [nowLine],
    });
    const rc = { 'TP.HCM cũ': '#dc2626', 'Bình Dương cũ': '#d97706', 'Bà Rịa – Vũng Tàu cũ': '#0891b2' };
    chart('sRegion', {
      type: 'bar',
      data: { labels: years, datasets: regions.map((k) => ({ label: k, data: years.map((y) => st.nam_khu_vuc[k].find((x) => x.nam === y)?.tb ?? null), backgroundColor: rc[k] || '#64748b', borderRadius: 4 })) },
      options: { scales: { x: { grid: { display: false } }, y: { beginAtZero: false, suggestedMin: 30, ticks: { callback: (v) => v + '°' } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } } } },
    });
    const sy = [...new Set(st.mua.map((x) => x.nam))];
    chart('sSeason', {
      type: 'bar',
      data: {
        labels: sy,
        datasets: [
          { label: 'Mùa khô', data: sy.map((y) => st.mua.find((x) => x.nam === y && x.mua === 'Mùa khô')?.tb ?? null), backgroundColor: '#f59e0b', borderRadius: 4 },
          { label: 'Mùa mưa', data: sy.map((y) => st.mua.find((x) => x.nam === y && x.mua === 'Mùa mưa')?.tb ?? null), backgroundColor: '#3b82f6', borderRadius: 4 },
        ],
      },
      options: { scales: { x: { grid: { display: false } }, y: { beginAtZero: false, suggestedMin: 30, ticks: { callback: (v) => v + '°' } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } } } },
    });
    chart('sHist', {
      type: 'bar',
      data: { labels: bins.map((b) => `${b}–${b + 1}`), datasets: [{ label: 'Số phường/xã', data: hist, backgroundColor: bins.map((b) => css(err ? errAt(b + 0.5) : colorAt(b + 0.5))), borderRadius: 3 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, font: { size: 9.5 } } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  }

  // ───────────────────────── Tab: Dự báo (12 tháng · 7 ngày · các chế độ dự báo) ─────────────────────────
  // Chuẩn đề tài: AI + Landsat → dự báo THEO THÁNG (12 tháng); theo ngày (7 ngày) là giả lập từ dự báo tháng.
  // Các chế độ: AI tốt nhất · Tổ hợp AI · mô hình AI khác · khí hậu nhiều năm (mốc so sánh) · kịch bản phủ xanh · theo ngày.
  if (!S.fcView) S.fcView = 'month';
  function fcModes() {
    const runs = S.meta.runs;
    const best = bestRun();
    const by = (code) => runs.find((r) => r.ma_loai === 'MO_HINH' && r.ma_mo_hinh === code) || null;
    const ens = by('ENSEMBLE'), clim = by('KHI_HAU');
    const sim = runs.find((r) => r.ma_loai === 'GIA_LAP') || null;
    const others = runs.filter((r) => r.ma_loai === 'MO_HINH' && r !== best && r !== ens && r !== clim);
    const tp = ens?.tham_so?.thanh_phan;
    const memb = tp && typeof tp === 'object' ? Object.values(tp).map((x) => x.ten || '').filter(Boolean) : null;
    return { best, ens, clim, sim, others, memb };
  }
  const rmseOf = (r) => r?.metrics?.test?.rmse;
  function fcModesHTML() {
    const M = fcModes();
    const cur = S.fcView === 'day' ? null : (run() || M.best)?.ma_phien;
    const card = (o) => `<button type="button" class="fc-mode${o.on ? ' on' : ''}" ${o.attr} style="--c:${o.c}" aria-pressed="${!!o.on}">
        <i class="fa-solid ${o.ic}"></i><span class="t"><b>${o.name}${o.tag ? ` <em>${o.tag}</em>` : ''}</b><small>${o.sub}</small></span>
        ${o.m ? `<span class="m">${o.m}</span>` : ''}</button>`;
    const rm = (r) => (isNum(rmseOf(r)) ? `sai số ±${fmt(rmseOf(r), 2)}°` : '');
    const out = [];
    if (M.best) out.push(card({ on: cur === M.best.ma_phien, attr: `data-run="${M.best.ma_phien}"`, ic: 'fa-brain', c: '#4f46e5', name: 'AI theo tháng', tag: 'Khuyến nghị', sub: `${esc(M.best.ten_mo_hinh)} · 12 tháng tới`, m: rm(M.best) }));
    if (M.ens) out.push(card({ on: cur === M.ens.ma_phien, attr: `data-run="${M.ens.ma_phien}"`, ic: 'fa-layer-group', c: '#0891b2', name: 'Tổ hợp AI', sub: M.memb ? esc(M.memb.join(' + ')) : 'Kết hợp các mô hình tốt nhất', m: rm(M.ens) }));
    if (M.clim) out.push(card({ on: cur === M.clim.ma_phien, attr: `data-run="${M.clim.ma_phien}"`, ic: 'fa-chart-line', c: '#64748b', name: 'Khí hậu nhiều năm', sub: 'Mốc so sánh: TB cùng tháng các năm', m: rm(M.clim) }));
    if (M.sim) out.push(card({ on: cur === M.sim.ma_phien, attr: `data-run="${M.sim.ma_phien}"`, ic: 'fa-seedling', c: '#16a34a', name: 'Kịch bản phủ xanh', sub: 'Giả định tăng cây xanh (what-if)', m: 'Kịch bản' }));
    out.push(card({ on: S.fcView === 'day', attr: 'data-fv="day"', ic: 'fa-calendar-day', c: '#db2777', name: 'Theo ngày', sub: '7 ngày tới · giả lập từ thời tiết', m: 'Giả lập' }));
    const otherOn = M.others.some((r) => r.ma_phien === cur);
    const other = M.others.length ? `<label class="fc-other${otherOn ? ' on' : ''}"><i class="fa-solid fa-sliders"></i><span>Mô hình AI khác</span>
        <select id="fcOther" class="sel"><option value="">Chọn mô hình…</option>${M.others.map((r) => `<option value="${r.ma_phien}"${r.ma_phien === cur ? ' selected' : ''}>${esc(r.ten_mo_hinh)}${isNum(rmseOf(r)) ? ` · sai số ±${fmt(rmseOf(r), 2)} °C` : ''}</option>`).join('')}</select></label>` : '';
    return `<div class="fc-modes">${out.join('')}</div>${other}`;
  }

  async function renderWeatherTab() {
    const box = $('#tab-weather');
    if (!S.meta) return;
    const hasRun = !!(run() || bestRun());
    if (!hasRun) S.fcView = 'day';
    box.innerHTML = `
      <div class="seg fc-seg" id="fcSeg" role="tablist" aria-label="Dự báo theo">
        <button type="button" data-fv="month" class="${S.fcView === 'month' ? 'on' : ''}"${hasRun ? '' : ' disabled'}><i class="fa-solid fa-calendar"></i>Theo tháng · 12 tháng</button>
        <button type="button" data-fv="day" class="${S.fcView === 'day' ? 'on' : ''}"><i class="fa-solid fa-calendar-day"></i>Theo ngày · 7 ngày</button>
      </div>
      <div class="sec-h">Chế độ dự báo <span>chọn để xem trên bản đồ</span></div>
      ${fcModesHTML()}
      <div id="fcBody" class="fc-body"><div class="empty"><div class="ic"><i class="fa-solid fa-circle-notch fa-spin"></i></div><p>Đang tải dự báo…</p></div></div>`;
    box.classList.remove('anim'); void box.offsetWidth; box.classList.add('anim');
    $('#fcSeg').onclick = (e) => {
      const b = e.target.closest('button[data-fv]');
      if (!b || b.disabled || b.dataset.fv === S.fcView) return;
      S.fcView = b.dataset.fv;
      setMode(S.fcView === 'day' ? 'day' : 'run', S.fcView === 'day' ? { day: 0 } : {});
    };
    $$('.fc-mode', box).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.fv === 'day') { S.fcView = 'day'; setMode('day', { day: 0 }); }
      else chooseRun(+b.dataset.run);
    }));
    $('#fcOther')?.addEventListener('change', (e) => { if (e.target.value) chooseRun(+e.target.value); });
    const tok = ++fcToken;
    const body = $('#fcBody');
    if (S.fcView === 'day') await renderDayView(body, tok);
    else await renderMonthView(body, tok);
  }
  let fcToken = 0;

  async function renderMonthView(body, tok) {
    const r = run() || bestRun();
    const p = S.selected !== null ? S.wards.features[S.selected].properties : null;
    try {
      const M = fcModes();
      const [ser, climSer, fillSer] = await Promise.all([
        ensureRunSeries(r.ma_phien),
        p && M.clim && M.clim !== r ? ensureRunSeries(M.clim.ma_phien).catch(() => null) : null,
        p && S.fillRun ? ensureRunSeries(S.fillRun.ma_phien).catch(() => null) : null,
      ]);
      if (tok !== fcToken) return;
      const fut = r.months.filter((m) => m.tap === 'future');
      if (!fut.length) throw new Error('Phiên dự báo này chưa có tháng tương lai.');
      const wv = (series, ky) => { const row = matrixRow(series, ky); const v = row ? row[S.selected] : null; return isNum(v) ? v : null; };
      const val = (m) => (p ? wv(ser, m.ky) : m.tb);
      const vals = fut.map(val);
      const k0 = kyIdx(fut[0].ky);
      const hist = []; for (let i = k0 - 12; i < k0; i++) hist.push(idxKy(i));
      const histV = (ky) => {
        if (p) { const o = wv(S.gee, ky); if (isNum(o)) return { v: o, fill: false }; const f = fillSer ? wv(fillSer, ky) : null; return isNum(f) ? { v: f, fill: true } : null; }
        const g = geeItem(ky); if (g) return { v: g.tb, fill: false };
        const f = fillItem(ky); return f ? { v: f.tb, fill: true } : null;
      };
      const climV = (ky) => (!M.clim || M.clim === r ? null : p ? (climSer ? wv(climSer, ky) : null) : runItem(ky, M.clim)?.tb ?? null);
      const qb = r.tham_so?.khoang_du_bao_80?.phuong;
      const band = fut.map((m, h) => (qb?.[h] && isNum(vals[h]) ? [vals[h] + qb[h][0], vals[h] + qb[h][1]] : null));
      const ok = vals.map((v, h) => ({ v, m: fut[h] })).filter((x) => isNum(x.v));
      const hot = ok.reduce((a, b) => (!a || b.v > a.v ? b : a), null);
      const cool = ok.reduce((a, b) => (!a || b.v < a.v ? b : a), null);
      const mean = ok.length ? ok.reduce((s, x) => s + x.v, 0) / ok.length : NaN;
      const hv = hist.map(histV).filter(Boolean);
      const hmean = hv.length ? hv.reduce((s, x) => s + x.v, 0) / hv.length : NaN;
      const d = mean - hmean;
      const sim = r.ma_loai === 'GIA_LAP';
      const where = p ? `${p.loai} ${p.ten_xa}` : 'Toàn thành phố';
      // các phường nóng nhất trung bình 12 tháng tới
      const idx = fut.map((m) => ser.months.indexOf(m.ky)).filter((j) => j >= 0);
      const wavg = S.wards.features.map((f, i) => { let s = 0, n = 0; idx.forEach((j) => { const v = ser.tb[j]?.[i]; if (isNum(v)) { s += v; n++; } }); return { i, v: n ? s / n : NaN, f }; }).filter((x) => isNum(x.v)).sort((a, b) => b.v - a.v);
      const top = wavg.slice(0, 6);
      const lvTop = top.length ? top[0].v : 1;
      body.innerHTML = `
        <div class="w-head"><div class="ic" style="background:linear-gradient(135deg,#4f46e5,#7c3aed)"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
          <div><h3>${esc(where)}</h3><p>${sim ? 'Kịch bản phủ xanh 12 tháng tới' : 'Dự báo LST 12 tháng tới'} · ${esc(r.ten_mo_hinh)} · <span class="chip ${sim ? 'sim' : 'run'} dot">${sim ? 'kịch bản' : 'dự báo AI'}</span></p></div></div>
        <div class="fc-months" id="fcMonths">${fut.map((m, h) => {
          const v = vals[h], lv = levelOf(v);
          return `<button type="button" class="fc-mon${S.mode === 'run' && S.ky === m.ky ? ' on' : ''}" data-ky="${m.ky}" title="${kyText(m.ky)}: ${fmt(v, 1)} °C — xem trên bản đồ">
            <span class="d">${kyM(m.ky)}/${String(kyY(m.ky)).slice(2)}</span><b style="color:${lv ? lv.mau : 'inherit'}">${fmt(v, 1)}°</b><i style="background:${css(colorAt(v))}"></i></button>`;
        }).join('')}</div>
        <div class="w-kpis fc-kpis">
          <div class="w-kpi" style="border-color:#dc2626"><div class="k">Tháng nóng nhất</div><div class="v">${hot ? fmt(hot.v, 1) : '–'}<small> °C</small></div><div class="s">${hot ? kyText(hot.m.ky) : ''}</div></div>
          <div class="w-kpi" style="border-color:#2563eb"><div class="k">Tháng mát nhất</div><div class="v">${cool ? fmt(cool.v, 1) : '–'}<small> °C</small></div><div class="s">${cool ? kyText(cool.m.ky) : ''}</div></div>
          <div class="w-kpi" style="border-color:${d > 0 ? '#f97316' : '#0891b2'}"><div class="k">So với 12 tháng qua</div><div class="v">${isNum(d) ? signed(d, 1) : '–'}<small> °C</small></div><div class="s">TB ${fmt(mean, 1)} so với ${fmt(hmean, 1)} °C</div></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="fcMap"><i class="fa-solid fa-map"></i>Xem 12 tháng trên bản đồ</button>
          <button class="btn" id="fcPlay"><i class="fa-solid fa-play"></i>Chạy lần lượt</button>
          <button class="btn" id="fcCsv"><i class="fa-solid fa-file-csv"></i>Tải CSV</button>
        </div>
        <div class="sec-h">Diễn biến LST ${p ? 'của phường' : 'toàn TP'} <span>12 tháng qua → 12 tháng tới · °C</span></div>
        <div class="chart-box lg"><canvas id="cFc"></canvas></div>
        <div class="sec-h">Phường/xã nóng nhất 12 tháng tới <span>trung bình dự báo · bấm để xem</span></div>
        <div class="bars" id="fcTop">${top.map((x) => `<div class="b" data-i="${x.i}"><span>${esc(x.f.properties.loai)} ${esc(x.f.properties.ten_xa)}</span><i style="width:${clamp((x.v - 25) / (lvTop - 25 || 1), 0.05, 1) * 100}%;background:${css(colorAt(x.v))}"></i><b>${fmt(x.v, 1)}°</b></div>`).join('')}</div>
        ${sim ? `<div class="callout sim" style="margin-top:16px"><b>Kịch bản giả định:</b> ${esc(r.mo_ta || '')}${isNum(r.tham_so?.chenh_lech_tb_c) ? ` Mức thay đổi trung bình toàn TP: <b>${signed(r.tham_so.chenh_lech_tb_c, 2)} °C</b>.` : ''}</div>`
          : `<div class="callout" style="margin-top:16px"><b>Cách dự báo:</b> ${esc(r.mo_ta || '')}${isNum(rmseOf(r)) ? ` Sai số trên ảnh thật năm 2026 (RMSE): <b>${fmt(rmseOf(r), 2)} °C</b>${M.clim && r !== M.clim && isNum(rmseOf(M.clim)) ? ` — khí hậu nhiều năm: ${fmt(rmseOf(M.clim), 2)} °C` : ''}.` : ''}</div>`}`;
      $$('#fcMonths .fc-mon').forEach((b) => b.addEventListener('click', () => goRunMonth(+b.dataset.ky)));
      $('#fcMap').onclick = () => goRunMonth(fut[0].ky);
      $('#fcPlay').onclick = async () => { await goRunMonth(fut[0].ky); play(); };
      $$('#fcTop .b').forEach((b) => b.addEventListener('click', () => selectWard(+b.dataset.i, { fly: true })));
      $('#fcCsv').onclick = () => {
        const rows = ['thang,ma_xa,ten_xa,lst_du_bao_c,mo_hinh,loai'];
        fut.forEach((m) => { const row = matrixRow(ser, m.ky); S.wards.features.forEach((f, i) => { const v = row?.[i]; if (isNum(v)) rows.push([kyShort(m.ky), f.properties.ma_xa, `"${f.properties.loai} ${f.properties.ten_xa}"`, v, `"${r.ten_mo_hinh}"`, r.ma_loai].join(',')); }); });
        download(`du_bao_12_thang_${r.ma_mo_hinh}_${fut[0].ky}.csv`, '﻿' + rows.join('\n'), 'text/csv');
      };
      const labels = [...hist, ...fut.map((m) => m.ky)].map(kyShort);
      const H = hist.length, pad = (arr) => [...new Array(H).fill(null), ...arr];
      const hObs = hist.map((k) => { const x = histV(k); return x && !x.fill ? x.v : null; });
      const hFill = hist.map((k) => { const x = histV(k); return x && x.fill ? x.v : null; });
      const lastH = hist.map(histV).filter(Boolean).at(-1);
      const fcLine = pad(vals);
      if (lastH) fcLine[H - 1] = lastH.v;                      // nối liền đường dự báo với tháng cuối đã biết
      chart('cFc', {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Khoảng 80% (cao)', data: pad(band.map((b) => (b ? b[1] : null))), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(79,70,229,.13)' },
            { label: 'Khoảng 80% (thấp)', data: pad(band.map((b) => (b ? b[0] : null))), borderWidth: 0, pointRadius: 0, fill: false },
            { label: 'Quan trắc GEE', data: [...hObs, ...new Array(fut.length).fill(null)], borderColor: '#dc2626', backgroundColor: '#dc2626', pointRadius: 2.6, borderWidth: 2, spanGaps: true, tension: 0.3 },
            { label: 'Nội suy', data: [...hFill, ...new Array(fut.length).fill(null)], borderColor: '#d97706', backgroundColor: 'rgba(0,0,0,0)', pointRadius: 3, borderWidth: 1.4, showLine: false },
            { label: r.ten_mo_hinh, data: fcLine, borderColor: sim ? '#16a34a' : '#4f46e5', backgroundColor: sim ? '#16a34a' : '#4f46e5', borderDash: [6, 4], pointRadius: 2.6, borderWidth: 2.2, spanGaps: true, tension: 0.3 },
            ...(M.clim && M.clim !== r ? [{ label: 'Khí hậu nhiều năm', data: pad(fut.map((m) => climV(m.ky))), borderColor: '#94a3b8', backgroundColor: '#94a3b8', borderDash: [2, 3], pointRadius: 0, borderWidth: 1.6, spanGaps: true, tension: 0.3 }] : []),
          ],
        },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { filter: (it) => !it.text.startsWith('Khoảng') } }, nowLine: { index: labels.indexOf(kyShort(S.ky)) }, tooltip: { filter: (it) => it.raw !== null && !it.dataset.label.startsWith('Khoảng'), callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 1)} °C` } } }, scales: { x: { ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkipPadding: 14 }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } } },
        plugins: [nowLine],
      });
    } catch (e) {
      if (tok !== fcToken) return;
      body.innerHTML = `<div class="empty"><div class="ic"><i class="fa-solid fa-triangle-exclamation"></i></div><h3>Chưa tải được dự báo 12 tháng</h3><p>${esc(e.message)}</p></div>`;
    }
  }
  /** Mở đúng tháng dự báo trên bản đồ (chuyển sang chế độ 12 tháng nếu đang ở chế độ khác) */
  async function goRunMonth(ky) {
    if (S.mode !== 'run') return setMode('run', { ky });
    const i = S.frames.indexOf(ky);
    if (i >= 0) await setFrame(i);
  }
  /** Đổi tháng/ngày trên bản đồ → đánh dấu thẻ tương ứng trong tab Dự báo mà không dựng lại cả tab */
  bus.on('frame', () => {
    if (S.tab !== 'weather' || !drawerOpen()) return;
    $$('#fcMonths .fc-mon').forEach((b) => b.classList.toggle('on', S.mode === 'run' && +b.dataset.ky === S.ky));
    $$('#tab-weather .fc-day').forEach((b) => b.classList.toggle('on', S.mode === 'day' && +b.dataset.day === S.dayI));
    const c = charts.cFc;
    if (c) { c.options.plugins.nowLine = { index: c.data.labels.indexOf(kyShort(S.ky)) }; c.update('none'); }
  });

  async function renderDayView(body, tok) {
    const p = S.selected !== null ? S.wards.features[S.selected].properties : null;
    const where = p ? `${p.loai} ${p.ten_xa}` : 'Toàn thành phố';
    try {
      const dly = await ensureDaily();
      if (tok !== fcToken) return;
      const days = dly.days;
      const wv = p ? days.map((_, i) => dly.wards[i]?.[S.selected] ?? null) : null;
      const val = (i) => (wv ? wv[i] : days[i].lst);
      body.innerHTML = `
        <div class="w-head"><div class="ic" style="background:linear-gradient(135deg,#ec4899,#f97316)"><i class="fa-solid fa-calendar-day"></i></div>
          <div><h3>${esc(where)}</h3><p>Dự báo LST 7 ngày tới · <span class="chip day dot">giả lập</span></p></div></div>
        <div class="fc-days">${days.map((x, i) => {
          const dt = dateOf(x.ngay);
          const lv = levelOf(val(i));
          const ic = (x.mua_mm || 0) > 8 ? '🌧️' : x.buc_xa > 230 ? '☀️' : x.buc_xa > 170 ? '⛅' : '🌥️';
          return `<button class="fc-day${i === 0 ? ' today' : ''}${S.mode === 'day' && S.dayI === i ? ' on' : ''}" data-day="${i}" title="Xem ngày này trên bản đồ"><div class="d">${i === 0 ? 'Hôm nay' : `${WDS[dt.getDay()]} ${dt.getDate()}/${dt.getMonth() + 1}`}</div>
            <div class="ic">${ic}</div><div class="l" style="color:${lv ? lv.mau : 'inherit'}">${fmt(val(i), 0)}°</div><div class="a">${fmt(x.t_max, 0)}°/${fmt(x.t_min, 0)}°</div></button>`;
        }).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn primary" id="dayMap"><i class="fa-solid fa-map"></i>Xem 7 ngày trên bản đồ</button>
          <button class="btn" id="dayCsv"><i class="fa-solid fa-file-csv"></i>Tải CSV</button></div>
        <div class="sec-h">LST bề mặt và nhiệt độ không khí <span>°C · dải: khoảng 80%</span></div>
        <div class="chart-box"><canvas id="cWeather"></canvas></div>
        <div class="callout" style="margin-top:16px"><b>Vì sao theo ngày là giả lập?</b> Ảnh Landsat chỉ cho LST theo tháng (16 ngày/lần, thường bị mây), nên mô hình AI dự báo <b>theo tháng</b>. LST từng ngày được <b>giả lập</b>:
          LST ngày = dự báo tháng của <b>${esc(dly.phien?.ten_mo_hinh || 'mô hình tốt nhất')}</b> + ${fmt(dly.he_so?.t_max, 1)}×(T<sub>max</sub> − T<sub>max</sub> chuẩn tháng) + ${fmt(dly.he_so?.buc_xa, 3)}×(bức xạ − TB tuần) − ${fmt(Math.abs(dly.he_so?.mua ?? 0.05), 2)}×mưa (mm).
          Thời tiết: ${esc(dly.nguon)}. ${STATIC ? '' : 'Kết quả lưu ở bảng <code>du_bao_ngay</code>.'}</div>`;
      $$('.fc-day', body).forEach((b) => b.addEventListener('click', () => { if (S.mode === 'day') setDayFrame(+b.dataset.day); else setMode('day', { day: +b.dataset.day }); }));
      $('#dayMap').onclick = () => setMode('day', { day: 0 });
      $('#dayCsv').onclick = () => {
        const rows = ['ngay,ma_xa,ten_xa,lst_ngay_c,lst_thang_c,lech_c,t_max,buc_xa_wm2,mua_mm,nguon'];
        days.forEach((d, i) => S.wards.features.forEach((f, k) => { const v = dly.wards[i]?.[k]; if (isNum(v)) rows.push([d.ngay, f.properties.ma_xa, `"${f.properties.loai} ${f.properties.ten_xa}"`, v, '', d.lech, d.t_max, d.buc_xa, d.mua_mm, 'GIA_LAP'].join(',')); }));
        download(`du_bao_7_ngay_${days[0].ngay}.csv`, '﻿' + rows.join('\n'), 'text/csv');
      };
      const off = p ? (v, i) => (isNum(v) ? v - days[i].lst + val(i) : null) : (v) => v;
      chart('cWeather', {
        type: 'line',
        data: {
          labels: days.map((x) => dayShort(x.ngay)),
          datasets: [
            { label: 'P90', data: days.map((x, i) => off(x.p90, i)), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(220,38,38,.12)' },
            { label: 'P10', data: days.map((x, i) => off(x.p10, i)), borderWidth: 0, pointRadius: 0, fill: false },
            { label: `LST ${p ? 'phường' : 'toàn TP'} (giả lập)`, data: days.map((_, i) => val(i)), borderColor: '#dc2626', backgroundColor: '#dc2626', tension: 0.35, borderWidth: 2.2, pointRadius: 3 },
            { label: 'Không khí cao nhất', data: days.map((x) => x.t_max), borderColor: '#f59e0b', borderDash: [5, 3], tension: 0.3, pointRadius: 2 },
            { label: 'Không khí thấp nhất', data: days.map((x) => x.t_min), borderColor: '#3b82f6', borderDash: [5, 3], tension: 0.3, pointRadius: 2 },
          ],
        },
        options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } }, plugins: { legend: { labels: { filter: (it) => !it.text.startsWith('P') } }, tooltip: { filter: (it) => !it.dataset.label.startsWith('P'), callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 1)} °C` } } } },
      });
    } catch (e) {
      if (tok !== fcToken) return;
      body.innerHTML = `<div class="empty"><div class="ic"><i class="fa-solid fa-wifi"></i></div><h3>Chưa tính được dự báo 7 ngày</h3><p>${esc(e.message)}</p><button class="btn" id="wxRetry"><i class="fa-solid fa-rotate"></i>Thử lại</button></div>`;
      $('#wxRetry')?.addEventListener('click', () => { S.daily = null; renderWeatherTab(); });
    }
  }
  function setDayFrame(i) { const k = clamp(i, 0, S.frames.length - 1); setFrame(k); }

  // ───────────────────────── Thanh điều hướng & ngăn kéo ─────────────────────────
  const PANE_TITLE = { overview: 'Cảnh báo & xếp hạng', ward: 'Phường/xã', model: 'Mô hình dự báo', stats: 'Thống kê', weather: 'Dự báo' };
  function showTab(name, opts = {}) {
    if (S.simple && name === 'model') name = 'overview';
    S.tab = name;
    $$('#rail button[data-pane]').forEach((b) => b.classList.toggle('on', b.dataset.pane === name && drawerOpen()));
    $$('#drawer .pane').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    $('#drTitle').textContent = PANE_TITLE[name] || '';
    if (opts.norender) return;
    if (name === 'model') renderModelTab();
    if (name === 'stats') renderStatsTab();
    if (name === 'weather') renderWeatherTab();
  }
  const drawerOpen = () => !$('#layout').classList.contains('no-drawer');
  const overlayDrawer = () => window.innerWidth <= 1100;      // màn hẹp: ngăn kéo nổi đè lên bản đồ
  function openRight() {
    if (drawerOpen()) return;
    $('#layout').classList.remove('no-drawer');
    $$('#rail button[data-pane]').forEach((b) => b.classList.toggle('on', b.dataset.pane === S.tab));
    afterLayout();
  }
  function closeDrawer() {
    $('#layout').classList.add('no-drawer');
    $$('#rail button[data-pane]').forEach((b) => b.classList.remove('on'));
    afterLayout();
  }
  function afterLayout() { if (!overlayDrawer()) setTimeout(() => { map.invalidateSize({ pan: false }); markStripes(); }, 420); }
  $('#rail').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pane]');
    if (!b) return;
    if (drawerOpen() && S.tab === b.dataset.pane) { closeDrawer(); return; }   // bấm lại mục đang mở để thu ngăn kéo
    S.tab = b.dataset.pane;
    openRight();
    showTab(b.dataset.pane);
  });
  $('#drClose').addEventListener('click', closeDrawer);
  // Điện thoại: vuốt xuống trên tay nắm để thu tấm trượt
  (function sheetSwipe() {
    let y0 = null;
    const head = $('#drawer');
    head.addEventListener('touchstart', (e) => { if (e.target.closest('.dr-grip, .dr-head')) y0 = e.touches[0].clientY; }, { passive: true });
    head.addEventListener('touchend', (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 60) closeDrawer(); y0 = null; }, { passive: true });
  })();
  window.addEventListener('resize', debounce(() => { map.invalidateSize(); buildStripes(); }, 150));

  // ───────────────────────── Chế độ & mô hình ─────────────────────────
  let modeToken = 0;
  async function setMode(mode, opts = {}) {
    stop();
    const tok = ++modeToken;                               // bấm đổi chế độ liên tiếp: chỉ lần bấm cuối có hiệu lực
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    try {
      if (mode === 'day') { busy(true, 'Đang tính dự báo 7 ngày…'); await ensureDaily(); await ensureRunSeries(S.daily.phien.ma_phien).catch(() => {}); }
      if (mode === 'run') { busy(true, 'Đang tải kết quả dự báo…'); await ensureRunSeries(S.runId); }
    } catch (e) {
      busy(false);
      if (tok === modeToken) { toast('Không tải được dữ liệu: ' + e.message, 'err'); $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode)); }
      return;
    }
    busy(false);
    if (tok !== modeToken) return;
    S.mode = mode;
    if (mode === 'run') S.fcView = 'month';
    else if (mode === 'day') S.fcView = 'day';
    $('#runPick').hidden = mode !== 'run';
    buildFrames();
    buildStripes();
    let i;
    if (mode === 'day') i = clamp(opts.day ?? 0, 0, S.frames.length - 1);
    else if (opts.ky && S.frames.includes(opts.ky)) i = S.frames.indexOf(opts.ky);
    else if (mode === 'run') { const r = run(); const f = r.months.findIndex((m) => m.tap === 'future'); i = f >= 0 ? f : 0; }
    else i = S.frames.length - 1;
    await setFrame(i);
    bus.emit('mode', mode);
    if (S.tab === 'weather' && drawerOpen()) renderWeatherTab();
  }
  async function chooseRun(id) {
    const r = S.meta.runs.find((x) => x.ma_phien === id);
    if (!r || r.ma_loai === 'NOI_SUY') return;
    // đang xem 12 tháng: giữ tháng đang xem (nếu mô hình mới có tháng đó); chế độ khác: nhảy tới tháng tương lai đầu tiên
    const keep = S.mode === 'run' && r.months.some((m) => m.ky === S.ky) ? S.ky : null;
    S.fcView = 'month';
    S.runId = id;
    $('#runSel').value = String(id);
    if (r.ma_loai === 'GIA_LAP') S.cmp = 'pred';
    busy(true, 'Đang tải kết quả ' + r.ten_mo_hinh + '…');
    try { await ensureRunSeries(id); } finally { busy(false); }
    await setMode('run', keep ? { ky: keep } : {});
    if (S.tab === 'model') renderModelTab();
    if (S.tab === 'ward') renderWardTab();
    toast(`Đang xem: ${r.ten}`, 'info', 2200);
  }
  // Bấm "12 tháng" → nhảy tới tháng dự báo tương lai đầu tiên; "Hiện trạng" → giữ tháng đang xem nếu có ảnh
  $('#modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.mode === S.mode || b.disabled) return;
    const m = b.dataset.mode;
    // máy tính + ngăn kéo đang mở: chuyển ngăn kéo sang tab Dự báo để thấy ngay số liệu 12 tháng / 7 ngày
    if (m !== 'gee' && drawerOpen() && !overlayDrawer() && S.tab !== 'weather') showTab('weather', { norender: true });
    setMode(m, m === 'gee' && S.mode !== 'day' ? { ky: S.ky } : {});
  });
  $('#runSel').addEventListener('change', (e) => chooseRun(+e.target.value));
  $('#cmpSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.cmp === S.cmp) return;
    S.cmp = b.dataset.cmp;
    $$('#cmpSeg button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });

  // Công cụ bản đồ
  const homeBounds = () => S.meta?.home || [[10.33, 106.33], [11.52, 107.6]];
  // chừa chỗ cho thẻ "Đang xem" (trái, nếu đang mở), công cụ + chú giải (phải), dock thời gian (dưới)
  const fitPad = () => (isMobile()
    ? { paddingTopLeft: [16, 70], paddingBottomRight: [16, 90] }
    : { paddingTopLeft: [S.tucked ? 40 : (window.innerWidth <= 1360 ? 320 : 350), 30], paddingBottomRight: [110, 110] });
  /** Tâm + mức zoom NGUYÊN để thấy toàn TP (ô bản đồ đúng điểm ảnh nên nét; không bị thu nhỏ thừa một mức như fitBounds) */
  function homeView() {
    const b = L.latLngBounds(homeBounds());
    const pad = fitPad();
    const snap = map.options.zoomSnap;
    map.options.zoomSnap = 0;
    let cz;
    try { cz = map._getBoundsCenterZoom(b, pad); } finally { map.options.zoomSnap = snap; }
    // chỉ làm tròn lên khi gần sát mức nguyên kế tiếp (vd. 8,99 → 9; 9,6 → 9) để TP vừa khung, không bị cắt
    const z = clamp(Math.floor(cz.zoom + 0.15), map.getMinZoom(), map.getMaxZoom());
    // dời tâm theo phần đệm (thẻ thông tin bên trái, dock bên dưới) ở đúng mức zoom đã làm tròn
    const tl = L.point(pad.paddingTopLeft), br = L.point(pad.paddingBottomRight);
    const nw = map.project(b.getNorthWest(), z), se = map.project(b.getSouthEast(), z);
    const c = nw.add(se).divideBy(2).add(br.subtract(tl).divideBy(2));
    return { center: map.unproject(c, z), zoom: z };
  }
  function flyHome(dur = 1.1) { const v = homeView(); if (motionOK()) map.flyTo(v.center, v.zoom, { duration: dur }); else map.setView(v.center, v.zoom); }
  $('#btnHome').addEventListener('click', () => flyHome());
  $('#btnZoomIn').addEventListener('click', () => map.zoomIn());
  $('#btnZoomOut').addEventListener('click', () => map.zoomOut());
  $('#btnLayers').addEventListener('click', (e) => { $('#hudRight').classList.toggle('layers-open'); e.currentTarget.classList.toggle('on', $('#hudRight').classList.contains('layers-open')); });
  $('#baseSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.base !== S.base) setBase(b.dataset.base); });
  $('#viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.view !== S.view) setView(b.dataset.view); });
  $('#opRange').addEventListener('input', (e) => {
    S.opacity = +e.target.value / 100;
    $('#opVal').textContent = e.target.value + '%';
    $('#map').style.setProperty('--fade', '0ms');
    if (S.view === 'pixel') imgLayers[imgFront]?.setOpacity(S.opacity); else styleWards();
  });
  $('#btnOutline').addEventListener('click', (e) => { S.outline = !S.outline; e.currentTarget.classList.toggle('on', S.outline); styleWards(); });
  $('#btnLocate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Trình duyệt không hỗ trợ định vị.', 'err');
    navigator.geolocation.getCurrentPosition(
      (p) => { map.flyTo([p.coords.latitude, p.coords.longitude], 13); pickPoint(p.coords.latitude, p.coords.longitude); },
      () => toast('Không lấy được vị trí. Hãy cho phép quyền định vị.', 'err'), { timeout: 8000 });
  });

  // Thời gian
  $('#tlPlay').addEventListener('click', () => (S.playing ? stop() : play()));
  $('#tlPrev').addEventListener('click', () => stepFrame(-1));
  $('#tlNext').addEventListener('click', () => stepFrame(1));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || document.body.classList.contains('mode-3d') || $('.set-overlay:not([hidden])')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1); }
    else if (e.key === ' ') { e.preventDefault(); S.playing ? stop() : play(); }
    else if (e.key === 'Escape' && S.selected !== null) { selectWard(null); clearPoint(); }
  });

  // ───────────────────────── Tìm kiếm ─────────────────────────
  const sInput = $('#searchInput'), sRes = $('#searchResults');
  let sItems = [], sActive = -1, sToken = 0;
  function renderSearch() {
    sActive = -1;
    if (!sItems.length) { sRes.innerHTML = '<div class="empty">Không tìm thấy. Thử tên phường khác hoặc nhập “vĩ độ, kinh độ”.</div>'; sRes.classList.add('open'); return; }
    let grp = '';
    sRes.innerHTML = sItems.map((it, i) => {
      const g = it.grp !== grp ? `<div class="grp">${esc(it.grp)}</div>` : '';
      grp = it.grp;
      const sw = it.kind === 'ward' && isNum(S.V?.[it.i]) ? `<i class="sw" style="background:${css(valColor(S.V[it.i]))}"></i>` : '';
      return `${g}<button data-i="${i}" role="option">${sw}<span><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></span></button>`;
    }).join('');
    sRes.classList.add('open');
  }
  const remoteSearch = debounce(async (q, tok) => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=vn&limit=6&accept-language=vi&viewbox=106.3,11.6,107.7,10.3&bounded=1`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (tok !== sToken) return;
      sItems = sItems.filter((x) => x.kind === 'ward').concat(j.map((x) => ({ kind: 'place', grp: 'Địa điểm (OpenStreetMap)', lat: +x.lat, lon: +x.lon, title: x.name || x.display_name.split(',')[0], sub: x.display_name })));
      renderSearch();
    } catch { /* bỏ qua lỗi mạng: vẫn còn kết quả phường/xã */ }
  }, 450);
  /** Danh sách sẵn khi bấm vào ô tìm kiếm: toàn bộ phường/xã, nóng nhất lên đầu theo khung đang xem */
  function listAllWards() {
    const V = S.V;
    const all = S.wards.features.map((x) => x.properties);
    all.sort((a, b) => (isNum(V?.[b.i]) ? V[b.i] : -99) - (isNum(V?.[a.i]) ? V[a.i] : -99));
    sItems = all.map((p) => ({ kind: 'ward', grp: `${all.length} phường/xã · nóng nhất trước · ${frameShort()}`, i: p.i, title: `${p.loai} ${p.ten_xa}`, sub: `${p.khu_vuc}${isNum(V?.[p.i]) ? ` · ${fmt(V[p.i], 1)} °C` : ''}`, v: V?.[p.i] }));
    renderSearch();
    sRes.scrollTop = 0;
  }
  sInput.addEventListener('input', () => {
    const q = sInput.value.trim();
    const tok = ++sToken;
    if (q.length < 2) { listAllWards(); return; }
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      let lat = +m[1], lon = +m[2];
      if (lat > 90 || (lat > 50 && lon < 50)) [lat, lon] = [lon, lat];
      sItems = [{ kind: 'coord', grp: 'Toạ độ', lat, lon, title: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, sub: 'Đi tới toạ độ và tra cứu LST' }];
      return renderSearch();
    }
    const f = fold(q);
    sItems = S.wards.features.filter((x) => fold(`${x.properties.loai} ${x.properties.ten_xa}`).includes(f) || fold(x.properties.sap_nhap).includes(f))
      .slice(0, 8).map((x) => ({ kind: 'ward', grp: 'Phường/xã (ranh giới mới)', i: x.properties.i, title: `${x.properties.loai} ${x.properties.ten_xa}`, sub: `${x.properties.khu_vuc}${isNum(S.V?.[x.properties.i]) ? ` · ${fmt(S.V[x.properties.i], 1)} °C` : ''}${fold(x.properties.sap_nhap).includes(f) && !fold(x.properties.ten_xa).includes(f) ? ' · gồm ' + x.properties.sap_nhap : ''}` }));
    renderSearch();
    if (q.length >= 3) remoteSearch(q, tok);
  });
  function chooseSearch(i) {
    const it = sItems[i];
    if (!it) return;
    sRes.classList.remove('open');
    sInput.value = it.title;
    sInput.blur();
    if (it.kind === 'ward') selectWard(it.i, { fly: true, noDrawer: isMobile() });
    else { map.flyTo([it.lat, it.lon], 14, { duration: motionOK() ? 1 : 0 }); pickPoint(it.lat, it.lon, { fly: false }); }
  }
  sInput.addEventListener('keydown', (e) => {
    const btns = $$('button', sRes);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!btns.length) return;
      sActive = (sActive + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, k) => b.classList.toggle('active', k === sActive));
    } else if (e.key === 'Enter') { if (btns.length) chooseSearch(sActive >= 0 ? +btns[sActive].dataset.i : +btns[0].dataset.i); }
    else if (e.key === 'Escape') sRes.classList.remove('open');
  });
  sInput.addEventListener('focus', () => {
    if (!S.wards) return;
    if (sInput.value.trim().length >= 2 && sItems.length) sRes.classList.add('open');
    else listAllWards();
  });
  sRes.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) chooseSearch(+b.dataset.i); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) sRes.classList.remove('open'); });

  // ───────────────────────── Cài đặt: chủ đề, thang màu ─────────────────────────
  $('#btnSettings').addEventListener('click', () => SET.open('map'));
  SET.on((cur, prev) => {
    if (!S.meta) return;
    chartTheme();
    if (cur.palette !== prev.palette) {
      LST.palette = SET.palette(); PAL = LST.palette.map(hexToRgb);
      buildStripes(); renderRank(); renderNow(); updatePixels(); styleWards(); renderLegend();
      bus.emit('palette');
    }
    if (cur.showFill !== prev.showFill && S.mode === 'gee') {
      const keep = S.ky;
      buildFrames(); buildStripes();
      const i = S.frames.indexOf(keep);
      setFrame(i >= 0 ? i : S.frames.length - 1);
    }
    if (cur.theme !== prev.theme || cur.darkMap !== prev.darkMap) {
      styleWards();
      if (drawerOpen() && ['ward', 'model', 'stats', 'weather'].includes(S.tab)) showTab(S.tab);
      bus.emit('theme');
    }
  });

  // ───────────────────────── Khởi động ─────────────────────────
  function splash(p, text, err) {
    $('#spFill').style.width = p + '%';
    const t = $('#spText');
    t.textContent = text;
    t.classList.toggle('err', !!err);
  }
  (function splashStripes() {
    const box = $('#spStripes');
    const pal = SET.palette().map(hexToRgb);
    let h = '';
    for (let i = 0; i < 26; i++) {
      const t = 0.5 + 0.4 * Math.sin(i / 25 * Math.PI * 2 - 1.2) + 0.1 * Math.sin(i * 1.7);
      const c = rampAt(pal, clamp(t, 0, 1));
      h += `<i style="height:${18 + clamp(t, 0, 1) * 56}px;background:rgb(${c});animation-delay:${i * 35}ms, ${i * 90}ms"></i>`;
    }
    box.innerHTML = h;
  })();

  async function init() {
    const pill = $('#dbStatus');
    const me = await window.Auth.require();            // chưa đăng nhập → chuyển sang login.html
    if (!me) return;
    S.me = me;
    S.simple = me.role !== 'admin';                     // người dùng thường: giao diện rút gọn, ẩn phần kỹ thuật/quản trị
    document.body.classList.add('role-' + me.role);
    SET.setAccount({ name: me.name || me.username, roleLabel: window.Auth.ROLES[me.role], admin: me.role === 'admin', onLogout: () => window.Auth.signOut() });
    try {
      splash(12, 'Đang kết nối PostgreSQL/PostGIS…');
      const h = await api('/health');
      pill.classList.add('ok');
      pill.querySelector('.txt').textContent = h.static ? 'Demo' : `PostGIS ${String(h.postgis).split(' ')[0]}`;
      pill.title = h.static ? 'Bản demo tĩnh: dữ liệu xuất sẵn từ CSDL PostgreSQL/PostGIS' : `PostgreSQL ${h.pg} · PostGIS ${h.postgis}`;
      if (!h.schema_ok) throw new Error('CSDL chưa có schema “vientham”. Chạy: python database/etl/nap_du_lieu.py rồi noi_suy_thang.py, du_bao_lst.py');
      splash(30, 'Đang tải ranh giới 168 phường/xã và danh mục ảnh…');
      const [meta, wards, prov, gee] = await Promise.all([api('/meta'), api('/wards'), api('/boundary'), api('/series?chi_so=LST')]);
      S.meta = meta; S.wards = wards; S.province = prov; S.gee = gee; S.N = wards.features.length;
      wards.features.forEach((f) => wardIndex.set(f.properties.ma_xa, f.properties.i));
      const L0 = meta.indices.LST;
      if (!L0 || !L0.gee.length) throw new Error('Chưa có ảnh LST trong CSDL. Chạy: python database/etl/nap_du_lieu.py');
      LST = { ...L0, palette: SET.palette() }; PAL = LST.palette.map(hexToRgb);
      S.fillRun = meta.runs.find((r) => r.ma_loai === 'NOI_SUY') || null;
      $('#thrRange').value = S.thr;
      const best = bestRun() || meta.runs.find((r) => r.ma_loai !== 'NOI_SUY');
      S.runId = best?.ma_phien ?? null;
      const groups = [['MO_HINH', 'Mô hình dự báo'], ['GIA_LAP', 'Kịch bản giả lập']];
      $('#runSel').innerHTML = groups.map(([k, g]) => {
        const rs = meta.runs.filter((r) => r.ma_loai === k);
        return rs.length ? `<optgroup label="${g}">${rs.map((r) => `<option value="${r.ma_phien}">${esc(r.ten_mo_hinh)}${r.mac_dinh ? ' ★ chọn' : ''}${k === 'GIA_LAP' ? ' · phủ xanh' : ''}${r.metrics.test ? ` · RMSE ${fmt(r.metrics.test.rmse, 2)}` : ''}</option>`).join('')}</optgroup>` : '';
      }).join('');
      if (S.runId !== null) $('#runSel').value = String(S.runId);
      else { $('#modeSeg [data-mode="run"]').disabled = true; $('#modeSeg [data-mode="day"]').disabled = true; }

      splash(55, 'Đang dựng bản đồ…');
      setBase('google');                                  // mặc định Google Map
      const ob = meta.overlay.bounds;
      const bounds = [[ob[1], ob[0]], [ob[3], ob[2]]];
      for (let k = 0; k < 2; k++) {
        imgLayers[k] = L.imageOverlay(EMPTY, bounds, { pane: 'raster', opacity: 0, interactive: false, className: 'lst-img' }).addTo(map);
      }
      addProvince();
      buildWardLayer();
      $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
      setTucked(S.tucked === null ? isMobile() : S.tucked, false);
      if (overlayDrawer()) closeDrawer(); else showTab('overview');
      map.invalidateSize();
      { const v = homeView(); map.setView(v.center, v.zoom, { animate: false }); }
      buildFrames();
      const lastObs = LST.gee.at(-1).ky;
      S.frameI = Math.max(0, S.frames.indexOf(lastObs));
      S.ky = S.frames[S.frameI];
      buildStripes();
      renderWardTab();

      splash(78, 'Đang giải mã ảnh nhiệt mới nhất…');
      await decodePng(geeItem(S.ky).url, LST.encode);
      if (S.fillRun) await ensureRunSeries(S.fillRun.ma_phien).catch(() => {});
      await render();
      if (S.runId !== null) {                                            // tải trước để chuyển sang Dự báo / 7 ngày tức thì
        ensureRunSeries(S.runId).catch(() => {});
        setTimeout(() => ensureDaily().catch(() => {}), 1500);
      }

      // Phân quyền giao diện: quản trị viên thấy lối vào trang quản trị; ai cũng có nút đăng xuất
      if (me.role === 'admin') $('#roleChip').hidden = false;
      $('#btnLogout').title = `Đăng xuất · ${me.name || me.username} (${window.Auth.ROLES[me.role]})`;
      $('#btnLogout').addEventListener('click', () => window.Auth.signOut());
      if (new URLSearchParams(location.search).has('denied')) { toast('Tài khoản của bạn không có quyền vào trang quản trị', 'err'); history.replaceState(null, '', location.pathname); }
      splash(100, 'Sẵn sàng');
      setTimeout(() => {
        $('#splash').classList.add('out');
        document.body.classList.remove('booting');
        document.body.classList.add('enter');
        setTimeout(() => document.body.classList.remove('enter'), 1800);
      }, 250);
    } catch (e) {
      console.error(e);
      pill.classList.add('err');
      pill.querySelector('.txt').textContent = 'Lỗi CSDL';
      splash(100, e.message, true);
    }
  }

  // ───────────────────────── Giao tiếp với module 3D ─────────────────────────
  window.LSTApp = {
    S, map, bus, api, colorAt, errAt, css, levelOf, kyText, kyShort, fmt, esc, isNum, signed, motionOK,
    palette: () => LST, frames: () => S.frames, frameText, frameShort, isFill, hasObs, day,
    setFrame: (i) => { stop(); return setFrame(i); },
    step: stepFrame, play, stop, isPlaying: () => S.playing,
    selectWard: (i) => selectWard(i, { fly: true, from3d: true, noDrawer: true }),
    cellsQuery: () => {
      if (S.mode === 'day') return { phien: S.daily?.phien?.ma_phien, offset: day()?.lech || 0, table: 'du_bao_o (AI tháng) + dao động ngày' };
      if (S.mode === 'gee') return isFill(S.ky) ? { phien: S.fillRun.ma_phien, offset: 0, table: 'du_bao_o (nội suy)' } : { phien: null, offset: 0, table: 'quan_trac_o' };
      if (S.cmp === 'obs' && hasObs(S.ky)) return { phien: null, offset: 0, table: 'quan_trac_o' };
      return { phien: S.runId, offset: 0, table: 'du_bao_o' };
    },
    /** Chuỗi giá trị của 1 phường quanh khung hiện tại (tối đa n khung gần nhất) theo chế độ đang xem — cho biểu đồ so sánh 3D */
    wardSeries: (i, n = 24) => {
      const end = S.frameI, start = Math.max(0, end - n + 1);
      const fr = S.frames.slice(start, end + 1);
      const labels = fr.map((f) => (S.mode === 'day' ? dayShort(S.daily.days[f].ngay) : kyShort(f)));
      const vals = fr.map((f) => {
        if (S.mode === 'day') return S.daily.wards[f]?.[i] ?? null;
        if (S.mode === 'gee') return (matrixRow(S.gee, f) || matrixRow(S.runSeries[S.fillRun?.ma_phien], f))?.[i] ?? null;
        return matrixRow(S.runSeries[S.runId], f)?.[i] ?? null;
      });
      return { labels, vals };
    },
    run, errMode,
  };
  init();
})();
