/* =====================================================================
   Chế độ 3D — khối phường/xã cao theo LST, cột nhiệt từng ô 480 m
   Three.js r13x (vendor) + OrbitControls. Dữ liệu dùng chung với app.js qua window.LSTApp
   ===================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const app = () => window.LSTApp;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer, scene, camera, controls, sun;
  let raf = 0, running = false, built = false;
  let root, meshes = [], cells = null, labelsBox;
  let hovered = null, selected = null, gapMode = 0, autoRotate = false;
  let lon0 = 106.95, lat0 = 10.92, kx = 109.3, ky = 110.6;
  let camTween = null, lastNow = 0;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const tmpColor = new THREE.Color();
  const BASE_T = 23;

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

  // ───────────────────────── Khởi tạo Three.js ─────────────────────────
  function initThree() {
    const canvas = $('#v3dCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // giữ mã hoá tuyến tính để màu khối đúng thang màu GEE

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xdfe7f1, 260, 520);
    camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xaebcd0, 0.85));
    sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(-70, 160, 90);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 10, far: 420 });
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    const ground = new THREE.Mesh(new THREE.CircleGeometry(420, 64), new THREE.MeshLambertMaterial({ color: 0xe8eef6 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    scene.add(ground);
    const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.ShadowMaterial({ opacity: 0.16 }));
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -0.03;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);
    const grid = new THREE.GridHelper(420, 42, 0xc7d2e0, 0xd8e1ec);
    grid.position.y = -0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    scene.add(grid);

    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 6;
    controls.maxDistance = 360;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.autoRotateSpeed = 0.6;
    controls.addEventListener('start', () => { camTween = null; });

    root = new THREE.Group();
    scene.add(root);

    labelsBox = document.createElement('div');
    labelsBox.className = 'v3d-labels';
    labelsBox.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    $('#v3d').insertBefore(labelsBox, $('.v3d-top'));

    bindPointer(canvas);
  }

  function resize() {
    if (!renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 35), new THREE.LineBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.32 }));
      mesh.add(edges);
      const c = proj(p.tam[0], p.tam[1]);
      geo.computeBoundingSphere();
      mesh.userData = {
        i: p.i, p, edges, center: c, radius: geo.boundingSphere.radius, dir: dirs[p.khu_vuc] || [0, 0],
        h: 0.001, hT: 0.6, col: new THREE.Color(0xcbd5e1), colT: new THREE.Color(0xcbd5e1),
        off: [0, 0], offT: [0, 0], delay: (p.tam[0] - xmin) / ((xmax - xmin) || 1) * 900, t0: performance.now(),
        opT: 1,
      };
      root.add(mesh);
      meshes[p.i] = mesh;
    });

    // ranh giới tỉnh
    if (S.province) {
      const mat = new THREE.LineBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.6 });
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
    built = true;
    applyFrame(true);
    resetView(false);
  }

  // ───────────────────────── Cập nhật theo tháng ─────────────────────────
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
    updateTitles();
    renderLabels(true);
    if (selected) { refreshCard(); loadCells(); }
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
    if (S.mode === 'run' && r) {
      if (A.errMode()) src = `sai số ${r.ten_mo_hinh} so với GEE`;
      else if (S.cmp === 'obs' && A.S.meta.indices.LST.gee.some((g) => g.ky === S.ky)) src = 'GEE thực tế (đối chiếu)';
      else src = r.ma_loai === 'GIA_LAP' ? `giả lập ${r.ten_mo_hinh}` : `dự báo ${r.ten_mo_hinh}`;
    }
    $('#v3dSub').textContent = `${A.kyText(S.ky)} · ${src} · ${meshes.filter(Boolean).length} phường/xã`;
    $('#v3dMonth').textContent = A.kyText(S.ky);
    const err = A.errMode();
    const pal = err ? ['#1d4ed8', '#60a5fa', '#f1f5f9', '#f87171', '#b91c1c'] : A.palette().palette;
    const lo = err ? -5 : A.palette().min, hi = err ? 5 : A.palette().max;
    $('#v3dLgBar').style.background = `linear-gradient(90deg, ${pal.join(', ')})`;
    const ticks = err ? [-5, -2.5, 0, 2.5, 5] : [25, 30, 35, 40, 45];
    $('#v3dLgTicks').innerHTML = ticks.map((t) => `<span style="left:${(t - lo) / (hi - lo) * 100}%">${t}</span>`).join('');
    document.querySelector('.v3d-legend b').textContent = err ? 'Sai số dự báo (°C) · chiều cao theo độ lớn sai số' : 'LST (°C) · chiều cao khối tỉ lệ với nhiệt độ';
  }

  // ───────────────────────── Vòng lặp vẽ ─────────────────────────
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function loop(now) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (camTween) {
      const t = Math.min(1, (now - camTween.t0) / camTween.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      camera.position.lerpVectors(camTween.p0, camTween.p1, e);
      controls.target.lerpVectors(camTween.t0v, camTween.t1v, e);
      if (t >= 1) camTween = null;
    }
    controls.autoRotate = autoRotate && !selected && !camTween;
    controls.update();
    // hệ số làm mượt theo thời gian thực: hội tụ như nhau dù máy chạy 10 hay 144 khung/giây
    const dt = Math.min(120, now - (lastNow || now));
    lastNow = now;
    const a = reduceMotion ? 1 : 1 - Math.exp(-dt / 160);

    meshes.forEach((m) => {
      if (!m) return;
      const u = m.userData;
      const started = now - u.t0 >= u.delay;
      if (started) {
        const goal = selected && cells ? u.hT * cells.userData.k : u.hT;   // đang xem 1 phường: mọi khối co cùng tỉ lệ cột ô
        u.h += (goal - u.h) * a;
        u.col.lerp(u.colT, a);
      }
      u.off[0] += (u.offT[0] - u.off[0]) * a;
      u.off[1] += (u.offT[1] - u.off[1]) * a;
      m.scale.y = Math.max(0.001, u.h);
      m.position.set(u.off[0], 0, -u.off[1]);
      m.material.color.copy(u.col);
      const op = selected ? (m === selected ? (cells ? 0.16 : 1) : 0.32) : 1;
      m.material.opacity += (op - m.material.opacity) * a;
      m.material.depthWrite = m.material.opacity > 0.9;
      u.edges.material.opacity = selected && m !== selected ? 0.1 : (m === selected ? 0.9 : 0.32);
      u.edges.material.color.setHex(m === selected ? 0xb45309 : 0x0f172a);
      const glow = m === hovered && m !== selected ? 0.22 : 0;
      m.material.emissive.setRGB(glow, glow, glow);
    });

    if (cells) animateCells(now);
    renderer.render(scene, camera);
    renderLabels(false);
  }
  function start() {
    if (running) return;
    running = true;
    lastNow = 0;
    raf = requestAnimationFrame(loop);
  }
  function halt() {
    running = false;
    cancelAnimationFrame(raf);
  }

  // ───────────────────────── Nhãn nổi ─────────────────────────
  let labelSet = [];
  const v3 = new THREE.Vector3();
  function renderLabels(rebuild) {
    if (!labelsBox) return;
    const A = app();
    if (rebuild) {
      const err = A.errMode();
      let list = meshes.filter((m) => m && Number.isFinite(m.userData.v));
      list.sort((a, b) => (err ? Math.abs(b.userData.v) - Math.abs(a.userData.v) : b.userData.v - a.userData.v));
      labelSet = selected ? [selected] : list.slice(0, 5);
      labelsBox.innerHTML = labelSet.map((m, k) => `<div class="v3d-lab" data-k="${k}" style="position:absolute;transform:translate(-50%,-100%);padding:3px 9px;border-radius:8px;background:rgba(255,255,255,.95);border:1px solid #e2e8f0;box-shadow:0 4px 14px rgba(15,23,42,.15);font-size:11.5px;font-weight:700;white-space:nowrap;color:#0f172a">${A.esc(m.userData.p.ten_xa)} <span style="color:#dc2626">${err ? A.signed(m.userData.v, 1) : A.fmt(m.userData.v, 1)}°</span></div>`).join('');
    }
    const W = window.innerWidth, Hh = window.innerHeight;
    const placed = [];                                   // nhãn ưu tiên (nóng hơn) đặt trước, nhãn chồng lên sẽ ẩn
    [...labelsBox.children].forEach((el) => {
      const m = labelSet[+el.dataset.k];
      if (!m) return;
      const u = m.userData;
      v3.set(u.center[0] + u.off[0], m.scale.y + 0.8, -(u.center[1] + u.off[1]));
      v3.project(camera);
      const x = (v3.x + 1) / 2 * W, y = (1 - v3.y) / 2 * Hh;
      const w = el.offsetWidth || 120, h = el.offsetHeight || 22;
      const clash = placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < h + 4);
      const vis = v3.z < 1 && Math.abs(v3.x) < 1.1 && Math.abs(v3.y) < 1.1 && !clash;
      el.style.display = vis ? '' : 'none';
      if (vis) placed.push({ x, y, w });
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    });
  }

  // ───────────────────────── Tương tác chuột ─────────────────────────
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
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || down.b !== 0) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return;                       // đang kéo xoay -> không tính là nhấp
      const m = pick(e);
      if (m) select(m, true); else deselect();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) { tip.hidden = true; return; }
      const m = pick(e);
      hovered = m;
      canvas.style.cursor = m ? 'pointer' : 'grab';
      if (!m) { tip.hidden = true; return; }
      const A = app();
      const u = m.userData;
      const err = A.errMode();
      const lv = err ? null : A.levelOf(u.v);
      const rank = rankOf(u.i);
      tip.innerHTML = `<h4>${A.esc(u.p.loai)} ${A.esc(u.p.ten_xa)}</h4>
        <div class="r"><span>${err ? 'Sai số TB' : 'LST trung bình'}</span><b>${err ? A.signed(u.v, 2) : A.fmt(u.v, 2)} °C</b></div>
        ${rank ? `<div class="r"><span>Xếp hạng nóng</span><b>${rank}</b></div>` : ''}
        <div class="r"><span>Khu vực</span><b>${A.esc(u.p.khu_vuc)}</b></div>
        ${lv ? `<div class="r"><span>Mức</span><b style="color:${lv.mau}">${A.esc(lv.ten)}</b></div>` : ''}`;
      const W = window.innerWidth;
      tip.style.left = e.clientX + 'px';
      tip.style.top = e.clientY + 'px';
      tip.style.transform = e.clientX > W - 260 ? 'translate(calc(-100% - 16px), 16px)' : 'translate(16px, 16px)';
      tip.hidden = false;
    });
    canvas.addEventListener('pointerleave', () => { hovered = null; tip.hidden = true; });
  }
  function rankOf(i) {
    const V = app().S.V;
    if (!V || !Number.isFinite(V[i])) return null;
    let r = 1, n = 0;
    for (let k = 0; k < V.length; k++) if (Number.isFinite(V[k])) { n++; if (V[k] > V[i]) r++; }
    return `${r}/${n}`;
  }

  // ───────────────────────── Chọn phường ─────────────────────────
  function select(m, sync) {
    if (!m) return;
    selected = m;
    $('#v3dTip').hidden = true;
    const u = m.userData;
    const dist = Math.max(7, u.radius * 3.3);
    const target = new THREE.Vector3(u.center[0] + u.offT[0], u.radius * 0.35, -(u.center[1] + u.offT[1]));
    const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
    const el = 50 * Math.PI / 180;                              // nhìn xiên 50° để thấy rõ cả mặt bằng lẫn chiều cao cột
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    flyTo(target.clone().add(dir.multiplyScalar(dist)), target);
    refreshCard();
    loadCells();
    renderLabels(true);
    if (sync) app().selectWard(u.i);
  }
  function deselect() {
    if (!selected) return;
    selected = null;
    clearCells();
    $('#v3dCard').hidden = true;
    renderLabels(true);
  }
  function flyTo(pos, target, dur = 950) {
    if (reduceMotion) { camera.position.copy(pos); controls.target.copy(target); return; }
    camTween = { p0: camera.position.clone(), p1: pos, t0v: controls.target.clone(), t1v: target, t0: performance.now(), dur };
  }
  function resetView(anim = true) {
    const pos = new THREE.Vector3(-18, 118, 132), target = new THREE.Vector3(0, 0, -4);
    if (anim) flyTo(pos, target, 1100); else { camera.position.copy(pos); controls.target.copy(target); controls.update(); }
  }

  // ───────────────────────── Cột nhiệt từng ô 480 m ─────────────────────────
  let cellToken = 0;
  async function loadCells() {
    if (!selected) return;
    const A = app();
    const S = A.S;
    const u = selected.userData;
    const tok = ++cellToken;
    const hasObs = S.meta.indices.LST.gee.some((g) => g.ky === S.ky);
    const usePhien = S.mode === 'run' && !(S.cmp === 'obs' && hasObs);
    try {
      const d = await A.api(`/cells?ma_xa=${encodeURIComponent(u.p.ma_xa)}&ky=${S.ky}${usePhien ? `&phien=${S.runId}` : ''}`);
      if (tok !== cellToken || !selected || selected.userData !== u) return;
      buildCells(d.cells, u);
      refreshCard(d.cells);
    } catch (e) { console.warn('cells', e); }
  }
  function clearCells() {
    if (!cells) return;
    root.remove(cells);
    cells.geometry.dispose();
    cells.material.dispose();
    cells = null;
  }
  function buildCells(list, u) {
    clearCells();
    if (!list.length) return;
    const geo = new THREE.BoxGeometry(0.42, 1, 0.42);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 });
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    inst.castShadow = true;
    const data = [];
    const c0 = u.center;
    list.forEach(([lon, lat, v], k) => {
      const q = proj(lon, lat);
      const x = q[0] + u.offT[0], z = -(q[1] + u.offT[1]);
      inst.setColorAt(k, colorFor(v));
      data.push({ x, z, h: H(v), d: Math.hypot(q[0] - c0[0], q[1] - c0[1]) * 70 });
    });
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // co chiều cao để cột cao nhất ≈ 1,4 × bán kính phường (phường nhỏ ở trung tâm không thành "kim")
    const maxH = Math.max(...data.map((c) => c.h));
    const k = Math.min(1, Math.max(0.08, (u.radius * 1.4) / maxH));
    inst.userData = { data, k, t0: performance.now() };
    root.add(inst);
    cells = inst;
    animateCells(performance.now(), true);
  }
  const dummy = new THREE.Object3D();
  function animateCells(now, force) {
    const u = cells.userData;
    if (u.done && !force) return;
    let done = true;
    u.data.forEach((c, k) => {
      const t = reduceMotion ? 1 : Math.min(1, Math.max(0, (now - u.t0 - c.d) / 650));
      if (t < 1) done = false;
      const s = t === 1 ? 1 : 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);   // easeOutBack
      dummy.position.set(c.x, 0, c.z);
      dummy.scale.set(1, Math.max(0.001, c.h * u.k * s), 1);
      dummy.updateMatrix();
      cells.setMatrixAt(k, dummy.matrix);
    });
    cells.instanceMatrix.needsUpdate = true;
    u.done = done;
  }

  // ───────────────────────── Thẻ chi tiết ─────────────────────────
  function refreshCard(cellList) {
    if (!selected) return;
    const A = app();
    const S = A.S;
    const u = selected.userData;
    const err = A.errMode();
    const lv = err ? null : A.levelOf(u.v);
    const card = $('#v3dCard');
    let cellHtml = '';
    if (cellList && cellList.length) {
      const vs = cellList.map((c) => c[2]).filter(Number.isFinite).sort((a, b) => a - b);
      const q = (p) => vs[Math.min(vs.length - 1, Math.floor(p * (vs.length - 1)))];
      cellHtml = `<div class="sec-h">Các ô 480 m trong phường <span>${vs.length} ô</span></div>
        <div class="w-kpis"><div class="w-kpi"><div class="k">Thấp nhất</div><div class="v">${A.fmt(vs[0], 1)}°</div></div>
        <div class="w-kpi"><div class="k">Trung vị</div><div class="v">${A.fmt(q(0.5), 1)}°</div></div>
        <div class="w-kpi"><div class="k">Cao nhất</div><div class="v">${A.fmt(vs.at(-1), 1)}°</div></div></div>
        <p class="note">Mỗi cột là 1 ô lưới 480 m lấy từ bảng ${S.mode === 'run' && !(S.cmp === 'obs') ? '<code>du_bao_o</code>' : '<code>quan_trac_o</code>'}; chiều cao và màu theo LST của ô.</p>`;
    } else if (card.dataset.cells && card.dataset.ward === u.p.ma_xa) {
      cellHtml = card.dataset.cells;
    }
    const tr = $('#v3dCardBody');
    tr.innerHTML = `
      <div class="w-head" style="padding-right:36px"><div class="ic" style="background:${lv ? lv.mau : '#2563eb'}"><i class="fa-solid fa-location-dot"></i></div>
        <div><h3>${A.esc(u.p.loai)} ${A.esc(u.p.ten_xa)}</h3><p>${A.esc(u.p.khu_vuc)} · ${A.kyText(S.ky)}</p></div></div>
      <div class="w-kpis">
        <div class="w-kpi"><div class="k">${err ? 'Sai số TB' : 'LST trung bình'}</div><div class="v">${err ? A.signed(u.v, 2) : A.fmt(u.v, 1)}<small> °C</small></div><div class="s">${lv ? A.esc(lv.ten) : ''}</div></div>
        <div class="w-kpi"><div class="k">Xếp hạng</div><div class="v">${rankOf(u.i) || '–'}</div><div class="s">${err ? 'theo sai số' : 'nóng nhất = 1'}</div></div>
        <div class="w-kpi"><div class="k">Diện tích</div><div class="v">${A.fmt(u.p.dtich_km2, 1)}<small> km²</small></div><div class="s">${(u.p.dan_so || 0).toLocaleString('vi-VN')} dân</div></div>
      </div>
      ${cellHtml || '<p class="note"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang tải các ô 480 m…</p>'}
      ${lv?.khuyen_cao ? `<div class="callout ${lv.muc >= 4 ? 'warn' : 'info'}"><b>${A.esc(lv.ten)}:</b> ${A.esc(lv.khuyen_cao)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn primary" id="v3dTo2d"><i class="fa-regular fa-map"></i>Xem trên bản đồ 2D</button>
        <button class="btn" id="v3dDesel"><i class="fa-solid fa-arrow-left"></i>Toàn thành phố</button>
      </div>`;
    if (cellList) { card.dataset.cells = cellHtml; card.dataset.ward = u.p.ma_xa; }
    card.hidden = false;
    $('#v3dTo2d').onclick = () => { const i = u.i; close(); app().selectWard(i); };
    $('#v3dDesel').onclick = () => { deselect(); resetView(); };
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
        if (Number.isInteger(i) && meshes[i]) setTimeout(() => select(meshes[i], false), 700);
      }, 30);
    } else {
      applyFrame(false);
      if (Number.isInteger(i) && meshes[i]) select(meshes[i], false);
    }
    start();
    syncPlay(A.isPlaying());
  }
  function close() {
    const box = $('#v3d');
    box.classList.remove('open');
    document.body.classList.remove('mode-3d');
    $('#v3dTip').hidden = true;
    deselect();
    setTimeout(() => { if (!box.classList.contains('open')) { box.hidden = true; halt(); } }, 460);
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
    $('#btn3d').addEventListener('click', () => open(null));          // nút trên thanh trên: toàn cảnh
    $('#v3dExit').addEventListener('click', close);
    $('#v3dReset').addEventListener('click', () => { deselect(); resetView(); });
    $('#v3dCardClose').addEventListener('click', () => { deselect(); resetView(); });
    $('#v3dRotate').addEventListener('click', (e) => { autoRotate = !autoRotate; e.currentTarget.classList.toggle('on', autoRotate); });
    $('#v3dLayout').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      gapMode = +b.dataset.gap;
      document.querySelectorAll('#v3dLayout button').forEach((x) => x.classList.toggle('on', x === b));
      applyLayout();
      if (selected) { clearCells(); setTimeout(loadCells, 500); select(selected, false); }
    });
    $('#v3dPrev').addEventListener('click', () => A.step(-1));
    $('#v3dNext').addEventListener('click', () => A.step(1));
    $('#v3dPlay').addEventListener('click', () => (A.isPlaying() ? A.stop() : A.play()));
    document.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); if (selected) { deselect(); resetView(); } else close(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); A.step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); A.step(1); }
      else if (e.key === ' ') { e.preventDefault(); A.isPlaying() ? A.stop() : A.play(); }
    });
    window.addEventListener('resize', () => { if (isOpen()) resize(); });

    A.bus.on('frame', () => { if (built) applyFrame(false); });
    A.bus.on('play', syncPlay);
    A.bus.on('open3d', (i) => open(i));
    A.bus.on('select', (i) => {
      if (!built || !isOpen()) return;
      if (i === null) deselect(); else if (meshes[i] && selected !== meshes[i]) select(meshes[i], false);
    });
  }
  boot();
})();
