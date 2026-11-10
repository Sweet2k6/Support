/* =====================================================================
   Chế độ 3D — khối phường/xã cao theo LST; chọn phường để NÂNG LÊN thành tấm nổi
   với cột nhiệt từng ô 480 m; chọn nhiều phường để SO SÁNH; tìm phường trong 3D.
   Three.js r13x (vendor) + OrbitControls. Dữ liệu dùng chung với app.js qua window.LSTApp
   ===================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const app = () => window.LSTApp;
  const motion = () => (app() ? app().motionOK() : true);
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let renderer, scene, camera, controls, sun, ground, grid, shadowCatcher;
  let raf = 0, running = false, built = false;
  let root, meshes = [], labelsBox;
  let hovered = null, tipFor = null, gapMode = 0, autoRotate = false, barsOn = true, cardOpen = true;
  const picked = [];                    // các phường đang chọn (thứ tự chọn)
  let lon0 = 106.95, lat0 = 10.92, kx = 109.3, ky = 110.6;
  let camTween = null, lastNow = 0;
  let sceneBox = null;                  // khung x/z của toàn bộ khối (để nhìn vừa màn hình và giới hạn tâm xoay)
  let hull = [];                        // bao lồi x/z của TP
  function convexHull(P) {               // chuỗi đơn điệu (Andrew)
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  const coarse = window.matchMedia('(pointer: coarse)').matches;    // màn hình cảm ứng
  const isPhone = () => window.innerWidth <= 820;
  // Vẽ theo nhu cầu: chỉ vẽ lại khi camera/khối/nhãn thay đổi; bóng đổ chỉ tính lại khi khối di chuyển
  let needsRender = true, shadowDirty = true, labelAnim = false, prevDrawn = false;
  const perf = { ema: 0, n: 0 };
  const invalidate = () => { needsRender = true; };
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const tmpColor = new THREE.Color();
  const BASE_T = 23;
  const LIFT = 13;                      // độ cao nâng tấm phường được chọn (cao hơn khối nóng nhất ≈ 11)
  const DIM_H = 0.45;                   // khi đang chọn: các khối còn lại thấp xuống còn 45 % để không che tấm nổi
  const SLAB = 0.7;                     // độ dày tấm khi được chọn
  const BAR_K = 0.6;                    // tỉ lệ chiều cao cột ô so với khối toàn cảnh (dùng chung → so sánh được)
  const MAX_PICK = 6;

  // chiều cao toàn cảnh: 45 °C ≈ 11 km trên vùng rộng ~140 km
  const H = (v) => (Number.isFinite(v) ? Math.max(0.4, (v - BASE_T) * 0.5) : 0.3);
  const proj = (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky];

  function colorFor(v) {
    const A = app();
    const c = A.errMode() ? A.errAt(v) : A.colorAt(v);
    return c ? tmpColor.setRGB(c[0] / 255, c[1] / 255, c[2] / 255).clone() : new THREE.Color(0xcbd5e1);
  }
  function heightFor(v) {
    return app().errMode() ? (Number.isFinite(v) ? 0.6 + Math.abs(v) * 2.6 : 0.4) : H(v);
  }
  const isPicked = (m) => picked.includes(m);

  // ───────────────────────── Khởi tạo Three.js ─────────────────────────
  function themeColors() {
    const dark = document.documentElement.dataset.theme === 'dark';
    return dark
      ? { fog: 0x0e1628, ground: 0x111a2e, grid1: 0x23314f, grid2: 0x1b2742, edge: 0xe2e8f0, prov: 0xcbd5e1, shadow: 0.35 }
      : { fog: 0xdfe7f1, ground: 0xe8eef6, grid1: 0xc7d2e0, grid2: 0xd8e1ec, edge: 0x0f172a, prov: 0x0f172a, shadow: 0.16 };
  }
  function applyTheme() {
    if (!scene) return;
    const t = themeColors();
    scene.fog.color.setHex(t.fog);
    ground.material.color.setHex(t.ground);
    shadowCatcher.material.opacity = t.shadow;
    grid.material.color.setHex(t.grid2);
    scene.traverse((o) => { if (o.userData.province) o.material.color.setHex(t.prov); });
    meshes.forEach((m) => { if (m) m.userData.edgeBase = t.edge; });
    shadowDirty = true;
    invalidate();
  }
  function initThree() {
    const canvas = $('#v3dCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth <= 820 ? 1.5 : 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // giữ mã hoá tuyến tính để màu khối đúng thang màu
    renderer.shadowMap.autoUpdate = false;              // xoay camera không cần tính lại bóng (đèn cố định) → nhẹ hơn nhiều

    const t = themeColors();
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(t.fog, 260, 560);
    camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xaebcd0, 0.85));
    sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(-70, 160, 90);
    sun.castShadow = true;
    const sm = window.innerWidth <= 820 ? 1024 : 2048;
    sun.shadow.mapSize.set(sm, sm);
    Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 10, far: 420 });
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    ground = new THREE.Mesh(new THREE.CircleGeometry(420, 64), new THREE.MeshLambertMaterial({ color: t.ground }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);
    shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.ShadowMaterial({ opacity: t.shadow }));
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -0.03;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);
    grid = new THREE.GridHelper(420, 42, t.grid1, t.grid2);
    grid.position.y = -0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    scene.add(grid);

    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = coarse ? 0.12 : 0.08;
    controls.minDistance = 28;                          // không cho chui sát vào khối (nhìn xấu, dễ lạc hướng)
    controls.maxDistance = 520;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.screenSpacePanning = false;                // kéo bằng 2 ngón / chuột phải: trượt trên mặt đất, tâm xoay không bay lên trời
    controls.rotateSpeed = coarse ? 0.7 : 0.9;
    controls.zoomSpeed = coarse ? 1 : 0.9;
    controls.panSpeed = coarse ? 0.8 : 1;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.autoRotateSpeed = 0.6;
    controls.addEventListener('start', () => { camTween = null; userMoved = true; });
    controls.addEventListener('change', invalidate);

    root = new THREE.Group();
    scene.add(root);

    labelsBox = document.createElement('div');
    labelsBox.className = 'v3d-labels';
    $('#v3d').insertBefore(labelsBox, $('.v3d-top'));

    bindPointer(canvas);
  }

  function resize() {
    if (!renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 0.75 ? 56 : camera.aspect < 1.15 ? 48 : 42;
    camera.updateProjectionMatrix();
    invalidate();
  }

  // ───────────────────────── Dựng khối phường ─────────────────────────
  function shapesOf(geom) {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    return polys.map((rings) => {
      const toV = (ring) => ring.map(([x, y]) => { const p = proj(x, y); return new THREE.Vector2(p[0], p[1]); });
      const shape = new THREE.Shape(toV(rings[0]));
      rings.slice(1).forEach((h) => shape.holes.push(new THREE.Path(toV(h))));
      return shape;
    });
  }

  function buildScene() {
    const A = app();
    const S = A.S;
    const hb = S.meta.home;
    lat0 = (hb[0][0] + hb[1][0]) / 2;
    lon0 = (hb[0][1] + hb[1][1]) / 2;
    kx = 111.32 * Math.cos(lat0 * Math.PI / 180);
    ky = 110.57;

    // hướng tách cho 3 khu vực cũ: lấy tâm từng khu so với tâm TP.HCM cũ
    const cen = {};
    S.wards.features.forEach((f) => {
      const p = f.properties;
      if (!p.so_o) return;
      const c = (cen[p.khu_vuc] ||= [0, 0, 0]);
      const q = proj(p.tam[0], p.tam[1]);
      c[0] += q[0]; c[1] += q[1]; c[2]++;
    });
    Object.values(cen).forEach((c) => { c[0] /= c[2]; c[1] /= c[2]; });
    const base = cen['TP.HCM cũ'] || [0, 0];
    const dirs = {};
    Object.entries(cen).forEach(([k, c]) => {
      const dx = c[0] - base[0], dz = c[1] - base[1], L = Math.hypot(dx, dz) || 1;
      dirs[k] = k === 'TP.HCM cũ' ? [0, 0] : [dx / L, dz / L];
    });

    const t = themeColors();
    const xs = S.wards.features.map((f) => f.properties.tam[0]);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    meshes = [];
    S.wards.features.forEach((f) => {
      const p = f.properties;
      if (!p.so_o) { meshes[p.i] = null; return; }            // Côn Đảo: ngoài vùng ảnh
      const geo = new THREE.ExtrudeGeometry(shapesOf(f.geometry), { depth: 1, bevelEnabled: false, curveSegments: 1 });
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.62, metalness: 0.04, transparent: true, opacity: 1 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.scale.y = 0.001;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 35), new THREE.LineBasicMaterial({ color: t.edge, transparent: true, opacity: 0.32 }));
      mesh.add(edges);
      const c = proj(p.tam[0], p.tam[1]);
      geo.computeBoundingSphere();
      mesh.userData = {
        i: p.i, p, edges, center: c, radius: geo.boundingSphere.radius, dir: dirs[p.khu_vuc] || [0, 0], edgeBase: t.edge,
        h: 0.001, hT: 0.6, col: new THREE.Color(0xcbd5e1), colT: new THREE.Color(0xcbd5e1),
        off: [0, 0], offT: [0, 0], y: 0, delay: (p.tam[0] - xmin) / ((xmax - xmin) || 1) * 900, t0: performance.now(),
        bars: null, cells: null,
      };
      root.add(mesh);
      meshes[p.i] = mesh;
    });

    // ranh giới tỉnh
    if (S.province) {
      const mat = new THREE.LineBasicMaterial({ color: t.prov, transparent: true, opacity: 0.6 });
      S.province.features.forEach((f) => {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        polys.forEach((rings) => {
          const pts = rings[0].map(([x, y]) => { const q = proj(x, y); return new THREE.Vector3(q[0], 0.04, -q[1]); });
          if (pts.some((v) => Math.abs(v.x) > 300 || Math.abs(v.z) > 300)) return;
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
          line.userData.province = true;
          scene.add(line);
        });
      });
    }
    const bb = new THREE.Box3();
    meshes.forEach((m) => { if (m) { m.geometry.computeBoundingBox(); bb.union(m.geometry.boundingBox); } });
    sceneBox = { minX: bb.min.x, maxX: bb.max.x, minZ: bb.min.z, maxZ: bb.max.z };
    // bao lồi của toàn bộ ranh giới (toạ độ x/z) → tính khung nhìn vừa khít theo hình dạng thật của TP
    const all = [];
    S.wards.features.forEach((f) => {
      if (!f.properties.so_o) return;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach((rings) => rings[0].forEach(([x, y]) => { const q = proj(x, y); all.push([q[0], -q[1]]); }));
    });
    hull = convexHull(all);
    built = true;
    applyFrame(true);
    resetView(false);
  }

  // ───────────────────────── Cập nhật theo khung thời gian ─────────────────────────
  function applyFrame(intro) {
    if (!built) return;
    const A = app();
    const S = A.S;
    const now = performance.now();
    meshes.forEach((m) => {
      if (!m) return;
      const v = S.V ? S.V[m.userData.i] : NaN;
      m.userData.v = v;
      m.userData.hT = heightFor(v);
      m.userData.colT = colorFor(v);
      if (intro) { m.userData.t0 = now; m.userData.h = 0.001; }
      else m.userData.delay = 0;
    });
    tipFor = null;
    updateTitles();
    renderLabels(true);
    if (picked.length) { picked.forEach(loadCells); scheduleCard(); }
    if ($('#v3dList').classList.contains('open')) renderList();
  }

  function applyLayout() {
    meshes.forEach((m) => {
      if (!m) return;
      const d = m.userData.dir;
      m.userData.offT = gapMode ? [d[0] * 16, d[1] * 16] : [0, 0];
    });
  }

  function updateTitles() {
    const A = app();
    const S = A.S;
    const r = A.run();
    let src = 'hiện trạng GEE';
    if (S.mode === 'day') src = 'dự báo ngày (giả lập)';
    else if (S.mode === 'gee' && A.isFill(S.ky)) src = 'nội suy (tháng thiếu ảnh)';
    else if (S.mode === 'run' && r) {
      if (A.errMode()) src = `sai số ${r.ten_mo_hinh} so với GEE`;
      else if (S.cmp === 'obs' && A.hasObs(S.ky)) src = 'GEE thực tế (đối chiếu)';
      else src = r.ma_loai === 'GIA_LAP' ? `giả lập ${r.ten_mo_hinh}` : `dự báo ${r.ten_mo_hinh}`;
    }
    $('#v3dSub').textContent = `${A.frameText()} · ${src} · ${meshes.filter(Boolean).length} phường/xã`;
    $('#v3dMonth').textContent = A.frameText();
    const err = A.errMode();
    const pal = err ? ['#1d4ed8', '#60a5fa', '#f1f5f9', '#f87171', '#b91c1c'] : A.palette().palette;
    const lo = err ? -5 : A.palette().min, hi = err ? 5 : A.palette().max;
    $('#v3dLgBar').style.background = `linear-gradient(90deg, ${pal.join(', ')})`;
    const ticks = err ? [-5, -2.5, 0, 2.5, 5] : [25, 30, 35, 40, 45];
    $('#v3dLgTicks').innerHTML = ticks.map((t) => `<span style="left:${(t - lo) / (hi - lo) * 100}%">${t}</span>`).join('');
    $('.v3d-legend b').textContent = err ? 'Sai số dự báo (°C) · chiều cao theo độ lớn sai số' : 'LST (°C) · chiều cao khối tỉ lệ với nhiệt độ';
  }

  // ───────────────────────── Vòng lặp vẽ ─────────────────────────
  const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const elastic = (p) => (p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
  const dummy = new THREE.Object3D();
  // tiến về đích theo hệ số a; đủ gần thì chốt đúng đích để biết là đã "đứng yên"
  const approach = (cur, goal, a, eps) => { const v = cur + (goal - cur) * a; return Math.abs(goal - v) < eps ? goal : v; };
  const colorNear = (p, q) => Math.abs(p.r - q.r) + Math.abs(p.g - q.g) + Math.abs(p.b - q.b) < 0.003;
  function loop(now) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    // hệ số làm mượt theo thời gian thực: hội tụ như nhau dù máy chạy 30 hay 144 khung/giây
    const dt = Math.min(100, now - (lastNow || now));
    lastNow = now;
    if (camTween) {
      const t = Math.min(1, (now - camTween.t0) / camTween.dur), e = easeIO(t);
      camera.position.lerpVectors(camTween.p0, camTween.p1, e);
      controls.target.lerpVectors(camTween.t0v, camTween.t1v, e);
      if (t >= 1) camTween = null;
      needsRender = true;
    }
    controls.autoRotate = autoRotate && !picked.length && !camTween;
    if (controls.update()) needsRender = true;
    keepTarget();
    const ok = motion();
    const a = ok ? 1 - Math.exp(-dt / 150) : 1;
    const aLift = ok ? 1 - Math.exp(-dt / 210) : 1;
    const anyPick = picked.length > 0;
    let geo = false, look = false;

    for (let k = 0; k < meshes.length; k++) {
      const m = meshes[k];
      if (!m) continue;
      const u = m.userData;
      const sel = isPicked(m);
      let moved = false;
      if (now - u.t0 >= u.delay) {
        const goal = sel ? SLAB : (anyPick ? u.hT * DIM_H : u.hT);   // phường được chọn: dẹt thành tấm nổi
        if (u.h !== goal) { u.h = approach(u.h, goal, a, 1e-3); moved = true; }
        if (!u.col.equals(u.colT)) {
          u.col.lerp(u.colT, a);
          if (colorNear(u.col, u.colT)) u.col.copy(u.colT);
          m.material.color.copy(u.col);
          look = true;
        }
      } else geo = true;                                   // còn chờ tới lượt mọc lên (hiệu ứng mở đầu)
      const yT = sel ? LIFT : (m === hovered ? 0.5 : 0);
      if (u.y !== yT) { u.y = approach(u.y, yT, aLift, 1e-3); moved = true; }
      if (u.off[0] !== u.offT[0] || u.off[1] !== u.offT[1]) {
        u.off[0] = approach(u.off[0], u.offT[0], a, 1e-3);
        u.off[1] = approach(u.off[1], u.offT[1], a, 1e-3);
        moved = true;
      }
      if (moved) { m.scale.y = Math.max(0.001, u.h); m.position.set(u.off[0], u.y, -u.off[1]); geo = true; }
      const mat = m.material;
      const op = anyPick ? (sel ? (barsOn && u.cells ? 0.6 : 0.95) : 0.34) : 1;
      if (mat.opacity !== op) { mat.opacity = approach(mat.opacity, op, a, 2e-3); look = true; }
      const tr = mat.opacity < 0.995;                      // khối đặc vẽ ở lượt "đục" (nhanh hơn), chỉ khối mờ mới trộn màu
      if (mat.transparent !== tr) mat.transparent = tr;
      const dw = mat.opacity > 0.9;
      if (mat.depthWrite !== dw) mat.depthWrite = dw;
      u.edges.material.opacity = anyPick && !sel ? 0.12 : (sel ? 0.95 : 0.32);
      u.edges.material.color.setHex(sel ? 0xf59e0b : u.edgeBase);
      const glow = m === hovered && !sel ? 0.2 : (sel ? 0.06 : 0);
      mat.emissive.setRGB(glow, glow * 0.85, glow * 0.5);
      const C = u.cells;
      if (C && (moved || !C.done || C.morph)) { animateCells(u, now, a); geo = true; }
    }
    if (geo) { shadowDirty = true; needsRender = true; }
    if (look) needsRender = true;

    const draw = needsRender;
    if (draw) {
      needsRender = false;
      if (shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
      renderer.render(scene, camera);
      if (prevDrawn) tune(dt);
    }
    prevDrawn = draw;
    if (draw || labelAnim) labelAnim = renderLabels(false, dt);
  }
  /** Không cho kéo tâm xoay ra khỏi vùng TP (lạc ra khoảng trống rồi không tìm lại được các khối) */
  const tgtFix = new THREE.Vector3();
  function keepTarget() {
    if (!sceneBox || camTween) return;
    const t = controls.target, B = sceneBox, m = 6;
    tgtFix.set(clamp(t.x, B.minX - m, B.maxX + m), clamp(t.y, 0, LIFT + 4), clamp(t.z, B.minZ - m, B.maxZ + m)).sub(t);
    if (tgtFix.lengthSq() > 1e-8) { t.add(tgtFix); camera.position.add(tgtFix); needsRender = true; }
  }
  /** Máy yếu (dưới ~40 khung/giây kéo dài khi đang chuyển động) → hạ dần độ phân giải vẽ, tối thiểu 1× */
  function tune(dt) {
    perf.ema = perf.n ? perf.ema * 0.94 + dt * 0.06 : dt;
    if (++perf.n < 90) return;
    perf.n = 60;
    const pr = renderer.getPixelRatio();
    if (perf.ema > 25 && pr > 1.01) {
      renderer.setPixelRatio(Math.max(1, Math.round((pr - 0.25) * 100) / 100));
      resize();
      perf.n = 0;
    }
  }
  function start() {
    if (running) return;
    running = true;
    lastNow = 0;
    prevDrawn = false;
    needsRender = shadowDirty = true;
    raf = requestAnimationFrame(loop);
  }
  function halt() {
    running = false;
    cancelAnimationFrame(raf);
  }

  // ───────────────────────── Nhãn nổi ─────────────────────────
  // Đặt nhãn bằng transform (GPU, toạ độ lẻ pixel → trôi mượt theo camera, không giật từng pixel);
  // kích thước đo MỘT lần khi đổi nội dung (không đọc layout mỗi khung); nhãn chồng nhau được
  // xếp tầng lên trên với chân chỉ xuống đúng phường thay vì ẩn/hiện chớp nháy khi xoay.
  const STEM = 7;                                        // chân nhãn tối thiểu (px)
  let labels = [];
  const labelMap = new Map();
  const v3 = new THREE.Vector3();
  function renderLabels(rebuild, dt = 16) {
    if (!labelsBox) return false;
    if (rebuild) {
      const A = app();
      const err = A.errMode();
      let set;
      if (picked.length) set = picked.slice();
      else {
        const list = meshes.filter((m) => m && Number.isFinite(m.userData.v));
        list.sort((a, b) => (err ? Math.abs(b.userData.v) - Math.abs(a.userData.v) : b.userData.v - a.userData.v));
        set = list.slice(0, 3);                            // toàn cảnh: chỉ 3 phường nóng nhất cho gọn mắt
      }
      const keep = new Set(set);
      labelMap.forEach((L, m) => { if (!keep.has(m)) { L.el.remove(); labelMap.delete(m); } });
      labels = set.map((m) => {
        let L = labelMap.get(m);
        if (!L) {
          const el = document.createElement('div');
          el.className = 'v3d-lab';
          el.innerHTML = '<span></span><i class="stem"></i>';
          labelsBox.appendChild(el);
          L = { m, el, txt: el.firstChild, stem: el.lastChild, w: 0, h: 0, dy: 0, op: 0, fresh: true, html: '', tf: '', st: '', os: '' };
          labelMap.set(m, L);
        }
        const u = m.userData;
        const html = `${A.esc(u.p.ten_xa)} <b>${err ? A.signed(u.v, 1) : A.fmt(u.v, 1)}°</b>`;
        if (L.html !== html) { L.txt.innerHTML = html; L.html = html; L.w = 0; }
        const sel = isPicked(m);
        if (L.el.classList.contains('sel') !== sel) { L.el.classList.toggle('sel', sel); L.w = 0; }
        return L;
      });
      // nhãn ưu tiên cao nằm trên cùng → chân của nhãn bị xếp tầng phía trên đi khuất sau nhãn bên dưới, không đè chữ
      labels.forEach((L, k) => { L.el.style.zIndex = String(labels.length - k); });
      labels.forEach((L) => { if (!L.w) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; } });   // gom đo một lượt
      invalidate();
    }
    if (!labels.length) return false;
    const W = window.innerWidth, Hh = window.innerHeight;
    const ok = motion();
    const k = ok ? 1 - Math.exp(-dt / 110) : 1;
    const placed = [];
    let anim = false;
    for (const L of labels) {
      const m = L.m, u = m.userData;
      if (!L.w) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
      const top = isPicked(m) ? u.y + m.scale.y + (u.cells && barsOn ? u.cells.maxH * BAR_K : 0) + 1.2 : u.y + m.scale.y + 0.8;
      v3.set(u.center[0] + u.off[0], top, -(u.center[1] + u.off[1])).project(camera);
      const vis = v3.z < 1 && Math.abs(v3.x) < 1.15 && Math.abs(v3.y) < 1.15;
      const x = (v3.x + 1) / 2 * W, y = (1 - v3.y) / 2 * Hh;
      let dy = 0;
      if (vis) {
        // đẩy nhãn lên trên các nhãn đã đặt (theo thứ tự ưu tiên cố định → không đổi chỗ qua lại)
        for (let pass = 0; pass < 8; pass++) {
          let bumped = false;
          const bottom = y - STEM - dy;
          for (const p of placed) {
            if (Math.abs(p.x - x) < (p.w + L.w) / 2 + 6 && bottom > p.top - 4 && bottom - L.h < p.bottom + 4) {
              dy = Math.max(dy, y - STEM - p.top + 4);
              bumped = true;
            }
          }
          if (!bumped) break;
        }
        placed.push({ x, w: L.w, top: y - STEM - dy - L.h, bottom: y - STEM - dy });
      }
      if (L.fresh || !ok) L.dy = dy;
      else { L.dy += (dy - L.dy) * k; if (Math.abs(dy - L.dy) < 0.3) L.dy = dy; else anim = true; }
      const opT = vis ? 1 : 0;
      if (!ok) L.op = opT;
      else { L.op += (opT - L.op) * Math.min(1, k * 1.6); if (Math.abs(opT - L.op) < 0.02) L.op = opT; else anim = true; }
      L.fresh = false;
      const lx = clamp(x - L.w / 2, 6, Math.max(6, W - L.w - 6));
      const tf = `translate3d(${lx.toFixed(1)}px,${(y - STEM - L.dy - L.h).toFixed(1)}px,0)`;
      if (tf !== L.tf) { L.el.style.transform = tf; L.tf = tf; }
      const sx = clamp(x - lx, 8, L.w - 8).toFixed(0) + 'px';
      if (sx !== L.sx) { L.stem.style.left = sx; L.sx = sx; }
      const st = `scaleY(${(STEM + L.dy).toFixed(1)})`;
      if (st !== L.st) { L.stem.style.transform = st; L.st = st; }
      const os = L.op.toFixed(2);
      if (os !== L.os) { L.el.style.opacity = os; L.el.style.visibility = L.op > 0 ? 'visible' : 'hidden'; L.os = os; }
    }
    return anim;
  }

  // ───────────────────────── Tương tác chuột / chạm ─────────────────────────
  function pick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(meshes.filter(Boolean), false);
    return hits.length ? hits[0].object : null;
  }
  function bindPointer(canvas) {
    let down = null;
    const tip = $('#v3dTip');
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; closeList(); });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || down.b !== 0) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > (e.pointerType === 'touch' ? 14 : 6)) return;     // đang kéo xoay -> không tính là nhấp
      const m = pick(e);
      if (m) toggle(m, { fly: true });              // nhấp chỗ trống không xoá lựa chọn (bỏ chọn bằng ✕, "Xoá tất cả" hoặc Esc)
    });
    // dò khối dưới chuột tối đa 1 lần mỗi khung hình; nội dung tooltip chỉ dựng lại khi đổi phường
    let hoverEv = null, hoverRaf = 0;
    const setHover = (m) => {
      if (m === hovered) return;
      hovered = m;
      canvas.style.cursor = m ? 'pointer' : 'grab';
      invalidate();
    };
    function doHover() {
      hoverRaf = 0;
      const e = hoverEv;
      if (!e || !running) return;
      const m = pick(e);
      setHover(m);
      if (!m) { tip.hidden = true; tipFor = null; return; }
      if (tipFor !== m) {
        tipFor = m;
        const A = app();
        const u = m.userData;
        const err = A.errMode();
        const lv = err ? null : A.levelOf(u.v);
        const rank = rankOf(u.i);
        tip.innerHTML = `<h4>${A.esc(u.p.loai)} ${A.esc(u.p.ten_xa)}</h4>
          <div class="r"><span>${err ? 'Sai số TB' : 'LST trung bình'}</span><b>${err ? A.signed(u.v, 2) : A.fmt(u.v, 2)} °C</b></div>
          ${rank ? `<div class="r"><span>Xếp hạng nóng</span><b>${rank}</b></div>` : ''}
          <div class="r"><span>Khu vực</span><b>${A.esc(u.p.khu_vuc)}</b></div>
          ${lv ? `<div class="r"><span>Mức</span><b style="color:${lv.mau}">${A.esc(lv.ten)}</b></div>` : ''}
          <div class="hint">${isPicked(m) ? 'Nhấp để bỏ chọn' : picked.length ? 'Nhấp để thêm vào so sánh' : 'Nhấp để nâng lên & xem cột nhiệt'}</div>`;
      }
      const flip = e.clientX > window.innerWidth - 260;
      tip.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0) ${flip ? 'translate(calc(-100% - 16px), 16px)' : 'translate(16px, 16px)'}`;
      tip.hidden = false;
    }
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons || e.pointerType === 'touch') { hoverEv = null; if (!tip.hidden) tip.hidden = true; return; }
      hoverEv = e;
      if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover);
    });
    canvas.addEventListener('pointerleave', () => { hoverEv = null; setHover(null); tip.hidden = true; tipFor = null; });
  }
  function rankOf(i) {
    const V = app().S.V;
    if (!V || !Number.isFinite(V[i])) return null;
    let r = 1, n = 0;
    for (let k = 0; k < V.length; k++) if (Number.isFinite(V[k])) { n++; if (V[k] > V[i]) r++; }
    return `${r}/${n}`;
  }

  // ───────────────────────── Chọn / so sánh phường ─────────────────────────
  function toggle(m, opts = {}) {
    if (!m) return;
    $('#v3dTip').hidden = true;
    tipFor = null;
    const k = picked.indexOf(m);
    if (k >= 0) {
      picked.splice(k, 1);
      clearCells(m);
    } else {
      if (picked.length >= MAX_PICK) { const old = picked.shift(); clearCells(old); }
      picked.push(m);
      loadCells(m);
    }
    afterPick(opts);
  }
  function selectOnly(m, opts = {}) {
    picked.splice(0).forEach(clearCells);
    if (m) { picked.push(m); loadCells(m); }
    afterPick(opts);
  }
  function afterPick(opts) {
    cardOpen = true;
    setSheet(isPhone() ? 'peek' : 'full');
    invalidate();
    refreshCard();
    renderLabels(true);
    updateCmpBtn();
    if ($('#v3dList').classList.contains('open')) renderList();
    if (opts.fly !== false) frameSelection();
    if (!picked.length && opts.fly !== false) resetView();
  }
  function clearAll(fly) {
    if (!picked.length) return;
    picked.splice(0).forEach(clearCells);
    $('#v3dCard').hidden = true;
    setSheet(sheet);
    invalidate();
    renderLabels(true);
    updateCmpBtn();
    if (fly) resetView();
  }
  function updateCmpBtn() {
    const b = $('#v3dCmpBtn');
    b.hidden = picked.length < 2;
    $('#v3dCmpN').textContent = picked.length;
    b.classList.toggle('on', picked.length >= 2 && cardOpen);
  }
  /** Điện thoại: thẻ phía dưới có 2 nấc — 'peek' (ló tên + số chính) và 'full' (đọc hết, cuộn được) */
  let sheet = 'full';
  function setSheet(st) {
    sheet = st;
    const card = $('#v3dCard'), box = $('#v3d');
    const vis = !card.hidden && picked.length > 0 && cardOpen;
    card.classList.toggle('peek', st === 'peek');
    box.classList.toggle('card-peek', vis && st === 'peek');
    box.classList.toggle('card-full', vis && st !== 'peek');
    const g = $('#v3dGrip');
    if (g) { g.setAttribute('aria-expanded', String(st !== 'peek')); g.title = st === 'peek' ? 'Mở rộng thẻ' : 'Thu gọn thẻ'; }
    if (st === 'peek') card.scrollTop = 0;
  }
  /** Đưa camera tới khung nhìn vừa đủ các phường đã chọn (không zoom sát) */
  function frameSelection() {
    if (!picked.length) return;
    const pts = picked.map((m) => ({ x: m.userData.center[0] + m.userData.offT[0], z: -(m.userData.center[1] + m.userData.offT[1]), r: m.userData.radius }));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    const spread = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.z - cz) + p.r));
    const narrow = camera.aspect < 0.75 ? 1.35 : 1;
    const dist = clamp((spread * 3 + 62) * narrow, 75, 330);   // đủ xa để thấy tấm nổi + cột + bối cảnh xung quanh
    const target = new THREE.Vector3(cx, LIFT * 0.75, cz);
    // card bên phải che một phần màn hình: dời tâm nhìn sang phải một chút
    const right = new THREE.Vector3().subVectors(camera.position, controls.target).cross(new THREE.Vector3(0, 1, 0)).normalize();
    if (window.innerWidth > 820) target.addScaledVector(right, -dist * 0.12);
    const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
    const el = 50 * Math.PI / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    flyTo(target.clone().add(dir.multiplyScalar(dist)), target, 1300);
  }
  function flyTo(pos, target, dur = 1100) {
    if (!motion()) { camera.position.copy(pos); controls.target.copy(target); return; }
    camTween = { p0: camera.position.clone(), p1: pos, t0v: controls.target.clone(), t1v: target, t0: performance.now(), dur };
  }
  function homePose(azDeg = -7.5) {
    const B = sceneBox || { minX: -70, maxX: 70, minZ: -60, maxZ: 60 };
    const target = new THREE.Vector3((B.minX + B.maxX) / 2, 0, (B.minZ + B.maxZ) / 2);
    const portrait = camera.aspect < 0.9;
    const el = (portrait ? 60 : 41) * Math.PI / 180, az = azDeg * Math.PI / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const fwd = new THREE.Vector3(-dir.x, 0, -dir.z).normalize();          // hướng nhìn chiếu xuống mặt đất
    const pts = [];
    const outline = hull.length ? hull : [[B.minX, B.minZ], [B.maxX, B.minZ], [B.maxX, B.maxZ], [B.minX, B.maxZ]];
    outline.forEach(([x, z]) => { pts.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 9, z)); });
    const Wv = window.innerWidth, Hv = window.innerHeight, ph = isPhone();
    // phần màn hình bị thanh trên / mốc thời gian + chú giải phía dưới che
    const topPx = ph ? 132 : 84, botPx = ph ? 138 : 118, sidePx = ph ? 8 : 28;
    const yTop = 1 - (2 * topPx) / Hv, yBot = -1 + (2 * botPx) / Hv, xLim = 1 - (2 * sidePx) / Wv;
    const p0 = camera.position.clone(), q0 = camera.quaternion.clone();
    const place = (d) => { camera.position.copy(target).addScaledVector(dir, d); camera.lookAt(target); camera.updateMatrixWorld(); };
    let d = 200;
    for (let pass = 0; pass < 3; pass++) {
      let lo = 40, hi = 1200;
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        place(mid);
        const ok = pts.every((p) => { v3.copy(p).project(camera); return v3.x > -xLim && v3.x < xLim && v3.y < yTop && v3.y > yBot; });
        if (ok) hi = mid; else lo = mid;
      }
      d = hi;
      // canh giữa theo chiều dọc trong phần màn hình còn trống
      place(d);
      let y0 = Infinity, y1 = -Infinity;
      pts.forEach((p) => { v3.copy(p).project(camera); y0 = Math.min(y0, v3.y); y1 = Math.max(y1, v3.y); });
      const off = (y0 + y1) / 2 - (yTop + yBot) / 2;
      if (Math.abs(off) < 0.01) break;
      target.addScaledVector(fwd, off * d * Math.tan((camera.fov * Math.PI) / 360) / Math.sin(el));
    }
    camera.position.copy(p0); camera.quaternion.copy(q0); camera.updateMatrixWorld();
    return { pos: target.clone().addScaledVector(dir, d), target, d };
  }
  /** Toàn cảnh: máy tính nhìn hướng bắc; điện thoại dọc thử vài góc xoay, chọn góc để TP (dài theo hướng
   *  tây bắc – đông nam) nằm dọc theo màn hình → khối to hơn hẳn, chỉ đổi hướng khi lợi ≥ 15 % */
  function bestHome() {
    const north = homePose(-7.5);
    let best = north;
    if (camera.aspect < 0.9) {
      for (const az of [25, 40, 55]) { const p = homePose(az); if (p.d < best.d) best = p; }
      if (best.d > north.d * 0.85) best = north;
    }
    controls.maxDistance = Math.max(520, best.d * 1.4);
    return best;
  }
  let userMoved = false;                // người dùng đã tự xoay/thu phóng → đổi kích thước màn hình không kéo camera về toàn cảnh
  function resetView(anim = true) {
    userMoved = false;
    const { pos, target } = bestHome();
    if (anim) flyTo(pos, target, 1200); else { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
  }

  // ───────────────────────── Cột nhiệt từng ô 480 m trên tấm nổi ─────────────────────────
  async function loadCells(m) {
    if (!m || !isPicked(m)) return;
    const A = app();
    const S = A.S;
    const u = m.userData;
    const tok = (u.cellTok = (u.cellTok || 0) + 1);
    const q = A.cellsQuery();
    try {
      const d = await A.api(`/cells?ma_xa=${encodeURIComponent(u.p.ma_xa)}&ky=${S.ky}${q.phien ? `&phien=${q.phien}` : ''}`);
      if (tok !== u.cellTok || !isPicked(m)) return;
      const list = d.cells.map(([lon, lat, v]) => [lon, lat, Number.isFinite(v) ? v + (q.offset || 0) : v]);
      u.cellStats = statsOf(list);
      u.cellTable = q.table;
      buildCells(m, list);
      scheduleCard();
    } catch (e) { console.warn('cells', e); }
  }
  function statsOf(list) {
    const vs = list.map((c) => c[2]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vs.length) return null;
    const q = (p) => vs[Math.min(vs.length - 1, Math.floor(p * (vs.length - 1)))];
    return { n: vs.length, min: vs[0], max: vs.at(-1), med: q(0.5), mean: vs.reduce((a, b) => a + b, 0) / vs.length };
  }
  function clearCells(m) {
    const u = m && m.userData;
    if (!u || !u.cells) return;
    root.remove(u.cells.inst);
    u.cells.inst.geometry.dispose();
    u.cells.inst.material.dispose();
    u.cells = null;
    shadowDirty = true;
    invalidate();
  }
  function buildCells(m, list) {
    const u = m.userData;
    const old = u.cells;
    const prev = new Map();
    if (old) old.data.forEach((c) => prev.set(c.key, c));
    // cùng tập ô → chỉ đổi chiều cao/màu mượt (không dựng lại), khác → dựng lại với hiệu ứng nảy
    const same = old && old.data.length === list.length && list.every(([lon, lat]) => prev.has(`${lon},${lat}`));
    if (same) {
      list.forEach(([lon, lat, v]) => { const c = prev.get(`${lon},${lat}`); c.hT = H(v); c.colT = colorFor(v); });
      old.maxH = Math.max(...old.data.map((c) => c.hT));
      old.morph = true;
      invalidate();
      return;
    }
    if (old) clearCells(m);
    if (!list.length) return;
    const geo = new THREE.BoxGeometry(0.42, 1, 0.42);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 });
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    inst.castShadow = true;
    inst.visible = barsOn;
    const c0 = u.center;
    const data = list.map(([lon, lat, v], k) => {
      const q = proj(lon, lat);
      const col = colorFor(v);
      inst.setColorAt(k, col);
      return { key: `${lon},${lat}`, qx: q[0], qz: q[1], h: H(v), hT: H(v), col: col.clone(), colT: col, d: Math.hypot(q[0] - c0[0], q[1] - c0[1]) * 60 };
    });
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    u.cells = { inst, data, t0: performance.now() + 180, maxH: Math.max(...data.map((c) => c.h)), done: false, morph: false };
    root.add(inst);
    animateCells(u, performance.now(), 1, true);
    shadowDirty = true;
    invalidate();
  }
  function animateCells(u, now, a, force) {
    const C = u.cells;
    const inst = C.inst;
    inst.visible = barsOn;
    const ok = motion();
    let done = true;
    const baseY = u.y + u.h;                             // mặt trên tấm nổi
    let colDirty = false;
    C.data.forEach((c, k) => {
      let s = 1;
      if (!C.done || force) {
        const p = ok ? clamp((now - C.t0 - c.d) / 620, 0, 1) : 1;
        if (p < 1) done = false;
        s = elastic(p);
      }
      if (C.morph) {
        c.h += (c.hT - c.h) * a;
        c.col.lerp(c.colT, a);
        inst.setColorAt(k, c.col);
        colDirty = true;
      }
      dummy.position.set(c.qx + u.off[0], baseY, -(c.qz + u.off[1]));
      dummy.scale.set(1, Math.max(0.001, c.h * BAR_K * s), 1);
      dummy.updateMatrix();
      inst.setMatrixAt(k, dummy.matrix);
    });
    if (C.morph && C.data.every((c) => Math.abs(c.hT - c.h) < 0.005)) C.morph = false;
    if (colDirty && inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.instanceMatrix.needsUpdate = true;
    if (done) C.done = true;
  }

  // ───────────────────────── Thẻ chi tiết / bảng so sánh ─────────────────────────
  let cmpChart = null, cardRaf = 0;
  /** gom các lần cập nhật thẻ trong cùng một khung hình (đổi tháng + tải ô của nhiều phường) thành 1 lần */
  function scheduleCard() {
    if (!cardRaf) cardRaf = requestAnimationFrame(() => { cardRaf = 0; refreshCard(); });
  }
  function refreshCard() {
    const card = $('#v3dCard');
    if (cardRaf) { cancelAnimationFrame(cardRaf); cardRaf = 0; }
    if (!picked.length || !cardOpen) { card.hidden = true; setSheet(sheet); return; }
    const scroll = card.scrollTop;
    const A = app();
    const S = A.S;
    const err = A.errMode();
    const body = $('#v3dCardBody');
    if (cmpChart) { cmpChart.destroy(); cmpChart = null; }
    if (picked.length === 1) {
      const u = picked[0].userData;
      const lv = err ? null : A.levelOf(u.v);
      const cs = u.cellStats;
      body.innerHTML = `
        <div class="w-head" style="padding-right:36px"><div class="ic" style="background:${lv ? lv.mau : '#2563eb'}"><i class="fa-solid fa-location-dot"></i></div>
          <div><h3>${A.esc(u.p.loai)} ${A.esc(u.p.ten_xa)}</h3><p>${A.esc(u.p.khu_vuc)} · ${A.esc(A.frameText())}</p></div></div>
        <div class="w-kpis">
          <div class="w-kpi"><div class="k">${err ? 'Sai số TB' : 'LST trung bình'}</div><div class="v">${err ? A.signed(u.v, 2) : A.fmt(u.v, 1)}<small> °C</small></div><div class="s">${lv ? A.esc(lv.ten) : ''}</div></div>
          <div class="w-kpi"><div class="k">Xếp hạng</div><div class="v">${rankOf(u.i) || '–'}</div><div class="s">${err ? 'theo sai số' : 'nóng nhất = 1'}</div></div>
          <div class="w-kpi"><div class="k">Diện tích</div><div class="v">${A.fmt(u.p.dtich_km2, 1)}<small> km²</small></div><div class="s">${(u.p.dan_so || 0).toLocaleString('vi-VN')} dân</div></div>
        </div>
        ${cs ? `<div class="sec-h">Các ô 480 m trong phường <span>${cs.n} ô · cột nhiệt trên tấm nổi</span></div>
          <div class="w-kpis"><div class="w-kpi"><div class="k">Thấp nhất</div><div class="v">${A.fmt(cs.min, 1)}°</div></div>
          <div class="w-kpi"><div class="k">Trung vị</div><div class="v">${A.fmt(cs.med, 1)}°</div></div>
          <div class="w-kpi"><div class="k">Cao nhất</div><div class="v">${A.fmt(cs.max, 1)}°</div></div></div>
          <p class="note">Mỗi cột là 1 ô lưới 480 m lấy từ <code>${A.esc(u.cellTable || '')}</code>; chiều cao và màu theo LST của ô.</p>`
        : '<p class="note"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang tải các ô 480 m…</p>'}
        ${lv?.khuyen_cao ? `<div class="callout ${lv.muc >= 4 ? 'warn' : 'info'}"><b>${A.esc(lv.ten)}:</b> ${A.esc(lv.khuyen_cao)}</div>` : ''}
        <div class="callout"><i class="fa-solid fa-scale-balanced"></i> Nhấp thêm phường khác (hoặc tìm ở ô phía trên) để <b>so sánh</b> tối đa ${MAX_PICK} phường.</div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn primary" id="v3dTo2d"><i class="fa-regular fa-map"></i>Xem trên bản đồ 2D</button>
          <button class="btn" id="v3dDesel"><i class="fa-solid fa-arrow-left"></i>Toàn thành phố</button>
        </div>`;
      $('#v3dTo2d').onclick = () => { const i = u.i; close(); app().selectWard(i); };
      $('#v3dDesel').onclick = () => clearAll(true);
    } else {
      const items = picked.map((m) => ({ m, u: m.userData, v: m.userData.v })).filter((x) => Number.isFinite(x.v));
      const avg = items.length ? items.reduce((s, x) => s + x.v, 0) / items.length : NaN;
      const hot = items.reduce((a, b) => (!a || b.v > a.v ? b : a), null);
      const cool = items.reduce((a, b) => (!a || b.v < a.v ? b : a), null);
      const span = hot && cool ? hot.v - cool.v : NaN;
      const pal = A.palette();
      body.innerHTML = `
        <div class="cmp-head"><div><div class="cmp-kicker">Đối chiếu & so sánh nhiều phường</div>
          <h3>So sánh ${picked.length} phường/xã đã chọn</h3><p class="note" style="margin:3px 0 0">${A.esc(A.frameText())}</p></div></div>
        <div class="cmp-tools">
          <button class="mini-btn" id="cmpBars"><i class="fa-solid fa-chart-simple"></i>Cột nhiệt: ${barsOn ? 'Bật' : 'Tắt'}</button>
          <button class="mini-btn" id="cmpFit"><i class="fa-solid fa-expand"></i>Nhìn vừa các phường</button>
          <button class="mini-btn danger" id="cmpClear"><i class="fa-solid fa-trash"></i>Xoá tất cả</button>
        </div>
        <div class="cmp-kpis">
          <div class="cmp-kpi"><div class="k">${err ? 'Sai số TB nhóm' : 'Nhiệt độ TB nhóm'}</div><div class="v">${A.fmt(avg, 1)}°C</div></div>
          <div class="cmp-kpi hot"><div class="k">${err ? 'Lớn nhất' : 'Nóng nhất'}${hot ? ` · ${A.fmt(hot.v, 1)}°C` : ''}</div><div class="v" title="${hot ? `${A.esc(hot.u.p.loai)} ${A.esc(hot.u.p.ten_xa)}` : ''}">${hot ? A.esc(hot.u.p.ten_xa) : '–'}</div></div>
          <div class="cmp-kpi cool"><div class="k">${err ? 'Nhỏ nhất' : 'Mát nhất'}${cool ? ` · ${A.fmt(cool.v, 1)}°C` : ''}</div><div class="v" title="${cool ? `${A.esc(cool.u.p.loai)} ${A.esc(cool.u.p.ten_xa)}` : ''}">${cool ? A.esc(cool.u.p.ten_xa) : '–'}</div></div>
          <div class="cmp-kpi"><div class="k">Độ chênh (Δ)</div><div class="v">${Number.isFinite(span) ? '+' + A.fmt(span, 1) : '–'}°C</div></div>
        </div>
        <div class="sec-h" style="margin-top:4px">Diễn biến gần đây <span>các khung trước đến hiện tại</span></div>
        <div class="cmp-chart"><canvas id="cmpChart"></canvas></div>
        <div class="cmp-list">${picked.map((m) => {
          const u = m.userData, v = u.v, cs = u.cellStats;
          const d = v - avg;
          const c = A.css(err ? A.errAt(v) : A.colorAt(v));
          const pct = clamp((v - pal.min) / (pal.max - pal.min), 0.04, 1) * 100;
          return `<div class="cmp-ward" data-i="${u.i}">
            <div class="top"><span class="sw" style="background:${c}"></span>
              <div style="min-width:0"><h4 data-fly="${u.i}" title="Nhìn tới phường này">${A.esc(u.p.loai)} ${A.esc(u.p.ten_xa)}</h4>
              <span class="diff ${d > 0.05 ? 'hot' : d < -0.05 ? 'cool' : ''}">${Number.isFinite(d) ? `${d > 0 ? '+' : ''}${A.fmt(d, 1)}°C (${Math.abs(d) < 0.05 ? 'bằng' : d > 0 ? 'cao hơn' : 'mát hơn'} TB nhóm)` : 'không có số liệu'}</span></div>
              <button class="icon-btn ghost rm" data-rm="${u.i}" title="Bỏ chọn phường này"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="mets"><span>Trung bình: <b>${A.fmt(v, 1)}°C</b></span><span class="mx">Cao nhất: <b>${cs ? A.fmt(cs.max, 1) + '°C' : '…'}</b></span><span class="mn">Thấp nhất: <b>${cs ? A.fmt(cs.min, 1) + '°C' : '…'}</b></span></div>
            <div class="cmp-track"><i style="width:${pct}%;background:${c}"></i></div></div>`;
        }).join('')}</div>`;
      $('#cmpBars').onclick = () => {
        barsOn = !barsOn;
        picked.forEach((m) => { if (m.userData.cells) m.userData.cells.inst.visible = barsOn; });
        shadowDirty = true;
        invalidate();
        renderLabels(true);
        refreshCard();
      };
      $('#cmpFit').onclick = () => frameSelection();
      $('#cmpClear').onclick = () => clearAll(true);
      body.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { const m = meshes[+b.dataset.rm]; if (m) toggle(m, { fly: false }); }; });
      body.querySelectorAll('[data-fly]').forEach((h) => { h.onclick = () => { const m = meshes[+h.dataset.fly]; if (m) flyToWard(m); }; });
      drawCmpChart();
    }
    card.hidden = false;
    setSheet(isPhone() ? sheet : 'full');
    if (scroll && sheet !== 'peek') card.scrollTop = scroll;
  }
  function flyToWard(m) {
    const u = m.userData;
    const target = new THREE.Vector3(u.center[0] + u.offT[0], LIFT * 0.75, -(u.center[1] + u.offT[1]));
    const dist = clamp(u.radius * 4 + 60, 70, 160);
    const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
    const el = 50 * Math.PI / 180;
    flyTo(target.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist)), target, 1000);
  }
  function drawCmpChart() {
    const A = app();
    const el = document.getElementById('cmpChart');
    if (!el || !window.Chart) return;
    const cols = ['#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
    let labels = [];
    const ds = picked.map((m, k) => {
      const s = A.wardSeries(m.userData.i, 18);
      labels = s.labels;
      return { label: m.userData.p.ten_xa, data: s.vals, borderColor: cols[k % cols.length], backgroundColor: cols[k % cols.length], borderWidth: 2, pointRadius: 1.8, tension: 0.3, spanGaps: true };
    });
    cmpChart = new Chart(el, {
      type: 'line', data: { labels, datasets: ds },
      options: { animation: motion() && !A.isPlaying() ? { duration: 450 } : false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${A.fmt(c.raw, 1)} °C` } } }, scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0, font: { size: 9.5 } }, grid: { display: false } }, y: { ticks: { callback: (v) => v + '°', font: { size: 9.5 } } } } },
    });
  }

  // ───────────────────────── Tìm phường trong 3D ─────────────────────────
  let listItems = [], listActive = -1;
  function renderList() {
    const A = app();
    const q = fold($('#v3dSearch').value.trim());
    const all = meshes.filter(Boolean).map((m) => m.userData);
    let items = q ? all.filter((u) => fold(`${u.p.loai} ${u.p.ten_xa}`).includes(q) || fold(u.p.sap_nhap).includes(q)) : all.slice();
    items.sort((a, b) => (q ? 0 : (Number.isFinite(b.v) ? b.v : -99) - (Number.isFinite(a.v) ? a.v : -99)));
    items = items.slice(0, q ? 40 : 168);
    listItems = items;
    listActive = -1;
    const box = $('#v3dList');
    box.innerHTML = items.length ? items.map((u, k) => `<button data-k="${k}" class="${isPicked(meshes[u.i]) ? 'picked' : ''}" role="option">
      <i style="background:${A.css(A.errMode() ? A.errAt(u.v) : A.colorAt(u.v))}"></i>
      <span style="min-width:0"><b>${A.esc(u.p.loai)} ${A.esc(u.p.ten_xa)}</b><small>${A.esc(u.p.khu_vuc)}</small></span>
      <span class="t">${Number.isFinite(u.v) ? A.fmt(u.v, 1) + '°C' : '–'}</span></button>`).join('')
      : '<div class="empty">Không tìm thấy phường/xã phù hợp.</div>';
    box.classList.add('open');
  }
  function closeList() { $('#v3dList').classList.remove('open'); }
  function chooseItem(k) {
    const u = listItems[k];
    if (!u) return;
    const m = meshes[u.i];
    if (!m) return;
    if (!isPicked(m)) toggle(m, { fly: true });
    else flyToWard(m);
    closeList();
    const sIn = $('#v3dSearch');
    sIn.value = '';
    sIn.blur();
  }

  // ───────────────────────── Mở / đóng ─────────────────────────
  function open(i) {
    const A = app();
    if (!A || !A.S.meta) return;
    const box = $('#v3d');
    box.hidden = false;
    document.body.classList.add('mode-3d');
    requestAnimationFrame(() => box.classList.add('open'));
    if (!renderer) {
      try { initThree(); } catch (e) {
        console.error(e);
        box.classList.remove('open'); box.hidden = true; document.body.classList.remove('mode-3d');
        alert('Trình duyệt không hỗ trợ WebGL nên không mở được chế độ 3D.');
        return;
      }
    }
    resize();
    const loading = $('#v3dLoading');
    if (!built) {
      loading.classList.remove('done');
      setTimeout(() => {
        buildScene();
        loading.classList.add('done');
        if (Number.isInteger(i) && meshes[i]) setTimeout(() => selectOnly(meshes[i], { fly: true }), 800);
      }, 30);
    } else {
      applyFrame(false);
      if (Number.isInteger(i) && meshes[i]) selectOnly(meshes[i], { fly: true });
    }
    start();
    syncPlay(A.isPlaying());
    setTimeout(() => { if (isOpen()) document.body.classList.add('v3d-full'); }, 480);
    try { if (!(history.state && history.state.v3d)) history.pushState({ v3d: 1 }, ''); } catch (e) { /* trình duyệt chặn history */ }
    if (coarse) coach();
  }
  let coachT = 0;
  function coach() {
    const h = $('.v3d-hint');
    if (!h) return;
    h.classList.add('show');
    clearTimeout(coachT);
    coachT = setTimeout(() => h.classList.remove('show'), 5200);
  }
  function close(fromPop) {
    const box = $('#v3d');
    document.body.classList.remove('v3d-full');
    box.classList.remove('open');
    document.body.classList.remove('mode-3d');
    $('#v3dTip').hidden = true;
    closeList();
    clearAll(false);
    $('.v3d-hint')?.classList.remove('show');
    setTimeout(() => { if (!box.classList.contains('open')) { box.hidden = true; halt(); } }, 460);
    try { if (fromPop !== true && history.state && history.state.v3d) history.back(); } catch (e) { /* bỏ qua */ }
  }
  const isOpen = () => document.body.classList.contains('mode-3d');
  function syncPlay(on) {
    const b = $('#v3dPlay');
    b.classList.toggle('playing', on);
    b.innerHTML = `<i class="fa-solid fa-${on ? 'pause' : 'play'}"></i>`;
  }

  // ───────────────────────── Nối sự kiện ─────────────────────────
  function boot() {
    const A = app();
    if (!A) return setTimeout(boot, 50);
    $('#btn3d').addEventListener('click', () => open(null));          // nút trên thanh: toàn cảnh
    $('#v3dExit').addEventListener('click', () => close());
    window.addEventListener('popstate', () => { if (isOpen()) close(true); });
    // Thẻ phía dưới (điện thoại): chạm tay nắm / tiêu đề để mở rộng–thu gọn, vuốt lên/xuống trên tay nắm
    const grip = $('#v3dGrip');
    if (grip) {
      grip.addEventListener('click', () => setSheet(sheet === 'peek' ? 'full' : 'peek'));
      let gy = null;
      grip.addEventListener('touchstart', (e) => { gy = e.touches[0].clientY; }, { passive: true });
      grip.addEventListener('touchend', (e) => {
        if (gy === null) return;
        const dy = e.changedTouches[0].clientY - gy; gy = null;
        if (dy < -24) setSheet('full'); else if (dy > 24) setSheet('peek');
      }, { passive: true });
    }
    $('#v3dCard').addEventListener('click', (e) => { if (sheet === 'peek' && isPhone() && !e.target.closest('button, a, input, select')) setSheet('full'); });
    $('#v3dReset').addEventListener('click', () => { clearAll(false); resetView(); });
    $('#v3dCardClose').addEventListener('click', () => clearAll(true));
    $('#v3dCmpBtn').addEventListener('click', () => { cardOpen = !cardOpen; refreshCard(); updateCmpBtn(); });
    $('#v3dRotate').addEventListener('click', (e) => { autoRotate = !autoRotate; e.currentTarget.classList.toggle('on', autoRotate); });
    $('#v3dLayout').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      gapMode = +b.dataset.gap;
      $$('#v3dLayout button').forEach((x) => x.classList.toggle('on', x === b));
      applyLayout();
      if (picked.length) frameSelection();
    });
    $('#v3dPrev').addEventListener('click', () => A.step(-1));
    $('#v3dNext').addEventListener('click', () => A.step(1));
    $('#v3dPlay').addEventListener('click', () => (A.isPlaying() ? A.stop() : A.play()));
    const sIn = $('#v3dSearch');
    sIn.addEventListener('focus', renderList);
    sIn.addEventListener('input', renderList);
    sIn.addEventListener('keydown', (e) => {
      const btns = [...$('#v3dList').querySelectorAll('button')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!btns.length) return;
        listActive = (listActive + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
        btns.forEach((b, k) => b.classList.toggle('active', k === listActive));
        btns[listActive].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') { e.preventDefault(); chooseItem(listActive >= 0 ? listActive : 0); }
      else if (e.key === 'Escape') { e.stopPropagation(); closeList(); sIn.blur(); }
    });
    $('#v3dList').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) chooseItem(+b.dataset.k); });
    document.addEventListener('click', (e) => { if (isOpen() && !e.target.closest('.v3d-search')) closeList(); });
    document.addEventListener('keydown', (e) => {
      if (!isOpen() || document.querySelector('.set-overlay:not([hidden])')) return;
      if (e.target.closest('input, select, textarea')) return;
      if (e.key === '/') { e.preventDefault(); sIn.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (picked.length) clearAll(true); else close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); A.step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); A.step(1); }
      else if (e.key === ' ') { e.preventDefault(); A.isPlaying() ? A.stop() : A.play(); }
    });
    window.addEventListener('resize', () => { if (isOpen()) { resize(); if (built && !picked.length && !camTween && !userMoved) resetView(false); } });
    // Safari trên iPhone: chặn cử chỉ chụm 2 ngón phóng to cả trang khi đang ở 3D
    document.addEventListener('gesturestart', (e) => { if (isOpen()) e.preventDefault(); });

    A.bus.on('frame', () => { if (built) applyFrame(false); });
    A.bus.on('palette', () => { if (built) applyFrame(false); });
    A.bus.on('theme', () => { applyTheme(); if (built) renderLabels(true); if (picked.length) refreshCard(); });
    A.bus.on('play', syncPlay);
    A.bus.on('open3d', (i) => open(i));
    A.bus.on('select', (i) => {
      if (!built || !isOpen()) return;
      if (i === null) clearAll(true); else if (meshes[i] && !isPicked(meshes[i])) selectOnly(meshes[i], { fly: true });
    });
  }
  boot();
  // chỉ đọc — phục vụ kiểm thử tự động (khoảng cách / góc camera, số phường đang chọn)
  window.__v3dDebug = () => (camera && controls ? {
    dist: +camera.position.distanceTo(controls.target).toFixed(1),
    az: +(Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z) * 180 / Math.PI).toFixed(1),
    picked: picked.length, sheet,
  } : null);
  window.__v3dDebug.screenOf = (i) => {            // toạ độ màn hình của tâm phường i (mặt trên khối)
    const m = meshes[i]; if (!m) return null;
    const u = m.userData; v3.set(u.center[0] + u.off[0], u.y + m.scale.y, -(u.center[1] + u.off[1])).project(camera);
    return [(v3.x + 1) / 2 * window.innerWidth, (1 - v3.y) / 2 * window.innerHeight];
  };
})();
