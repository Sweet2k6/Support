/* =====================================================================
   LST Forecast · TP.HCM — xác thực & phân quyền phía trình duyệt
   Hai chế độ, cùng một giao diện lập trình (window.Auth):
     • Máy chủ (npm start)  : gọi /api/auth/* — mật khẩu băm scrypt trong PostgreSQL,
                              phiên là cookie HttpOnly. Đây là phân quyền thật.
     • Tĩnh (GitHub Pages)  : không có máy chủ nên tài khoản lưu trong localStorage của
                              trình duyệt (PBKDF2). Chỉ để demo/ẩn giao diện, KHÔNG phải bảo mật thật.
   Vai trò: 'admin' (toàn quyền) · 'user' (chỉ xem bản đồ, xếp hạng, thống kê, xuất CSV).
   ===================================================================== */
(function () {
  'use strict';
  const STATIC = /github\.io$/.test(location.hostname) || location.protocol === 'file:' || new URLSearchParams(location.search).has('static');
  const ROLES = { admin: 'Quản trị viên', user: 'Người dùng' };
  const NAME_RE = /^[a-z0-9_.-]{3,32}$/;
  const MIN_PW = 6;

  // Tài khoản khởi tạo cho bản tĩnh. ĐỔI mật khẩu admin ngay sau lần đăng nhập đầu tiên.
  const SEED = [
    { u: 'admin', name: 'Quản trị viên', role: 'admin', pw: 'admin123' },
    { u: 'nguoidung', name: 'Người dùng', role: 'user', pw: 'user123' },
  ];

  const fail = (msg) => { throw new Error(msg); };
  const normName = (u) => String(u || '').trim().toLowerCase();
  function checkNew(u, pw) {
    if (!NAME_RE.test(u)) fail('Tên đăng nhập gồm 3–32 ký tự: chữ thường, số, dấu . _ -');
    if (String(pw || '').length < MIN_PW) fail(`Mật khẩu cần ít nhất ${MIN_PW} ký tự`);
  }

  /* ───────────── Chế độ máy chủ ───────────── */
  async function call(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Lỗi ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  const server = {
    me: () => call('GET', 'api/auth/me').then((d) => d.user).catch((e) => { if (e.status === 401) return null; throw e; }),
    login: (u, pw, remember) => call('POST', 'api/auth/login', { u: normName(u), pw, remember: !!remember }).then((d) => d.user),
    register: (u, name, pw) => { u = normName(u); checkNew(u, pw); return call('POST', 'api/auth/register', { u, name, pw }).then((d) => d.user); },
    logout: () => call('POST', 'api/auth/logout').catch(() => {}),
    list: () => call('GET', 'api/admin/users').then((d) => d.users),
    add: ({ u, name, pw, role }) => { u = normName(u); checkNew(u, pw); return call('POST', 'api/admin/users', { u, name, pw, role }); },
    update: (id, patch) => { if (patch.pw !== undefined && patch.pw.length < MIN_PW) fail(`Mật khẩu cần ít nhất ${MIN_PW} ký tự`); return call('PATCH', 'api/admin/users/' + encodeURIComponent(id), patch); },
    remove: (id) => call('DELETE', 'api/admin/users/' + encodeURIComponent(id)),
  };

  /* ───────────── Chế độ tĩnh (localStorage) ───────────── */
  const KEY_USERS = 'lst.users.v1', KEY_SESSION = 'lst.session.v1';
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function pbkdf2(pw, saltHex) {
    const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
  }
  async function makeRecord(u, name, role, pw) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    return { u, name: name || u, role, salt, hash: await pbkdf2(pw, salt), created: Date.now(), last: null, locked: false };
  }
  const readUsers = () => { try { return JSON.parse(localStorage.getItem(KEY_USERS)) || null; } catch { return null; } };
  const writeUsers = (list) => localStorage.setItem(KEY_USERS, JSON.stringify(list));
  async function users() {
    let list = readUsers();
    if (!list || !list.length) { list = await Promise.all(SEED.map((s) => makeRecord(s.u, s.name, s.role, s.pw))); writeUsers(list); }
    return list;
  }
  const pub = (r) => ({ id: r.u, username: r.u, name: r.name, role: r.role, locked: !!r.locked, created: r.created, last: r.last });
  const readSession = () => {
    for (const st of [sessionStorage, localStorage]) {
      try { const s = JSON.parse(st.getItem(KEY_SESSION)); if (s && s.exp > Date.now()) return s; } catch { /* bỏ qua */ }
    }
    return null;
  };
  const local = {
    async me() {
      const s = readSession(); if (!s) return null;
      const r = (await users()).find((x) => x.u === s.u);
      return r && !r.locked ? pub(r) : null;
    },
    async login(u, pw, remember) {
      u = normName(u);
      const list = await users();
      const r = list.find((x) => x.u === u);
      if (!r || (await pbkdf2(pw, r.salt)) !== r.hash) fail('Sai tên đăng nhập hoặc mật khẩu');
      if (r.locked) fail('Tài khoản đang bị khoá. Liên hệ quản trị viên');
      r.last = Date.now(); writeUsers(list);
      const s = JSON.stringify({ u, exp: Date.now() + (remember ? 30 : 1) * 864e5 });
      sessionStorage.removeItem(KEY_SESSION); localStorage.removeItem(KEY_SESSION);
      (remember ? localStorage : sessionStorage).setItem(KEY_SESSION, s);
      return pub(r);
    },
    async register(u, name, pw) {
      u = normName(u); checkNew(u, pw);
      const list = await users();
      if (list.some((x) => x.u === u)) fail('Tên đăng nhập đã tồn tại');
      const r = await makeRecord(u, String(name || '').trim(), 'user', pw);
      list.push(r); writeUsers(list);
      return pub(r);
    },
    async logout() { sessionStorage.removeItem(KEY_SESSION); localStorage.removeItem(KEY_SESSION); },
    async list() { return (await users()).map(pub); },
    async add({ u, name, pw, role }) {
      u = normName(u); checkNew(u, pw);
      if (!ROLES[role]) fail('Vai trò không hợp lệ');
      const list = await users();
      if (list.some((x) => x.u === u)) fail('Tên đăng nhập đã tồn tại');
      list.push(await makeRecord(u, String(name || '').trim(), role, pw)); writeUsers(list);
      return { ok: true };
    },
    async update(id, patch) {
      const list = await users();
      const r = list.find((x) => x.u === id); if (!r) fail('Không tìm thấy tài khoản');
      const me = readSession();
      const isSelf = me && me.u === id;
      const admins = list.filter((x) => x.role === 'admin' && !x.locked).length;
      if (patch.role !== undefined) {
        if (!ROLES[patch.role]) fail('Vai trò không hợp lệ');
        if (isSelf && patch.role !== 'admin') fail('Không thể tự hạ quyền của chính mình');
        r.role = patch.role;
      }
      if (patch.locked !== undefined) {
        if (isSelf && patch.locked) fail('Không thể tự khoá tài khoản của mình');
        if (patch.locked && r.role === 'admin' && admins <= 1) fail('Phải còn ít nhất một quản trị viên hoạt động');
        r.locked = !!patch.locked;
      }
      if (patch.name !== undefined) r.name = String(patch.name).trim() || r.u;
      if (patch.pw !== undefined) {
        if (patch.pw.length < MIN_PW) fail(`Mật khẩu cần ít nhất ${MIN_PW} ký tự`);
        r.salt = hex(crypto.getRandomValues(new Uint8Array(16))); r.hash = await pbkdf2(patch.pw, r.salt);
      }
      writeUsers(list); return { ok: true };
    },
    async remove(id) {
      const list = await users();
      const r = list.find((x) => x.u === id); if (!r) fail('Không tìm thấy tài khoản');
      const me = readSession();
      if (me && me.u === id) fail('Không thể tự xoá tài khoản của mình');
      if (r.role === 'admin' && list.filter((x) => x.role === 'admin').length <= 1) fail('Phải còn ít nhất một quản trị viên');
      writeUsers(list.filter((x) => x.u !== id)); return { ok: true };
    },
  };

  /* ───────────── Giao diện lập trình chung ───────────── */
  const impl = STATIC ? local : server;
  const here = () => location.pathname.split('/').pop() || 'index.html';
  window.Auth = {
    STATIC, ROLES,
    me: impl.me, login: impl.login, register: impl.register, logout: impl.logout,
    list: impl.list, add: impl.add, update: impl.update, remove: impl.remove,
    /** Trả về người dùng hiện tại; chưa đăng nhập → chuyển sang trang đăng nhập (và trả null). */
    async require(role) {
      let me = null;
      try { me = await impl.me(); } catch (e) { console.error(e); }
      if (!me) { location.replace('login.html?next=' + encodeURIComponent(here() + location.search)); return null; }
      if (role && me.role !== role) { location.replace('index.html?denied=1'); return null; }
      return me;
    },
    async signOut() { await impl.logout(); location.replace('login.html'); },
  };
})();
