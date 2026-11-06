/* =====================================================================
   LST Forecast · TP.HCM — bản đồ 2D, thời gian, xếp hạng, phân tích
   Leaflet + Chart.js · dữ liệu từ API Express/PostGIS (schema vientham)
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
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const Y0 = 2020;
  const kyY = (k) => Math.floor(k / 100);
  const kyM = (k) => k % 100;
  const kyIdx = (k) => (kyY(k) - Y0) * 12 + kyM(k) - 1;
  const idxKy = (i) => (Y0 + Math.floor(i / 12)) * 100 + (i % 12) + 1;
  const kyText = (k) => `Tháng ${kyM(k)}/${kyY(k)}`;
  const kyShort = (k) => `${kyM(k)}/${kyY(k)}`;
  const isDry = (k) => [12, 1, 2, 3, 4].includes(kyM(k));
  const TAP_TEXT = { train: 'huấn luyện', val: 'kiểm định', test: 'kiểm tra', future: 'dự báo tương lai' };

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
    if (p === '/weather') {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${q.lat}&longitude=${q.lon}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,shortwave_radiation_sum&timezone=Asia%2FHo_Chi_Minh&forecast_days=7`);
      if (!r.ok) throw new Error('Open-Meteo trả lỗi ' + r.status);
      const { daily } = await r.json();
      return {
        nguon: 'Open-Meteo', ngay: daily.time.map((d, i) => {
          const solar = ((daily.shortwave_radiation_sum[i] || 0) * 1e6) / 86400;
          const t = daily.temperature_2m_max[i];
          return { ngay: d, t_max: t, t_min: daily.temperature_2m_min[i], t_tb: daily.temperature_2m_mean[i], buc_xa: Math.round(solar), lst: Math.round((t + 3.5 + 0.008 * solar) * 100) / 100 };
        }),
      };
    }
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
    if (!isNum(to)) { el.innerHTML = '–'; return; }
    const from = isNum(el.dataset.v) ? +el.dataset.v : to;
    el.dataset.v = to;
    if (reduceMotion || Math.abs(to - from) < 1e-9) { el.innerHTML = fmt(to, dec) + suffix; return; }
    const t0 = performance.now(), dur = 550;
    const step = (now) => {
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
    gee: null, runSeries: {}, wardCache: new Map(),
    mode: 'gee', runId: null, cmp: 'pred', base: 'google', outline: true, opacity: 0.85,
    frames: [], frameI: 0, ky: null, V: null,
    thr: 40, sortDesc: true, region: '', filter: '',
    selected: null, hover: null, point: null,
    playing: false, timer: null, tab: 'overview',
  };

  // ───────────────────────── Thang màu ─────────────────────────
  const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  let LST = { min: 25, max: 45, palette: ['#0000FF', '#0066FF', '#00FFFF', '#00FF00', '#FFFF00', '#FFCC00', '#FF6600', '#FF0000'], encode: [10, 70], nguong: [] };
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
  function niceTicks(lo, hi, target = 5) {
    const raw = (hi - lo) / target, p = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  // ───────────────────────── Bản đồ ─────────────────────────
  const map = L.map('map', { zoomControl: false, preferCanvas: false, zoomSnap: 0.25, wheelPxPerZoomLevel: 90, minZoom: 8, maxZoom: 18 })
    .setView([10.85, 106.75], 9);
  map.createPane('raster').style.zIndex = 350;
  map.createPane('mask').style.zIndex = 380;
  map.createPane('labels').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';
  map.getPane('mask').style.pointerEvents = 'none';
  L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 130 }).addTo(map);

  // 2 lớp nền như bản web cũ: Google Map (mặc định) và Vệ tinh (Google, có nhãn)
  const gTile = (lyrs) => L.tileLayer(`https://mt{s}.google.com/vt/lyrs=${lyrs}&hl=vi&x={x}&y={y}&z={z}`,
    { subdomains: '0123', maxZoom: 20, attribution: '© Google', keepBuffer: 4 });
  const BASES = { google: [gTile('m')], sat: [gTile('y')] };
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
    while (imgCache.size > 30) imgCache.delete(imgCache.keys().next().value);
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
      d[j] = lut[t]; d[j + 1] = lut[t + 1]; d[j + 2] = lut[t + 2]; d[j + 3] = 238;
    }
    cx.putImageData(out, 0, 0);
    return new Promise((res) => pxCanvas.toBlob((b) => res(URL.createObjectURL(b)), 'image/png'));
  }

  // ───────────────────────── Nguồn dữ liệu theo khung hiện tại ─────────────────────────
  const run = () => S.meta?.runs.find((r) => r.ma_phien === S.runId) || null;
  const geeItem = (ky) => LST.gee?.find((g) => g.ky === ky) || null;
  const runItem = (ky, r = run()) => r?.months.find((m) => m.ky === ky) || null;
  const wardIndex = new Map();

  function matrixRow(series, ky) {
    if (!series) return null;
    const j = series.months.indexOf(ky);
    return j >= 0 ? series.tb[j] : null;
  }
  async function ensureRunSeries(id) {
    if (!S.runSeries[id]) S.runSeries[id] = await api(`/series?chi_so=LST&phien=${id}`);
    return S.runSeries[id];
  }
  /** Giá trị trung bình 168 phường tại khung hiện tại theo chế độ hiển thị */
  function currentValues() {
    const ky = S.ky;
    const obs = matrixRow(S.gee, ky);
    if (S.mode === 'gee') return obs ? Float32Array.from(obs, (v) => (v === null ? NaN : v)) : new Float32Array(S.N).fill(NaN);
    const pred = matrixRow(S.runSeries[S.runId], ky);
    const P = pred ? Float32Array.from(pred, (v) => (v === null ? NaN : v)) : new Float32Array(S.N).fill(NaN);
    if (S.cmp === 'obs' && obs) return Float32Array.from(obs, (v) => (v === null ? NaN : v));
    if (S.cmp === 'err' && obs) return P.map((v, i) => (obs[i] === null ? NaN : v - obs[i]));
    return P;
  }
  const errMode = () => S.mode === 'run' && S.cmp === 'err' && hasObs(S.ky);
  const hasObs = (ky) => !!geeItem(ky);

  // ───────────────────────── Lớp phường/xã ─────────────────────────
  function buildWardLayer() {
    wardLayer = L.geoJSON(S.wards, {
      renderer: L.svg({ padding: 0.4 }),
      style: () => ({ className: 'ward', weight: 0.7, color: '#ffffff', fillOpacity: 0 }),
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
  function styleWard(i) {
    const layer = wardPaths[i];
    if (!layer || !S.V) return;
    const v = S.V[i];
    const err = errMode();
    const over = !err && isNum(v) && v >= S.thr;
    const dark = S.base === 'sat';
    // phường chỉ vẽ đường ranh (vùng tô trong suốt nhưng vẫn nhận chuột); màu nhiệt lấy từ ảnh pixel
    let st = {
      fillColor: '#000', fillOpacity: 0,
      color: dark ? 'rgba(255,255,255,.8)' : 'rgba(15,23,42,.5)',
      weight: S.outline ? 0.6 : 0,
      opacity: 1,
    };
    if (over) st = { ...st, color: '#991b1b', weight: S.outline ? 1.6 : 1.2 };
    if (S.hover === i) st = { ...st, color: '#0f172a', weight: 2.6 };
    if (S.selected === i) st = { ...st, color: '#f59e0b', weight: 3.4 };
    layer.setStyle(st);
    if (S.selected === i || S.hover === i) layer.bringToFront();
  }
  function styleWards() { for (let i = 0; i < S.N; i++) styleWard(i); }

  function addProvince() {
    if (!S.province) return;
    const holes = [];
    S.province.features.forEach((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach((p) => holes.push(p[0].map(([x, y]) => [y, x])));
    });
    const world = [[-89, -179], [-89, 179], [89, 179], [89, -179]];
    L.polygon([world, ...holes], { pane: 'mask', stroke: false, fillColor: '#f8fafc', fillOpacity: 0.5, interactive: false }).addTo(map);
    L.geoJSON(S.province, { pane: 'mask', interactive: false, style: { color: '#0f172a', weight: 1.8, opacity: 0.85, fill: false } }).addTo(map);
  }

  // ───────────────────────── Lớp ảnh pixel ─────────────────────────
  let pxToken = 0;
  S.px = null;
  async function updatePixels() {
    const tok = ++pxToken;
    const ky = S.ky;
    let url = null, img = null, err = false, smooth = false;
    try {
      busy(true, 'Đang giải mã ảnh nhiệt…');
      const g = geeItem(ky), f = S.mode === 'run' ? runItem(ky) : null;
      if (S.mode === 'gee' || (S.cmp === 'obs' && g)) {
        if (!g) throw new Error('Không có ảnh GEE ' + kyShort(ky));
        img = await decodePng(g.url, LST.encode);
      } else if (S.cmp === 'err' && g && f) {
        const [a, b] = await Promise.all([decodePng(f.url, LST.encode), decodePng(g.url, LST.encode)]);
        const vals = new Float32Array(a.vals.length);
        for (let i = 0; i < vals.length; i++) vals[i] = a.vals[i] - b.vals[i];
        img = { w: a.w, h: a.h, vals };
        err = true; smooth = true;
      } else {
        if (!f) throw new Error('Phiên dự báo không có tháng ' + kyShort(ky));
        img = await decodePng(f.url, LST.encode);
        smooth = true;
      }
      if (tok !== pxToken) return;
      url = err ? await colorize(img, errAt, ERR.min, ERR.max) : await colorize(img, colorAt, LST.min, LST.max);
      if (tok !== pxToken) { URL.revokeObjectURL(url); return; }
      S.px = { ...img, err };
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
      layer.getElement()?.classList.toggle('smooth', smooth);
      layer.setOpacity(S.opacity);
      imgLayers[imgFront].setOpacity(0);
      imgFront = back;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 800);
      prefetchNext();
    } catch (e) {
      console.error(e);
      if (tok === pxToken) toast(e.message, 'err');
    } finally {
      if (tok === pxToken) busy(false);
    }
  }
  function prefetchNext() {
    const k = S.frames[(S.frameI + 1) % S.frames.length];
    const it = S.mode === 'gee' ? geeItem(k) : runItem(k);
    if (it) decodePng(it.url, LST.encode).catch(() => {});
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
  function busy(on, text) {
    if (text) $('#busyT').textContent = text;
    $('#busy').hidden = !on;
  }

  // ───────────────────────── Tooltip & ô đọc giá trị ─────────────────────────
  const tip = $('#tip');
  function showTip(e) {
    const i = S.hover;
    if (i === null || i === undefined) return;
    const p = S.wards.features[i].properties;
    const v = S.V?.[i];
    const err = errMode();
    const pv = pixelAt(e.latlng);
    const lv = err ? null : levelOf(v);
    const rank = rankOf(i);
    tip.innerHTML = `
      <h4>${esc(p.loai)} ${esc(p.ten_xa)}</h4>
      <div class="sub">${esc(p.khu_vuc)}${rank ? ` · hạng ${rank.r}/${rank.n}` : ''}</div>
      <div class="r"><span>${err ? 'Sai số TB phường' : 'TB phường/xã'}</span><b>${err ? signed(v) : fmt(v, 2)} °C</b></div>
      ${isNum(pv) ? `<div class="r"><span>Tại con trỏ</span><b>${err ? signed(pv) : fmt(pv, 1)} °C</b></div>` : ''}
      ${lv ? `<span class="lvl" style="background:${lv.mau}">${esc(lv.ten)}</span>` : ''}`;
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
    const v = pixelAt(e.latlng);
    const err = errMode();
    $('#roVal').innerHTML = isNum(v) ? `${err ? 'Sai số ' + signed(v, 1) : 'LST ' + fmt(v, 1)} °C` : '&nbsp;';
    legendMarker(v);
  });
  map.on('mouseout', () => { $('#roXY').textContent = 'Di chuột lên bản đồ để xem giá trị'; $('#roVal').innerHTML = '&nbsp;'; legendMarker(NaN); hideTip(); });
  map.on('click', (e) => pickPoint(e.latlng.lat, e.latlng.lng));

  // ───────────────────────── Chú giải ─────────────────────────
  function renderLegend() {
    const err = errMode();
    const lo = err ? ERR.min : LST.min, hi = err ? ERR.max : LST.max;
    $('#lgTitle').textContent = err ? 'Sai số °C' : 'LST °C';
    $('#lgBar').style.background = `linear-gradient(0deg, ${(err ? ERR : LST).palette.join(', ')})`;
    $('#lgTicks').innerHTML = niceTicks(lo, hi, 5).map((t) => `<span style="bottom:${(t - lo) / (hi - lo) * 100}%">${err && t > 0 ? '+' : ''}${t}</span>`).join('');
    $('#lgLow').textContent = err ? 'Dự báo thấp hơn' : 'Mát';
    $('#lgHigh').textContent = err ? 'Dự báo cao hơn' : 'Nóng';
    let sub = '';
    if (S.mode === 'gee' || (S.cmp === 'obs' && hasObs(S.ky))) sub = 'ảnh GEE 30 m';
    else sub = 'lưới dự báo 480 m';
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
    S.frames = S.mode === 'gee' ? LST.gee.map((g) => g.ky) : (run()?.months.map((m) => m.ky) || []);
  }
  async function setFrame(i, opts = {}) {
    if (!S.frames.length) return;
    S.frameI = (i + S.frames.length) % S.frames.length;
    S.ky = S.frames[S.frameI];
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
      await setFrame(S.frameI + 1, { fromPlay: true });
      if (S.playing) S.timer = setTimeout(tick, +$('#speedSel').value);
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

  // Thanh sọc nhiệt
  function buildStripes() {
    const r = S.meta.runs.find((x) => x.ma_phien === S.runId);
    const last = Math.max(...LST.gee.map((g) => kyIdx(g.ky)), ...(r ? r.months.map((m) => kyIdx(m.ky)) : [0]));
    const box = $('#stripes');
    let html = '';
    for (let i = 0; i <= last; i++) {
      const ky = idxKy(i);
      const g = geeItem(ky), f = r ? runItem(ky, r) : null;
      const cls = ['m'];
      let bg = '';
      let title = kyText(ky);
      if (f) {
        cls.push('fc');
        bg = css(colorAt(f.tb));
        title += ` · dự báo ${fmt(f.tb, 1)} °C (${TAP_TEXT[f.tap] || ''})`;
        if (g) { cls.push('obs-too'); title += ` · GEE ${fmt(g.tb, 1)} °C`; }
      } else if (g) {
        cls.push('obs');
        bg = css(colorAt(g.tb));
        title += ` · GEE ${fmt(g.tb, 1)} °C`;
      } else title += ' · không có ảnh (mây/thiếu dữ liệu)';
      if (kyM(ky) === 1) cls.push('yr');
      const obsColor = g && f ? `--obs-color:${css(colorAt(g.tb))};` : '';
      html += `<div class="${cls.join(' ')}" data-ky="${ky}" style="--i:${i};${bg ? `background-color:${bg};` : ''}${obsColor}" title="${esc(title)}"></div>`;
    }
    box.innerHTML = html + '<div class="now-flag" id="nowFlag"></div>';
    const n = last + 1;
    let ax = '';
    for (let y = Y0; y <= kyY(idxKy(last)); y++) {
      const pos = ((y - Y0) * 12) / n * 100;
      if (pos <= 95) ax += `<span style="left:${pos}%">${y}</span>`;   // bỏ nhãn quá sát mép phải
    }
    $('#tlAxis').innerHTML = ax;
    markStripes();
  }
  function markStripes() {
    const set = new Set(S.frames);
    let cur = null;
    $$('#stripes .m').forEach((el) => {
      const k = +el.dataset.ky;
      el.classList.toggle('cur', k === S.ky);
      el.classList.toggle('dim', (el.classList.contains('obs') || el.classList.contains('fc')) && !set.has(k));
      if (k === S.ky) cur = el;
    });
    const flag = $('#nowFlag');
    if (cur && flag) {
      flag.textContent = kyShort(S.ky);
      flag.style.left = cur.offsetLeft + cur.offsetWidth / 2 + 'px';
    }
  }
  $('#stripes').addEventListener('click', async (e) => {
    const el = e.target.closest('.m');
    if (!el) return;
    const ky = +el.dataset.ky;
    stop();
    if (S.frames.includes(ky)) await gotoKy(ky);                       // tháng thuộc chế độ đang xem
    else if (S.mode === 'gee' && runItem(ky)) await setMode('run', { ky }); // tháng chỉ có dự báo
    else if (S.mode === 'run' && geeItem(ky)) await setMode('gee', { ky }); // tháng chỉ có ảnh GEE
  });
  async function gotoKy(ky) {
    const i = S.frames.indexOf(ky);
    if (i >= 0) await setFrame(i);
  }

  // ───────────────────────── Vẽ lại toàn bộ theo khung hiện tại ─────────────────────────
  async function render(opts = {}) {
    if (S.mode === 'run') await ensureRunSeries(S.runId);
    S.V = currentValues();
    styleWards();
    updatePixels();
    renderTitle();
    renderLegend();
    renderNow();
    renderThreshold();
    renderRank();
    markStripes();
    $('#cmpSeg').hidden = !(S.mode === 'run' && hasObs(S.ky) && run()?.ma_loai === 'MO_HINH');
    if (!opts.fromPlay && S.tab === 'stats') renderStatsTab();
    if (S.selected !== null) updateWardLive();
    bus.emit('frame', { ky: S.ky, V: S.V, err: errMode() });
  }

  function sourceLabel() {
    if (S.mode === 'gee') return '<span class="chip gee dot">Hiện trạng · GEE</span>';
    const r = run();
    if (!r) return '';
    const it = runItem(S.ky);
    const tap = it?.tap ? ` · ${TAP_TEXT[it.tap]}` : '';
    if (r.ma_loai === 'GIA_LAP') return `<span class="chip sim dot">Giả lập · ${esc(r.ten_mo_hinh)}</span>`;
    return `<span class="chip run dot">Dự báo · ${esc(r.ten_mo_hinh)}${tap}</span>`;
  }
  function renderTitle() {
    const r = run();
    let p = `<b>${kyText(S.ky)}</b>`;
    if (S.mode === 'gee') p += ' · hiện trạng từ ảnh Google Earth Engine';
    else if (r) {
      const it = runItem(S.ky);
      const what = S.cmp === 'obs' && hasObs(S.ky) ? 'ảnh GEE thực tế để đối chiếu' : S.cmp === 'err' && hasObs(S.ky) ? 'sai số dự báo so với GEE' : (r.ma_loai === 'GIA_LAP' ? `kịch bản giả lập (${esc(r.ten_mo_hinh)})` : `dự báo ${esc(r.ten_mo_hinh)}`);
      p += ` · ${what}${it?.tap ? ` · tập ${TAP_TEXT[it.tap]}` : ''}`;
    }
    const el = $('#mapTitleP');
    el.innerHTML = p;
    el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
  }

  function cityMean() {
    if (S.mode === 'gee' || (S.cmp === 'obs' && hasObs(S.ky))) return geeItem(S.ky)?.tb;
    return runItem(S.ky)?.tb;
  }
  /** Trung bình nhiều năm cùng tháng (GEE), bỏ tháng đang xem */
  function climate(ky) {
    const xs = LST.gee.filter((g) => kyM(g.ky) === kyM(ky) && g.ky !== ky).map((g) => g.tb);
    return xs.length ? { tb: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : null;
  }
  function renderNow() {
    $('#nowMonth').textContent = kyText(S.ky);
    $('#nowSrc').innerHTML = sourceLabel();
    const s = $('#nowSeason');
    s.textContent = isDry(S.ky) ? 'Mùa khô' : 'Mùa mưa';
    s.classList.toggle('wet', !isDry(S.ky));
    const err = errMode();
    const mean = err ? meanOf(S.V) : cityMean();
    $('#nowSwatch').style.background = isNum(mean) ? css(err ? errAt(mean) : colorAt(mean)) : '#cbd5e1';
    $('#kpiMeanK').textContent = err ? 'Sai số TB (dự báo − GEE)' : 'Trung bình toàn TP';
    $('#kpiDeltaK').textContent = err ? 'RMSE tập kiểm tra' : 'So với cùng kỳ';
    $('#kpiHotK').textContent = err ? 'Dự báo cao hơn thực tế nhiều nhất' : 'Phường/xã nóng nhất';
    animateNumber($('#kpiMean'), mean, 1, ' <small>°C</small>');
    if (err) {
      const r = run();
      $('#kpiMeanSub').textContent = 'trung bình các phường';
      $('#kpiDelta').innerHTML = `${fmt(r?.metrics?.test?.rmse, 2)} <small>°C</small>`;
      $('#kpiDeltaSub').textContent = `${r?.ten_mo_hinh || ''} · từng ô`;
    } else {
      const g = geeItem(S.ky);
      $('#kpiMeanSub').textContent = g && (S.mode === 'gee' || S.cmp === 'obs') ? `5–95%: ${fmt(g.p05, 1)}–${fmt(g.p95, 1)} °C` : (runItem(S.ky) ? `5–95%: ${fmt(runItem(S.ky).p05, 1)}–${fmt(runItem(S.ky).p95, 1)} °C` : '');
      const c = climate(S.ky);
      if (c && isNum(mean)) {
        const d = mean - c.tb;
        $('#kpiDelta').innerHTML = `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${fmt(Math.abs(d), 1)}</span> <small>°C</small>`;
        $('#kpiDeltaSub').textContent = `TB tháng ${kyM(S.ky)} của ${c.n} năm khác`;
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
    } else { hot.textContent = '–'; $('#kpiHotSub').innerHTML = '&nbsp;'; }
  }
  const meanOf = (V) => { let s = 0, n = 0; V.forEach((v) => { if (isNum(v)) { s += v; n++; } }); return n ? s / n : NaN; };

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
    const head = 'hang,ma_xa,loai,ten_xa,khu_vuc_cu,thang,nguon,lst_tb_c\n';
    const src = S.mode === 'gee' ? 'GEE' : `${run()?.ma_loai}:${run()?.ma_mo_hinh}${S.cmp !== 'pred' ? ':' + S.cmp : ''}`;
    const rows = rankCache.order.map((i) => {
      const p = S.wards.features[i].properties;
      return [rankCache.r[i], p.ma_xa, p.loai, `"${p.ten_xa}"`, `"${p.khu_vuc}"`, kyShort(S.ky), src, S.V[i].toFixed(3)].join(',');
    });
    download(`xep_hang_lst_${S.ky}.csv`, '﻿' + head + rows.join('\n'), 'text/csv');
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
    row?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    if (S.point && S.point.ward?.ma_xa !== S.wards.features[i].properties.ma_xa) clearPoint();
    const wasOpen = drawerOpen();
    showTab('ward');
    openRight();
    renderWardTab();
    if (opts.fly !== false) {
      // nếu ngăn kéo vừa mở thì đợi bản đồ co lại xong mới bay tới, tránh lệch tâm
      setTimeout(() => {
        const b = wardPaths[i]?.getBounds();
        if (b?.isValid() && S.selected === i) map.flyToBounds(b, { ...fitPad(), maxZoom: 13.5, duration: reduceMotion ? 0 : 0.9 });
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

  // ───────────────────────── Biểu đồ ─────────────────────────
  Chart.defaults.font.family = "'Be Vietnam Pro', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#475569';
  Chart.defaults.borderColor = '#e2e8f0';
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation.duration = reduceMotion ? 0 : 650;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15,23,42,.94)';
  Chart.defaults.plugins.tooltip.padding = 9;
  Chart.defaults.plugins.tooltip.cornerRadius = 9;
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
      g.save(); g.strokeStyle = 'rgba(15,23,42,.55)'; g.setLineDash([4, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.restore();
    },
  };
  function monthAxis(fromKy, toKy) {
    const out = [];
    for (let i = kyIdx(fromKy); i <= kyIdx(toKy); i++) out.push(idxKy(i));
    return out;
  }

  // ───────────────────────── Tab: Phường/Xã ─────────────────────────
  async function renderWardTab() {
    const box = $('#tab-ward');
    if (S.selected === null) {
      box.innerHTML = `<div class="empty"><div class="ic"><i class="fa-solid fa-hand-pointer"></i></div>
        <h3>Chọn một phường/xã</h3>
        <p>Nhấp vào bản đồ, chọn trong bảng xếp hạng hoặc gõ tên vào ô tìm kiếm để xem diễn biến nhiệt độ bề mặt từ 2020 và kết quả dự báo.</p>
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
    const fc = d.du_bao?.[S.runId] || [];
    const runR = run();
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
          <button class="icon-btn" id="w3d" title="Xem 3D"><i class="fa-solid fa-cube"></i></button>
          <button class="icon-btn" id="wCsv" title="Tải chuỗi số liệu CSV"><i class="fa-solid fa-download"></i></button>
        </div>
      </div>
      ${hasData ? `
      <div class="w-kpis">
        <div class="w-kpi"><div class="k" id="wNowK">${kyShort(S.ky)}</div><div class="v" id="wNow">–</div><div class="s" id="wNowS">&nbsp;</div></div>
        <div class="w-kpi"><div class="k">Xếp hạng nóng</div><div class="v" id="wRank">–</div><div class="s" id="wRankS">trong toàn TP</div></div>
        <div class="w-kpi"><div class="k">Xu hướng 2020–26</div><div class="v ${tr?.do_doc_nam > 0 ? 'up' : 'down'}">${tr ? signed(tr.do_doc_nam, 2) : '–'}<small> °C/năm</small></div><div class="s">${tr ? `hồi quy ${tr.so_thang} tháng` : ''}</div></div>
      </div>
      <div class="sec-h">Diễn biến LST theo tháng <span>dải mờ: 10–90% pixel</span></div>
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

    // Biểu đồ chuỗi tháng: GEE + dải p10–p90 + dự báo phiên đang chọn
    const lastKy = Math.max(d.series.LST.at(-1)?.ky || 0, fc.at(-1)?.ky || 0, ...(runR ? runR.months.map((m) => m.ky) : [0]));
    const axis = monthAxis(202001, lastKy);
    const at = (arr, key) => { const m = new Map(arr.map((x) => [x.ky, x[key]])); return axis.map((k) => m.get(k) ?? null); };
    chart('cWard', {
      type: 'line',
      data: {
        labels: axis.map(kyShort),
        datasets: [
          { label: 'P90', data: at(d.series.LST, 'p90'), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(239,68,68,.12)', spanGaps: true },
          { label: 'P10', data: at(d.series.LST, 'p10'), borderWidth: 0, pointRadius: 0, fill: false, spanGaps: true },
          { label: 'GEE (TB phường)', data: at(d.series.LST, 'tb'), borderColor: '#dc2626', backgroundColor: '#dc2626', borderWidth: 2, pointRadius: 2.5, tension: 0.25, spanGaps: true },
          { label: runR ? runR.ten_mo_hinh : 'Dự báo', data: at(fc, 'tb'), borderColor: '#4f46e5', backgroundColor: '#4f46e5', borderDash: [6, 4], borderWidth: 2, pointRadius: 2.5, tension: 0.25, spanGaps: true },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { filter: (it) => !it.text.startsWith('P') } },
          tooltip: { filter: (it) => it.raw !== null && !it.dataset.label.startsWith('P'), callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } },
          nowLine: { index: axis.indexOf(S.ky) },
        },
        scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } },
      },
      plugins: [nowLine],
    });
    const env = monthAxis(202001, Math.max(d.series.NDVI.at(-1)?.ky || 202001, d.series.TVDI.at(-1)?.ky || 202001));
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
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } }, y: { suggestedMin: 0, suggestedMax: 0.8 } } },
    });
    if (S.point && S.point.ward?.ma_xa === p.ma_xa) {
      const pt = S.point;
      const pf = pt.du_bao?.[S.runId] || [];
      const pAxis = monthAxis(202001, Math.max(pt.series.LST.at(-1)?.[0] || 202001, pf.at(-1)?.[0] || 202001));
      const pm = (arr) => { const m = new Map(arr); return pAxis.map((k) => m.get(k) ?? null); };
      chart('cPoint', {
        type: 'line',
        data: {
          labels: pAxis.map(kyShort),
          datasets: [
            { label: 'GEE tại ô', data: pm(pt.series.LST), borderColor: '#0f172a', backgroundColor: '#0f172a', pointRadius: 2, borderWidth: 1.6, spanGaps: true },
            { label: 'Dự báo tại ô', data: pm(pf), borderColor: '#4f46e5', backgroundColor: '#4f46e5', borderDash: [5, 4], pointRadius: 2, borderWidth: 1.6, spanGaps: true },
          ],
        },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 1)} °C` } }, nowLine: { index: pAxis.indexOf(S.ky) } }, scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } } },
        plugins: [nowLine],
      });
    }
  }
  /** Cập nhật nhanh các số liệu phụ thuộc tháng mà không vẽ lại cả tab */
  function updateWardLive() {
    if (S.selected === null || !$('#wNow')) return;
    const v = S.V[S.selected];
    const err = errMode();
    const lv = err ? null : levelOf(v);
    $('#wNowK').textContent = `${kyShort(S.ky)} · ${S.mode === 'gee' ? 'GEE' : (S.cmp === 'obs' && hasObs(S.ky) ? 'GEE' : run()?.ma_mo_hinh || '')}`;
    animateNumber($('#wNow'), v, err ? 2 : 1, err ? ' <small>°C sai số</small>' : ' <small>°C</small>');
    $('#wNowS').textContent = lv ? lv.ten : (isNum(v) ? '' : 'không có ảnh tháng này');
    const ic = $('#wIc');
    if (ic) ic.style.background = lv ? lv.mau : 'linear-gradient(135deg,#2563eb,#4f46e5)';
    const rk = rankOf(S.selected);
    $('#wRank').innerHTML = rk ? `${rk.r}<small> / ${rk.n}</small>` : '–';
    if (charts.cWard) {
      const labels = charts.cWard.data.labels;
      charts.cWard.options.plugins.nowLine = { index: labels.indexOf(kyShort(S.ky)) };
      charts.cWard.update('none');
    }
    if (charts.cPoint) {
      charts.cPoint.options.plugins.nowLine = { index: charts.cPoint.data.labels.indexOf(kyShort(S.ky)) };
      charts.cPoint.update('none');
    }
  }

  // ───────────────────────── Tab: Mô hình ─────────────────────────
  function renderModelTab() {
    const box = $('#tab-model');
    const runs = S.meta.runs.filter((r) => r.ma_loai === 'MO_HINH');
    const sims = S.meta.runs.filter((r) => r.ma_loai === 'GIA_LAP');
    if (!runs.length) { box.innerHTML = '<div class="empty"><h3>Chưa có kết quả mô hình</h3><p>Chạy <code>python database/etl/du_bao_lst.py</code> để huấn luyện và ghi kết quả.</p></div>'; return; }
    const best = runs.reduce((a, b) => ((b.metrics.test?.rmse ?? 1e9) < (a.metrics.test?.rmse ?? 1e9) ? b : a));
    const cur = run()?.ma_loai === 'MO_HINH' ? run() : best;
    const testMonths = cur.months.filter((m) => m.tap === 'test').map((m) => kyShort(m.ky));
    const futMonths = cur.months.filter((m) => m.tap === 'future').map((m) => kyShort(m.ky));
    const imp = cur.tham_so?.muc_do_quan_trong;
    const FEAT = {
      lst_khi_hau_cung_thang: 'LST khí hậu cùng tháng', lst_tb_o: 'LST trung bình ô', lst_lan_gan_nhat: 'LST lần quan trắc gần nhất',
      so_thang_tu_lan_gan_nhat: 'Số tháng từ lần gần nhất', lst_tb_12_thang: 'LST TB 12 tháng trước', ndvi_lan_gan_nhat: 'NDVI gần nhất',
      ndvi_khi_hau_cung_thang: 'NDVI khí hậu cùng tháng', tvdi_lan_gan_nhat: 'TVDI gần nhất', lst_tp_khi_hau_cung_thang: 'LST TP khí hậu cùng tháng',
      di_thuong_tp_gan_nhat: 'Dị thường LST TP gần nhất', sin_thang: 'Mùa (sin tháng)', cos_thang: 'Mùa (cos tháng)', tam_du_bao: 'Tầm dự báo (tháng)',
      x_chuan_hoa: 'Toạ độ X', y_chuan_hoa: 'Toạ độ Y', nam: 'Năm (xu thế)',
    };
    box.innerHTML = `
      <div class="callout info"><b>Bài toán:</b> dùng ảnh GEE đến hết tháng trước để dự báo LST <b>từng ô 480 m</b> cho 6 tháng tới.
        Huấn luyện 2021–2024 · kiểm định 2025 · kiểm tra: dữ liệu đến 12/2025 → dự báo ${testMonths[0] || '1/2026'}–${testMonths.at(-1) || '6/2026'} · tương lai: ${futMonths[0] || ''}–${futMonths.at(-1) || ''}.</div>
      <div class="sec-h">So sánh trên tập kiểm tra <span>nhấp để chọn mô hình hiển thị</span></div>
      <table class="tbl" id="mTbl">
        <thead><tr><th>Mô hình</th><th>MAE</th><th>RMSE</th><th>R²</th><th title="R² sau khi bỏ trung bình toàn TP của từng tháng">R² không gian</th><th>MAPE %</th></tr></thead>
        <tbody>${runs.map((r) => {
          const t = r.metrics.test || {};
          return `<tr class="pick${r.ma_phien === cur.ma_phien ? ' on' : ''}" data-id="${r.ma_phien}">
            <td><b>${esc(r.ten_mo_hinh)}</b>${r === best ? ' <span class="chip best">tốt nhất</span>' : ''}<span class="grp">${esc(r.nhom)}</span></td>
            <td>${fmt(t.mae, 2)}</td><td class="${r === best ? 'good' : ''}">${fmt(t.rmse, 2)}</td><td>${fmt(t.r2, 3)}</td><td>${fmt(r.tham_so?.r2_khong_gian_test, 3)}</td><td>${fmt(t.mape, 1)}</td></tr>`;
        }).join('')}</tbody>
      </table>
      <p class="note">Đơn vị MAE, RMSE: °C, tính trên từng ô có quan trắc GEE (${(runs[0].metrics.test?.n || 0).toLocaleString('vi-VN')} giá trị). <b>R² không gian</b> bỏ phần nhiệt độ chung của cả thành phố trong tháng, cho biết mô hình dự báo đúng chỗ nào nóng hơn, chỗ nào mát hơn. LSTM, GRU, Transformer có trong danh mục mô hình của CSDL nhưng cần PyTorch để chạy.</p>
      <div class="sec-h">RMSE theo tập dữ liệu <span>°C · thấp hơn là tốt hơn</span></div>
      <div class="chart-box"><canvas id="cRmse"></canvas></div>
      <div class="sec-h">Thực tế và dự báo · ${esc(cur.ten_mo_hinh)} <span>mẫu ô của tập kiểm tra</span></div>
      <div class="chart-box lg"><canvas id="cScatter"></canvas></div>
      ${imp ? `<div class="sec-h">Mức độ quan trọng của biến <span>${esc(cur.ten_mo_hinh)}</span></div>
      <div class="bars">${Object.entries(imp).slice(0, 8).map(([k, v], i, arr) => `<div class="b"><span title="${esc(k)}">${esc(FEAT[k] || k)}</span><i style="width:${v / arr[0][1] * 100}%"></i><b>${fmt(v * 100, 1)}%</b></div>`).join('')}</div>` : ''}
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
      options: { scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false, font: { size: 10 } } }, y: { beginAtZero: true } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } } } },
    });
    api(`/compare?phien=${cur.ma_phien}`).then((cmp) => {
      if (!$('#cScatter')) return;
      const months = [...new Set(cmp.diem.map((x) => x[0]))];
      const cols = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
      const all = cmp.diem.flatMap((x) => [x[1], x[2]]);
      const lo = Math.floor(Math.min(...all)), hi = Math.ceil(Math.max(...all));
      chart('cScatter', {
        type: 'scatter',
        data: {
          datasets: [
            ...months.map((m, k) => ({ label: kyShort(m), data: cmp.diem.filter((x) => x[0] === m).map((x) => ({ x: x[1], y: x[2] })), backgroundColor: cols[k % cols.length] + '55', pointRadius: 1.6, borderWidth: 0 })),
            { label: 'y = x', type: 'line', data: [{ x: lo, y: lo }, { x: hi, y: hi }], borderColor: '#0f172a', borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 },
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
    const r = run() || S.meta.runs.find((x) => x.mac_dinh);
    const fc = st.city_runs[r?.ma_phien] || [];
    const lastKy = Math.max(st.city.at(-1)?.ky || 0, fc.at(-1)?.ky || 0);
    const axis = monthAxis(202001, lastKy);
    const mp = (arr) => { const m = new Map(arr.map((x) => [x.ky, x.tb])); return axis.map((k) => m.get(k) ?? null); };
    const regions = Object.keys(st.nam_khu_vuc);
    const years = [...new Set(Object.values(st.nam_khu_vuc).flat().map((x) => x.nam))].sort();
    const vals = [...S.V].filter(isNum);
    const err = errMode();
    const binLo = err ? -6 : Math.floor(Math.min(...vals)), binHi = err ? 6 : Math.ceil(Math.max(...vals));
    const bins = []; for (let b = binLo; b < binHi; b++) bins.push(b);
    const hist = bins.map((b) => vals.filter((v) => v >= b && v < b + 1).length);
    const up = st.xu_huong.slice(0, 8), down = st.xu_huong.slice(-5).reverse();
    box.innerHTML = `
      <div class="sec-h">LST trung bình toàn thành phố <span>theo tháng · °C</span></div>
      <div class="chart-box lg"><canvas id="sCity"></canvas></div>
      <div class="sec-h">Theo khu vực cũ <span>trung bình năm (GEE)</span></div>
      <div class="chart-box"><canvas id="sRegion"></canvas></div>
      <div class="sec-h">Mùa khô và mùa mưa <span>trung bình các phường</span></div>
      <div class="chart-box"><canvas id="sSeason"></canvas></div>
      <div class="sec-h">Phân bố LST các phường · ${kyShort(S.ky)} <span>${err ? 'sai số' : 'số phường theo khoảng 1 °C'}</span></div>
      <div class="chart-box sm"><canvas id="sHist"></canvas></div>
      <div class="sec-h">Nóng lên nhanh nhất <span>°C/năm · hồi quy 2020–2026</span></div>
      <div class="bars" id="sUp">${up.map((x) => `<div class="b"><span>${esc(x.ten)}</span><i style="width:${clamp(x.slope / (up[0].slope || 1), 0.03, 1) * 100}%;background:linear-gradient(90deg,#fb923c,#dc2626)"></i><b>${signed(x.slope, 2)}</b></div>`).join('')}</div>
      <div class="sec-h">Ít tăng nhất / đang giảm</div>
      <div class="bars">${down.map((x) => `<div class="b"><span>${esc(x.ten)}</span><i style="width:${clamp(Math.abs(x.slope) / (Math.abs(down[0].slope) || 1), 0.03, 1) * 100}%;background:linear-gradient(90deg,#60a5fa,#2563eb)"></i><b>${signed(x.slope, 2)}</b></div>`).join('')}</div>
      <p class="note">Xu hướng tính bằng hàm <code>regr_slope</code> trong view <code>v_xu_huong_phuong</code>; tháng có ảnh khác nhau giữa các năm nên chỉ mang tính tham khảo.</p>`;
    box.classList.remove('anim'); void box.offsetWidth; box.classList.add('anim');
    $$('#sUp .b').forEach((b, k) => b.addEventListener('click', () => { const i = wardIndex.get(up[k].ma_xa); if (i !== undefined) selectWard(i, { fly: true }); }));
    chart('sCity', {
      type: 'line',
      data: {
        labels: axis.map(kyShort),
        datasets: [
          { label: 'GEE hiện trạng', data: mp(st.city), borderColor: '#dc2626', backgroundColor: '#dc2626', pointRadius: 2.5, borderWidth: 2, spanGaps: true, tension: 0.25 },
          { label: r ? r.ten : 'Dự báo', data: mp(fc), borderColor: '#4f46e5', backgroundColor: '#4f46e5', borderDash: [6, 4], pointRadius: 2.5, borderWidth: 2, spanGaps: true, tension: 0.25 },
        ],
      },
      options: { interaction: { mode: 'index', intersect: false }, plugins: { nowLine: { index: axis.indexOf(S.ky) }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 2)} °C` } } }, scales: { x: { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } } },
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

  // ───────────────────────── Tab: Thời tiết 7 ngày ─────────────────────────
  async function renderWeatherTab() {
    const box = $('#tab-weather');
    const p = S.selected !== null ? S.wards.features[S.selected].properties : null;
    const [lon, lat] = p ? p.tam : [106.70, 10.776];
    const where = p ? `${p.loai} ${p.ten_xa}` : 'Trung tâm TP.HCM';
    box.innerHTML = `<div class="empty"><div class="ic"><i class="fa-solid fa-circle-notch fa-spin"></i></div><p>Đang lấy dự báo thời tiết cho ${esc(where)}…</p></div>`;
    try {
      const d = await api(`/weather?lat=${lat}&lon=${lon}`);
      const days = d.ngay;
      const wd = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
      box.innerHTML = `
        <div class="w-head"><div class="ic" style="background:linear-gradient(135deg,#0ea5e9,#2563eb)"><i class="fa-solid fa-cloud-sun"></i></div>
          <div><h3>${esc(where)}</h3><p>7 ngày tới · nguồn ${esc(d.nguon)}</p></div></div>
        <div class="fc-days">${days.map((x, i) => {
          const dt = new Date(x.ngay + 'T12:00:00+07:00');
          const lv = levelOf(x.lst);
          const ic = x.buc_xa > 230 ? '☀️' : x.buc_xa > 170 ? '⛅' : '🌧️';
          return `<div class="fc-day${i === 0 ? ' today' : ''}"><div class="d">${i === 0 ? 'Hôm nay' : `${wd[dt.getDay()]} ${dt.getDate()}/${dt.getMonth() + 1}`}</div>
            <div class="ic">${ic}</div><div class="l" style="color:${lv ? lv.mau : 'inherit'}">${fmt(x.lst, 0)}°</div><div class="a">${fmt(x.t_max, 0)}°/${fmt(x.t_min, 0)}°</div></div>`;
        }).join('')}</div>
        <div class="sec-h">Nhiệt độ không khí và LST ước tính <span>°C</span></div>
        <div class="chart-box"><canvas id="cWeather"></canvas></div>
        <div class="callout"><b>Cách ước tính:</b> LST ≈ nhiệt độ không khí cao nhất + 3,5 + 0,008 × bức xạ mặt trời (W/m²). Đây là ước tính nhanh theo thời tiết, khác với dự báo LST từ ảnh vệ tinh ở tab Mô hình. Số liệu được lưu vào bảng <code>thoi_tiet_du_bao</code>.</div>`;
      box.classList.remove('anim'); void box.offsetWidth; box.classList.add('anim');
      chart('cWeather', {
        type: 'line',
        data: {
          labels: days.map((x) => { const dt = new Date(x.ngay + 'T12:00:00+07:00'); return `${dt.getDate()}/${dt.getMonth() + 1}`; }),
          datasets: [
            { label: 'LST ước tính', data: days.map((x) => x.lst), borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,.12)', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 3 },
            { label: 'Không khí cao nhất', data: days.map((x) => x.t_max), borderColor: '#f59e0b', borderDash: [5, 3], tension: 0.3, pointRadius: 2 },
            { label: 'Không khí thấp nhất', data: days.map((x) => x.t_min), borderColor: '#3b82f6', borderDash: [5, 3], tension: 0.3, pointRadius: 2 },
          ],
        },
        options: { interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => v + '°' } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.raw, 1)} °C` } } } },
      });
    } catch (e) {
      box.innerHTML = `<div class="empty"><div class="ic"><i class="fa-solid fa-wifi"></i></div><h3>Chưa lấy được dự báo thời tiết</h3><p>${esc(e.message)}. Kiểm tra kết nối Internet rồi thử lại.</p><button class="btn" id="wxRetry"><i class="fa-solid fa-rotate"></i>Thử lại</button></div>`;
      $('#wxRetry')?.addEventListener('click', renderWeatherTab);
    }
  }

  // ───────────────────────── Thanh điều hướng dọc & ngăn kéo ─────────────────────────
  const PANE_TITLE = { overview: 'Cảnh báo & xếp hạng', ward: 'Phường/xã', model: 'Mô hình dự báo', stats: 'Thống kê', weather: 'Thời tiết 7 ngày' };
  function showTab(name) {
    S.tab = name;
    $$('#rail button[data-pane]').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
    $$('#drawer .pane').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    $('#drTitle').textContent = PANE_TITLE[name] || '';
    if (name === 'model') renderModelTab();
    if (name === 'stats') renderStatsTab();
    if (name === 'weather') renderWeatherTab();
  }
  const drawerOpen = () => !$('#layout').classList.contains('no-drawer');
  const overlayDrawer = () => window.innerWidth <= 1100;      // màn hẹp: ngăn kéo nổi đè lên bản đồ
  function openRight() {
    if (drawerOpen()) return;
    $('#layout').classList.remove('no-drawer');
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
    showTab(b.dataset.pane);
    openRight();
  });
  $('#drClose').addEventListener('click', closeDrawer);
  window.addEventListener('resize', debounce(() => { map.invalidateSize(); markStripes(); }, 150));

  // ───────────────────────── Chế độ & mô hình ─────────────────────────
  async function setMode(mode, opts = {}) {
    stop();
    S.mode = mode;
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#runPick').hidden = mode !== 'run';
    if (mode === 'run') await ensureRunSeries(S.runId);
    buildFrames();
    let i;
    if (opts.ky && S.frames.includes(opts.ky)) i = S.frames.indexOf(opts.ky);
    else if (mode === 'run') { const r = run(); const f = r.months.findIndex((m) => m.tap === 'future'); i = f >= 0 ? f : 0; }
    else i = S.frames.length - 1;
    markStripes();
    await setFrame(i);
    bus.emit('mode', mode);
  }
  async function chooseRun(id) {
    const r = S.meta.runs.find((x) => x.ma_phien === id);
    if (!r) return;
    const keep = S.ky;
    S.runId = id;
    $('#runSel').value = String(id);
    if (r.ma_loai === 'GIA_LAP') S.cmp = 'pred';
    busy(true, 'Đang tải kết quả ' + r.ten_mo_hinh + '…');
    try { await ensureRunSeries(id); } finally { busy(false); }
    buildStripes();
    await setMode('run', { ky: keep });
    if (S.tab === 'model') renderModelTab();
    if (S.tab === 'ward') renderWardTab();
    toast(`Đang xem: ${r.ten}`, 'info', 2200);
  }
  $('#modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.mode !== S.mode) setMode(b.dataset.mode, { ky: S.ky }); });
  $('#runSel').addEventListener('change', (e) => chooseRun(+e.target.value));
  $('#cmpSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.cmp === S.cmp) return;
    S.cmp = b.dataset.cmp;
    $$('#cmpSeg button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });

  // Công cụ bản đồ
  const homeBounds = () => S.meta?.home || [[10.33, 106.33], [11.52, 107.6]];
  // chừa chỗ cho thẻ "Đang xem" (trái), công cụ + chú giải (phải), dock thời gian (dưới)
  const fitPad = () => (window.innerWidth <= 820
    ? { paddingTopLeft: [20, 150], paddingBottomRight: [20, 120] }
    : { paddingTopLeft: [window.innerWidth <= 1360 ? 330 : 360, 30], paddingBottomRight: [110, 120] });
  function flyHome(dur = 1.1) { map.flyToBounds(homeBounds(), { ...fitPad(), duration: reduceMotion ? 0 : dur }); }
  $('#btnHome').addEventListener('click', () => flyHome());
  $('#btnZoomIn').addEventListener('click', () => map.zoomIn());
  $('#btnZoomOut').addEventListener('click', () => map.zoomOut());
  $('#baseSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.base !== S.base) setBase(b.dataset.base); });
  $('#opRange').addEventListener('input', (e) => {
    S.opacity = +e.target.value / 100;
    $('#opVal').textContent = e.target.value + '%';
    imgLayers[imgFront]?.setOpacity(S.opacity);
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
    if (e.target.closest('input, select, textarea') || document.body.classList.contains('mode-3d')) return;
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
      return `${g}<button data-i="${i}" role="option"><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></button>`;
    }).join('');
    sRes.classList.add('open');
  }
  const remoteSearch = debounce(async (q, tok) => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=vn&limit=6&accept-language=vi&viewbox=106.3,11.6,107.7,10.3&bounded=1`);
      const j = await r.json();
      if (tok !== sToken) return;
      sItems = sItems.filter((x) => x.kind === 'ward').concat(j.map((x) => ({ kind: 'place', grp: 'Địa điểm (OpenStreetMap)', lat: +x.lat, lon: +x.lon, title: x.name || x.display_name.split(',')[0], sub: x.display_name })));
      renderSearch();
    } catch { /* bỏ qua lỗi mạng: vẫn còn kết quả phường/xã */ }
  }, 450);
  sInput.addEventListener('input', () => {
    const q = sInput.value.trim();
    const tok = ++sToken;
    if (q.length < 2) { sRes.classList.remove('open'); return; }
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      let lat = +m[1], lon = +m[2];
      if (lat > 90 || (lat > 50 && lon < 50)) [lat, lon] = [lon, lat];
      sItems = [{ kind: 'coord', grp: 'Toạ độ', lat, lon, title: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, sub: 'Đi tới toạ độ và tra cứu LST' }];
      return renderSearch();
    }
    const f = fold(q);
    sItems = S.wards.features.filter((x) => fold(`${x.properties.loai} ${x.properties.ten_xa}`).includes(f) || fold(x.properties.sap_nhap).includes(f))
      .slice(0, 8).map((x) => ({ kind: 'ward', grp: 'Phường/xã (ranh giới mới)', i: x.properties.i, title: `${x.properties.loai} ${x.properties.ten_xa}`, sub: `${x.properties.khu_vuc}${fold(x.properties.sap_nhap).includes(f) && !fold(x.properties.ten_xa).includes(f) ? ' · gồm ' + x.properties.sap_nhap : ''}` }));
    renderSearch();
    if (q.length >= 3) remoteSearch(q, tok);
  });
  function chooseSearch(i) {
    const it = sItems[i];
    if (!it) return;
    sRes.classList.remove('open');
    sInput.value = it.title;
    sInput.blur();
    if (it.kind === 'ward') selectWard(it.i, { fly: true });
    else { map.flyTo([it.lat, it.lon], 14, { duration: reduceMotion ? 0 : 1 }); pickPoint(it.lat, it.lon, { fly: false }); }
  }
  sInput.addEventListener('keydown', (e) => {
    const btns = $$('button', sRes);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!btns.length) return;
      sActive = (sActive + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach((b, k) => b.classList.toggle('active', k === sActive));
    } else if (e.key === 'Enter') { chooseSearch(sActive >= 0 ? +btns[sActive].dataset.i : 0); }
    else if (e.key === 'Escape') sRes.classList.remove('open');
  });
  sInput.addEventListener('focus', () => { if (sInput.value.trim().length >= 2 && sItems.length) sRes.classList.add('open'); });
  sRes.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) chooseSearch(+b.dataset.i); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) sRes.classList.remove('open'); });

  // ───────────────────────── Khởi động ─────────────────────────
  function splash(p, text, err) {
    $('#spFill').style.width = p + '%';
    const t = $('#spText');
    t.textContent = text;
    t.classList.toggle('err', !!err);
  }
  (function splashStripes() {
    const box = $('#spStripes');
    const pal = ['#0000FF', '#0066FF', '#00FFFF', '#00FF00', '#FFFF00', '#FFCC00', '#FF6600', '#FF0000'];
    let h = '';
    for (let i = 0; i < 26; i++) {
      const t = 0.5 + 0.4 * Math.sin(i / 25 * Math.PI * 2 - 1.2) + 0.1 * Math.sin(i * 1.7);
      const c = rampAt(pal.map(hexToRgb), clamp(t, 0, 1));
      h += `<i style="height:${18 + clamp(t, 0, 1) * 56}px;background:rgb(${c});animation-delay:${i * 35}ms"></i>`;
    }
    box.innerHTML = h;
  })();

  async function init() {
    const pill = $('#dbStatus');
    const me = await window.Auth.require();            // chưa đăng nhập → chuyển sang login.html
    if (!me) return;
    S.me = me;
    try {
      splash(12, 'Đang kết nối PostgreSQL/PostGIS…');
      const h = await api('/health');
      pill.classList.add('ok');
      pill.querySelector('.txt').textContent = h.static ? 'Demo' : `PostGIS ${String(h.postgis).split(' ')[0]}`;
      if (h.static) pill.title = 'Bản demo tĩnh: dữ liệu xuất sẵn từ CSDL PostgreSQL/PostGIS';
      pill.title = `PostgreSQL ${h.pg} · PostGIS ${h.postgis}`;
      if (!h.schema_ok) throw new Error('CSDL chưa có schema “vientham”. Chạy: python database/etl/nap_du_lieu.py rồi du_bao_lst.py');
      splash(30, 'Đang tải ranh giới 168 phường/xã và danh mục ảnh…');
      const [meta, wards, prov, gee] = await Promise.all([api('/meta'), api('/wards'), api('/boundary'), api('/series?chi_so=LST')]);
      S.meta = meta; S.wards = wards; S.province = prov; S.gee = gee; S.N = wards.features.length;
      wards.features.forEach((f) => wardIndex.set(f.properties.ma_xa, f.properties.i));
      const L0 = meta.indices.LST;
      if (!L0 || !L0.gee.length) throw new Error('Chưa có ảnh LST trong CSDL. Chạy: python database/etl/nap_du_lieu.py');
      LST = L0; PAL = LST.palette.map(hexToRgb);
      $('#thrRange').value = S.thr;
      const best = meta.runs.find((r) => r.mac_dinh) || meta.runs.find((r) => r.ma_loai === 'MO_HINH') || meta.runs[0];
      S.runId = best?.ma_phien ?? null;
      const groups = [['MO_HINH', 'Mô hình dự báo'], ['GIA_LAP', 'Kịch bản giả lập']];
      $('#runSel').innerHTML = groups.map(([k, g]) => {
        const rs = meta.runs.filter((r) => r.ma_loai === k);
        return rs.length ? `<optgroup label="${g}">${rs.map((r) => `<option value="${r.ma_phien}">${esc(r.ten_mo_hinh)}${r.mac_dinh ? ' ★ tốt nhất' : ''}${k === 'GIA_LAP' ? ' · phủ xanh' : ''}${r.metrics.test ? ` · RMSE ${fmt(r.metrics.test.rmse, 2)}` : ''}</option>`).join('')}</optgroup>` : '';
      }).join('');
      if (S.runId !== null) $('#runSel').value = String(S.runId); else $('#modeSeg [data-mode="run"]').disabled = true;

      splash(55, 'Đang dựng bản đồ…');
      setBase('google');                                  // mặc định Google Map như web cũ
      const ob = meta.overlay.bounds;
      const bounds = [[ob[1], ob[0]], [ob[3], ob[2]]];
      for (let k = 0; k < 2; k++) {
        imgLayers[k] = L.imageOverlay(EMPTY, bounds, { pane: 'raster', opacity: 0, interactive: false, className: 'lst-img' }).addTo(map);
      }
      addProvince();
      buildWardLayer();
      if (overlayDrawer()) closeDrawer(); else showTab('overview');
      map.invalidateSize();
      map.fitBounds(homeBounds(), fitPad());
      buildFrames();
      S.frameI = S.frames.length - 1;
      S.ky = S.frames[S.frameI];
      buildStripes();
      renderWardTab();

      splash(78, 'Đang giải mã ảnh nhiệt mới nhất…');
      await decodePng(geeItem(S.ky).url, LST.encode);
      await render();
      if (S.runId !== null) ensureRunSeries(S.runId).catch(() => {});   // tải trước để chuyển sang Dự báo tức thì

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
    S, map, bus, api, colorAt, errAt, css, levelOf, kyText, kyShort, fmt, esc, isNum, signed,
    palette: () => LST, frames: () => S.frames,
    setFrame: (i) => { stop(); return setFrame(i); },
    step: stepFrame, play, stop, isPlaying: () => S.playing,
    selectWard: (i) => selectWard(i, { fly: true, from3d: true }),
    run, errMode,
  };
  init();
})();
