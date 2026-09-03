/* =====================================================================
 * cl.sync.js — Lớp ĐỒNG BỘ + CACHE (offline-first) cho Module Nhập Đơn
 * ---------------------------------------------------------------------
 * Nguồn dữ liệu chính = Supabase (PostgreSQL). LocalStorage = cache + offline.
 *  - Đăng nhập bằng Supabase Auth (email/mật khẩu). RLS cách ly theo xưởng.
 *  - Đọc: ưu tiên cache (nhanh), làm tươi từ DB ở nền.
 *  - Ghi: cập nhật cache NGAY + đẩy lên DB; mất mạng thì xếp hàng, tự flush khi online.
 *  - Thiếu cấu hình / tắt sync  => chạy OFFLINE thuần (chỉ cache), không lỗi.
 *
 * Nạp SAU cl.config.js. Expose: window.CLCloud
 * ===================================================================== */
(function (root) {
  'use strict';
  var CFG = root.CL_CONFIG || {};
  var SUPA_UMD = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  // ---------- Cache (LocalStorage) ----------
  var K = {
    profile: 'clc_profile',
    dsIndex: function (fid) { return 'clc_ds_index_' + (fid || 'none'); },
    dsItem:  function (id)  { return 'clc_ds_' + id; },
    queue:   'clc_queue',
    lastSync:'clc_last_sync',
    /* Sổ "mảnh nào đã THẬT SỰ nằm trên máy chủ" (thêm 29/8 — xem ghi chú ở saveGoi).
       Trước đây app cứ thấy dấu vân tay không đổi là bỏ qua không gửi lại, mà dấu vân tay
       thì ghi vào bộ nhớ máy TRƯỚC khi gửi ⇒ lần gửi hỏng là mảnh vĩnh viễn không bao giờ
       được gửi nữa, còn chỉ mục vẫn trỏ tới nó ⇒ "bản lưu thiếu 67 mảnh". */
    daLen:   function (fid) { return 'clc_len_' + (fid || 'none'); }
  };
  function jget(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  function jdel(k) { try { localStorage.removeItem(k); } catch (_) {} }

  // ---------- Trạng thái ----------
  var client = null;          // Supabase client
  var profile = jget(K.profile, null);  // {id,email,role,factory_id,display_name,step_perms}
  var listeners = { auth: [], sync: [] };
  var loadingClient = null;

  function emit(kind, payload) { (listeners[kind] || []).forEach(function (f) { try { f(payload); } catch (_) {} }); }
  function log() { try { console.log.apply(console, ['[CLCloud]'].concat([].slice.call(arguments))); } catch (_) {} }

  function configured() { return !!(CFG.SYNC_ENABLED && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY); }
  function online() { return (typeof navigator === 'undefined') || navigator.onLine !== false; }

  /* =====================================================================
   * NÉN + CHIA MẢNH BẢN LƯU (chốt 28/8) — "tự lưu chỉ gửi phần thay đổi"
   * ---------------------------------------------------------------------
   * Trước: mỗi lần tự lưu đẩy TOÀN BỘ kho lên Supabase (68 đơn ≈ 7MB) và nhét nguyên chừng đó
   * vào localStorage — mạng xưởng 5 Mbps mất ~11 giây/lần, còn localStorage tràn 5MB ở khoảng
   * 48 đơn rồi hỏng cache IM LẶNG (mất mạng là không mở lại được).
   * Nay một bản lưu gồm:
   *   · 1 dòng CHỈ MỤC (kind 'orders')     — nhật ký + danh sách mảnh kèm dấu vân tay
   *   · mỗi MÃ ĐƠN 1 dòng (kind 'orders-manh')
   *   · 1 dòng ẢNH (kind 'orders-anh')     — ảnh chiếm hơn nửa dung lượng mà hầu như không đổi
   * Mảnh nào dấu vân tay không đổi thì KHÔNG gửi lại. Tất cả nén gzip trước khi gửi.
   * Đo trên 8 đơn thật: cả kho 833KB → sửa 1 ô chỉ đẩy ~52KB (chỉ mục 7KB + 1 mảnh 45KB).
   * Bản lưu KIỂU CŨ (payload nguyên khối) vẫn đọc được bình thường.
   * ===================================================================== */
  var KIND_MANH = 'orders-manh', KIND_ANH = 'orders-anh';
  function laManh(d) { return !!d && (d.kind === KIND_MANH || d.kind === KIND_ANH); }
  function coNen() { return typeof root.CompressionStream === 'function' && typeof root.DecompressionStream === 'function'; }
  function b64Tu(bytes) {
    var s = '', N = 0x8000;
    for (var i = 0; i < bytes.length; i += N) s += String.fromCharCode.apply(null, bytes.subarray(i, i + N));
    return root.btoa(s);
  }
  function b64Ve(b64) {
    var s = root.atob(b64), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function nen(obj) {
    var chuoi = JSON.stringify(obj);
    if (!coNen()) return Promise.resolve({ n: 0, d: chuoi });
    try {
      var cs = new root.CompressionStream('gzip');
      var w = cs.writable.getWriter();
      w.write(new TextEncoder().encode(chuoi)); w.close();
      return new Response(cs.readable).arrayBuffer()
        .then(function (buf) { return { n: 1, d: b64Tu(new Uint8Array(buf)) }; })
        .catch(function () { return { n: 0, d: chuoi }; });
    } catch (_) { return Promise.resolve({ n: 0, d: chuoi }); }
  }
  function giaiNen(o) {
    if (!o) return Promise.resolve(null);
    if (!o.n) { try { return Promise.resolve(typeof o.d === 'string' ? JSON.parse(o.d) : o.d); } catch (_) { return Promise.resolve(null); } }
    try {
      var ds = new root.DecompressionStream('gzip');
      var w = ds.writable.getWriter();
      w.write(b64Ve(o.d)); w.close();
      return new Response(ds.readable).text().then(function (t) { return JSON.parse(t); });
    } catch (e) { return Promise.reject(e); }
  }
  function bam32(s) { var h = 5381, i = s.length; while (i) h = (h * 33 ^ s.charCodeAt(--i)) >>> 0; return h; }

  /* =====================================================================
   * KHO TRONG MÁY = IndexedDB + BẢN MỞ NHANH (thêm 29/8)
   * ---------------------------------------------------------------------
   * User: "mở link là phải có dữ liệu đã lưu trên máy … dù không có mạng vẫn xem được chứ
   * không phải đợi load" — mở mấy lần vẫn trắng rồi một lúc sau mới có.
   * NGUYÊN NHÂN: localStorage chỉ khoảng 5MB. Một bản lưu 54 đơn KÈM ẢNH đã vài MB, ghi vào là
   * tràn — mà `jset` bọc try/catch nên tràn thì NUỐT LỖI IM LẶNG. Thế là mảnh không nằm trong
   * máy, mở app lên chẳng có gì, phải đợi tải từ máy chủ.
   * SỬA: dùng IndexedDB (rộng hàng trăm MB) và lưu hẳn MỘT BẢN MỞ NHANH — cả kho đã ghép sẵn,
   * nén gzip, một bản ghi duy nhất. Mở app = đọc đúng 1 bản ghi rồi bày ra, không phụ thuộc
   * mấy chục mảnh rời, không đụng tới mạng.
   * ===================================================================== */
  var DB_TEN = 'cl_kho', DB_BANG = 'bl', _db = null, _dbLoi = false;
  function moDB() {
    if (_db) return Promise.resolve(_db);
    if (_dbLoi || typeof indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise(function (res) {
      var rq;
      try { rq = indexedDB.open(DB_TEN, 1); } catch (e) { _dbLoi = true; return res(null); }
      rq.onupgradeneeded = function () { try { rq.result.createObjectStore(DB_BANG); } catch (e) {} };
      rq.onsuccess = function () { _db = rq.result; res(_db); };
      rq.onerror = function () { _dbLoi = true; res(null); };
      rq.onblocked = function () { _dbLoi = true; res(null); };
      setTimeout(function () { if (!_db) res(null); }, 4000);      // đừng treo app vì IndexedDB
    });
  }
  function idbDoc(khoa) {
    return moDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        try {
          var rq = db.transaction(DB_BANG, 'readonly').objectStore(DB_BANG).get(khoa);
          rq.onsuccess = function () { res(rq.result == null ? null : rq.result); };
          rq.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
  }
  function idbGhi(khoa, gt) {
    return moDB().then(function (db) {
      if (!db) return false;
      return new Promise(function (res) {
        try {
          var tx = db.transaction(DB_BANG, 'readwrite');
          tx.objectStore(DB_BANG).put(gt, khoa);
          tx.oncomplete = function () { res(true); };
          tx.onerror = function () { res(false); };
          tx.onabort = function () { res(false); };
        } catch (e) { res(false); }
      });
    }).catch(function () { return false; });
  }
  function khoaMoNhanh() { return 'mo-nhanh-' + (fid() || 'none'); }

  function fid() { return profile && profile.factory_id; }
  function lenRoi() { return jget(K.daLen(fid()), {}); }
  function danhDauLen(ids) {
    if (!ids || !ids.length) return;
    var m = lenRoi(); ids.forEach(function (i) { if (i) m[i] = 1; }); jset(K.daLen(fid()), m);
  }
  /* Tên dòng mảnh CHÍNH LÀ mã đơn — nhờ vậy khi chỉ mục hỏng vẫn tìm lại được mảnh theo mã đơn
     mà KHÔNG phải tải payload của cả trăm dòng về giải nén (chỉ xin 3 cột, nhẹ như lông hồng). */
  var TIEN_TO_MANH = '⚙ mảnh · ';
  function tenManh(md) { return TIEN_TO_MANH + md; }
  function mdTuTen(ten) { ten = String(ten == null ? '' : ten); return ten.slice(0, TIEN_TO_MANH.length) === TIEN_TO_MANH ? ten.slice(TIEN_TO_MANH.length) : ''; }
  // Bản đồ mã đơn → id dòng mảnh MỚI NHẤT trên máy chủ (kể cả mảnh mồ côi). Chỉ lấy cột nhẹ.
  function banDoManh(c) {
    return c.from('datasets').select('id,name,updated_at')
      .eq('factory_id', fid()).eq('kind', KIND_MANH)
      .order('updated_at', { ascending: false }).range(0, 999)
      .then(function (r) {
        var bd = {}; if (r.error || !r.data) return bd;
        r.data.forEach(function (row) { var m = mdTuTen(row.name); if (m && !bd[m]) bd[m] = row.id; });
        return bd;
      }).catch(function () { return {}; });
  }
  // Mọi dòng mảnh còn nằm trong bộ nhớ máy → mã đơn: dòng (bản mới nhất)
  function manhTrongMay() {
    var ds = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('clc_ds_') !== 0 || k.indexOf('clc_ds_index_') === 0) continue;
        var row = jget(k, null);
        if (row && row.payload && row.payload.__manh) ds.push(row);
      }
    } catch (_) {}
    var theo = {};
    ds.forEach(function (r) {
      var m = mdTuTen(r.name); if (!m) return;
      if (!theo[m] || String(r.updated_at || '') > String(theo[m].updated_at || '')) theo[m] = r;
    });
    return theo;
  }

  /* ⚠⚠ LẤY NHIỀU DÒNG THÌ PHẢI CHIA LÔ (sửa 28/8 — đây chính là lỗi làm "thiếu 67 mảnh").
     PostgREST nhét danh sách id vào URL: `?id=in.(uuid,uuid,…)`. Mỗi UUID 38 ký tự, 67 mảnh là
     URL hơn 2.600 ký tự — vượt giới hạn của proxy/Supabase ⇒ truy vấn hỏng ⇒ app tưởng mảnh
     không tồn tại và báo "bản lưu thiếu 67 mảnh", trong khi dữ liệu VẪN CÒN NGUYÊN trên máy chủ.
     Nay: chia lô 15 dòng, chạy tuần tự; lô nào hỏng thì hạ xuống lấy TỪNG DÒNG một. */
  var LO = 15;
  function layNhieuDong(c, ids) {
    var lo = [], i;
    for (i = 0; i < ids.length; i += LO) lo.push(ids.slice(i, i + LO));
    var duoc = 0, hong = 0;
    return lo.reduce(function (chuoi, mot) {
      return chuoi.then(function () {
        return c.from('datasets').select('*').in('id', mot).then(function (r) {
          if (!r.error) { (r.data || []).forEach(function (row) { jset(K.dsItem(row.id), row); duoc++; }); return; }
          // cả lô hỏng → thử từng dòng, đừng bỏ cả lô chỉ vì một dòng có vấn đề
          return mot.reduce(function (ch2, mid) {
            return ch2.then(function () {
              return c.from('datasets').select('*').eq('id', mid).maybeSingle().then(function (r2) {
                if (!r2.error && r2.data) { jset(K.dsItem(r2.data.id), r2.data); duoc++; } else hong++;
              }).catch(function () { hong++; });
            });
          }, Promise.resolve());
        }).catch(function () { hong += mot.length; });
      });
    }, Promise.resolve()).then(function () {
      log('lấy mảnh: được ' + duoc + ' / hỏng ' + hong + ' / tổng ' + ids.length);
      return { duoc: duoc, hong: hong };
    });
  }
  function ghiNhieuDong(c, rows) {   // ghi theo lô, lô nào hỏng thì dừng và báo (đừng ghi nửa vời rồi im)
    if (!rows || !rows.length) return Promise.resolve({});
    var lo = [], i;
    for (i = 0; i < rows.length; i += LO) lo.push(rows.slice(i, i + LO));
    return lo.reduce(function (chuoi, mot) {
      return chuoi.then(function (kq) {
        if (kq && kq.error) return kq;
        return c.from('datasets').upsert(mot).then(function (r) {
          // ghi được lô nào thì ghi SỔ lô đó ngay — lô sau hỏng cũng không xoá công của lô trước
          if (!(r && r.error)) danhDauLen(mot.map(function (d) { return d.id; }));
          return r;
        });
      });
    }, Promise.resolve({}));
  }
  /* Đếm số mã đơn của bản lưu ĐANG NẰM TRÊN MÁY CHỦ (không phải bản trong máy — bản trong máy
     có thể đã cũ hoặc thiếu). Dùng cho phanh chống ghi đè làm co nhỏ. */
  function demManhTrenMayChu(c, id) {
    return c.from('datasets').select('payload').eq('id', id).maybeSingle()
      .then(function (r) {
        var p = r && r.data && r.data.payload;
        if (!p || !p.__goi) return -1;
        return (p.manh || []).length;
      }).catch(function () { return -1; });
  }
  function idMoi() { return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : ('ds-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }

  /* Tìm lại mảnh mà CHỈ MỤC trỏ tới nhưng không còn tồn tại. Khoá tra cứu là MÃ ĐƠN (nằm ở
     cột name của dòng mảnh), nên chỉ mục hỏng cũng không sao.
     Trả về { thay: {id-cũ: id-mới}, hong: [mấy cái chịu thua] }. */
  function vaManh(mat) {
    var thay = {}, con = mat.slice();
    var may = manhTrongMay();
    con = con.filter(function (x) {
      if (x.loai !== 'manh') return true;
      var r = may[String(x.md)];
      if (r && r.payload) { thay[x.id] = r.id; return false; }
      return true;
    });
    if (!con.length || !configured() || !online() || !fid()) return Promise.resolve({ thay: thay, hong: con });
    return ensureClient().then(function (c) {
      if (!c) return { thay: thay, hong: con };
      return banDoManh(c).then(function (bd) {
        var can = [], ghep = [];
        con.forEach(function (x) {
          var nid = (x.loai === 'manh') ? bd[String(x.md)] : null;
          if (nid) { can.push(nid); ghep.push({ x: x, nid: nid }); }
        });
        var anhThieu = con.filter(function (x) { return x.loai === 'anh'; })[0];
        var doAnh = !anhThieu ? null
          : c.from('datasets').select('id').eq('factory_id', fid()).eq('kind', KIND_ANH)
              .order('updated_at', { ascending: false }).limit(1)
              .then(function (r) { var d0 = r && r.data && r.data[0]; if (d0) { can.push(d0.id); ghep.push({ x: anhThieu, nid: d0.id }); } })
              .catch(function () {});
        return Promise.resolve(doAnh).then(function () {
          if (!can.length) return { thay: thay, hong: con };
          return layNhieuDong(c, can).then(function () {
            ghep.forEach(function (g) { var r = jget(K.dsItem(g.nid), null); if (r && r.payload) thay[g.x.id] = g.nid; });
            return { thay: thay, hong: con.filter(function (x) { return !thay[x.id]; }) };
          });
        });
      });
    }).catch(function () { return { thay: thay, hong: con }; });
  }

  // ---------- Nạp thư viện Supabase (UMD) ----------
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Không tải được ' + src)); };
      document.head.appendChild(s);
    });
  }
  function ensureClient() {
    if (client) return Promise.resolve(client);
    if (!configured()) return Promise.resolve(null);
    if (loadingClient) return loadingClient;
    loadingClient = (root.supabase ? Promise.resolve() : loadScript(SUPA_UMD))
      .then(function () {
        if (!root.supabase || !root.supabase.createClient) throw new Error('supabase-js chưa sẵn sàng');
        client = root.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true }
        });
        // Xử lý link "đặt lại mật khẩu" từ email → cho người dùng nhập mật khẩu mới.
        try {
          client.auth.onAuthStateChange(function (event) {
            if (event === 'PASSWORD_RECOVERY') {
              var np = window.prompt('Đặt lại mật khẩu — nhập mật khẩu MỚI (tối thiểu 6 ký tự):');
              if (np) client.auth.updateUser({ password: np }).then(function (r) { alert(r.error ? ('Lỗi: ' + r.error.message) : 'Đã đổi mật khẩu ✓. Hãy đăng nhập lại.'); });
            }
          });
        } catch (e) {}
        log('client sẵn sàng');
        return client;
      })
      .catch(function (e) { log('lỗi nạp client:', e.message); client = null; return null; });
    return loadingClient;
  }

  // ---------- AUTH ----------
  function fetchProfile() {
    return client.auth.getUser().then(function (r) {
      var u = r && r.data && r.data.user; if (!u) return null;
      return client.from('profiles').select('*').eq('id', u.id).single().then(function (pr) {
        var p = pr.data || { id: u.id, email: u.email, role: 'user' };
        profile = p; jset(K.profile, p); return p;
      });
    });
  }
  var CLCloud = {
    // Cấu hình / trạng thái
    configured: configured,
    isOnline: online,
    getProfile: function () { return profile; },
    onAuth: function (cb) { listeners.auth.push(cb); },
    onSync: function (cb) { listeners.sync.push(cb); },

    // Khởi tạo: nạp client + khôi phục phiên (nếu có)
    init: function () {
      return ensureClient().then(function (c) {
        if (!c) return { offline: true, profile: null };
        return c.auth.getSession().then(function (s) {
          if (s && s.data && s.data.session) return fetchProfile().then(function (p) { emit('auth', p); return { profile: p }; });
          return { profile: null };
        });
      });
    },

    // Đăng nhập email/mật khẩu (Supabase Auth)
    signIn: function (email, password) {
      return ensureClient().then(function (c) {
        if (!c) return Promise.reject(new Error('Chưa cấu hình Supabase (đang offline).'));
        return c.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
          if (r.error) throw new Error(r.error.message);
          return fetchProfile().then(function (p) {
            if (p && p.active === false) { c.auth.signOut(); throw new Error('Tài khoản đã bị khóa.'); }
            emit('auth', p); return p;
          });
        });
      });
    },
    /* Xác thực lại mật khẩu của CHÍNH người đang đăng nhập (dùng cho việc nguy hiểm như
       "Xóa tất cả"). Đăng nhập lại đúng email đang dùng → phiên không đổi, KHÔNG phát
       sự kiện 'auth' nên app không bị nạp lại dữ liệu. Sai mật khẩu → trả false. */
    verifyPassword: function (password) {
      return ensureClient().then(function (c) {
        if (!c) return Promise.reject(new Error('Chưa cấu hình Supabase — không xác thực được mật khẩu.'));
        var em = profile && profile.email;
        if (!em) return Promise.reject(new Error('Không xác định được email đang đăng nhập.'));
        return c.auth.signInWithPassword({ email: em, password: String(password == null ? '' : password) })
          .then(function (r) { return !(r && r.error); });
      });
    },
    signOut: function () {
      profile = null; jdel(K.profile);
      emit('auth', null);
      return ensureClient().then(function (c) { return c ? c.auth.signOut() : null; });
    },

    // ---------- DATASETS: đọc (cache trước, DB làm tươi) ----------
    // Trả danh sách metadata từ cache ngay; đồng thời gọi refresh() ở nền.
    listCached: function () { return jget(K.dsIndex(profile && profile.factory_id), []); },
    getCached: function (id) { return jget(K.dsItem(id), null); },

    // Kéo dữ liệu xưởng từ DB → cache (gọi khi đăng nhập / bấm làm tươi)
    pull: function () {
      if (!profile) return Promise.resolve([]);
      if (!configured() || !online()) return Promise.resolve(CLCloud.listCached());
      return ensureClient().then(function (c) {
        if (!c) return CLCloud.listCached();
        return c.from('datasets').select('id,factory_id,name,kind,created_by,created_at,updated_at')
          .order('updated_at', { ascending: false })
          .then(function (r) {
            if (r.error) { log('pull lỗi:', r.error.message); return CLCloud.listCached(); }
            // Bỏ mấy dòng MẢNH ra khỏi danh sách: chúng là ruột của bản lưu, không phải bản lưu
            var list = (r.data || []).filter(function (d) { return !laManh(d); });
            jset(K.dsIndex(profile.factory_id), list);
            jset(K.lastSync, Date.now());
            emit('sync', { type: 'pull', count: list.length });
            return list;
          });
      });
    },
    // Lấy full 1 dataset (cache trước, rồi DB)
    fetchOne: function (id) {
      var cached = CLCloud.getCached(id);
      if (!configured() || !online()) return Promise.resolve(cached);
      return ensureClient().then(function (c) {
        if (!c) return cached;
        return c.from('datasets').select('*').eq('id', id).single().then(function (r) {
          if (r.error) return cached;
          jset(K.dsItem(id), r.data);
          return r.data;
        });
      });
    },

    // ---------- DATASETS: ghi (cache ngay + đẩy DB / xếp hàng offline) ----------
    save: function (rec) {
      // rec = {id?, name, payload}. Gắn factory_id theo profile.
      if (!profile || !profile.factory_id) return Promise.reject(new Error('Tài khoản chưa được gán Xưởng — liên hệ quản trị viên.'));
      var id = rec.id || (root.crypto && crypto.randomUUID ? crypto.randomUUID() : 'ds-' + Date.now());
      var now = new Date().toISOString();
      var row = {
        id: id, factory_id: profile.factory_id, name: rec.name || ('Đơn ' + now),
        kind: rec.kind || 'orders', payload: rec.payload || {},
        created_by: profile.id, updated_at: now
      };
      // 1) cache ngay
      jset(K.dsItem(id), row);
      var idx = CLCloud.listCached().filter(function (d) { return d.id !== id; });
      idx.unshift({ id: id, factory_id: row.factory_id, name: row.name, kind: row.kind, created_by: row.created_by, updated_at: now, created_at: now });
      jset(K.dsIndex(profile.factory_id), idx);
      // 2) đẩy DB — BÁO LỖI THẬT nếu ghi hỏng (RLS...), chỉ xếp hàng khi thực sự offline.
      if (!configured()) return Promise.resolve(row);
      if (!online()) { enqueue({ op: 'upsert', row: row }); return Promise.resolve(row); }
      return ensureClient().then(function (c) {
        if (!c) { enqueue({ op: 'upsert', row: row }); return row; }
        return c.from('datasets').upsert(row).select().then(function (r) {
          if (r.error) throw new Error('Lưu đám mây thất bại: ' + r.error.message);
          return row;
        });
      });
    },
    /* LƯU THEO MẢNH — rec = {id?, name, goi:{chung, manh:[{md,…}], anh}} (goi do
       __CLAPP.chiaLuu() dựng). Chỉ mảnh nào ĐỔI mới nén + gửi lại; mảnh cũ giữ nguyên dòng
       trên Supabase. Trả về dòng CHỈ MỤC. */
    saveGoi: function (rec) {
      if (!profile || !profile.factory_id) return Promise.reject(new Error('Tài khoản chưa được gán Xưởng — liên hệ quản trị viên.'));
      var goi = rec.goi || {}, id = rec.id || idMoi(), now = new Date().toISOString();
      var cuRow = jget(K.dsItem(id), null);
      var cu = (cuRow && cuRow.payload && cuRow.payload.__goi) ? cuRow.payload : null;
      /* ⚠ PHANH AN TOÀN (thêm 28/8 sau sự cố): bản lưu cũ đang có đơn mà bản mới KHÔNG có đơn
         nào thì đây gần như chắc chắn là ghi đè nhầm lúc app vừa nạp hụt — từ chối lưu, giữ
         nguyên bản cũ. Muốn xoá thật thì dùng nút "Xóa tất cả" rồi lưu tay. */
      if (cu && (cu.manh || []).length && !(goi.manh || []).length) {
        return Promise.reject(new Error('Bỏ qua lần lưu này: dữ liệu đang TRỐNG mà bản lưu cũ có ' +
          (cu.manh || []).length + ' đơn — không ghi đè để khỏi mất đơn.'));
      }
      var cuTheoMd = {}; if (cu) (cu.manh || []).forEach(function (m) { cuTheoMd[m.md] = m; });
      var dongMoi = [], dsManh = [], daDung = {};
      /* ⚠⚠ CHỈ ĐƯỢC BỎ QUA MẢNH KHI BIẾT CHẮC NÓ ĐANG NẰM TRÊN MÁY CHỦ (sửa 29/8).
         Đây là gốc rễ của "bản lưu thiếu 67 mảnh": bản cũ chỉ so DẤU VÂN TAY, mà dấu vân tay
         được ghi vào bộ nhớ máy TRƯỚC khi gửi lên máy chủ. Một lần gửi hỏng (mạng chập, URL
         quá dài, tự lưu nuốt lỗi bằng .catch rỗng) là từ đó về sau app luôn thấy "vân tay khớp
         rồi, khỏi gửi" ⇒ mảnh KHÔNG BAO GIỜ lên máy chủ, còn chỉ mục thì vẫn trỏ vào nó.
         Nay phải có TÊN trong sổ daLen (chỉ ghi sổ SAU KHI máy chủ nhận) mới được bỏ qua. */
      var soLen = lenRoi();
      function phan(khoa, obj, kind, ten, cuMuc) {
        var s = JSON.stringify(obj), h = bam32(s);
        if (cuMuc && cuMuc.h === h && cuMuc.id && soLen[cuMuc.id]) { daDung[cuMuc.id] = 1; return Promise.resolve({ md: khoa, id: cuMuc.id, h: h }); }
        var pid = (cuMuc && cuMuc.id) || idMoi(); daDung[pid] = 1;
        return nen(obj).then(function (n) {
          dongMoi.push({ id: pid, factory_id: profile.factory_id, name: ten, kind: kind,
                         payload: { __manh: 1, n: n.n, d: n.d }, created_by: profile.id, updated_at: now });
          return { md: khoa, id: pid, h: h };
        });
      }
      var viec = (goi.manh || []).map(function (g) {
        return phan(g.md, g, KIND_MANH, tenManh(g.md), cuTheoMd[g.md]);
      });
      viec.push(phan('__anh', goi.anh || {}, KIND_ANH, '⚙ ảnh trong đơn', cu && cu.anh));
      return Promise.all(viec).then(function (ds) {
        var anh = ds.pop(); dsManh = ds;
        return nen(goi.chung || {}).then(function (nc) {
          var row = { id: id, factory_id: profile.factory_id, name: rec.name || ('Đơn ' + now), kind: 'orders',
            payload: { __goi: 1, v: 1, nc: nc.n, chung: nc.d, manh: dsManh, anh: { id: anh.id, h: anh.h } },
            created_by: profile.id, updated_at: now };
          // cache: chỉ mục + mọi dòng mảnh (đã nén nên nhẹ hơn hẳn bản cũ)
          jset(K.dsItem(id), row);
          dongMoi.forEach(function (d) { jset(K.dsItem(d.id), d); });
          var idx = CLCloud.listCached().filter(function (d) { return d.id !== id; });
          idx.unshift({ id: id, factory_id: row.factory_id, name: row.name, kind: 'orders', created_by: row.created_by, updated_at: now, created_at: now });
          jset(K.dsIndex(profile.factory_id), idx);
          /* ⚠⚠ KHÔNG BAO GIỜ XOÁ MẢNH CŨ (sửa 28/8 sau sự cố mất dữ liệu).
             Bản đầu có đoạn "dọn mảnh không còn ai dùng". Nhưng chỉ cần MỘT lần app lưu nhầm
             trạng thái RỖNG (vd vừa nạp lại hụt) là danh sách mảnh mới trống ⇒ toàn bộ mảnh
             của mọi đơn bị coi là thừa ⇒ XOÁ SẠCH, không lấy lại được.
             Mảnh không còn ai trỏ tới chỉ nằm chiếm chỗ, mỗi mảnh vài chục KB — rẻ hơn rất
             nhiều so với rủi ro mất đơn. Chúng cũng CHÍNH LÀ phao cứu sinh khi bản lưu hỏng.
             Muốn dọn thì dọn tay, có nhìn tận mắt. */
          if (!configured()) return row;
          if (!online()) { dongMoi.concat([row]).forEach(function (d) { enqueue({ op: 'upsert', row: d }); }); return row; }
          return ensureClient().then(function (c) {
            if (!c) { dongMoi.concat([row]).forEach(function (d) { enqueue({ op: 'upsert', row: d }); }); return row; }
            /* ⚠⚠ PHANH CHỐNG GHI ĐÈ LÀM CO NHỎ BẢN LƯU CHUNG (thêm 3/9).
               Bằng chứng thật: 10:03:32 máy anh Hoàn ghi lên ô lưu của xưởng bản ĐỦ 66 đơn.
               10:05:54 một máy khác (đang mở bản thiếu 10 đơn) tự lưu đè lên đúng ô đó ⇒ cả
               xưởng mất 56 đơn. Một ô lưu dùng chung thì máy nào cũng ghi được — nên phải có
               phanh: bản mới ÍT ĐƠN HƠN bản đang nằm trên máy chủ thì TỪ CHỐI.
               Muốn thay thật (vd cố ý bỏ bớt đơn) thì bấm ☁ Lưu rồi xác nhận — lúc đó epGhi=true. */
            return demManhTrenMayChu(c, id).then(function (svN) {
              var moiN = (goi.manh || []).length;
              if (svN > 0 && moiN < svN && !rec.epGhi) {
                throw new Error('KHÔNG ghi đè: trên máy chủ đang có ' + svN + ' đơn, bản này chỉ có ' +
                  moiN + ' đơn. Tải lại trang (Ctrl+F5) để lấy bản đầy đủ. Nếu thật sự muốn thay bằng ' +
                  'bản ít đơn hơn thì bấm ☁ Lưu rồi xác nhận.');
              }
              return ghiThat(c);
            });
          });
          function ghiThat(c) {
            /* mảnh trước, CHỈ MỤC sau — chỉ mục lên rồi mà mảnh chưa có là bản lưu hỏng.
               Ghi cũng CHIA LÔ: gửi cả trăm dòng một lượt là một cú ngã làm hỏng tất cả. */
            var b1 = ghiNhieuDong(c, dongMoi);
            return b1.then(function (r) {
              if (r && r.error) throw new Error('Lưu đám mây thất bại (mảnh): ' + r.error.message);
              return c.from('datasets').upsert(row).select();
            }).then(function (r) {
              if (r && r.error) throw new Error('Lưu đám mây thất bại: ' + r.error.message);
              danhDauLen([row.id]);
              return row;
            });
          }
        });
      });
    },
    /* ĐỌC 1 bản lưu → payload đầy đủ. Nhận cả kiểu CŨ (payload nguyên khối) lẫn kiểu MẢNH.
       Kiểu mảnh: lấy các dòng mảnh (cache trước, thiếu thì hỏi DB 1 lần cho cả mớ) rồi gộp. */
    fetchGoi: function (id) {
      return Promise.resolve(CLCloud.fetchOne(id)).then(function (d) {
        var p = d && d.payload;
        /* ⚠ Không đọc được thì phải BÁO HỎNG, TUYỆT ĐỐI không trả về rỗng: chỗ gọi nó làm
           `loadData(payload || {})`, mà loadData rỗng là XOÁ TRẮNG màn hình (sự cố 28/8). */
        if (!d) return Promise.reject(new Error('Không đọc được bản lưu — kiểm tra mạng rồi thử lại. Dữ liệu đang mở KHÔNG bị đụng tới.'));
        if (!p || !p.__goi) return d;                       // bản lưu kiểu cũ — trả nguyên
        var ids = (p.manh || []).map(function (m) { return m.id; });
        if (p.anh && p.anh.id) ids.push(p.anh.id);
        var thieu = ids.filter(function (x) { return !jget(K.dsItem(x), null); });
        var doThieu = (!thieu.length || !configured() || !online()) ? Promise.resolve(null)
          : ensureClient().then(function (c) { return c ? layNhieuDong(c, thieu) : null; });
        return doThieu.then(function () {
          var caiGi = [];
          (p.manh || []).forEach(function (m) { caiGi.push({ loai: 'manh', md: m.md, id: m.id }); });
          if (p.anh && p.anh.id) caiGi.push({ loai: 'anh', id: p.anh.id });
          var mat = caiGi.filter(function (x) { var r = jget(K.dsItem(x.id), null); return !r || !r.payload; });
          function ghepRa(ds2, va) {
            return Promise.all(ds2.map(function (x) {
              var row = jget(K.dsItem(x.id), null);
              return giaiNen({ n: row.payload.n, d: row.payload.d }).then(function (v) { return { loai: x.loai, v: v }; });
            })).then(function (ds) {
              return giaiNen({ n: p.nc, d: p.chung }).then(function (chung) {
                var goi = { chung: chung || {}, manh: [], anh: {} };
                ds.forEach(function (x) { if (x.loai === 'anh') goi.anh = x.v || {}; else goi.manh.push(x.v); });
                if (!(root.__CLAPP && root.__CLAPP.gopLuu))
                  return Promise.reject(new Error('Bản app đang chạy quá cũ, chưa biết ghép bản lưu chia mảnh — tải lại trang (Ctrl+F5) rồi thử lại.'));
                var payload = root.__CLAPP.gopLuu(goi);
                if (!payload || (!(payload.orders || []).length && !(payload.files || []).length))
                  return Promise.reject(new Error('Ghép bản lưu ra RỖNG — không nạp để khỏi xoá mất dữ liệu đang mở.'));
                return Object.assign({}, d, { payload: payload, __va: va || null });
              });
            });
          }
          if (!mat.length) return ghepRa(caiGi, null);
          /* ⭑ VÁ CHỖ THIẾU RỒI MỞ, ĐỪNG BÁO HỎNG RỒI THÔI (sửa 29/8).
             Chỉ mục trỏ vào mảnh không còn tồn tại thì vẫn còn cửa: tên dòng mảnh chính là MÃ
             ĐƠN, nên tìm lại đúng mảnh đó ở chỗ khác (bộ nhớ máy, hoặc mảnh mồ côi trên máy
             chủ) là mở được. Vá xong app tự lưu lại một bản LÀNH rồi dọn rác — xem suaVaDon().
             Vẫn giữ nguyên luật cũ: KHÔNG tìm lại được gì thì báo hỏng, tuyệt đối không trả rỗng. */
          return vaManh(mat).then(function (kq) {
            var duoc = caiGi.map(function (x) { return kq.thay[x.id] ? { loai: x.loai, md: x.md, id: kq.thay[x.id] } : x; })
                            .filter(function (x) { var r = jget(K.dsItem(x.id), null); return r && r.payload; });
            var conManh = duoc.filter(function (x) { return x.loai === 'manh'; }).length;
            if (!conManh) return Promise.reject(new Error('Bản lưu hỏng: thiếu ' + mat.length +
              ' mảnh và không tìm lại được mảnh nào — chưa mở được. Dữ liệu đang mở KHÔNG bị đụng tới; kiểm tra mạng rồi tải lại trang (Ctrl+F5).'));
            return ghepRa(duoc, { vaDuoc: mat.length - kq.hong.length, hong: kq.hong.map(function (x) { return x.md || 'ảnh'; }) });
          });
        });
      });
    },
    /* ===== MỞ NGAY TỪ BỘ NHỚ MÁY — KHÔNG HỎI MẠNG (thêm 29/8) =====
       User: "mở app ra là phải có dữ liệu". Trước đây mở app là phải đợi 3 vòng hỏi máy chủ
       (danh sách → chỉ mục → từng lô mảnh) mới thấy đơn, mạng xưởng chậm thì ngồi nhìn số 0.
       Nay: bản lưu nằm sẵn trong bộ nhớ máy thì dựng lại và mở NGAY, xong mới lặng lẽ đối
       chiếu máy chủ ở nền. Thiếu dù chỉ 1 mảnh thì trả null để đường mạng lo — thà chậm còn
       hơn mở ra thiếu đơn rồi người dùng tưởng là đủ. */
    /* ===== BẢN MỞ NHANH — MỘT bản ghi, mở là có ngay (thêm 29/8) =====
       Ghi lại CẢ KHO đã ghép sẵn (nén gzip) vào IndexedDB sau mỗi lần nạp/lưu thành công.
       Mở app = đọc đúng một bản ghi rồi bày ra: không phụ thuộc mấy chục mảnh rời, không hỏi
       mạng, không sợ localStorage tràn. Kèm mấy con số để biết ngay đủ hay thiếu. */
    luuMoNhanh: function (payload, meta) {
      if (!payload || !(payload.orders || []).length) return Promise.resolve(false);
      meta = meta || {};
      return nen(payload).then(function (n) {
        return idbGhi(khoaMoNhanh(), {
          v: 1, t: new Date().toISOString(), nguon: meta.nguon || '',
          id: meta.id || '', sv: meta.sv || '',
          soFile: (payload.files || []).length, soDong: (payload.orders || []).length,
          soDon: (function () { var m = {}, i, c = 0;
            for (i = 0; i < payload.orders.length; i++) { var k = String(payload.orders[i] && payload.orders[i].maDon || ''); if (!m[k]) { m[k] = 1; c++; } }
            return c; })(),
          n: n.n, d: n.d
        });
      }).catch(function () { return false; });
    },
    docMoNhanh: function () {
      return idbDoc(khoaMoNhanh()).then(function (r) {
        if (!r || !r.d) return null;
        return giaiNen({ n: r.n, d: r.d }).then(function (pl) {
          if (!pl || !(pl.orders || []).length) return null;
          return { payload: pl, t: r.t, nguon: r.nguon, id: r.id || '', sv: r.sv || '',
                   soFile: r.soFile, soDong: r.soDong, soDon: r.soDon };
        }).catch(function () { return null; });
      }).catch(function () { return null; });
    },
    napNhanh: function (id) {
      var d = jget(K.dsItem(id), null);
      var p = d && d.payload;
      if (!p) return Promise.resolve(null);
      if (!p.__goi) return Promise.resolve((p.orders || []).length ? d : null);
      var caiGi = [];
      (p.manh || []).forEach(function (m) { caiGi.push({ loai: 'manh', id: m.id }); });
      if (p.anh && p.anh.id) caiGi.push({ loai: 'anh', id: p.anh.id });
      if (!caiGi.length) return Promise.resolve(null);
      /* ⭑ THIẾU MẢNH THÌ VẪN MỞ PHẦN ĐANG CÓ (sửa 29/8 theo yêu cầu "mở link là phải có dữ liệu
         đã lưu trên máy, dù không có mạng").
         Bản trước thiếu dù 1 mảnh là trả null ⇒ ngồi nhìn số 0 đợi mạng. Nay mở ngay những đơn
         có sẵn và nói thẳng còn thiếu mấy đơn. Đổi lại phải có PHANH: bản mở tạm KHÔNG được tự
         lưu đè lên máy chủ (xem _moTam bên auth.web.js) — không thì mở thiếu một lần là ghi đè
         mất mấy đơn kia, đúng cái sự cố 28/8. */
      var co = caiGi.filter(function (x) { var r = jget(K.dsItem(x.id), null); return r && r.payload; });
      var thieu = caiGi.length - co.length;
      if (!co.filter(function (x) { return x.loai === 'manh'; }).length) return Promise.resolve(null);
      return Promise.all(co.map(function (x) {
        var row = jget(K.dsItem(x.id), null);
        return giaiNen({ n: row.payload.n, d: row.payload.d }).then(function (v) { return { loai: x.loai, v: v }; }).catch(function () { return null; });
      })).then(function (ds) {
        var hong = ds.filter(function (x) { return !x; }).length;
        return giaiNen({ n: p.nc, d: p.chung }).then(function (chung) {
          var goi = { chung: chung || {}, manh: [], anh: {} };
          ds.forEach(function (x) { if (!x) return; if (x.loai === 'anh') goi.anh = x.v || {}; else goi.manh.push(x.v); });
          if (!goi.manh.length || !(root.__CLAPP && root.__CLAPP.gopLuu)) return null;
          var payload = root.__CLAPP.gopLuu(goi);
          if (!payload || !(payload.orders || []).length) return null;
          return Object.assign({}, d, { payload: payload, __du: !(thieu + hong), __thieu: thieu + hong, __can: caiGi.length });
        }).catch(function () { return null; });
      }).catch(function () { return null; });
    },
    /* ===== SOI LẠI BẢN LƯU TRÊN MÁY CHỦ (thêm 29/8) =====
       Hỏi thẳng máy chủ: từng mảnh của bản lưu này CÓ THẬT không (chỉ xin cột id nên rất nhẹ).
       Đây là cái chốt an toàn bắt buộc phải qua trước khi dọn rác — không bao giờ xoá cái gì
       khi chưa nhìn tận mắt thấy bản lưu mới đã đủ mảnh. */
    kiemTraBanLuu: function (id) {
      if (!configured() || !online()) return Promise.resolve({ ok: false, thieu: -1, ids: [] });
      return ensureClient().then(function (c) {
        if (!c) return { ok: false, thieu: -1, ids: [] };
        return c.from('datasets').select('*').eq('id', id).maybeSingle().then(function (r) {
          if (r.error || !r.data) return { ok: false, thieu: -1, ids: [] };
          var p = r.data.payload;
          if (!p || !p.__goi) return { ok: !!(p && (p.orders || []).length), thieu: 0, ids: [id] };
          var ids = (p.manh || []).map(function (m) { return m.id; });
          if (p.anh && p.anh.id) ids.push(p.anh.id);
          var co = {}, lo = [], i;
          for (i = 0; i < ids.length; i += LO) lo.push(ids.slice(i, i + LO));
          return lo.reduce(function (ch, mot) {
            return ch.then(function () {
              return c.from('datasets').select('id').in('id', mot)
                .then(function (rr) { (rr.data || []).forEach(function (x) { co[x.id] = 1; }); })
                .catch(function () {});
            });
          }, Promise.resolve()).then(function () {
            var thieu = ids.filter(function (x) { return !co[x]; });
            return { ok: !thieu.length, thieu: thieu.length, ids: ids.concat([id]) };
          });
        }).catch(function () { return { ok: false, thieu: -1, ids: [] }; });
      });
    },
    /* ===== DỌN RÁC — CHỈ GIỮ LẠI BẢN LƯU CUỐI (thêm 29/8 theo yêu cầu) =====
       User: "Chỉ dữ liệu lần sao lưu cuối. Các đơn cũ dữ liệu thừa hãy xóa hết đi cả trên máy
       và supabase". Xoá mọi dòng orders / orders-manh / orders-anh của xưởng KHÔNG thuộc bản
       lưu đang giữ, cả trên máy chủ lẫn trong bộ nhớ máy.
       ⚠ CHỈ ĐƯỢC GỌI SAU khi kiemTraBanLuu() nói OK — xoá là không lấy lại được. */
    donDep: function (giuIds) {
      var giu = {}; (giuIds || []).forEach(function (i) { if (i) giu[i] = 1; });
      if (!Object.keys(giu).length) return Promise.resolve({ may: 0, server: 0 });
      var may = 0;
      try {
        var bo = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf('clc_ds_') !== 0) continue;
          if (k.indexOf('clc_ds_index_') === 0) continue;   // ⚠ đây là DANH SÁCH, không phải bản lưu
          if (!giu[k.slice(7)]) bo.push(k);
        }
        bo.forEach(function (k) { jdel(k); }); may = bo.length;
      } catch (_) {}
      // sổ "đã lên máy chủ" cũng thu gọn theo, khỏi phình vô hạn
      try { var so = lenRoi(), so2 = {}; Object.keys(giu).forEach(function (x) { if (so[x]) so2[x] = 1; }); jset(K.daLen(fid()), so2); } catch (_) {}
      if (!configured() || !online() || !fid()) return Promise.resolve({ may: may, server: 0 });
      return ensureClient().then(function (c) {
        if (!c) return { may: may, server: 0 };
        return c.from('datasets').select('id,kind').eq('factory_id', fid()).then(function (r) {
          if (r.error) return { may: may, server: 0, loi: r.error.message };
          var xoa = (r.data || []).filter(function (d) {
            return !giu[d.id] && (d.kind === 'orders' || d.kind === KIND_MANH || d.kind === KIND_ANH);
          }).map(function (d) { return d.id; });
          if (!xoa.length) return { may: may, server: 0 };
          var lo = [], i2;
          for (i2 = 0; i2 < xoa.length; i2 += LO) lo.push(xoa.slice(i2, i2 + LO));
          return lo.reduce(function (ch, mot) {
            return ch.then(function () { return c.from('datasets').delete().in('id', mot); });
          }, Promise.resolve()).then(function () {
            // danh sách bản lưu trong bộ nhớ máy cũng chỉ còn lại đúng bản đang giữ
            try {
              var idx = CLCloud.listCached().filter(function (d) { return giu[d.id]; });
              jset(K.dsIndex(fid()), idx);
            } catch (_) {}
            return { may: may, server: xoa.length };
          });
        }).catch(function () { return { may: may, server: 0 }; });
      });
    },
    /* ===== QUAY VỀ MỘT MỐC THỜI GIAN (thêm 29/8) =====
       User: "Tôi muốn lấy dữ liệu đã cập nhật xử lý 66 file như dòng tô đỏ trong hình
       (14:41:14 28/8 — 66 file → 1778 dòng). Bản đó là bản dữ liệu đúng đầy đủ."
       Mỗi lần lưu, mã đơn nào ĐỔI thì được ghi thành một dòng mảnh mới mang mốc thời gian của
       lần lưu đó. Cả kho mảnh vì thế chính là một cuốn phim: muốn quay về lúc T thì với TỪNG
       mã đơn lấy bản mới nhất mà còn ≤ T. Đây là lý do KHÔNG được tự động xoá mảnh cũ.
       dsKho() chỉ xin cột nhẹ (id·kind·name·updated_at) nên quét cả nghìn dòng vẫn nhanh. */
    dsKho: function () {
      var may = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf('clc_ds_') !== 0 || k.indexOf('clc_ds_index_') === 0) continue;
          var r = jget(k, null); if (!r) continue;
          may.push({ id: r.id || k.slice(7), kind: r.kind || '?', name: r.name || '', updated_at: r.updated_at || '', nguon: 'máy' });
        }
      } catch (_) {}
      if (!configured() || !online() || !fid()) return Promise.resolve({ may: may, server: [] });
      return ensureClient().then(function (c) {
        if (!c) return { may: may, server: [] };
        /* ⚠ PHẢI KÉO THEO TỪNG TRANG (sửa 3/9). Bản trước xin một phát `.range(0,1999)`; trên dữ
           liệu thật của user nó trả về RỖNG (dải nâu ghi "Đã dò 0 lần lưu") nên phần tự vá không
           có mốc nào mà dò. timDonConSot() kéo từng trang thì chạy được — nay làm y như vậy. */
        var gom = [];
        function trang(tu) {
          return c.from('datasets').select('id,kind,name,updated_at').eq('factory_id', fid())
            .order('updated_at', { ascending: false }).range(tu, tu + 199)
            .then(function (r) {
              if (r.error || !r.data || !r.data.length) return gom;
              gom = gom.concat(r.data);
              return r.data.length < 200 ? gom : trang(tu + 200);
            }).catch(function () { return gom; });
        }
        return trang(0).then(function (rows) {
          return { may: may, server: (rows || []).map(function (d) { d.nguon = 'máy chủ'; return d; }) };
        });
      }).catch(function () { return { may: may, server: [] }; });
    },
    // moc = chuỗi ISO ('' = lấy bản mới nhất của mỗi mã đơn, không giới hạn thời gian)
    dungLaiToiMoc: function (moc) {
      var gioi = String(moc == null ? '' : moc);
      return CLCloud.dsKho().then(function (kho) {
        var tatCa = kho.server.concat(kho.may);
        var chon = {}, anhId = null, anhT = '';
        tatCa.forEach(function (d) {
          var t = String(d.updated_at || '');
          if (gioi && t > gioi) return;
          if (d.kind === KIND_ANH) { if (t > anhT) { anhT = t; anhId = d.id; } return; }
          if (d.kind !== KIND_MANH) return;
          var m = mdTuTen(d.name); if (!m) return;
          if (!chon[m] || t > chon[m].t) chon[m] = { id: d.id, t: t };
        });
        var mds = Object.keys(chon);
        if (!mds.length) return { payload: null, bc: { maDon: 0, dong: 0, file: 0, thieu: 0 } };
        var ids = mds.map(function (m) { return chon[m].id; });
        if (anhId) ids.push(anhId);
        var thieu = ids.filter(function (x) { return !jget(K.dsItem(x), null); });
        var doThieu = (!thieu.length || !configured() || !online()) ? Promise.resolve(null)
          : ensureClient().then(function (c) { return c ? layNhieuDong(c, thieu) : null; });
        return doThieu.then(function () {
          return Promise.all(ids.map(function (x) {
            var row = jget(K.dsItem(x), null);
            if (!row || !row.payload) return null;
            return giaiNen({ n: row.payload.n, d: row.payload.d }).catch(function () { return null; });
          })).then(function (vs) {
            var manh = [], anh = {}, hong = 0;
            vs.forEach(function (v) { if (!v) { hong++; return; } if (v.md != null) manh.push(v); else if (v.imgStore) anh = v; });
            if (!manh.length || !(root.__CLAPP && root.__CLAPP.gopLuu)) return { payload: null, bc: { maDon: 0, dong: 0, file: 0, thieu: hong } };
            var pl = root.__CLAPP.gopLuu({ chung: { mds: manh.map(function (g) { return g.md; }) }, manh: manh, anh: anh });
            return { payload: pl, bc: { maDon: manh.length, dong: (pl && pl.orders || []).length,
                                        file: (pl && pl.files || []).length, thieu: hong } };
          });
        });
      });
    },
    /* ===== CỨU DỮ LIỆU (thêm 28/8 sau sự cố mất dữ liệu) =====
       Quét MỌI mảnh còn nằm trong bộ nhớ trình duyệt rồi ghép lại, KHÔNG cần dòng chỉ mục.
       Dùng khi chỉ mục hỏng/ghi đè nhầm mà mảnh thì vẫn còn — đây là lý do bản mới KHÔNG bao
       giờ tự xoá mảnh nữa. Trả về payload (như bản lưu) hoặc null nếu chẳng còn gì. */
    cuuManh: function () {
      var ds = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf('clc_ds_') !== 0) continue;
          var row = jget(k, null);
          if (row && row.payload && row.payload.__manh) ds.push(row);
        }
      } catch (_) {}
      if (!ds.length) return Promise.resolve(null);
      return Promise.all(ds.map(function (r) {
        return giaiNen({ n: r.payload.n, d: r.payload.d }).catch(function () { return null; });
      })).then(function (vs) {
        var manh = [], anh = {};
        vs.forEach(function (v) { if (!v) return; if (v.md != null) manh.push(v); else if (v.imgStore) anh = v; });
        if (!manh.length || !(root.__CLAPP && root.__CLAPP.gopLuu)) return null;
        var payload = root.__CLAPP.gopLuu({ chung: { mds: manh.map(function (g) { return g.md; }) }, manh: manh, anh: anh });
        return (payload && (payload.orders || []).length) ? payload : null;
      });
    },
    /* ===== GOM TẤT CẢ — CỨU DỮ LIỆU KHÔNG CẦN CHỈ MỤC (thêm 28/8, lần sửa thứ 5) =====
       Bằng chứng từ máy user: app cứu được 1394 dòng TỪ BỘ NHỚ MÁY, trong khi chỉ mục trên máy
       chủ lại trỏ tới 67 mã mảnh KHÔNG tồn tại. Nghĩa là CHỈ MỤC ĐÃ HỎNG — mà mọi đường nạp cũ
       đều đi qua nó, nên cứ thiếu mãi.
       Hàm này BỎ QUA chỉ mục, quét thẳng ba nguồn rồi gộp theo MÃ ĐƠN (mỗi mã lấy bản mới nhất):
         1. mọi mảnh trong bộ nhớ máy (localStorage)
         2. mọi dòng 'orders-manh' của xưởng trên máy chủ — kể cả mảnh mồ côi
         3. mọi bản lưu NGUYÊN KHỐI kiểu cũ ('orders' không chia mảnh) — mỏ vàng, vì đó là các
            bản ☁ Lưu tay TRƯỚC khi có chia mảnh, thường còn đủ đơn
       Trả về { payload, bc } — bc là BÁO CÁO để nhìn thấy sự thật, không phải đoán. */
    gomTatCa: function () {
      var theoMd = {}, anh = {};
      var bc = { manhTrongMay: 0, manhTrenServer: 0, banNguyenKhoi: 0, donTuNguyenKhoi: 0, maDon: 0, dong: 0 };
      function nhan(v, t) {
        if (!v || v.md == null) return;
        var m = String(v.md);
        if (!theoMd[m] || String(t || '') > String(theoMd[m].t || '')) theoMd[m] = { v: v, t: t || '' };
      }
      // (1) bộ nhớ máy
      var dsMay = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i); if (!k || k.indexOf('clc_ds_') !== 0) continue;
          var r = jget(k, null);
          if (r && r.payload && r.payload.__manh) dsMay.push(r);
          else if (r && r.payload && !r.payload.__goi && (r.payload.orders || []).length) dsMay.push(r);
        }
      } catch (_) {}
      var b1 = Promise.all(dsMay.map(function (r) {
        if (r.payload.__manh) {
          return giaiNen({ n: r.payload.n, d: r.payload.d })
            .then(function (v) { if (v && v.md != null) { bc.manhTrongMay++; nhan(v, r.updated_at); } })
            .catch(function () {});
        }
        // bản nguyên khối nằm trong cache máy
        try {
          bc.banNguyenKhoi++;
          var g = root.__CLAPP.chiaLuu(r.payload);
          (g.manh || []).forEach(function (v) { bc.donTuNguyenKhoi++; nhan(v, r.updated_at); });
          var im = (g.anh && g.anh.imgStore) || {}; for (var q in im) if (anh[q] === undefined) anh[q] = im[q];
        } catch (_) {}
        return null;
      }));
      // (2) + (3) máy chủ
      var b2 = (!configured() || !online() || !profile || !profile.factory_id) ? Promise.resolve()
        : ensureClient().then(function (c) {
            if (!c) return;
            function trang(kind, tu, nhanDong) {
              return c.from('datasets').select('id,kind,updated_at,payload')
                .eq('factory_id', profile.factory_id).eq('kind', kind)
                .order('updated_at', { ascending: false }).range(tu, tu + 9)
                .then(function (r) {
                  if (r.error || !r.data || !r.data.length) return null;
                  return Promise.all(r.data.map(nhanDong)).then(function () {
                    return r.data.length < 10 ? null : trang(kind, tu + 10, nhanDong);
                  });
                }).catch(function () { return null; });
            }
            return trang(KIND_MANH, 0, function (row) {
              if (!row.payload || !row.payload.__manh) return null;
              return giaiNen({ n: row.payload.n, d: row.payload.d })
                .then(function (v) { if (v && v.md != null) { bc.manhTrenServer++; nhan(v, row.updated_at); } })
                .catch(function () {});
            }).then(function () {
              return trang('orders', 0, function (row) {
                var p = row.payload;
                if (!p || p.__goi || !(p.orders || []).length) return null;   // bỏ dòng chỉ mục, chỉ lấy bản NGUYÊN KHỐI
                try {
                  bc.banNguyenKhoi++;
                  var g = root.__CLAPP.chiaLuu(p);
                  (g.manh || []).forEach(function (v) { bc.donTuNguyenKhoi++; nhan(v, row.updated_at); });
                  var im = (g.anh && g.anh.imgStore) || {}; for (var q in im) if (anh[q] === undefined) anh[q] = im[q];
                } catch (_) {}
                return null;
              });
            });
          }).catch(function () {});
      // (2b) ảnh: lấy dòng ảnh mới nhất
      var b3 = (!configured() || !online() || !profile || !profile.factory_id) ? Promise.resolve()
        : ensureClient().then(function (c) {
            if (!c) return;
            return c.from('datasets').select('payload,updated_at').eq('factory_id', profile.factory_id)
              .eq('kind', KIND_ANH).order('updated_at', { ascending: false }).limit(1)
              .then(function (r) {
                if (r.error || !r.data || !r.data.length) return;
                var row = r.data[0]; if (!row.payload || !row.payload.__manh) return;
                return giaiNen({ n: row.payload.n, d: row.payload.d }).then(function (v) {
                  var im = (v && v.imgStore) || {}; for (var q in im) if (anh[q] === undefined) anh[q] = im[q];
                }).catch(function () {});
              }).catch(function () {});
          }).catch(function () {});

      return Promise.all([b1, b2, b3]).then(function () {
        var mds = Object.keys(theoMd);
        if (!mds.length || !(root.__CLAPP && root.__CLAPP.gopLuu)) return { payload: null, bc: bc };
        var manh = mds.map(function (m) { return theoMd[m].v; });
        var pl = root.__CLAPP.gopLuu({ chung: { mds: mds }, manh: manh, anh: { imgStore: anh } });
        bc.maDon = mds.length; bc.dong = (pl && pl.orders || []).length;
        return { payload: (pl && (pl.orders || []).length) ? pl : null, bc: bc };
      });
    },
    /* ===== TÌM ĐƠN CÒN SÓT TRÊN MÁY CHỦ (thêm 28/8) =====
       Quét MỌI dòng mảnh của xưởng — kể cả mảnh MỒ CÔI, tức không còn dòng chỉ mục nào trỏ
       tới (do bản cũ từng ghi đè chỉ mục bằng trạng thái rỗng). Mỗi mã đơn lấy bản MỚI NHẤT.
       Trả về payload chỉ gồm mấy đơn mà kho đang mở CHƯA CÓ — hoặc null nếu không thiếu gì. */
    timDonConSot: function (daCo) {
      if (!configured() || !online() || !profile || !profile.factory_id) return Promise.resolve(null);
      return ensureClient().then(function (c) {
        if (!c) return null;
        // kéo theo TỪNG TRANG — mỗi mảnh vài chục KB, 67 mảnh một lượt là response quá nặng
        var gom = [];
        function trang(tu) {
          return c.from('datasets').select('id,updated_at,payload')
            .eq('factory_id', profile.factory_id).eq('kind', KIND_MANH)
            .order('updated_at', { ascending: false }).range(tu, tu + 14)
            .then(function (r) {
              if (r.error || !r.data || !r.data.length) return gom;
              gom = gom.concat(r.data);
              return r.data.length < 15 ? gom : trang(tu + 15);
            }).catch(function () { return gom; });
        }
        return trang(0)
          .then(function (rows) {
            var r = { data: rows };
            if (!r.data || !r.data.length) return null;
            return Promise.all(r.data.map(function (row) {
              if (!row.payload || !row.payload.__manh) return null;
              return giaiNen({ n: row.payload.n, d: row.payload.d })
                .then(function (v) { return (v && v.md != null) ? { md: String(v.md), v: v, t: row.updated_at || '' } : null; })
                .catch(function () { return null; });
            })).then(function (ds) {
              var moi = {};
              ds.forEach(function (x) { if (x && (!moi[x.md] || x.t > moi[x.md].t)) moi[x.md] = x; });
              var co = daCo || {};
              var thieu = Object.keys(moi).filter(function (m) { return !co[m]; }).map(function (m) { return moi[m].v; });
              if (!thieu.length || !(root.__CLAPP && root.__CLAPP.gopLuu)) return null;
              var pl = root.__CLAPP.gopLuu({ chung: { mds: thieu.map(function (g) { return g.md; }) }, manh: thieu, anh: {} });
              return (pl && (pl.orders || []).length) ? pl : null;
            });
          });
      }).catch(function () { return null; });
    },
    remove: function (id) {
      // Xoá bản lưu là xoá luôn RUỘT của nó, không thì mấy dòng mảnh nằm lại chiếm chỗ mãi
      try {
        var _r = jget(K.dsItem(id), null), _p = _r && _r.payload;
        if (_p && _p.__goi) {
          var _con = (_p.manh || []).map(function (m) { return m.id; });
          if (_p.anh && _p.anh.id) _con.push(_p.anh.id);
          _con.forEach(function (x) { jdel(K.dsItem(x)); });
          if (_con.length && configured()) {
            if (!online()) _con.forEach(function (x) { enqueue({ op: 'delete', id: x }); });
            else ensureClient().then(function (c) { if (c) c.from('datasets').delete().in('id', _con); });
          }
        }
      } catch (_) {}
      jdel(K.dsItem(id));
      var idx = CLCloud.listCached().filter(function (d) { return d.id !== id; });
      jset(K.dsIndex(profile && profile.factory_id), idx);
      return pushOrQueue({ op: 'delete', id: id });
    },

    // Đẩy toàn bộ hàng đợi (gọi khi có mạng lại)
    flush: flushQueue,
    pendingCount: function () { return jget(K.queue, []).length; },

    // ---------- QUẢN LÝ xưởng / user (super & factory admin) ----------
    listFactories: function () {
      return ensureClient().then(function (c) { if (!c) return []; return c.from('factories').select('*').order('code').then(function (r) { return r.error ? [] : (r.data || []); }); });
    },
    createFactory: function (code, name) {
      return ensureClient().then(function (c) { if (!c) return Promise.reject(new Error('offline')); return c.from('factories').insert({ code: code, name: name }).select().single().then(function (r) { if (r.error) throw new Error(r.error.message); return r.data; }); });
    },
    listProfiles: function () {
      return ensureClient().then(function (c) { if (!c) return []; return c.from('profiles').select('*').order('created_at').then(function (r) { return r.error ? [] : (r.data || []); }); });
    },
    updateProfile: function (id, patch) {
      return ensureClient().then(function (c) { if (!c) return Promise.reject(new Error('offline')); return c.from('profiles').update(patch).eq('id', id).then(function (r) { if (r.error) throw new Error(r.error.message); return true; }); });
    },
    // Tạo tài khoản QUA Edge Function (service_role): xác nhận email sẵn + gắn role/xưởng/quyền ngay.
    // info = {email, password, display_name, role, factory_id, step_perms}
    createUser: function (info) {
      return ensureClient().then(function (c) {
        if (!c) return Promise.reject(new Error('Chưa cấu hình Supabase'));
        return c.functions.invoke('admin-set-password', { body: Object.assign({ op: 'create-user' }, info) }).then(function (r) {
          if (r.error) { var x = r.error.context; if (x && x.json) return x.json().then(function (b) { throw new Error((b && b.error) || r.error.message); }, function () { throw new Error(r.error.message); }); throw new Error(r.error.message); }
          if (r.data && r.data.error) throw new Error(r.data.error);
          return r.data; // {ok, id}
        });
      });
    },

    // Super/Factory Admin đổi mật khẩu tài khoản khác TRỰC TIẾP qua Edge Function (không cần email).
    adminSetPassword: function (targetId, newPass) {
      return ensureClient().then(function (c) {
        if (!c) return Promise.reject(new Error('Chưa cấu hình Supabase'));
        return c.functions.invoke('admin-set-password', { body: { target_user_id: targetId, new_password: newPass } }).then(function (r) {
          if (r.error) { var x = r.error.context; if (x && x.json) return x.json().then(function (b) { throw new Error((b && b.error) || r.error.message); }, function () { throw new Error(r.error.message); }); throw new Error(r.error.message); }
          if (r.data && r.data.error) throw new Error(r.data.error);
          return true;
        });
      });
    },
    // XÓA VĨNH VIỄN tài khoản (auth user + profile) qua Edge Function (service_role). Không hồi phục.
    deleteUser: function (targetId) {
      return ensureClient().then(function (c) {
        if (!c) return Promise.reject(new Error('Chưa cấu hình Supabase'));
        return c.functions.invoke('admin-set-password', { body: { op: 'delete-user', target_user_id: targetId } }).then(function (r) {
          if (r.error) { var x = r.error.context; if (x && x.json) return x.json().then(function (b) { throw new Error((b && b.error) || r.error.message); }, function () { throw new Error(r.error.message); }); throw new Error(r.error.message); }
          if (r.data && r.data.error) throw new Error(r.data.error);
          return true;
        });
      });
    },
    // Gửi email đặt lại mật khẩu (dự phòng).
    resetPassword: function (email) {
      return ensureClient().then(function (c) {
        if (!c) return Promise.reject(new Error('Chưa cấu hình Supabase'));
        return c.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) {
          if (r.error) throw new Error(r.error.message); return true;
        });
      });
    },

    // ---------- REALTIME: theo dõi thay đổi datasets + profiles (quyền/cài đặt) của xưởng ----------
    subscribe: function (onChange) {
      return ensureClient().then(function (c) {
        if (!c || !profile) return null;
        var flt = profile.factory_id ? ('factory_id=eq.' + profile.factory_id) : undefined;
        var ch = c.channel('sync-' + (profile.factory_id || 'all'))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'datasets', filter: flt }, function (payload) {
            try { onChange && onChange({ table: 'datasets', payload: payload }); } catch (_) {}
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: flt }, function (payload) {
            try { onChange && onChange({ table: 'profiles', payload: payload }); } catch (_) {}
          })
          .subscribe();
        return ch;
      });
    },
    // Nạp lại profile hiện tại (vai trò + phân quyền step) từ cloud.
    refreshProfile: function () { return ensureClient().then(function (c) { if (!c) return null; return fetchProfile(); }); }
  };

  // ---------- Hàng đợi offline ----------
  function enqueue(job) { var q = jget(K.queue, []); q.push(job); jset(K.queue, q); emit('sync', { type: 'queued', pending: q.length }); }
  function pushOrQueue(job) {
    if (!configured()) return Promise.resolve();           // offline thuần: chỉ cache
    if (!online()) { enqueue(job); return Promise.resolve(); }
    return ensureClient().then(function (c) {
      if (!c) { enqueue(job); return; }
      return runJob(c, job).catch(function (e) { log('đẩy lỗi, xếp hàng:', e.message); enqueue(job); });
    });
  }
  function runJob(c, job) {
    if (job.op === 'upsert') return c.from('datasets').upsert(job.row).then(thrower);
    if (job.op === 'delete') return c.from('datasets').delete().eq('id', job.id).then(thrower);
    return Promise.resolve();
  }
  function thrower(r) { if (r && r.error) throw new Error(r.error.message); return r; }
  function flushQueue() {
    if (!configured() || !online()) return Promise.resolve();
    var q = jget(K.queue, []); if (!q.length) return Promise.resolve();
    return ensureClient().then(function (c) {
      if (!c) return;
      var chain = Promise.resolve(), ok = [];
      q.forEach(function (job, i) { chain = chain.then(function () { return runJob(c, job).then(function () { ok.push(i); }); }); });
      return chain.then(function () {
        jset(K.queue, []); emit('sync', { type: 'flushed', count: ok.length }); log('đã đồng bộ', ok.length, 'thao tác offline');
      }).catch(function (e) {
        // giữ lại các job chưa chạy được
        var remain = q.filter(function (_, i) { return ok.indexOf(i) < 0; });
        jset(K.queue, remain); log('flush dừng ở lỗi:', e.message);
      });
    });
  }

  // Tự flush khi mạng trở lại
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () { log('online → flush'); flushQueue(); });
  }

  root.CLCloud = CLCloud;
  log('nạp xong. configured =', configured());
})(typeof window !== 'undefined' ? window : this);
