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
    lastSync:'clc_last_sync'
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
  function idMoi() { return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : ('ds-' + Date.now() + '-' + Math.random().toString(16).slice(2)); }

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
      function phan(khoa, obj, kind, ten, cuMuc) {
        var s = JSON.stringify(obj), h = bam32(s);
        if (cuMuc && cuMuc.h === h && cuMuc.id) { daDung[cuMuc.id] = 1; return Promise.resolve({ md: khoa, id: cuMuc.id, h: h }); }
        var pid = (cuMuc && cuMuc.id) || idMoi(); daDung[pid] = 1;
        return nen(obj).then(function (n) {
          dongMoi.push({ id: pid, factory_id: profile.factory_id, name: ten, kind: kind,
                         payload: { __manh: 1, n: n.n, d: n.d }, created_by: profile.id, updated_at: now });
          return { md: khoa, id: pid, h: h };
        });
      }
      var viec = (goi.manh || []).map(function (g) {
        return phan(g.md, g, KIND_MANH, '⚙ mảnh · ' + g.md, cuTheoMd[g.md]);
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
            // mảnh trước, CHỈ MỤC sau — chỉ mục lên rồi mà mảnh chưa có là bản lưu hỏng
            var b1 = dongMoi.length ? c.from('datasets').upsert(dongMoi) : Promise.resolve({});
            return Promise.resolve(b1).then(function (r) {
              if (r && r.error) throw new Error('Lưu đám mây thất bại (mảnh): ' + r.error.message);
              return c.from('datasets').upsert(row).select();
            }).then(function (r) {
              if (r && r.error) throw new Error('Lưu đám mây thất bại: ' + r.error.message);
              return row;
            });
          });
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
          : ensureClient().then(function (c) {
              if (!c) return null;
              return c.from('datasets').select('*').in('id', thieu).then(function (r) {
                if (r.error) return null;
                (r.data || []).forEach(function (row) { jset(K.dsItem(row.id), row); });
                return null;
              });
            });
        return doThieu.then(function () {
          var caiGi = [];
          (p.manh || []).forEach(function (m) { caiGi.push({ loai: 'manh', md: m.md, id: m.id }); });
          if (p.anh && p.anh.id) caiGi.push({ loai: 'anh', id: p.anh.id });
          var mat = caiGi.filter(function (x) { var r = jget(K.dsItem(x.id), null); return !r || !r.payload; });
          if (mat.length) return Promise.reject(new Error('Bản lưu thiếu ' + mat.length + ' mảnh (' +
            mat.slice(0, 3).map(function (x) { return x.md || 'ảnh'; }).join(', ') +
            (mat.length > 3 ? '…' : '') + ') — chưa mở được. Dữ liệu đang mở KHÔNG bị đụng tới; kiểm tra mạng rồi bấm ⭳ Nạp lại.'));
          return Promise.all(caiGi.map(function (x) {
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
              return Object.assign({}, d, { payload: payload });
            });
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
