/**
 * LST Forecast · TP.HCM — xác thực & phân quyền phía máy chủ
 *
 *  • Tài khoản lưu ở schema riêng "quan_tri" (script nạp dữ liệu chạy DROP SCHEMA vientham
 *    nên KHÔNG đặt chung, kẻo mất tài khoản mỗi lần nạp lại).
 *  • Mật khẩu băm scrypt + muối riêng từng người. Không lưu mật khẩu gốc.
 *  • Phiên: cookie HttpOnly + SameSite=Lax chứa token ký HMAC-SHA256 (không cần bảng phiên).
 *    Mỗi yêu cầu đọc lại tài khoản từ CSDL nên khoá/đổi vai trò có hiệu lực gần như ngay.
 *  • Chặn dò mật khẩu: 5 lần sai liên tiếp → khoá 5 phút theo (IP + tên đăng nhập).
 *  • Vai trò: 'admin' | 'user'.
 *      user  : /api/* (xem dữ liệu), /data/* (ảnh raster)
 *      admin : thêm — trang quản trị, /api/admin/*, tải GeoTIFF dự báo (/data/du_bao/)
 */
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SCHEMA = 'quan_tri';
const COOKIE = 'lst_sid';
const DAY = 864e5;
const NAME_RE = /^[a-z0-9_.-]{3,32}$/;
const ROLES = ['admin', 'user'];

