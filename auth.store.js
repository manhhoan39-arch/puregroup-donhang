/* =====================================================================
 * auth.store.js — "Backend" chạy HOÀN TOÀN TRONG TRÌNH DUYỆT
 *   Auth + RBAC + Multi-Tenant, không cần server.
 *   - Mở file trực tiếp (offline) hoặc deploy tĩnh (Netlify/Vercel) đều chạy.
 *   - Dữ liệu lưu trên máy người dùng: users/factories/audit + session ở localStorage,
 *     dataset (đơn hàng, Mix, Step5/6, file) ở IndexedDB (chịu được payload lớn).
 *   - LƯU Ý BẢO MẬT: mọi thứ chạy client nên đây là PHÂN TÁCH THEO QUY TRÌNH,
 *     không phải rào bảo mật chống người dùng kỹ thuật. Phù hợp công cụ nội bộ.
 *
 * Cung cấp API: window.CLStore.handle(method, path, body, token) -> Promise(body)
 *   (mô phỏng đúng REST cũ để auth.web.js gần như không phải đổi).
 * Đồng thời export lõi thuần (Core) cho unit test trên Node.
 * ===================================================================== */
(function (root) {
  'use strict';

  // ================= LÕI THUẦN (RBAC + tenant) — test được trên Node =================
  var ROLES = ['user', 'factory_admin', 'super_admin'];
  var PERMISSIONS = {
    super_admin: [
      'factory:create', 'factory:read', 'factory:update', 'factory:delete',
      'user:create', 'user:read', 'user:update', 'user:delete',
      'dataset:create', 'dataset:read', 'dataset:update', 'dataset:delete',
      'dataset:import', 'dataset:export', 'dataset:run',
      'audit:read', 'scope:all',
    ],
    factory_admin: [
      'factory:read',
      'user:create', 'user:read', 'user:update', 'user:delete',
      'dataset:create', 'dataset:read', 'dataset:update', 'dataset:delete',
      'dataset:import', 'dataset:export', 'dataset:run',
      'audit:read',
    ],
    user: ['dataset:create', 'dataset:read', 'dataset:import', 'dataset:export', 'dataset:run'],
  };
  function can(role, perm) { var l = PERMISSIONS[role]; return !!l && l.indexOf(perm) !== -1; }
  function crossFactory(role) { return can(role, 'scope:all'); }
  function scopeFactoryId(user) { return crossFactory(user.role) ? null : (user.factory_id || null); }

  function ApiErr(status, message) { return { apiError: true, status: status, message: message }; }

  // Lọc dataset theo phạm vi tenant.
  function filterDatasets(list, scopeFid, filterFid) {
    if (scopeFid == null) return filterFid ? list.filter(function (d) { return d.factory_id === filterFid; }) : list;
    return list.filter(function (d) { return d.factory_id === scopeFid; });
  }
  function canSeeDataset(row, scopeFid) { return row && (scopeFid == null || row.factory_id === scopeFid); }

  // Quy tắc tạo user: trả {role, factory_id} đã chuẩn hoá hoặc ném lỗi.
  function resolveNewUser(actor, body) {
    var cross = crossFactory(actor.role);
    var role = body.role || 'user';
    if (ROLES.indexOf(role) === -1) throw ApiErr(400, 'Role không hợp lệ');
    if (!cross && role === 'super_admin') throw ApiErr(403, 'Không thể tạo/gán Super Admin');
    var fid = role === 'super_admin' ? null : (cross ? (body.factory_id || null) : actor.factory_id);
    return { role: role, factory_id: fid };
  }
  // Guard khi thao tác lên 1 user đích.
  function guardTargetUser(actor, target) {
    if (crossFactory(actor.role)) return;
    if (target.factory_id !== actor.factory_id) throw ApiErr(403, 'Không thể thao tác user của xưởng khác');
    if (target.role === 'super_admin') throw ApiErr(403, 'Không đủ quyền');
  }

  var Core = {
    ROLES: ROLES, PERMISSIONS: PERMISSIONS, can: can, crossFactory: crossFactory,
    scopeFactoryId: scopeFactoryId, filterDatasets: filterDatasets, canSeeDataset: canSeeDataset,
    resolveNewUser: resolveNewUser, guardTargetUser: guardTargetUser, ApiErr: ApiErr,
  };

  // Node test dừng ở đây (không đụng API trình duyệt).
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }

  // ================= LỚP LƯU TRỮ (trình duyệt) =================
  var LS_DB = 'cl_offline_db_v1'; // {factories, users, audit}
  var IDB_NAME = 'charmlash_orders';
  var IDB_STORE = 'datasets';

  function uid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function nowIso() { return new Date().toISOString(); }
  function loadDB() { try { return JSON.parse(localStorage.getItem(LS_DB)) || {}; } catch (_) { return {}; } }
  function saveDB(db) { localStorage.setItem(LS_DB, JSON.stringify(db)); }

  // ---- Băm mật khẩu: PBKDF2 (Web Crypto) + fallback nếu không có subtle ----
  function enc(s) { return new TextEncoder().encode(s); }
  function bufToHex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function hexToBuf(hex) { var a = new Uint8Array(hex.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }
  function randSalt() { var s = new Uint8Array(16); (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(s) : s.forEach(function (_, i) { s[i] = Math.floor(Math.random() * 256); }); return s; }

  function subtleAvailable() { return root.crypto && root.crypto.subtle && typeof root.crypto.subtle.deriveBits === 'function'; }

  function hashPassword(plain, saltHex) {
    var salt = saltHex ? hexToBuf(saltHex) : randSalt();
    if (subtleAvailable()) {
      return root.crypto.subtle.importKey('raw', enc(String(plain)), 'PBKDF2', false, ['deriveBits'])
        .then(function (key) {
          return root.crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
        })
        .then(function (bits) { return { algo: 'pbkdf2', salt: bufToHex(salt), hash: bufToHex(bits) }; });
    }
    // Fallback (yếu hơn) — chỉ dùng khi trình duyệt không có crypto.subtle.
    return Promise.resolve({ algo: 'weak', salt: bufToHex(salt), hash: weakHash(bufToHex(salt) + '::' + plain) });
  }
  function weakHash(str) { var h = 5381; for (var i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; } var out = ''; for (var k = 0; k < 8; k++) { h = (h * 33 + 7) >>> 0; out += ('0000000' + h.toString(16)).slice(-8); } return out; }
  function verifyPassword(plain, rec) {
    if (!rec) return Promise.resolve(false);
    if (rec.algo === 'weak') return Promise.resolve(weakHash(rec.salt + '::' + plain) === rec.hash);
    return hashPassword(plain, rec.salt).then(function (r) { return r.hash === rec.hash; });
  }

  // ---- IndexedDB cho datasets ----
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          var s = db.createObjectStore(IDB_STORE, { keyPath: 'id' });
          s.createIndex('factory_id', 'factory_id', { unique: false });
        }
      };
      r.onsuccess = function (e) { res(e.target.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function dsTx(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, mode);
        var store = tx.objectStore(IDB_STORE);
        var out = fn(store);
        tx.oncomplete = function () { res(out && out.__req ? out.__req.result : out); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function dsAll() { return dsTx('readonly', function (s) { var req = s.getAll(); return { __req: req }; }); }
  function dsGet(id) { return dsTx('readonly', function (s) { var req = s.get(id); return { __req: req }; }); }
  function dsPut(obj) { return dsTx('readwrite', function (s) { s.put(obj); return obj; }); }
  function dsDelete(id) { return dsTx('readwrite', function (s) { s.delete(id); return true; }); }

  // ---- Audit ----
  function audit(db, entry) {
    db.audit = db.audit || [];
    db.audit.unshift({ id: uid(), created_at: nowIso(), factory_id: entry.factory_id || null, username: entry.username || null, action: entry.action, detail: entry.detail || null });
    if (db.audit.length > 1000) db.audit.length = 1000;
  }

  // ================= Migration: đổi tên xưởng cũ HN/HCM -> NĐ/HY (không mất dữ liệu) =================
  function migrateExisting(db) {
    var facMap = { HN: { code: 'NĐ', name: 'Xưởng NĐ' }, HCM: { code: 'HY', name: 'Xưởng HY' } };
    var userMap = { 'admin.hn': 'admin.nd', 'user.hn': 'user.nd', 'admin.hcm': 'admin.hy', 'user.hcm': 'user.hy' };
    var changed = false;
    (db.factories || []).forEach(function (f) {
      var m = facMap[f.code];
      if (m) { f.name = m.name; f.code = m.code; changed = true; }
    });
    (db.users || []).forEach(function (u) {
      if (userMap[u.username]) { u.username = userMap[u.username]; changed = true; }
      if (u.display_name) {
        var nd = u.display_name.replace(/\bHN\b/g, 'NĐ').replace(/\bHCM\b/g, 'HY');
        if (nd !== u.display_name) { u.display_name = nd; changed = true; }
      }
    });
    return changed;
  }

  // Quyền MẶC ĐỊNH cho tài khoản user mới / seed = CHỈ XEM mọi bảng (không phải toàn quyền).
  // → user ở cửa sổ ẩn danh (dữ liệu bị seed lại) KHÔNG còn hành xử như admin.
  function defaultUserPerms(){ return { s1:'view', s3:'view', s4:'view', s5:'view', s6:'view', s10:'view', s7:'view', s8:'view', s9:'view' }; }

  // ================= SEED lần đầu =================
  var initPromise = null;
  function ensureInit() {
    if (initPromise) return initPromise;
    initPromise = (function () {
      var db = loadDB();
      if (migrateExisting(db)) saveDB(db); // đổi tên xưởng cũ nếu có
      if (db.users && db.users.length) return Promise.resolve(db);
      db.factories = db.factories || [];
      db.users = db.users || [];
      db.audit = db.audit || [];
      var facND = { id: uid(), code: 'NĐ', name: 'Xưởng NĐ', active: 1, created_at: nowIso() };
      var facHY = { id: uid(), code: 'HY', name: 'Xưởng HY', active: 1, created_at: nowIso() };
      db.factories.push(facND, facHY);
      var seedList = [
        { username: 'superadmin', pass: 'ChangeMe!123', display_name: 'Super Admin', role: 'super_admin', factory_id: null },
        { username: 'admin.nd', pass: 'Factory@123', display_name: 'Factory Admin NĐ', role: 'factory_admin', factory_id: facND.id },
        { username: 'user.nd', pass: 'User@123', display_name: 'Nhân viên NĐ', role: 'user', factory_id: facND.id },
        { username: 'admin.hy', pass: 'Factory@123', display_name: 'Factory Admin HY', role: 'factory_admin', factory_id: facHY.id },
        { username: 'user.hy', pass: 'User@123', display_name: 'Nhân viên HY', role: 'user', factory_id: facHY.id },
      ];
      return seedList.reduce(function (p, s) {
        return p.then(function () {
          return hashPassword(s.pass).then(function (pw) {
            db.users.push({ id: uid(), username: s.username, pass: pw, pass_plain: s.pass, display_name: s.display_name, role: s.role, factory_id: s.factory_id, active: 1, created_at: nowIso(), stepPerms: (s.role === 'user') ? defaultUserPerms() : null });
          });
        });
      }, Promise.resolve()).then(function () { saveDB(db); return db; });
    })();
    return initPromise;
  }

  // ================= Tiện ích =================
  function pubUser(u) { if (!u) return u; return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, factory_id: u.factory_id, active: u.active, created_at: u.created_at, stepPerms: u.stepPerms || null, pass_plain: (u.pass_plain != null ? u.pass_plain : null) }; }
  function pubFactory(f) { return f; }
  function findUser(db, id) { return (db.users || []).filter(function (u) { return u.id === id; })[0]; }
  function findUserByName(db, n) { return (db.users || []).filter(function (u) { return u.username === n; })[0]; }
  function findFactory(db, id) { return (db.factories || []).filter(function (f) { return f.id === id; })[0]; }
  function authUser(db, token) { var u = token && findUser(db, token); if (!u || !u.active) throw ApiErr(401, 'Chưa đăng nhập hoặc phiên không hợp lệ'); return u; }
  function requirePerm(user, perm) { if (!can(user.role, perm)) throw ApiErr(403, 'Thiếu quyền: ' + perm); }

  // ================= ROUTER =================
  // Trả về Promise(body). Lỗi -> reject({apiError,status,message}) để auth.web.js xử lý.
  function handle(method, rawPath, body, token) {
    method = method.toUpperCase();
    var qs = {};
    var path = rawPath;
    var qi = rawPath.indexOf('?');
    if (qi >= 0) { path = rawPath.slice(0, qi); rawPath.slice(qi + 1).split('&').forEach(function (kv) { var p = kv.split('='); qs[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); }); }
    body = body || {};
    var parts = path.replace(/^\/api\//, '').split('/'); // vd ['datasets','<id>']
    var res = parts[0], id = parts[1];

    return ensureInit().then(function (db) {
      // ---- AUTH ----
      if (res === 'auth') {
        if (id === 'login' && method === 'POST') {
          var u = findUserByName(db, String(body.username || '').trim());
          if (!u || !u.active) throw ApiErr(401, 'Sai tài khoản hoặc mật khẩu');
          return verifyPassword(body.password, u.pass).then(function (okp) {
            if (!okp) throw ApiErr(401, 'Sai tài khoản hoặc mật khẩu');
            audit(db, { factory_id: u.factory_id, username: u.username, action: 'login' }); saveDB(db);
            return { token: u.id, user: pubUser(u), factory: u.factory_id ? findFactory(db, u.factory_id) : null, permissions: PERMISSIONS[u.role] || [] };
          });
        }
        if (id === 'me' && method === 'GET') {
          var me = authUser(db, token);
          return { user: pubUser(me), factory: me.factory_id ? findFactory(db, me.factory_id) : null, permissions: PERMISSIONS[me.role] || [] };
        }
        if (id === 'logout' && method === 'POST') {
          try { var lu = authUser(db, token); audit(db, { factory_id: lu.factory_id, username: lu.username, action: 'logout' }); saveDB(db); } catch (e) {}
          return { ok: true };
        }
        throw ApiErr(404, 'Không tìm thấy');
      }

      var actor = authUser(db, token);
      var scopeFid = scopeFactoryId(actor);

      // ---- FACTORIES ----
      if (res === 'factories') {
        if (method === 'GET') {
          requirePerm(actor, 'factory:read');
          if (crossFactory(actor.role)) return (db.factories || []).slice();
          var f = actor.factory_id ? findFactory(db, actor.factory_id) : null;
          return f ? [f] : [];
        }
        if (method === 'POST') {
          requirePerm(actor, 'factory:create');
          if (!body.code || !body.name) throw ApiErr(400, 'Cần mã và tên xưởng');
          if ((db.factories || []).some(function (f) { return f.code === String(body.code).trim(); })) throw ApiErr(409, 'Mã xưởng đã tồn tại');
          var nf = { id: uid(), code: String(body.code).trim(), name: String(body.name).trim(), active: 1, created_at: nowIso() };
          db.factories.push(nf); audit(db, { username: actor.username, action: 'factory:create', detail: nf.code }); saveDB(db);
          return nf;
        }
        if (method === 'PUT' && id) {
          requirePerm(actor, 'factory:update');
          var ef = findFactory(db, id); if (!ef) throw ApiErr(404, 'Không tìm thấy xưởng');
          if (body.code && db.factories.some(function (f) { return f.code === String(body.code).trim() && f.id !== id; })) throw ApiErr(409, 'Mã xưởng đã tồn tại');
          if (body.name != null) ef.name = String(body.name);
          if (body.code != null) ef.code = String(body.code).trim();
          if (body.active != null) ef.active = body.active ? 1 : 0;
          audit(db, { username: actor.username, action: 'factory:update', detail: ef.code }); saveDB(db);
          return ef;
        }
        if (method === 'DELETE' && id) {
          requirePerm(actor, 'factory:delete');
          var df = findFactory(db, id); if (!df) throw ApiErr(404, 'Không tìm thấy xưởng');
          db.factories = db.factories.filter(function (f) { return f.id !== id; });
          db.users = db.users.filter(function (u) { return u.factory_id !== id; }); // cascade user
          audit(db, { username: actor.username, action: 'factory:delete', detail: df.code }); saveDB(db);
          // cascade dataset trong IndexedDB
          return dsAll().then(function (all) {
            return Promise.all((all || []).filter(function (d) { return d.factory_id === id; }).map(function (d) { return dsDelete(d.id); }));
          }).then(function () { return { ok: true }; });
        }
      }

      // ---- USERS ----
      if (res === 'users') {
        if (method === 'GET') {
          requirePerm(actor, 'user:read');
          var list = (db.users || []).filter(function (u) { return scopeFid == null || u.factory_id === scopeFid; });
          return list.map(pubUser);
        }
        if (method === 'POST') {
          requirePerm(actor, 'user:create');
          if (!body.username || !body.password) throw ApiErr(400, 'Cần username và password');
          var rn = resolveNewUser(actor, body);
          if (rn.role !== 'super_admin') {
            if (!rn.factory_id) throw ApiErr(400, 'User/Factory Admin bắt buộc thuộc một Factory');
            if (!findFactory(db, rn.factory_id)) throw ApiErr(400, 'Factory không tồn tại');
          }
          if (findUserByName(db, String(body.username).trim())) throw ApiErr(409, 'Username đã tồn tại');
          return hashPassword(body.password).then(function (pw) {
            var nu = { id: uid(), username: String(body.username).trim(), pass: pw, pass_plain: body.password, display_name: body.display_name || body.username, role: rn.role, factory_id: rn.factory_id, active: 1, created_at: nowIso(), stepPerms: (rn.role === 'user') ? ((body.stepPerms && typeof body.stepPerms === 'object') ? body.stepPerms : defaultUserPerms()) : null };
            db.users.push(nu); audit(db, { factory_id: rn.factory_id, username: actor.username, action: 'user:create', detail: nu.username }); saveDB(db);
            return pubUser(nu);
          });
        }
        if (method === 'PUT' && id) {
          requirePerm(actor, 'user:update');
          var tu = findUser(db, id); if (!tu) throw ApiErr(404, 'Không tìm thấy user');
          guardTargetUser(actor, tu);
          if (body.display_name != null) tu.display_name = body.display_name;
          if (body.active != null) tu.active = body.active ? 1 : 0;
          if (body.role != null) { var rr = resolveNewUser(actor, { role: body.role, factory_id: tu.factory_id }); tu.role = rr.role; }
          if (body.stepPerms !== undefined) tu.stepPerms = (body.stepPerms && typeof body.stepPerms === 'object') ? body.stepPerms : null;
          if (tu.role !== 'user') tu.stepPerms = null;  // chỉ user mới bị giới hạn theo step
          if (crossFactory(actor.role) && body.factory_id !== undefined) tu.factory_id = body.factory_id;
          var chain = Promise.resolve();
          if (body.password) chain = hashPassword(body.password).then(function (pw) { tu.pass = pw; tu.pass_plain = body.password; });
          return chain.then(function () { audit(db, { factory_id: tu.factory_id, username: actor.username, action: 'user:update', detail: tu.username }); saveDB(db); return pubUser(tu); });
        }
        if (method === 'DELETE' && id) {
          requirePerm(actor, 'user:delete');
          var du = findUser(db, id); if (!du) throw ApiErr(404, 'Không tìm thấy user');
          if (du.id === actor.id) throw ApiErr(400, 'Không thể tự xóa chính mình');
          guardTargetUser(actor, du);
          var supers = (db.users || []).filter(function (u) { return u.role === 'super_admin' && u.active; });
          if (du.role === 'super_admin' && supers.length <= 1) throw ApiErr(400, 'Phải còn ít nhất 1 Super Admin');
          db.users = db.users.filter(function (u) { return u.id !== id; });
          audit(db, { factory_id: du.factory_id, username: actor.username, action: 'user:delete', detail: du.username }); saveDB(db);
          return { ok: true };
        }
      }

      // ---- DATASETS (IndexedDB, cô lập tenant) ----
      if (res === 'datasets') {
        if (method === 'GET' && !id) {
          requirePerm(actor, 'dataset:read');
          return dsAll().then(function (all) {
            return filterDatasets(all || [], scopeFid, qs.factoryId).sort(function (a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); })
              .map(function (d) { return { id: d.id, factory_id: d.factory_id, name: d.name, kind: d.kind, created_by: d.created_by, created_at: d.created_at, updated_at: d.updated_at }; });
          });
        }
        if (method === 'GET' && id) {
          requirePerm(actor, 'dataset:read');
          return dsGet(id).then(function (d) { if (!canSeeDataset(d, scopeFid)) throw ApiErr(404, 'Không thấy dataset (hoặc thuộc xưởng khác)'); return d; });
        }
        if (method === 'POST') {
          requirePerm(actor, 'dataset:create');
          if (!body.name) throw ApiErr(400, 'Cần tên dataset');
          var fid = crossFactory(actor.role) ? (body.factory_id || qs.factoryId || null) : actor.factory_id;
          if (!fid) throw ApiErr(400, 'Cần factory_id (super admin phải chỉ định xưởng)');
          if (!findFactory(db, fid)) throw ApiErr(400, 'Factory không tồn tại');
          var t = nowIso();
          var nd = { id: uid(), factory_id: fid, name: body.name, kind: body.kind || 'orders', payload: body.payload || {}, created_by: actor.username, created_at: t, updated_at: t };
          return dsPut(nd).then(function () { audit(db, { factory_id: fid, username: actor.username, action: 'dataset:create', detail: nd.name }); saveDB(db); return nd; });
        }
        if (method === 'PUT' && id) {
          requirePerm(actor, 'dataset:update');
          return dsGet(id).then(function (d) {
            if (!canSeeDataset(d, scopeFid)) throw ApiErr(404, 'Không thấy dataset (hoặc thuộc xưởng khác)');
            if (body.name != null) d.name = body.name;
            if (body.kind != null) d.kind = body.kind;
            if (body.payload !== undefined) d.payload = body.payload;
            d.updated_at = nowIso();
            return dsPut(d).then(function () { audit(db, { factory_id: d.factory_id, username: actor.username, action: 'dataset:update', detail: d.name }); saveDB(db); return d; });
          });
        }
        if (method === 'DELETE' && id) {
          requirePerm(actor, 'dataset:delete');
          return dsGet(id).then(function (d) {
            if (!canSeeDataset(d, scopeFid)) throw ApiErr(404, 'Không thấy dataset (hoặc thuộc xưởng khác)');
            return dsDelete(id).then(function () { audit(db, { factory_id: d.factory_id, username: actor.username, action: 'dataset:delete', detail: d.name }); saveDB(db); return { ok: true }; });
          });
        }
      }

      // ---- AUDIT ----
      if (res === 'audit' && method === 'GET') {
        requirePerm(actor, 'audit:read');
        var lim = Math.min(parseInt(qs.limit, 10) || 200, 1000);
        return (db.audit || []).filter(function (a) { return scopeFid == null || a.factory_id === scopeFid; }).slice(0, lim);
      }

      throw ApiErr(404, 'Không tìm thấy: ' + method + ' ' + path);
    });
  }

  // Xuất/nhập toàn bộ dữ liệu (sao lưu) — tiện cho admin.
  function exportAll() {
    return dsAll().then(function (all) { return { meta: loadDB(), datasets: all || [], exportedAt: nowIso() }; });
  }

  root.CLStore = { handle: handle, Core: Core, exportAll: exportAll, migrateExisting: migrateExisting, _resetForTest: function () { initPromise = null; } };
})(typeof window !== 'undefined' ? window : globalThis);
