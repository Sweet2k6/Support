/* =====================================================================
   LST Forecast · Cài đặt giao diện (dùng chung cho trang bản đồ, quản trị, đăng nhập)
   • Chế độ sáng / tối / theo thiết bị
   • Thang màu LST (đổi màu ảnh nhiệt, chú giải, dải thời gian, 3D)
   • Tuỳ chọn bản đồ: làm tối bản đồ nền khi ở chế độ tối, hiện tháng nội suy, hiệu ứng chuyển động
   Lưu trong localStorage của trình duyệt (mỗi người dùng/máy một cài đặt). Nạp trong <head> để áp
   chủ đề trước khi trang hiện ra (không chớp trắng).
   ===================================================================== */
(function () {
  'use strict';
  const KEY = 'lst.settings.v1';
  const PALETTES = {
    gee: { ten: 'GEE (mặc định)', mo_ta: 'Thang màu gốc của Google Earth Engine', mau: ['#0000FF', '#0066FF', '#00FFFF', '#00FF00', '#FFFF00', '#FFCC00', '#FF6600', '#FF0000'] },
    turbo: { ten: 'Turbo', mo_ta: 'Cầu vồng cải tiến, chuyển màu đều mắt', mau: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'] },
    thermal: { ten: 'Nhiệt (xanh–đỏ)', mo_ta: 'Lạnh xanh, nóng đỏ — dễ đọc khi in', mau: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026'] },
    ylorrd: { ten: 'Vàng–Cam–Đỏ', mo_ta: 'Một sắc độ, nhấn mạnh vùng nóng', mau: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'] },
    inferno: { ten: 'Inferno', mo_ta: 'Tối → sáng, thân thiện người mù màu', mau: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'] },
    viridis: { ten: 'Viridis', mo_ta: 'Chuẩn khoa học, đọc tốt cả khi in đen trắng', mau: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'] },
  };
  const DEF = { theme: 'light', palette: 'gee', darkMap: true, showFill: true, motion: true };
  const listeners = [];
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try { return { ...DEF, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { ...DEF }; }
  }
  let cur = read();
  if (!PALETTES[cur.palette]) cur.palette = 'gee';
  const resolvedTheme = () => (cur.theme === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : cur.theme);

  function apply() {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme();
    root.classList.toggle('dark-map', resolvedTheme() === 'dark' && cur.darkMap);
    root.classList.toggle('no-motion', !cur.motion);
    root.style.setProperty('--lst-grad', `linear-gradient(90deg, ${PALETTES[cur.palette].mau.join(', ')})`);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolvedTheme() === 'dark' ? '#0b1220' : '#0f172a';
  }
  function set(patch) {
    const prev = cur;
    cur = { ...cur, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* chế độ riêng tư: chỉ áp dụng trong phiên */ }
    apply();
    listeners.forEach((f) => { try { f(cur, prev); } catch (e) { console.error(e); } });
    syncDialog();
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (cur.theme === 'auto') { apply(); listeners.forEach((f) => f(cur, cur)); } });
  apply();

  // ───────────── Hộp thoại cài đặt (dựng khi mở lần đầu) ─────────────
  let box = null;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function build(ctx) {
    box = document.createElement('div');
    box.className = 'set-overlay';
    box.hidden = true;
    box.innerHTML = `
      <div class="set-panel" role="dialog" aria-modal="true" aria-labelledby="setTitle">
        <header class="set-head">
          <span class="set-ic"><i class="fa-solid fa-sliders"></i></span>
          <div><h2 id="setTitle">Cài đặt</h2><p>Áp dụng ngay · lưu trên trình duyệt này</p></div>
          <button class="icon-btn ghost set-x" type="button" aria-label="Đóng"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="set-body">
          <section class="set-acc" hidden>
            <h3><i class="fa-solid fa-user"></i>Tài khoản</h3>
            <div class="acc-row"><span class="acc-av"><i class="fa-solid fa-user"></i></span>
              <span class="acc-t"><b data-acc-name>–</b><small data-acc-role>–</small></span>
              <a class="btn" data-acc-admin href="admin.html" hidden><i class="fa-solid fa-user-shield"></i>Quản trị</a>
              <button class="btn" type="button" data-acc-out><i class="fa-solid fa-right-from-bracket"></i>Đăng xuất</button></div>
          </section>
          <section>
            <h3><i class="fa-solid fa-circle-half-stroke"></i>Giao diện</h3>
            <div class="theme-pick" role="radiogroup" aria-label="Chế độ giao diện">
              <button type="button" data-theme="light"><span class="tp tp-light"><i></i><i></i><i></i></span><b>Sáng</b></button>
              <button type="button" data-theme="dark"><span class="tp tp-dark"><i></i><i></i><i></i></span><b>Tối</b></button>
              <button type="button" data-theme="auto"><span class="tp tp-auto"><i></i><i></i><i></i></span><b>Theo thiết bị</b></button>
            </div>
          </section>
          <section>
            <h3><i class="fa-solid fa-palette"></i>Thang màu nhiệt độ bề mặt (LST)</h3>
            <div class="pal-list" role="radiogroup" aria-label="Thang màu LST">
              ${Object.entries(PALETTES).map(([k, p]) => `
                <button type="button" class="pal" data-pal="${k}">
                  <span class="pal-bar" style="background:linear-gradient(90deg, ${p.mau.join(', ')})"></span>
                  <span class="pal-t"><b>${esc(p.ten)}</b><small>${esc(p.mo_ta)}</small></span>
                  <i class="fa-solid fa-circle-check pal-ok"></i>
                </button>`).join('')}
            </div>
          </section>
          ${ctx === 'map' ? `
          <section>
            <h3><i class="fa-solid fa-map"></i>Bản đồ</h3>
            <label class="sw-row"><span><b>Làm tối bản đồ nền</b><small>Khi ở chế độ tối, bản đồ Google chuyển sang tông tối</small></span>
              <span class="switch"><input type="checkbox" data-opt="darkMap" /><i></i></span></label>
            <label class="sw-row"><span><b>Hiện tháng nội suy</b><small>Lấp các tháng không có ảnh vệ tinh (đánh dấu rõ là ước tính)</small></span>
              <span class="switch"><input type="checkbox" data-opt="showFill" /><i></i></span></label>
          </section>` : ''}
          <section>
            <h3><i class="fa-solid fa-wand-magic-sparkles"></i>Chuyển động</h3>
            <label class="sw-row"><span><b>Hiệu ứng chuyển động</b><small>Tắt nếu máy chậm hoặc bạn thích giao diện tĩnh</small></span>
              <span class="switch"><input type="checkbox" data-opt="motion" /><i></i></span></label>
          </section>
        </div>
        <footer class="set-foot">
          <button class="btn" type="button" data-reset><i class="fa-solid fa-rotate-left"></i>Mặc định</button>
          <button class="btn primary" type="button" data-close><i class="fa-solid fa-check"></i>Xong</button>
        </footer>
      </div>`;
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('.set-x, [data-close]')) return close();
      const t = e.target.closest('[data-theme]');
      if (t && t.closest('.theme-pick')) return set({ theme: t.dataset.theme });
      const p = e.target.closest('[data-pal]');
      if (p) return set({ palette: p.dataset.pal });
      if (e.target.closest('[data-reset]')) return set({ ...DEF });
      if (e.target.closest('[data-acc-out]') && account && account.onLogout) return account.onLogout();
    });
    box.addEventListener('change', (e) => {
      const o = e.target.closest('[data-opt]');
      if (o) set({ [o.dataset.opt]: o.checked });
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box && !box.hidden) { e.stopPropagation(); close(); } }, true);
  }
  let account = null;
  function syncDialog() {
    if (!box) return;
    const acc = box.querySelector('.set-acc');
    acc.hidden = !account;
    if (account) {
      box.querySelector('[data-acc-name]').textContent = account.name || '';
      box.querySelector('[data-acc-role]').textContent = account.roleLabel || '';
      box.querySelector('[data-acc-admin]').hidden = !account.admin;
    }
    box.querySelectorAll('.theme-pick [data-theme]').forEach((b) => { b.classList.toggle('on', b.dataset.theme === cur.theme); b.setAttribute('aria-checked', b.dataset.theme === cur.theme); });
    box.querySelectorAll('[data-pal]').forEach((b) => { b.classList.toggle('on', b.dataset.pal === cur.palette); b.setAttribute('aria-checked', b.dataset.pal === cur.palette); });
    box.querySelectorAll('[data-opt]').forEach((i) => { i.checked = !!cur[i.dataset.opt]; });
  }
  let lastFocus = null;
  function open(ctx) {
    if (!box) build(ctx || document.body.dataset.ctx || 'page');
    syncDialog();
    lastFocus = document.activeElement;
    box.hidden = false;
    requestAnimationFrame(() => box.classList.add('open'));
    box.querySelector('.set-x').focus();
  }
  function close() {
    if (!box) return;
    box.classList.remove('open');
    setTimeout(() => { box.hidden = true; }, 260);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  window.LSTSettings = {
    PALETTES, get: () => ({ ...cur }), set, open, close,
    theme: resolvedTheme,
    palette: () => PALETTES[cur.palette].mau.slice(),
    on: (f) => listeners.push(f),
    setAccount: (a) => { account = a; syncDialog(); },
  };
})();
