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
            var list = r.data || [];
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
      if (!profile || !profile.factory_id) return Promise.reject(new Error('Chưa xác định xưởng của người dùng.'));
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
      // 2) đẩy DB (hoặc xếp hàng)
      return pushOrQueue({ op: 'upsert', row: row }).then(function () { return row; });
    },
    remove: function (id) {
      jdel(K.dsItem(id));
      var idx = CLCloud.listCached().filter(function (d) { return d.id !== id; });
      jset(K.dsIndex(profile && profile.factory_id), idx);
      return pushOrQueue({ op: 'delete', id: id });
    },

    // Đẩy toàn bộ hàng đợi (gọi khi có mạng lại)
    flush: flushQueue,
    pendingCount: function () { return jget(K.queue, []).length; }
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
