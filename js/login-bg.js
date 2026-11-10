/* =====================================================================
   Bản đồ trang đăng nhập — LST TP.HCM rõ nét tự chạy qua các tháng có ảnh vệ tinh.
   · Bản đồ: 168 phường tô màu theo LST trung bình, nổi trên nền lưới kinh/vĩ độ có bóng đổ;
     mỗi lần sang tháng mới, màu đổi lần lượt từ tây sang đông như một lượt quét vệ tinh.
   · Điểm nóng: 3 phường nóng nhất tháng có vòng sáng và nhãn nhiệt độ (máy tính).
   · Bảng "đang phát": tháng, LST trung bình / cao nhất / thấp nhất, thanh tiến trình 2017–2026.
   · Chân bản đồ: mỗi cột là một phường (xếp tây → đông như bản đồ), cao theo LST, có số °C mờ.
   Vẽ trong khung #stage (không phải cả cửa sổ) nên trên điện thoại bản đồ nằm gọn phía trên
   tấm đăng nhập. Dữ liệu: login-bg.json (database/tao_nen_dang_nhap.js) — chỉ số tổng hợp, không tên phường.
   ===================================================================== */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const LO = 27, HI = 45;                                  // thang chiều cao cột (°C)
  const HOLD = 2800, SWEEP = 1100, DUR = 800;              // ms: mỗi tháng · thời gian quét · thời gian đổi màu 1 phường
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches || (window.LSTSettings && LSTSettings.get().motion === false);
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const palette = () => (window.LSTSettings ? LSTSettings.palette() : ['#0000FF', '#0066FF', '#00FFFF', '#00FF00', '#FFFF00', '#FFCC00', '#FF6600', '#FF0000']).map(hex);
  let PAL = palette();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rgbAt = (v) => {
    const t = clamp((v - 25) / 20, 0, 1), x = t * (PAL.length - 1), i = Math.min(Math.floor(x), PAL.length - 2), f = x - i;
    return [0, 1, 2].map((j) => Math.round(PAL[i][j] + (PAL[i + 1][j] - PAL[i][j]) * f));
  };
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const fmt1 = (v) => (Number.isFinite(v) ? v.toFixed(1).replace('.', ',') : '–');
  const kyText = (k) => `Tháng ${k % 100}/${Math.floor(k / 100)}`;

  const stage = $('#stage');
  const mapCv = $('#bgMap'), fxCv = $('#bgFx'), eqCv = $('#eq');
  const mx = mapCv.getContext('2d'), fx = fxCv.getContext('2d'), ex = eqCv.getContext('2d');
  const under = document.createElement('canvas');           // lớp nền tĩnh: lưới kinh/vĩ độ + bóng đổ của bản đồ
  const ux = under.getContext('2d');
  let D = null;                     // dữ liệu
  let W = 0, H = 0, dpr = 1, mob = false, paths = [], border = null, cen = [], xr = [], order = [];
  let mi = 0, from = null, to = null, shown = null, t0 = 0, nextAt = 0;
  let cols = [], hot = [], avoid = [], colsTop = 0, sweepX = [0, 0];

  // ── Chuẩn bị hình học theo kích thước khung ──
  function layout() {
    W = stage.clientWidth; H = stage.clientHeight;
    if (!W || !H) return;
    mob = W < 700 || window.innerWidth <= 760;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const [cv, g] of [[mapCv, mx], [fxCv, fx], [under, ux]]) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0); }
    const eh = eqCv.clientHeight || 124;
    eqCv.width = Math.round(W * dpr); eqCv.height = Math.round(eh * dpr); ex.setTransform(dpr, 0, 0, dpr, 0, 0);
    colsTop = H - eh - (parseFloat(getComputedStyle(eqCv).bottom) || 0);
    // vùng chữ nổi trên bản đồ (để nhãn điểm nóng / nhãn lưới tránh ra)
    const sr = stage.getBoundingClientRect();
    avoid = ['.st-head', '.st-hud', '.st-scale'].map((q) => $(q)).filter((el) => el && el.offsetParent).map((el) => {
      const r = el.getBoundingClientRect();
      return [r.left - sr.left - 6, r.top - sr.top - 6, r.right - sr.left + 6, r.bottom - sr.top + 6];
    });
    if (!D) return;
    const [x0, y0, x1, y1] = D.bbox;
    const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
    // khung đặt bản đồ: chừa chỗ cho tiêu đề phía trên và cột nhiệt độ phía dưới
    const head = $('.st-head');
    const headB = head && head.offsetParent ? head.offsetTop + head.offsetHeight + 14 : 84;
    const top = mob ? 80 : Math.max(84, headB), bottom = colsTop - (mob ? 4 : 16), padX = mob ? 10 : 30;
    const availW = W - padX * 2, availH = bottom - top;
    const s = Math.min(availW / ((x1 - x0) * k), availH / (y1 - y0));
    const ox = padX + (availW - (x1 - x0) * k * s) / 2 + (mob ? 0 : W * 0.02), oy = top + (availH - (y1 - y0) * s) / 2;
    const P = (x, y) => [ox + (x - x0) * k * s, oy + (y1 - y) * s];
    border = new Path2D();
    paths = D.wards.map((rings, i) => {
      const p = new Path2D();
      let sx = 0, sy = 0, n = 0;
      rings.forEach((ring) => {
        ring.forEach(([x, y], j) => { const q = P(x, y); if (j) p.lineTo(q[0], q[1]); else p.moveTo(q[0], q[1]); sx += q[0]; sy += q[1]; n++; });
        p.closePath();
      });
      border.addPath(p);
      cen[i] = n ? [sx / n, sy / n] : null;
      return p;
    });
    const xs = cen.filter(Boolean).map((c) => c[0]);
    const xa = Math.min(...xs), xb = Math.max(...xs);
    sweepX = [xa, xb];
    xr = cen.map((c) => (c ? (c[0] - xa) / ((xb - xa) || 1) : 0));
    // cột chân bản đồ: chọn đều các phường theo thứ tự tây → đông
    order = cen.map((c, i) => [c, i]).filter((x) => x[0]).sort((a, b) => a[0][0] - b[0][0]).map((x) => x[1]);
    const n = clamp(Math.round(W / (mob ? 26 : 34)), 12, 44);
    const keep = cols;
    cols = Array.from({ length: n }, (_, j) => {
      const w = order[Math.floor((j + 0.5) / n * order.length)];
      const old = keep.find((c) => c.w === w);
      return old || { w, h: 0, v: NaN, ph: Math.random() * 6.28, f1: 0.6 + Math.random() * 0.9, f2: 1.7 + Math.random() * 1.6, lab: '', labT: 0 };
    });
    // thước tỉ lệ: 1 km theo phương đông–tây = s / 111,32 px
    const pxKm = s / 111.32;
    const km = [5, 10, 20, 25, 50].find((q) => q * pxKm >= 64) || 50;
    const bar = $('#stScale .bar');
    if (bar) { bar.style.width = Math.round(km * pxKm) + 'px'; $('#stScaleT').textContent = `${km} km`; }
    drawUnder(P, x0, y0, x1, y1);
    drawMap(performance.now(), true);
  }
  const hitAvoid = (x0, y0, x1, y1) => avoid.some((r) => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);

  /** Lưới kinh/vĩ độ (mỗi 0,25°) + bóng đổ dưới bản đồ — vẽ một lần mỗi khi đổi kích thước/giao diện */
  function drawUnder(P, x0, y0, x1, y1) {
    const dk = dark();
    ux.clearRect(0, 0, W, H);
    ux.lineWidth = 1;
    ux.strokeStyle = dk ? 'rgba(148,163,184,.09)' : 'rgba(15,23,42,.07)';
    ux.font = '500 10px Inter, system-ui, sans-serif';
    ux.fillStyle = dk ? 'rgba(148,163,184,.55)' : 'rgba(71,85,105,.6)';
    const st = 0.25;
    for (let lon = Math.ceil((x0 - 1) / st) * st; lon <= x1 + 1; lon += st) {
      const x = Math.round(P(lon, y0)[0]) + 0.5;
      if (x < 0 || x > W) continue;
      ux.beginPath(); ux.moveTo(x, 0); ux.lineTo(x, colsTop); ux.stroke();
      if (!mob) {
        const t = `${lon.toFixed(2).replace('.', ',')}°Đ`, tw = ux.measureText(t).width;
        if (x + 4 + tw < W - 4 && !hitAvoid(x + 2, colsTop - 18, x + 6 + tw, colsTop - 4)) ux.fillText(t, x + 4, colsTop - 7);
      }
    }
    for (let lat = Math.ceil((y0 - 1) / st) * st; lat <= y1 + 1; lat += st) {
      const y = Math.round(P(x0, lat)[1]) + 0.5;
      if (y < 0 || y > colsTop) continue;
      ux.beginPath(); ux.moveTo(0, y); ux.lineTo(W, y); ux.stroke();
      if (!mob) {
        const t = `${lat.toFixed(2).replace('.', ',')}°B`;
        if (y > 14 && y < colsTop - 26 && !hitAvoid(4, y - 14, 60, y - 2)) ux.fillText(t, 8, y - 4);
      }
    }
    // bóng đổ mềm: bản đồ như một tấm nổi trên nền lưới
    ux.save();
    ux.shadowColor = dk ? 'rgba(0,0,0,.6)' : 'rgba(30,41,59,.26)';
    ux.shadowBlur = mob ? 14 : 26;
    ux.shadowOffsetY = mob ? 5 : 10;
    ux.fillStyle = dk ? '#0b1322' : '#f1f5f9';
    ux.fill(border);
    ux.restore();
  }

  // ── Dữ liệu tháng ──
  const monthVals = (j) => D.v[j];
  function stats(V) {
    let s = 0, n = 0, hi = -Infinity, lo = Infinity;
    V.forEach((v) => { if (Number.isFinite(v)) { s += v; n++; hi = Math.max(hi, v); lo = Math.min(lo, v); } });
    return { mean: n ? s / n : NaN, max: hi, min: lo };
  }
  function goMonth(j, now, instant) {
    mi = (j + D.months.length) % D.months.length;
    from = shown ? Float32Array.from(shown) : null;
    const raw = monthVals(mi);
    to = Float32Array.from(raw, (v, i) => (v === null ? (from ? from[i] : NaN) : v));     // thiếu (mây) → giữ màu cũ
    if (!from || instant) { from = Float32Array.from(to); }
    shown = Float32Array.from(from);
    t0 = now;
    nextAt = now + HOLD;
    // 3 điểm nóng
    hot = [...to].map((v, i) => [v, i]).filter((x) => Number.isFinite(x[0]) && cen[x[1]]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x, r) => ({ i: x[1], v: x[0], r }));
    updateHud(to);
  }

  // ── Bảng "đang phát" ──
  function updateHud(V) {
    const st = stats(V);
    const ky = D.months[mi];
    $('#hudMonth').textContent = mob ? `${ky % 100}/${Math.floor(ky / 100)}` : kyText(ky);
    $('#hudMean').textContent = fmt1(st.mean) + '°';
    $('#hudMax').textContent = fmt1(st.max) + '°';
    $('#hudMin').textContent = fmt1(st.min) + '°';
    const a = D.months[0], b = D.months.at(-1);
    const idx = (k) => Math.floor(k / 100) * 12 + (k % 100);
    const cur = $('#hudCur');
    if (cur) cur.style.left = ((idx(ky) - idx(a)) / ((idx(b) - idx(a)) || 1) * 100).toFixed(2) + '%';
    const m = ky % 100;
    $('#hudSeason').textContent = m >= 5 && m <= 11 ? 'Mùa mưa' : 'Mùa khô';
    $('#hudMeanSw').style.background = `rgb(${rgbAt(st.mean)})`;
  }
  function buildTrack() {
    const a = Math.floor(D.months[0] / 100), b = Math.floor(D.months.at(-1) / 100);
    const idx = (k) => Math.floor(k / 100) * 12 + (k % 100);
    const i0 = idx(D.months[0]), i1 = idx(D.months.at(-1));
    const ticks = D.months.map((k) => `<i style="left:${((idx(k) - i0) / ((i1 - i0) || 1) * 100).toFixed(2)}%"></i>`).join('');
    const years = [];
    for (let y = a; y <= b; y += (b - a > 6 ? 3 : 1)) years.push(`<span style="left:${((y * 12 + 1 - i0) / ((i1 - i0) || 1) * 100).toFixed(2)}%">${y}</span>`);
    $('#hudTrack').innerHTML = `<div class="tk">${ticks}<b id="hudCur"></b></div><div class="yr">${years.join('')}</div>`;
    const fm = $('#factMonths');
    if (fm) fm.textContent = `${D.months.length} tháng`;
  }

  // ── Vẽ bản đồ (chỉ khi đang đổi màu) ──
  let mapBusy = true;
  function drawMap(now, force) {
    if (!D || !shown || !paths.length) return;
    let moving = false;
    for (let i = 0; i < shown.length; i++) {
      const p = clamp((now - t0 - xr[i] * SWEEP) / DUR, 0, 1);
      if (p < 1) moving = true;
      const a = from[i], b = to[i];
      shown[i] = !Number.isFinite(a) ? b : !Number.isFinite(b) ? a : a + (b - a) * ease(p);
    }
    if (!moving && !mapBusy && !force) return;
    mapBusy = moving;
    mx.clearRect(0, 0, W, H);
    mx.drawImage(under, 0, 0, W, H);
    for (let i = 0; i < paths.length; i++) {
      const v = shown[i];
      mx.fillStyle = Number.isFinite(v) ? `rgb(${rgbAt(v)})` : (dark() ? '#1e293b' : '#cbd5e1');
      mx.fill(paths[i]);
    }
    mx.lineWidth = mob ? 0.5 : 0.7;
    mx.strokeStyle = dark() ? 'rgba(11,18,32,.6)' : 'rgba(255,255,255,.75)';
    mx.stroke(border);
  }

  // ── Lớp nét: vạch quét + điểm nóng ──
  function drawFx(now) {
    fx.clearRect(0, 0, W, H);
    if (!D || !cen.length) return;
    const el = now - t0;
    const [xa, xb] = sweepX;
    if (el < SWEEP + DUR * 0.6) {                                   // vạch quét vệ tinh
      const x = xa + (xb - xa) * clamp(el / SWEEP, 0, 1);
      const c = dark() ? '125,211,252' : '37,99,235';
      const fade = el > SWEEP ? 1 - (el - SWEEP) / (DUR * 0.6) : 1;
      const g = fx.createLinearGradient(x - 90, 0, x + 2, 0);
      g.addColorStop(0, `rgba(${c},0)`); g.addColorStop(0.9, `rgba(${c},${0.08 * fade})`); g.addColorStop(1, `rgba(${c},${0.4 * fade})`);
      fx.save();
      fx.fillStyle = g;
      fx.fillRect(x - 90, 0, 92, colsTop);
      fx.globalCompositeOperation = 'destination-in';                // mờ dần ở mép trên và dưới
      const v = fx.createLinearGradient(0, 0, 0, colsTop);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(0.15, 'rgba(0,0,0,1)'); v.addColorStop(0.85, 'rgba(0,0,0,1)'); v.addColorStop(1, 'rgba(0,0,0,0)');
      fx.fillStyle = v;
      fx.fillRect(x - 90, 0, 92, colsTop);
      fx.restore();
    }
    if (mob) return;                                                // điện thoại: bản đồ nhỏ, bỏ nhãn điểm nóng cho gọn
    const placed = [];
    hot.forEach((h) => {                                            // điểm nóng hiện ra sau khi vạch quét đi qua
      const c = cen[h.i];
      const txt = fmt1(h.v) + '°C';
      fx.font = '600 11px Inter, system-ui, sans-serif';
      const tw = fx.measureText(txt).width + 12, lx = c[0] + 9, ly = c[1] - 22;
      if (ly < 8 || ly + 19 > colsTop - 4 || lx + tw > W - 4 || hitAvoid(lx, ly, lx + tw, ly + 19)) return;
      // hai điểm nóng sát nhau: chỉ giữ nhãn của điểm nóng hơn (tránh nhãn chồng lên nhau)
      if (placed.some((r) => lx < r[2] + 4 && lx + tw > r[0] - 4 && ly < r[3] + 4 && ly + 19 > r[1] - 4)) return;
      placed.push([lx, ly, lx + tw, ly + 19]);
      const a = clamp((el - xr[h.i] * SWEEP - DUR * 0.5) / 400, 0, 1);
      if (a <= 0) return;
      const pulse = (now / 1400 + h.r * 0.33) % 1;
      fx.globalAlpha = a;
      fx.strokeStyle = `rgba(220,38,38,${(1 - pulse) * 0.8})`;
      fx.lineWidth = 1.6;
      fx.beginPath(); fx.arc(c[0], c[1], 5 + pulse * 18, 0, Math.PI * 2); fx.stroke();
      fx.fillStyle = '#dc2626';
      fx.beginPath(); fx.arc(c[0], c[1], 3.2, 0, Math.PI * 2); fx.fill();
      fx.fillStyle = dark() ? 'rgba(17,26,46,.94)' : 'rgba(255,255,255,.96)';
      fx.strokeStyle = 'rgba(220,38,38,.55)'; fx.lineWidth = 1;
      roundRect(fx, lx, ly, tw, 19, 6); fx.fill(); fx.stroke();
      fx.fillStyle = dark() ? '#fca5a5' : '#dc2626';
      fx.fillText(txt, lx + 6, ly + 13.5);
      fx.globalAlpha = 1;
    });
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  // ── Cột nhiệt độ chân bản đồ ──
  function drawCols(now, dt) {
    const eh = eqCv.clientHeight || 124, w = W;
    ex.clearRect(0, 0, w, eh);
    if (!cols.length) return;
    const right = mob ? 50 : 82;                                       // lề phải dành cho nhãn trung bình
    const n = cols.length, gap = mob ? 3 : (n > 30 ? 5 : 4), bw = (w - 8 - right - gap * (n - 1)) / n;
    const top = mob ? 16 : 24, base = eh, span = base - top;
    const t = now / 1000, dk = dark();
    const live = !reduce();
    let sum = 0, cnt = 0;
    cols.forEach((c, j) => {
      const i = c.w;
      let v = shown ? shown[i] : NaN;
      if (!Number.isFinite(v)) v = Number.isFinite(c.v) ? c.v : 33;
      // dao động nhỏ như số đo trực tiếp (±0,4 °C), không đều nhau giữa các cột
      const jit = live ? 0.28 * Math.sin(t * c.f1 + c.ph) + 0.14 * Math.sin(t * c.f2 + c.ph * 1.7) : 0;
      const vv = v + jit;
      c.v = v;
      const target = clamp((vv - LO) / (HI - LO), 0.06, 1) * span;
      c.h += (target - c.h) * (live ? 1 - Math.exp(-dt / 120) : 1);
      sum += v; cnt++;
      const x = 4 + j * (bw + gap), y = base - c.h;
      const rgb = rgbAt(vv);
      const g = ex.createLinearGradient(0, y, 0, base);
      g.addColorStop(0, `rgba(${rgb},.95)`); g.addColorStop(1, `rgba(${rgb},${dk ? 0.16 : 0.26})`);
      ex.fillStyle = g;
      roundRect(ex, x, y, bw, c.h + 6, Math.min(5, bw / 3)); ex.fill();
      ex.fillStyle = `rgba(255,255,255,${dk ? 0.35 : 0.6})`;
      ex.fillRect(x + 2, y + 1.5, Math.max(0, bw - 4), 1.5);
      if (now - c.labT > 160) { c.labT = now; c.lab = bw > 30 ? fmt1(vv) + '°' : Math.round(vv) + '°'; }     // số cập nhật ~6 lần/giây
      ex.font = `600 ${bw > 30 ? 10.5 : mob ? 9 : 10}px Inter, system-ui, sans-serif`;
      ex.textAlign = 'center';
      ex.fillStyle = dk ? 'rgba(203,213,225,.72)' : 'rgba(51,65,85,.66)';
      ex.fillText(c.lab, x + bw / 2, y - (mob ? 4 : 6));
    });
    // đường trung bình toàn TP
    const mean = shown ? stats(shown).mean : sum / (cnt || 1);
    const my = base - clamp((mean - LO) / (HI - LO), 0.06, 1) * span;
    ex.setLineDash([5, 4]); ex.lineWidth = 1;
    ex.strokeStyle = dk ? 'rgba(226,232,240,.45)' : 'rgba(15,23,42,.35)';
    ex.beginPath(); ex.moveTo(4, my); ex.lineTo(w - right + 2, my); ex.stroke(); ex.setLineDash([]);
    ex.textAlign = 'right'; ex.font = `700 ${mob ? 10 : 10.5}px Inter, system-ui, sans-serif`;
    const lab = mob ? `TB ${Math.round(mean)}°` : `TB ${fmt1(mean)}°C`, lw = ex.measureText(lab).width + 12;
    ex.fillStyle = dk ? 'rgba(17,26,46,.92)' : 'rgba(255,255,255,.95)';
    ex.strokeStyle = dk ? 'rgba(148,163,184,.35)' : 'rgba(15,23,42,.15)';
    const ly = clamp(my - 10, 2, eh - 22);
    roundRect(ex, w - 6 - lw, ly, lw, 20, 7); ex.fill(); ex.stroke();
    ex.fillStyle = dk ? '#e2e8f0' : '#0f172a';
    ex.fillText(lab, w - 12, ly + 14);
    ex.textAlign = 'left';
  }

  // ── Vòng lặp ──
  let last = 0, looping = false;
  function frame(now) {
    const dt = Math.min(100, now - (last || now));
    last = now;
    if (D && !reduce() && now >= nextAt) goMonth(mi + 1, now);
    drawMap(now);
    drawFx(now);
    drawCols(now, dt);
    looping = !reduce();
    if (looping) requestAnimationFrame(frame);
  }
  function still() { const now = performance.now(); if (D) { t0 = now - 1e5; drawMap(now, true); } drawFx(now); drawCols(now, 1e4); }

  layout();
  requestAnimationFrame(frame);
  fetch('login-bg.json', { cache: 'force-cache' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).then((d) => {
    D = d;
    buildTrack();
    layout();
    const now = performance.now();
    goMonth(Math.max(0, D.months.length - 24), now, true);      // bắt đầu từ 2 năm gần nhất cho quen mắt
    t0 = now - 1e5;
    drawMap(now, true);
    document.body.classList.add('bg-ready');
    if (reduce()) { goMonth(D.months.length - 1, now, true); t0 = now - 1e5; still(); }
  }).catch(() => { document.body.classList.add('bg-off'); });

  // đổi kích thước khung (xoay máy, bàn phím ảo không đổi chiều cao khung vì dùng svh)
  let rsz = 0;
  const onResize = () => { cancelAnimationFrame(rsz); rsz = requestAnimationFrame(() => { layout(); if (shown) updateHud(to); if (!looping) still(); }); };
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(stage); else addEventListener('resize', onResize);
  if (window.LSTSettings) LSTSettings.on(() => {
    PAL = palette();
    mapBusy = true;
    layout();                                     // vẽ lại lưới/bóng đổ theo giao diện sáng/tối
    if (shown) updateHud(to);
    if (reduce()) still(); else if (!looping) { last = 0; requestAnimationFrame(frame); }
  });
})();