module.exports = function setupAuth(app, pool) {
  const T = `${SCHEMA}.tai_khoan`;
  let SECRET = process.env.SESSION_SECRET;
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[auth] Chưa đặt SESSION_SECRET trong .env — mọi người sẽ bị đăng xuất mỗi lần khởi động lại máy chủ.');
  }
  const secureCookie = process.env.COOKIE_SECURE === 'true';          // đặt true khi chạy sau HTTPS
  const allowRegister = process.env.ALLOW_REGISTER !== 'false';

  // ── Băm mật khẩu ──
  async function hashPw(pw) {
    const salt = crypto.randomBytes(16);
    return `${salt.toString('hex')}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
  }
  async function checkPw(pw, stored) {
    const [s, h] = String(stored).split(':');
    if (!s || !h) return false;
    const got = await scrypt(pw, Buffer.from(s, 'hex'), 64);
    const want = Buffer.from(h, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  // ── Token phiên ──
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  function makeToken(id, days) {
    const p = b64(JSON.stringify({ id, exp: Date.now() + days * DAY }));
    return `${p}.${sign(p)}`;
  }
  function readToken(tok) {
    const [p, sig] = String(tok || '').split('.');
    if (!p || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(p));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
  }
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter((x) => x[0]));
  function setCookie(res, value, days) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (days) parts.push(`Max-Age=${Math.round(days * 86400)}`); else if (value === '') parts.push('Max-Age=0');
    if (secureCookie) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // ── Truy vấn tài khoản (bộ nhớ đệm 10 giây để các yêu cầu ảnh/raster không dồn vào CSDL) ──
  const ucache = new Map();
  const dropCache = () => ucache.clear();
  async function userById(id) {
    const hit = ucache.get(id);
    if (hit && hit.t > Date.now()) return hit.u;
    const { rows } = await pool.query(`SELECT id, ten_dang_nhap, ho_ten, vai_tro, khoa FROM ${T} WHERE id = $1`, [id]);
    const u = rows[0] && !rows[0].khoa ? { id: rows[0].id, username: rows[0].ten_dang_nhap, name: rows[0].ho_ten || rows[0].ten_dang_nhap, role: rows[0].vai_tro } : null;
    ucache.set(id, { u, t: Date.now() + 10000 });
    return u;
  }
  const pubRow = (r) => ({ id: r.id, username: r.ten_dang_nhap, name: r.ho_ten || r.ten_dang_nhap, role: r.vai_tro, locked: r.khoa, created: r.tao_luc, last: r.dang_nhap_cuoi });

  // ── Tạo bảng + tài khoản quản trị đầu tiên ──
  async function init() {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${T} (
      id             serial PRIMARY KEY,
      ten_dang_nhap  text NOT NULL UNIQUE CHECK (ten_dang_nhap ~ '^[a-z0-9_.-]{3,32}$'),
      ho_ten         text,
      vai_tro        text NOT NULL DEFAULT 'user' CHECK (vai_tro IN ('admin', 'user')),
      mat_khau_bam   text NOT NULL,
      khoa           boolean NOT NULL DEFAULT false,
      tao_luc        timestamptz NOT NULL DEFAULT now(),
      dang_nhap_cuoi timestamptz)`);
    await pool.query(`COMMENT ON TABLE ${T} IS 'Tài khoản đăng nhập web. Mật khẩu băm scrypt (muối:băm). Vai trò admin | user.'`);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM ${T} WHERE vai_tro = 'admin'`);
    if (!rows[0].n) {
      const u = String(process.env.ADMIN_USER || 'admin').toLowerCase();
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw || pw.length < 6) {
        console.error('[auth] Chưa có quản trị viên. Đặt ADMIN_USER và ADMIN_PASSWORD (≥ 6 ký tự) trong .env rồi chạy lại.');
        return;
      }
      await pool.query(`INSERT INTO ${T} (ten_dang_nhap, ho_ten, vai_tro, mat_khau_bam) VALUES ($1, 'Quản trị viên', 'admin', $2)`, [u, await hashPw(pw)]);
      console.log(`[auth] Đã tạo quản trị viên "${u}". Nên xoá ADMIN_PASSWORD khỏi .env sau khi đăng nhập và đổi mật khẩu.`);
    }
  }
  const ready = init().catch((e) => { console.error('[auth] Không khởi tạo được bảng tài khoản:', e.message); });

  // ── Middleware: gắn req.user ──
  app.use(async (req, res, next) => {
    try {
      const d = readToken(cookies(req)[COOKIE]);
      req.user = d ? await userById(d.id) : null;
      next();
    } catch (e) { next(e); }
  });

  // Chống CSRF: yêu cầu ghi phải cùng nguồn gốc
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const o = req.headers.origin;
    if (o && new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
    next();
  });

  const requireLogin = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Cần đăng nhập' }));
  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Cần đăng nhập' });
    return req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Cần quyền quản trị' });
  };

  // ── Cổng chặn dữ liệu: đặt TRƯỚC express.static ──
  app.use((req, res, next) => {
    const p = req.path;
    // database/xuat_ban_tinh.js đặt LST_EXPORT=1 để máy chủ tạm (cổng 3999) cho phép chính máy đó gọi API khi xuất bản tĩnh.
    // Biến này không bao giờ được đặt khi chạy web thật.
    if (process.env.LST_EXPORT === '1' && ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(req.ip)) return next();
    if (p === '/admin' || p === '/admin.html') {
      return req.user && req.user.role === 'admin' ? next() : res.redirect(req.user ? '/index.html?denied=1' : '/login.html?next=admin.html');
    }
    if (p.startsWith('/api/auth/')) return next();
    if (p.startsWith('/api/admin/') || p.startsWith('/api/compare')) return requireAdmin(req, res, next);   // /api/compare: sai số mô hình, chỉ quản trị
    if (p.startsWith('/api/')) return requireLogin(req, res, next);
    if (p.startsWith('/data/du_bao/')) return requireAdmin(req, res, next);    // GeoTIFF dự báo: chỉ quản trị
    if (p.startsWith('/data/')) return requireLogin(req, res, next);
    next();
  });

  // ── Đăng nhập / đăng ký / đăng xuất ──
  const fails = new Map();
  const failKey = (req, u) => `${req.ip}|${u}`;

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      await ready;
      const u = String((req.body || {}).u || '').trim().toLowerCase();
      const pw = String((req.body || {}).pw || '');
      const k = failKey(req, u);
      const f = fails.get(k);
      if (f && f.until > Date.now()) return res.status(429).json({ error: `Nhập sai quá nhiều lần. Thử lại sau ${Math.ceil((f.until - Date.now()) / 60000)} phút` });
      const { rows } = await pool.query(`SELECT * FROM ${T} WHERE ten_dang_nhap = $1`, [u]);
      const r = rows[0];
      const ok = r ? await checkPw(pw, r.mat_khau_bam) : (await scrypt(pw, 'x', 64), false);   // tốn thời gian như nhau dù tài khoản có tồn tại hay không
      if (!ok) {
        const n = (f ? f.n : 0) + 1;
        fails.set(k, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
        return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
      }
      if (r.khoa) return res.status(403).json({ error: 'Tài khoản đang bị khoá. Liên hệ quản trị viên' });
      fails.delete(k);
      await pool.query(`UPDATE ${T} SET dang_nhap_cuoi = now() WHERE id = $1`, [r.id]);
      dropCache();
      const days = (req.body || {}).remember ? 30 : 0;           // 0 = cookie phiên, mất khi đóng trình duyệt
      setCookie(res, makeToken(r.id, days || 1), days);
      res.json({ user: pubRow(r) });
    } catch (e) { next(e); }
  });

  app.post('/api/auth/register', async (req, res, next) => {
    try {
      await ready;
      if (!allowRegister) return res.status(403).json({ error: 'Máy chủ đã tắt đăng ký tự do' });
      const { u, name, pw } = req.body || {};
      const un = String(u || '').trim().toLowerCase();
      if (!NAME_RE.test(un)) return res.status(400).json({ error: 'Tên đăng nhập gồm 3–32 ký tự: chữ thường, số, dấu . _ -' });
      if (String(pw || '').length < 6) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 6 ký tự' });
      try {
        const { rows } = await pool.query(`INSERT INTO ${T} (ten_dang_nhap, ho_ten, vai_tro, mat_khau_bam) VALUES ($1, $2, 'user', $3) RETURNING *`,
          [un, String(name || '').trim().slice(0, 80) || null, await hashPw(String(pw))]);
        res.status(201).json({ user: pubRow(rows[0]) });                // luôn là 'user' — không bao giờ nhận vai trò từ người gọi
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
        throw e;
      }
    } catch (e) { next(e); }
  });

  app.post('/api/auth/logout', (req, res) => { setCookie(res, '', 0); res.json({ ok: true }); });
  // Trả 200 + user:null khi chưa đăng nhập (không phải lỗi) để trình duyệt không báo đỏ ở trang đăng nhập
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null }));

  // ── Quản lý tài khoản (chỉ admin) ──
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
  const activeAdmins = async (excludeId) => (await pool.query(`SELECT count(*)::int n FROM ${T} WHERE vai_tro = 'admin' AND NOT khoa AND id <> $1`, [excludeId ?? -1])).rows[0].n;

  app.get('/api/admin/users', wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${T} ORDER BY vai_tro, ten_dang_nhap`);
    res.json({ users: rows.map(pubRow) });
  }));

  app.post('/api/admin/users', wrap(async (req, res) => {
    const { u, name, pw, role } = req.body || {};
    const un = String(u || '').trim().toLowerCase();
    if (!NAME_RE.test(un)) return res.status(400).json({ error: 'Tên đăng nhập gồm 3–32 ký tự: chữ thường, số, dấu . _ -' });
    if (String(pw || '').length < 6) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 6 ký tự' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
    try {
      await pool.query(`INSERT INTO ${T} (ten_dang_nhap, ho_ten, vai_tro, mat_khau_bam) VALUES ($1, $2, $3, $4)`,
        [un, String(name || '').trim().slice(0, 80) || null, role, await hashPw(String(pw))]);
      res.status(201).json({ ok: true });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
      throw e;
    }
  }));

  app.patch('/api/admin/users/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT * FROM ${T} WHERE id = $1`, [id]);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    const self = id === req.user.id;
    const { role, locked, pw, name } = req.body || {};
    const sets = [], vals = [];
    const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (role !== undefined) {
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
      if (self && role !== 'admin') return res.status(400).json({ error: 'Không thể tự hạ quyền của chính mình' });
      push('vai_tro', role);
    }
    if (locked !== undefined) {
      if (self && locked) return res.status(400).json({ error: 'Không thể tự khoá tài khoản của mình' });
      if (locked && t.vai_tro === 'admin' && (await activeAdmins(id)) < 1) return res.status(400).json({ error: 'Phải còn ít nhất một quản trị viên hoạt động' });
      push('khoa', !!locked);
    }
    if (name !== undefined) push('ho_ten', String(name).trim().slice(0, 80) || null);
    if (pw !== undefined) {
      if (String(pw).length < 6) return res.status(400).json({ error: 'Mật khẩu cần ít nhất 6 ký tự' });
      push('mat_khau_bam', await hashPw(String(pw)));
    }
    if (!sets.length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
    vals.push(id);
    await pool.query(`UPDATE ${T} SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    dropCache();
    res.json({ ok: true });
  }));

  app.delete('/api/admin/users/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Không thể tự xoá tài khoản của mình' });
    const { rows } = await pool.query(`SELECT vai_tro FROM ${T} WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    if (rows[0].vai_tro === 'admin' && (await activeAdmins(id)) < 1) return res.status(400).json({ error: 'Phải còn ít nhất một quản trị viên' });
    await pool.query(`DELETE FROM ${T} WHERE id = $1`, [id]);
    dropCache();
    res.json({ ok: true });
  }));

  return { requireLogin, requireAdmin, ready };
};
