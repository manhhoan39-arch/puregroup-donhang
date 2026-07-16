/* =====================================================================
 * auth.web.js — Đăng nhập + Phân quyền (RBAC) + Multi-Tenant cho Module 1
 * File client độc lập, nạp SAU app (dùng window.__CLAPP để bắc cầu vào state).
 * - Không phá vỡ chức năng cũ: nếu chưa cấu hình server, app vẫn chạy offline
 *   (chỉ khác là màn đăng nhập yêu cầu địa chỉ server).
 * - Nguồn quyền = server trả về (permissions[]), client KHÔNG hardcode ma trận.
 * ===================================================================== */
(function () {
  'use strict';

  // ---------- Lưu phiên (localStorage) ----------
  var LS = {
    token: 'cl_token',
    user: 'cl_user',
    factory: 'cl_factory',
    perms: 'cl_perms',
    apiBase: 'cl_api_base',
    activeFactory: 'cl_active_factory', // super admin chọn xưởng đang thao tác
  };
  var S = {
    token: localStorage.getItem(LS.token) || '',
    user: safeJson(localStorage.getItem(LS.user)),
    factory: safeJson(localStorage.getItem(LS.factory)),
    perms: safeJson(localStorage.getItem(LS.perms)) || [],
    factories: [], // super admin: danh sách xưởng
  };

  function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }
  function apiBase() { return (localStorage.getItem(LS.apiBase) || '').replace(/\/$/, ''); }
  function isFileProto() { return location.protocol === 'file:'; }
  function can(perm) { return S.perms.indexOf(perm) !== -1; }
  function isSuper() { return can('scope:all'); }
  function role() { return S.user && S.user.role; }

  // ---------- Gọi "API" — chạy hoàn toàn client qua CLStore (offline) ----------
  function api(method, path, body) {
    if (!window.CLStore) return Promise.reject(new Error('Thiếu auth.store.js'));
    return window.CLStore.handle(method, path, body, S.token).catch(function (e) {
      var status = e && e.status;
      var msg = (e && e.message) || 'Lỗi';
      if (status === 401 && S.token && !S.cloud) doLogout(true);  // ở chế độ đám mây, 401 của CLStore cục bộ KHÔNG được đá phiên cloud ra
      throw new Error(msg);
    });
  }

  // ---------- Tiện ích DOM ----------
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'style') e.setAttribute('style', attrs[k]);
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function toast(msg, kind) {
    var t = h('div', { class: 'cl-toast ' + (kind || '') , html: esc(msg) });
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 3200);
  }
  var ROLE_LABEL = { super_admin: 'Super Admin', factory_admin: 'Factory Admin', user: 'Nhân viên' };

  // Danh sách step (khớp data-s trong nav) + nhãn — dùng cho UI phân quyền theo step
  var STEP_LIST = [
    { key: 's1', label: 'Trang chủ / Nạp file' },
    { key: 's3', label: 'Nhập Đơn' },
    { key: 's4', label: 'Mix Label' },
    { key: 's5', label: 'Bảng Keo' },
    { key: 's6', label: 'Line Cuốn' },
    { key: 's10', label: 'Tổng hợp Box' },
    { key: 's7', label: 'So sánh / Đối chiếu' },
    { key: 's8', label: 'Lịch sử' },
    { key: 's9', label: 'Cài đặt' },
  ];
  var STEP_PERM_OPTS = [ { v: 'edit', t: 'Sửa' }, { v: 'view', t: 'Chỉ xem' }, { v: 'none', t: 'Ẩn' } ];
  // Tạo bảng chọn quyền theo step; trả {el, get()} — get() trả {s5:'edit',...}
  function makeStepPermEditor(initial) {
    initial = initial || {};
    var selects = {};
    var rows = STEP_LIST.map(function (st) {
      var sel = h('select', { class: 'cl-input', style: 'padding:3px 6px' });
      STEP_PERM_OPTS.forEach(function (o) { sel.appendChild(h('option', { value: o.v }, [o.t])); });
      sel.value = initial[st.key] || 'edit';
      selects[st.key] = sel;
      return h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 0' }, [
        h('span', { style: 'font-size:13px' }, [st.label]), sel,
      ]);
    });
    var el = h('div', { style: 'border:1px solid #e5d0d8;border-radius:8px;padding:8px 10px;background:#fff' }, [
      h('div', { style: 'font-weight:600;font-size:12px;color:#E8185C;margin-bottom:4px' }, ['Phân quyền theo bảng (chỉ áp dụng cho Nhân viên)']),
    ].concat(rows));
    return { el: el, get: function () { var o = {}; Object.keys(selects).forEach(function (k) { o[k] = selects[k].value; }); return o; } };
  }

  // ---------- CSS ----------
  function injectStyle() {
    if (document.getElementById('cl-auth-style')) return;
    var css = [
      '.cl-overlay{position:fixed;inset:0;z-index:99999;background:linear-gradient(135deg,#fdeef4,#e6fbfa);display:flex;align-items:center;justify-content:center;font-family:Calibri,system-ui,sans-serif}',
      '.cl-card{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(80,20,45,.22);width:360px;max-width:92vw;padding:26px 26px 22px}',
      '.cl-card h2{margin:0 0 2px;color:#e8185c;font-size:21px}',
      '.cl-sub{color:#8a6a78;font-size:12.5px;margin:0 0 18px}',
      '.cl-field{margin-bottom:12px}',
      '.cl-field label{display:block;font-size:12px;color:#5b4a53;margin-bottom:4px;font-weight:600}',
      '.cl-input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #dcc9d2;border-radius:8px;font-size:14px;outline:none;font-family:inherit}',
      '.cl-input:focus{border-color:#e8185c;box-shadow:0 0 0 3px rgba(232,24,92,.12)}',
      '.cl-input::-ms-reveal,.cl-input::-ms-clear{display:none}',  // ẩn icon con mắt/xóa mặc định của Edge
      '.cl-btn{background:#e8185c;color:#fff;border:none;border-radius:8px;padding:10px 14px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}',
      '.cl-btn:hover{background:#c01050}.cl-btn:disabled{opacity:.55;cursor:default}',
      '.cl-btn.sm{padding:5px 10px;font-size:12.5px}',
      '.cl-btn.ghost{background:#fff;color:#c01050;border:1px solid #f6aecb}.cl-btn.ghost:hover{background:#fdeef4}',
      '.cl-btn.danger{background:#fff;color:#dc2626;border:1px solid #fca5a5}.cl-btn.danger:hover{background:#fef2f2}',
      '.cl-err{background:#fef2f2;color:#b91c1c;border:1px solid #fca5a5;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-bottom:12px;display:none}',
      '.cl-hint{font-size:11px;color:#a08a94;margin-top:12px;line-height:1.5}',
      // top bar
      '#cl-bar{display:flex;align-items:center;gap:8px;margin-left:8px;font-family:Calibri,system-ui,sans-serif;font-size:13px}',
      '#cl-bar .who{line-height:1.15}#cl-bar .who b{color:#1f1520}#cl-bar .who span{color:#8a6a78;font-size:11px}',
      '.cl-pill{background:#fdeef4;color:#c01050;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:700}',
      '.cl-pill.teal{background:#e6fbfa;color:#0d9488}',
      // modal
      '.cl-modal{position:fixed;inset:0;z-index:99998;background:rgba(31,21,32,.45);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;font-family:Calibri,system-ui,sans-serif}',
      '.cl-modal .box{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(80,20,45,.28);width:820px;max-width:96vw;padding:20px 22px}',
      '.cl-modal h3{margin:0;color:#e8185c;font-size:18px}',
      '.cl-tabs{display:flex;gap:6px;margin:14px 0}',
      '.cl-tab{padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;color:#8a6a78;background:#f6eef2}',
      '.cl-tab.on{background:#e8185c;color:#fff}',
      '.cl-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.cl-table th,.cl-table td{text-align:left;padding:7px 9px;border-bottom:1px solid #eadfe4}',
      '.cl-table th{color:#8a6a78;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}',
      '.cl-row-form{display:flex;flex-wrap:wrap;gap:8px;align-items:end;background:#fdf8fa;border:1px solid #eadfe4;border-radius:10px;padding:12px;margin-bottom:14px}',
      '.cl-row-form .cl-field{margin:0;min-width:120px}',
      '.cl-close{cursor:pointer;color:#a08a94;font-size:22px;line-height:1;border:none;background:none}',
      '.cl-toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);background:#1f1520;color:#fff;padding:10px 18px;border-radius:10px;font-family:Calibri,sans-serif;font-size:13.5px;z-index:100000;opacity:0;transition:.3s;box-shadow:0 8px 24px rgba(0,0,0,.25)}',
      '.cl-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
      '.cl-toast.err{background:#b91c1c}.cl-toast.ok{background:#15803d}',
      '#role-chip{display:none!important}', // ẩn chip đổi quyền demo — RBAC thật thay thế
    ].join('\n');
    document.head.appendChild(h('style', { id: 'cl-auth-style', html: css }));
  }

  // ---------- Màn đăng nhập ----------
  function showLogin(prefillMsg) {
    injectStyle();
    removeEl('cl-overlay'); removeEl('cl-bar');
    // Đã cấu hình Supabase → CHỈ cho đăng nhập bằng email (đám mây), khóa đăng nhập cục bộ để tránh lộ trên web công khai.
    var cloudOnly = !!(window.CLCloud && window.CLCloud.configured());
    var errBox = h('div', { class: 'cl-err' });
    var uEl = h('input', { class: 'cl-input', id: 'cl-u', autocomplete: 'username', placeholder: cloudOnly ? 'email đăng nhập' : 'username (cục bộ) hoặc email (đám mây)' });
    var pEl = h('input', { class: 'cl-input', type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
    var btn = h('button', { class: 'cl-btn', style: 'width:100%;margin-top:6px' }, ['Đăng nhập']);
    var eye = h('button', { type: 'button', title: 'Hiện/ẩn mật khẩu', style: 'position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:none;cursor:pointer;font-size:15px;line-height:1' }, ['👁']);
    eye.addEventListener('click', function () { pEl.type = (pEl.type === 'password') ? 'text' : 'password'; });
    var pwWrap = h('div', { style: 'position:relative' }, [pEl, eye]);

    function fail(m) { errBox.textContent = m; errBox.style.display = 'block'; btn.disabled = false; btn.textContent = 'Đăng nhập'; }
    function submit() {
      errBox.style.display = 'none';
      var u = uEl.value.trim(), p = pEl.value;
      if (!u || !p) return fail('Nhập tài khoản/email và mật khẩu.');
      // Khi đã cấu hình đám mây: BẮT BUỘC đăng nhập bằng email, chặn đăng nhập cục bộ (bảo mật khi web công khai).
      if (cloudOnly && u.indexOf('@') < 0) return fail('Vui lòng đăng nhập bằng EMAIL (tài khoản đám mây).');
      btn.disabled = true; btn.textContent = 'Đang kiểm tra…';
      // Có "@" + đã cấu hình Supabase → đăng nhập ĐÁM MÂY; ngược lại → đăng nhập cục bộ (cũ).
      var useCloud = !!(window.CLCloud && window.CLCloud.configured() && u.indexOf('@') >= 0);
      if (useCloud) {
        window.CLCloud.signIn(u, p)
          .then(function (profile) { startCloudSession(profile); })
          .catch(function (e) { fail(e.message || 'Đăng nhập đám mây thất bại'); });
      } else {
        api('POST', '/api/auth/login', { username: u, password: p })
          .then(function (r) { setSession(r); startSession(); })
          .catch(function (e) { fail(e.message || 'Đăng nhập thất bại'); });
      }
    }
    btn.addEventListener('click', submit);
    [uEl, pEl].forEach(function (el) { el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); }); });

    var card = h('div', { class: 'cl-card' }, [
      h('h2', {}, ['Pure Group']),
      h('p', { class: 'cl-sub' }, ['Đăng nhập để tiếp tục']),
      errBox,
      h('div', { class: 'cl-field' }, [h('label', {}, ['Tên đăng nhập']), uEl]),
      h('div', { class: 'cl-field' }, [h('label', {}, ['Mật khẩu']), pwWrap]),
      btn,
      h('div', { class: 'cl-hint', html: 'Dữ liệu mỗi xưởng được lưu tách biệt ngay trên máy này. Liên hệ quản trị nếu quên mật khẩu.' }),
    ]);
    if (prefillMsg) { errBox.textContent = prefillMsg; errBox.style.display = 'block'; }
    var ov = h('div', { class: 'cl-overlay', id: 'cl-overlay' }, [card]);
    document.body.appendChild(ov);
    setTimeout(function () { uEl.focus(); }, 50);
  }

  function removeEl(id) { var e = document.getElementById(id); if (e) e.remove(); }

  function setSession(r) {
    S.token = r.token || S.token;
    S.user = r.user; S.factory = r.factory || null; S.perms = r.permissions || [];
    localStorage.setItem(LS.token, S.token);
    localStorage.setItem(LS.user, JSON.stringify(S.user));
    localStorage.setItem(LS.factory, JSON.stringify(S.factory));
    localStorage.setItem(LS.perms, JSON.stringify(S.perms));
  }

  // ---- ĐĂNG NHẬP ĐÁM MÂY (Supabase) ----
  var CLOUD_PERMS = {
    super_admin: ['scope:all','user:read','user:create','user:update','user:delete','factory:create','factory:read','factory:update','factory:delete','dataset:create','dataset:read','dataset:update','dataset:delete','audit:read'],
    factory_admin: ['user:read','user:create','user:update','user:delete','factory:read','dataset:create','dataset:read','dataset:update','dataset:delete','audit:read'],
    user: ['dataset:create','dataset:read']
  };
  function cloudToSession(profile) {
    return {
      token: 'cloud:' + profile.id,
      user: { id: profile.id, username: profile.email, display_name: profile.display_name || profile.email, role: profile.role, stepPerms: profile.step_perms || null },
      factory: profile.factory_id ? { id: profile.factory_id, name: 'Xưởng', code: '' } : null,
      permissions: CLOUD_PERMS[profile.role] || CLOUD_PERMS.user
    };
  }
  var cloudRTChannel = null;
  function startCloudSession(profile) {
    setSession(cloudToSession(profile));
    S.cloud = true;
    try { localStorage.setItem('cl_mode', 'cloud'); } catch (e) {}
    startSession();
    // REALTIME: máy khác lưu dữ liệu → tự nạp bản mới nhất.
    try {
      if (!cloudRTChannel && window.CLCloud && window.CLCloud.subscribe) {
        window.CLCloud.subscribe(function () {
          toast('Có dữ liệu mới từ máy khác — đang cập nhật…', 'ok');
          try { autoLoadLatest(true); } catch (_) {}
        }).then(function (ch) { cloudRTChannel = ch; });
      }
    } catch (e) {}
  }

  function doLogout(expired) {
    var t = S.token, wasCloud = S.cloud;
    S.token = ''; S.user = null; S.factory = null; S.perms = []; S.cloud = false;
    [LS.token, LS.user, LS.factory, LS.perms, LS.activeFactory].forEach(function (k) { localStorage.removeItem(k); });
    try { localStorage.removeItem('cl_mode'); } catch (e) {}
    if (wasCloud && window.CLCloud) { try { window.CLCloud.signOut(); } catch (e) {} }
    // Dọn dữ liệu đang mở để không lẫn giữa các xưởng khi đổi tài khoản.
    try { if (window.__CLAPP) window.__CLAPP.clearData(); } catch (e) {}
    if (t && !expired && window.CLStore) { window.CLStore.handle('POST', '/api/auth/logout', null, t).catch(function () {}); }
    showLogin(expired ? 'Phiên đã hết hạn, vui lòng đăng nhập lại.' : null);
  }

  // ---------- Thanh trên cùng (đã đăng nhập) ----------
  function buildBar() {
    removeEl('cl-bar');
    var bar = h('div', { id: 'cl-bar' });

    // super admin: chọn xưởng đang thao tác (cho lưu/nạp dataset)
    var facSel = null;
    if (isSuper() && !S.cloud) {   // bộ chọn xưởng dùng dữ liệu CLStore cục bộ — bỏ qua ở chế độ đám mây
      facSel = h('select', { class: 'cl-input', style: 'padding:4px 8px;font-size:12px;width:auto', title: 'Xưởng đang thao tác' });
      facSel.addEventListener('change', function () { localStorage.setItem(LS.activeFactory, facSel.value); });
      bar.appendChild(facSel);
      refreshFactories(facSel);
    }

    var who = h('div', { class: 'who' }, [
      h('b', {}, [S.user ? (S.user.display_name || S.user.username) : '']),
      h('br'),
      h('span', {}, [(ROLE_LABEL[role()] || role() || '') + (S.factory ? ' · ' + S.factory.name : (isSuper() ? ' · Toàn hệ thống' : ''))]),
    ]);
    bar.appendChild(who);

    // Lưu / Nạp dữ liệu theo xưởng
    if (can('dataset:create')) bar.appendChild(h('button', { class: 'cl-btn sm ghost', title: 'Lưu dữ liệu hiện tại lên server (theo xưởng)', onclick: saveDataset }, ['☁ Lưu']));
    if (can('dataset:read')) bar.appendChild(h('button', { class: 'cl-btn sm ghost', title: 'Nạp dữ liệu đã lưu của xưởng', onclick: openDatasetModal }, ['⭳ Nạp']));

    // Quản lý (User / Factory) — đám mây dùng Supabase, cục bộ dùng CLStore.
    if (can('user:read') || can('factory:create')) bar.appendChild(h('button', { class: 'cl-btn sm', onclick: (S.cloud ? openCloudAdminModal : openAdminModal) }, ['⚙ Quản lý']));

    bar.appendChild(h('button', { class: 'cl-btn sm danger', onclick: function () { doLogout(false); } }, ['Đăng xuất']));

    // Chèn vào hàng có ô tìm kiếm (header .topbar); fallback về body nếu không thấy.
    var host = document.querySelector('.topbar') || document.body;
    host.appendChild(bar);
    document.body.style.paddingTop = '';
    document.documentElement.classList.add('cl-role-' + (role() || 'x'));
  }

  function refreshFactories(sel) {
    if (!can('factory:read')) return;
    api('GET', '/api/factories').then(function (list) {
      S.factories = list || [];
      if (!sel) return;
      var active = localStorage.getItem(LS.activeFactory) || (S.factory && S.factory.id) || (list[0] && list[0].id) || '';
      sel.innerHTML = '';
      (list || []).forEach(function (f) { sel.appendChild(h('option', { value: f.id }, [f.code + ' · ' + f.name])); });
      if (active) sel.value = active;
      localStorage.setItem(LS.activeFactory, sel.value);
    }).catch(function () {});
  }

  function targetFactoryForWrite() {
    if (isSuper()) return localStorage.getItem(LS.activeFactory) || (S.factories[0] && S.factories[0].id) || null;
    return S.factory && S.factory.id;
  }

  // ---------- Lưu / Nạp dataset (multi-tenant) ----------
  function saveDataset() {
    if (!window.__CLAPP || !window.__CLAPP.hasData()) return toast('Chưa có dữ liệu để lưu — hãy nạp & xử lý file trước.', 'err');
    var def = 'Đơn ' + new Date().toLocaleString('vi-VN');
    var name = window.prompt('Tên bản lưu:', def);
    if (name == null) return;
    var payload = window.__CLAPP.getState();
    // ĐÁM MÂY: lưu qua Supabase (RLS gắn factory theo profile) + cache.
    if (S.cloud && window.CLCloud) {
      window.CLCloud.save({ name: name || def, payload: payload })
        .then(function () { try { localStorage.setItem('cl_ds_updated', JSON.stringify({ fid: (S.factory && S.factory.id), t: Date.now() })); } catch (_) {} toast('Đã lưu đám mây ✓', 'ok'); })
        .catch(function (e) { toast(e.message, 'err'); });
      return;
    }
    var fid = targetFactoryForWrite();
    if (!fid) return toast('Chưa chọn xưởng để lưu.', 'err');
    api('POST', '/api/datasets', { name: name || def, factory_id: fid, payload: payload })
      .then(function () {
        // Báo cho các tab/tài khoản khác (cùng máy) biết có bản mới → họ tự cập nhật.
        try { localStorage.setItem('cl_ds_updated', JSON.stringify({ fid: fid, t: Date.now() })); } catch (_) {}
        toast('Đã lưu ✓ — các tài khoản khác sẽ tự cập nhật', 'ok');
      })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  // Nghe tín hiệu "có dữ liệu mới" từ tab/tài khoản khác (cùng máy) → tự nạp lại bản mới nhất.
  // (Chỉ đồng bộ trong cùng một máy/trình duyệt — bản offline không có server để đồng bộ qua mạng.)
  window.addEventListener('storage', function (e) {
    if (e.key !== 'cl_ds_updated' || !S.token) return;
    var info = null; try { info = JSON.parse(e.newValue || 'null'); } catch (_) {}
    var myFid = S.factory && S.factory.id;
    var relevant = !info || !info.fid || info.fid === myFid || isSuper();
    if (relevant) { try { autoLoadLatest(true); } catch (_) {} }
  });

  function openDatasetModal() {
    var q = isSuper() ? ('?factoryId=' + (targetFactoryForWrite() || '')) : '';
    var getList = (S.cloud && window.CLCloud) ? window.CLCloud.pull() : api('GET', '/api/datasets' + q);
    Promise.resolve(getList).then(function (list) {
      var rows = (list || []).map(function (d) {
        var acts = [h('button', { class: 'cl-btn sm', onclick: function () { loadDataset(d.id); } }, ['Nạp'])];
        if (can('dataset:delete')) acts.push(h('button', { class: 'cl-btn sm danger', style: 'margin-left:6px', onclick: function () { delDataset(d.id, d.name); } }, ['Xóa']));
        return h('tr', {}, [
          h('td', {}, [d.name]),
          h('td', {}, [d.created_by || '—']),
          h('td', {}, [new Date(d.updated_at).toLocaleString('vi-VN')]),
          h('td', { style: 'text-align:right' }, acts),
        ]);
      });
      var body = h('div', {}, [
        rows.length
          ? h('table', { class: 'cl-table' }, [
              h('thead', {}, [h('tr', {}, [h('th', {}, ['Tên']), h('th', {}, ['Người tạo']), h('th', {}, ['Cập nhật']), h('th', {}, [''])])]),
              h('tbody', {}, rows),
            ])
          : h('p', { class: 'cl-sub' }, ['Chưa có bản lưu nào cho xưởng này.']),
      ]);
      openModal('Nạp dữ liệu đã lưu', body);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function loadDataset(id) {
    var get = (S.cloud && window.CLCloud) ? window.CLCloud.fetchOne(id) : api('GET', '/api/datasets/' + id);
    Promise.resolve(get).then(function (d) {
      if (window.__CLAPP) window.__CLAPP.loadData((d && d.payload) || {});
      closeModal();
      toast('Đã nạp "' + (d && d.name || '') + '" ✓', 'ok');
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function delDataset(id, name) {
    if (!window.confirm('Xóa bản lưu "' + name + '"?')) return;
    var del = (S.cloud && window.CLCloud) ? window.CLCloud.remove(id) : api('DELETE', '/api/datasets/' + id);
    Promise.resolve(del).then(function () { toast('Đã xóa ✓', 'ok'); openDatasetModal(); }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ================= QUẢN LÝ (ĐÁM MÂY): xưởng + user + phân quyền =================
  function cloudDefaultUserPerms() { return { s1:'view', s3:'view', s4:'view', s5:'view', s6:'view', s10:'view', s7:'view', s8:'view', s9:'view' }; }
  function openCloudAdminModal() {
    Promise.all([window.CLCloud.listFactories(), window.CLCloud.listProfiles()]).then(function (res) {
      var facs = res[0] || [], profs = res[1] || [];
      var pane = h('div', {});
      var tabU = h('div', { class: 'cl-tab on' }, ['👤 Người dùng']);
      var tabF = h('div', { class: 'cl-tab' }, ['🏭 Xưởng']);
      var body = h('div', {});
      function setTab(w) { tabU.classList.toggle('on', w === 'u'); tabF.classList.toggle('on', w === 'f'); body.innerHTML = ''; body.appendChild(w === 'u' ? usersPane() : facsPane()); }
      tabU.onclick = function () { setTab('u'); }; tabF.onclick = function () { setTab('f'); };

      function roleOpts(sel) { var s = h('select', { class: 'cl-input', style: 'padding:3px 6px' }); (isSuper() ? ['user','factory_admin','super_admin'] : ['user','factory_admin']).forEach(function (r) { s.appendChild(h('option', { value: r }, [ROLE_LABEL[r] || r])); }); if (sel) s.value = sel; return s; }
      function facOpts(sel, blank) { var s = h('select', { class: 'cl-input', style: 'padding:3px 6px' }); if (blank) s.appendChild(h('option', { value: '' }, ['—'])); facs.forEach(function (f) { s.appendChild(h('option', { value: f.id }, [f.code + ' · ' + f.name])); }); if (sel) s.value = sel; return s; }

      function usersPane() {
        var wrap = h('div', {});
        var em = h('input', { class: 'cl-input', placeholder: 'email' });
        var pw = h('input', { class: 'cl-input', type: 'text', placeholder: 'mật khẩu (>=6)' });
        var nm = h('input', { class: 'cl-input', placeholder: 'tên hiển thị' });
        var rr = roleOpts('user'), ff = facOpts('', false);
        var add = h('button', { class: 'cl-btn sm', onclick: function () {
          var e = em.value.trim(), p = pw.value, role = rr.value, fid = (role === 'super_admin' ? null : ff.value);
          if (!e || !p) return toast('Nhập email và mật khẩu', 'err');
          add.disabled = true;
          window.CLCloud.createUser(e, p, { display_name: nm.value.trim() || e })
            .then(function (u) { return window.CLCloud.updateProfile(u.id, { role: role, factory_id: fid, display_name: nm.value.trim() || e, step_perms: (role === 'user' ? cloudDefaultUserPerms() : null), pass_plain: p }); })
            .then(function () { toast('Đã tạo user ✓', 'ok'); openCloudAdminModal(); })
            .catch(function (err) { add.disabled = false; toast(err.message, 'err'); });
        } }, ['+ Thêm']);
        wrap.appendChild(h('div', { class: 'cl-row-form' }, [
          h('div', { class: 'cl-field' }, [h('label', {}, ['Email']), em]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Mật khẩu']), pw]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Tên']), nm]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Vai trò']), rr]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Xưởng']), ff]), add
        ]));
        var rows = profs.map(function (u) {
          var rs = roleOpts(u.role); rs.onchange = function () { window.CLCloud.updateProfile(u.id, { role: rs.value, step_perms: (rs.value === 'user' ? (u.step_perms || cloudDefaultUserPerms()) : null) }).then(function () { toast('Đã đổi vai trò ✓', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); };
          var fs = facOpts(u.factory_id || '', true); fs.onchange = function () { window.CLCloud.updateProfile(u.id, { factory_id: fs.value || null }).then(function () { toast('Đã đổi xưởng ✓', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); };
          var acts = [];
          acts.push(h('button', { class: 'cl-btn sm ghost', onclick: function () { editCloudPerms(u); } }, ['Phân quyền']));
          acts.push(h('button', { class: 'cl-btn sm ghost', style: 'margin-left:5px', title: 'Đặt mật khẩu mới trực tiếp (không cần email)', onclick: function () { var np = window.prompt('Đặt mật khẩu MỚI cho ' + u.email + ' (tối thiểu 6 ký tự):'); if (np == null) return; if (String(np).length < 6) return toast('Mật khẩu tối thiểu 6 ký tự', 'err'); window.CLCloud.adminSetPassword(u.id, np).then(function () { toast('Đã đổi mật khẩu ✓', 'ok'); openCloudAdminModal(); }).catch(function (e) { toast(e.message, 'err'); }); } }, ['Đổi MK']));
          acts.push(h('button', { class: 'cl-btn sm ghost', style: 'margin-left:5px', onclick: function () { window.CLCloud.updateProfile(u.id, { active: u.active === false }).then(function () { openCloudAdminModal(); }).catch(function (e) { toast(e.message, 'err'); }); } }, [u.active === false ? 'Mở' : 'Khóa']));
          return h('tr', { style: u.active === false ? 'opacity:.5' : '' }, [
            h('td', {}, [h('b', {}, [u.email || ''])]), h('td', {}, [pwCell(u)]), h('td', {}, [rs]), h('td', {}, [fs]), h('td', { style: 'text-align:right;white-space:nowrap' }, acts)
          ]);
        });
        wrap.appendChild(h('div', { style: 'max-height:360px;overflow:auto' }, [h('table', { class: 'cl-table' }, [
          h('thead', {}, [h('tr', {}, [h('th', {}, ['Email']), h('th', {}, ['Mật khẩu']), h('th', {}, ['Vai trò']), h('th', {}, ['Xưởng']), h('th', {}, [''])])]),
          h('tbody', {}, rows)
        ])]));
        return wrap;
      }
      function editCloudPerms(u) {
        removeEl('cl-perm-ov');
        var ed = makeStepPermEditor(u.step_perms || {});
        var box = h('div', { style: 'background:#fff;border-radius:12px;padding:16px 18px;max-width:420px;width:92%;max-height:86vh;overflow:auto' }, [
          h('div', { style: 'font-weight:700;color:#E8185C;margin-bottom:10px' }, ['Phân quyền: ' + (u.display_name || u.email)]), ed.el,
          h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px' }, [
            h('button', { class: 'cl-btn sm ghost', onclick: function () { removeEl('cl-perm-ov'); } }, ['Hủy']),
            h('button', { class: 'cl-btn sm', onclick: function () { window.CLCloud.updateProfile(u.id, { step_perms: ed.get() }).then(function () { removeEl('cl-perm-ov'); toast('Đã lưu phân quyền ✓', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); } }, ['Lưu'])
          ])
        ]);
        var ov = h('div', { id: 'cl-perm-ov', style: 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center', onclick: function (e) { if (e.target === ov) removeEl('cl-perm-ov'); } }, [box]);
        document.body.appendChild(ov);
      }
      function facsPane() {
        var wrap = h('div', {});
        var cc = h('input', { class: 'cl-input', placeholder: 'MÃ (vd NĐ)' });
        var nn = h('input', { class: 'cl-input', placeholder: 'Tên xưởng' });
        var add = h('button', { class: 'cl-btn sm', onclick: function () { if (!cc.value.trim() || !nn.value.trim()) return toast('Nhập mã và tên', 'err'); window.CLCloud.createFactory(cc.value.trim(), nn.value.trim()).then(function () { toast('Đã tạo xưởng ✓', 'ok'); openCloudAdminModal(); }).catch(function (e) { toast(e.message, 'err'); }); } }, ['+ Thêm']);
        wrap.appendChild(h('div', { class: 'cl-row-form' }, [h('div', { class: 'cl-field' }, [h('label', {}, ['Mã']), cc]), h('div', { class: 'cl-field' }, [h('label', {}, ['Tên xưởng']), nn]), add]));
        wrap.appendChild(h('table', { class: 'cl-table' }, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Mã']), h('th', {}, ['Tên'])])]), h('tbody', {}, facs.map(function (f) { return h('tr', {}, [h('td', {}, [h('b', {}, [f.code])]), h('td', {}, [f.name])]); }))]));
        return wrap;
      }
      pane.appendChild(h('div', { class: 'cl-tabs' }, [tabU, tabF]));
      pane.appendChild(body);
      body.appendChild(usersPane());
      if (!isSuper()) tabF.style.display = 'none';
      openModal('Quản lý (đám mây)', pane);
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ---------- Modal khung ----------
  function openModal(title, bodyEl) {
    closeModal();
    var box = h('div', { class: 'box' }, [
      h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
        h('h3', {}, [title]),
        h('button', { class: 'cl-close', onclick: closeModal, html: '&times;' }),
      ]),
      bodyEl,
    ]);
    var m = h('div', { class: 'cl-modal', id: 'cl-modal', onclick: function (e) { if (e.target === m) closeModal(); } }, [box]);
    document.body.appendChild(m);
  }
  function closeModal() { removeEl('cl-modal'); }

  // ---------- Modal Quản lý (Factory / User) ----------
  function openAdminModal() {
    var content = h('div', {});
    var tabs = h('div', { class: 'cl-tabs' });
    var tUsers = h('div', { class: 'cl-tab on', onclick: function () { setTab('users'); } }, ['👤 Người dùng']);
    var tFac = can('factory:create') ? h('div', { class: 'cl-tab', onclick: function () { setTab('fac'); } }, ['🏭 Xưởng']) : null;
    var tAudit = can('audit:read') ? h('div', { class: 'cl-tab', onclick: function () { setTab('audit'); } }, ['📜 Nhật ký']) : null;
    tabs.appendChild(tUsers); if (tFac) tabs.appendChild(tFac); if (tAudit) tabs.appendChild(tAudit);
    var pane = h('div', {});
    function setTab(which) {
      [tUsers, tFac, tAudit].forEach(function (t) { if (t) t.classList.remove('on'); });
      if (which === 'users') { tUsers.classList.add('on'); renderUsersPane(pane); }
      else if (which === 'fac') { tFac.classList.add('on'); renderFacPane(pane); }
      else if (which === 'audit') { tAudit.classList.add('on'); renderAuditPane(pane); }
    }
    content.appendChild(tabs); content.appendChild(pane);
    openModal('Quản lý', content);
    setTab('users');
  }

  // ----- USERS pane -----
  function renderUsersPane(pane) {
    pane.innerHTML = 'Đang tải…';
    Promise.all([api('GET', '/api/users'), can('factory:read') ? api('GET', '/api/factories') : Promise.resolve(S.factory ? [S.factory] : [])])
      .then(function (res) {
        var list = res[0] || [], facs = res[1] || [];
        var facName = {}; facs.forEach(function (f) { facName[f.id] = f.code + ' · ' + f.name; });
        pane.innerHTML = '';

        // form thêm
        var uu = h('input', { class: 'cl-input', placeholder: 'username' });
        var pp = h('input', { class: 'cl-input', type: 'text', placeholder: 'mật khẩu' });
        var nn = h('input', { class: 'cl-input', placeholder: 'tên hiển thị' });
        var rr = h('select', { class: 'cl-input' });
        var roleOpts = isSuper() ? ['user', 'factory_admin', 'super_admin'] : ['user', 'factory_admin'];
        roleOpts.forEach(function (r) { rr.appendChild(h('option', { value: r }, [ROLE_LABEL[r]])); });
        var ff = h('select', { class: 'cl-input' });
        facs.forEach(function (f) { ff.appendChild(h('option', { value: f.id }, [f.code + ' · ' + f.name])); });
        if (!isSuper() && S.factory) ff.value = S.factory.id;
        function syncFacDisabled() { ff.disabled = (rr.value === 'super_admin') || !isSuper(); }
        rr.addEventListener('change', syncFacDisabled); syncFacDisabled();

        var addBtn = h('button', { class: 'cl-btn sm', onclick: function () {
          var body = { username: uu.value.trim(), password: pp.value, display_name: nn.value.trim(), role: rr.value };
          if (rr.value !== 'super_admin') body.factory_id = isSuper() ? ff.value : (S.factory && S.factory.id);
          if (!body.username || !body.password) return toast('Nhập username và mật khẩu', 'err');
          api('POST', '/api/users', body).then(function () { toast('Đã tạo user ✓ — bấm "Phân quyền" để giới hạn bảng', 'ok'); renderUsersPane(pane); }).catch(function (e) { toast(e.message, 'err'); });
        } }, ['+ Thêm']);

        var form = h('div', { class: 'cl-row-form' }, [
          h('div', { class: 'cl-field' }, [h('label', {}, ['Username']), uu]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Mật khẩu']), pp]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Tên hiển thị']), nn]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Vai trò']), rr]),
          h('div', { class: 'cl-field' }, [h('label', {}, ['Xưởng']), ff]),
          addBtn,
        ]);
        if (can('user:create')) pane.appendChild(form);

        // bảng
        var rows = list.map(function (u) {
          var acts = [];
          if (can('user:update')) {
            if (u.role === 'user') acts.push(h('button', { class: 'cl-btn sm ghost', onclick: function () { editStepPerms(u, pane); } }, ['Phân quyền']));
            acts.push(h('button', { class: 'cl-btn sm ghost', style: 'margin-left:5px', onclick: function () { resetPw(u); } }, ['Đổi MK']));
            acts.push(h('button', { class: 'cl-btn sm ghost', style: 'margin-left:5px', onclick: function () { toggleActive(u, pane); } }, [u.active ? 'Khóa' : 'Mở']));
          }
          if (can('user:delete') && u.id !== (S.user && S.user.id)) acts.push(h('button', { class: 'cl-btn sm danger', style: 'margin-left:5px', onclick: function () { delUser(u, pane); } }, ['Xóa']));
          return h('tr', { style: u.active ? '' : 'opacity:.5' }, [
            h('td', {}, [h('b', {}, [u.username])]),
            h('td', {}, [pwCell(u)]),
            h('td', {}, [u.display_name || '—']),
            h('td', {}, [h('span', { class: 'cl-pill' }, [ROLE_LABEL[u.role] || u.role])]),
            h('td', {}, [u.factory_id ? (facName[u.factory_id] || u.factory_id) : (u.role === 'super_admin' ? 'Toàn hệ thống' : '—')]),
            h('td', { style: 'text-align:right' }, acts),
          ]);
        });
        pane.appendChild(h('table', { class: 'cl-table' }, [
          h('thead', {}, [h('tr', {}, [h('th', {}, ['Username']), h('th', {}, ['Mật khẩu']), h('th', {}, ['Tên']), h('th', {}, ['Vai trò']), h('th', {}, ['Xưởng']), h('th', {}, [''])])]),
          h('tbody', {}, rows),
        ]));
      }).catch(function (e) { pane.innerHTML = ''; pane.appendChild(h('p', { class: 'cl-err', style: 'display:block' }, [e.message])); });
  }
  // Ô mật khẩu — che sẵn, bấm 👁 để hiện (bảng này chỉ admin xem được).
  function pwCell(u) {
    if (u.pass_plain == null) return h('span', { style: 'color:#999;font-size:12px' }, ['(đặt lại để xem)']);
    var shown = false;
    var txt = h('code', { style: 'font-size:13px;letter-spacing:1px' }, ['••••••']);
    var btn = h('button', { class: 'cl-btn sm ghost', style: 'margin-left:6px;padding:1px 6px', title: 'Hiện/ẩn mật khẩu' }, ['👁']);
    btn.addEventListener('click', function () { shown = !shown; txt.textContent = shown ? u.pass_plain : '••••••'; });
    return h('span', { style: 'display:inline-flex;align-items:center' }, [txt, btn]);
  }
  function editStepPerms(u, pane) {
    removeEl('cl-perm-ov');
    var ed = makeStepPermEditor(u.stepPerms || {});
    var box = h('div', { style: 'background:#fff;border-radius:12px;padding:16px 18px;max-width:420px;width:92%;max-height:86vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.25)' }, [
      h('div', { style: 'font-weight:700;color:#E8185C;margin-bottom:10px' }, ['Phân quyền: ' + (u.display_name || u.username)]),
      ed.el,
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px' }, [
        h('button', { class: 'cl-btn sm ghost', onclick: function () { removeEl('cl-perm-ov'); } }, ['Hủy']),
        h('button', { class: 'cl-btn sm', onclick: function () {
          api('PUT', '/api/users/' + u.id, { stepPerms: ed.get() })
            .then(function () { removeEl('cl-perm-ov'); toast('Đã lưu phân quyền ✓', 'ok'); renderUsersPane(pane); })
            .catch(function (e) { toast(e.message, 'err'); });
        } }, ['Lưu']),
      ]),
    ]);
    var ov = h('div', { id: 'cl-perm-ov', style: 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center' , onclick: function (e) { if (e.target === ov) removeEl('cl-perm-ov'); } }, [box]);
    document.body.appendChild(ov);
  }
  function resetPw(u) {
    var p = window.prompt('Mật khẩu mới cho "' + u.username + '":');
    if (!p) return;
    api('PUT', '/api/users/' + u.id, { password: p }).then(function () { toast('Đã đổi mật khẩu ✓', 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
  }
  function toggleActive(u, pane) {
    api('PUT', '/api/users/' + u.id, { active: u.active ? false : true }).then(function () { renderUsersPane(pane); }).catch(function (e) { toast(e.message, 'err'); });
  }
  function delUser(u, pane) {
    if (!window.confirm('Xóa user "' + u.username + '"?')) return;
    api('DELETE', '/api/users/' + u.id).then(function () { toast('Đã xóa ✓', 'ok'); renderUsersPane(pane); }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ----- FACTORY pane -----
  function renderFacPane(pane) {
    pane.innerHTML = 'Đang tải…';
    api('GET', '/api/factories').then(function (list) {
      pane.innerHTML = '';
      var cc = h('input', { class: 'cl-input', placeholder: 'MÃ (vd HN)' });
      var nn = h('input', { class: 'cl-input', placeholder: 'Tên xưởng' });
      var addBtn = h('button', { class: 'cl-btn sm', onclick: function () {
        if (!cc.value.trim() || !nn.value.trim()) return toast('Nhập mã và tên xưởng', 'err');
        api('POST', '/api/factories', { code: cc.value.trim(), name: nn.value.trim() }).then(function () { toast('Đã tạo xưởng ✓', 'ok'); renderFacPane(pane); refreshFactories(); }).catch(function (e) { toast(e.message, 'err'); });
      } }, ['+ Thêm']);
      pane.appendChild(h('div', { class: 'cl-row-form' }, [
        h('div', { class: 'cl-field' }, [h('label', {}, ['Mã xưởng']), cc]),
        h('div', { class: 'cl-field' }, [h('label', {}, ['Tên xưởng']), nn]),
        addBtn,
      ]));
      var rows = list.map(function (f) {
        return h('tr', { style: f.active ? '' : 'opacity:.5' }, [
          h('td', {}, [h('span', { class: 'cl-pill teal' }, [f.code])]),
          h('td', {}, [f.name]),
          h('td', { style: 'text-align:right' }, [
            h('button', { class: 'cl-btn sm ghost', onclick: function () { editFac(f, pane); } }, ['Sửa']),
            h('button', { class: 'cl-btn sm danger', style: 'margin-left:5px', onclick: function () { delFac(f, pane); } }, ['Xóa']),
          ]),
        ]);
      });
      pane.appendChild(h('table', { class: 'cl-table' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, ['Mã']), h('th', {}, ['Tên']), h('th', {}, [''])])]),
        h('tbody', {}, rows),
      ]));
    }).catch(function (e) { pane.innerHTML = ''; pane.appendChild(h('p', { class: 'cl-err', style: 'display:block' }, [e.message])); });
  }
  function editFac(f, pane) {
    var name = window.prompt('Tên xưởng:', f.name); if (name == null) return;
    api('PUT', '/api/factories/' + f.id, { name: name }).then(function () { toast('Đã cập nhật ✓', 'ok'); renderFacPane(pane); refreshFactories(); }).catch(function (e) { toast(e.message, 'err'); });
  }
  function delFac(f, pane) {
    if (!window.confirm('Xóa xưởng "' + f.name + '"?\nToàn bộ user và dữ liệu của xưởng sẽ bị xóa theo.')) return;
    api('DELETE', '/api/factories/' + f.id).then(function () { toast('Đã xóa xưởng ✓', 'ok'); renderFacPane(pane); refreshFactories(); }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ----- AUDIT pane -----
  function renderAuditPane(pane) {
    pane.innerHTML = 'Đang tải…';
    api('GET', '/api/audit?limit=200').then(function (list) {
      pane.innerHTML = '';
      var rows = (list || []).map(function (a) {
        return h('tr', {}, [
          h('td', {}, [new Date(a.created_at).toLocaleString('vi-VN')]),
          h('td', {}, [a.username || '—']),
          h('td', {}, [h('span', { class: 'cl-pill' }, [a.action])]),
          h('td', {}, [a.detail || '']),
        ]);
      });
      pane.appendChild(h('table', { class: 'cl-table' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, ['Thời gian']), h('th', {}, ['Người dùng']), h('th', {}, ['Hành động']), h('th', {}, ['Chi tiết'])])]),
        h('tbody', {}, rows),
      ]));
    }).catch(function (e) { pane.innerHTML = ''; pane.appendChild(h('p', { class: 'cl-err', style: 'display:block' }, [e.message])); });
  }

  // ---------- Khởi động phiên đã đăng nhập ----------
  function startSession() {
    injectStyle();
    removeEl('cl-overlay');
    // Mọi role đăng nhập đều được chạy Step/sửa lưới (import/run/export). Quản lý mới bị giới hạn.
    try { if (window.__CLAPP) window.__CLAPP.setGridRole('admin'); } catch (e) {}
    // Áp phân quyền theo step: admin toàn quyền; user theo stepPerms đã cấu hình.
    try { if (window.__CLAPP && window.__CLAPP.setPerms) window.__CLAPP.setPerms(role(), (S.user && S.user.stepPerms) || null); } catch (e) {}
    // Lớp PHÒNG VỆ (độc lập HTML): tự ẩn menu + đặt cờ quyền, phòng khi HTML là bản cache cũ.
    try { applyPermsFallback(); } catch (e) { console.warn('applyPermsFallback', e); }
    // Phát hiện HTML CŨ (thiếu bridge setPerms) → cảnh báo: cần tải lại để chặn SỬA trong các Step.
    try {
      var restricted = role() === 'user' && S.user && S.user.stepPerms && Object.keys(S.user.stepPerms).length;
      var htmlNew = window.__CLAPP && typeof window.__CLAPP.setPerms === 'function';
      if (restricted && !htmlNew) {
        toast('⚠ Trang đang chạy bản CŨ (cache). Hãy nhấn Ctrl+Shift+R để nạp lại thì phân quyền SỬA mới có hiệu lực.', 'err');
      }
    } catch (e) {}
    buildBar();
    // Tự động nạp bản lưu MỚI NHẤT của xưởng khi đăng nhập (nút ⭳ Nạp vẫn dùng để chọn bản khác).
    try { autoLoadLatest(); } catch (e) { console.warn('autoLoadLatest', e); }
  }

  // Tự nạp dataset mới nhất theo xưởng. force=true → nạp lại kể cả khi đang có dữ liệu (đồng bộ bản mới).
  function autoLoadLatest(force) {
    if (!can('dataset:read')) return;
    if (!force && window.__CLAPP && window.__CLAPP.hasData && window.__CLAPP.hasData()) return;
    var q = isSuper() ? ('?factoryId=' + (targetFactoryForWrite() || '')) : '';
    var getList = (S.cloud && window.CLCloud) ? window.CLCloud.pull() : api('GET', '/api/datasets' + q);
    Promise.resolve(getList).then(function (list) {
      if (!list || !list.length) return;              // xưởng chưa có bản lưu nào
      var latest = list[0];                            // bản mới nhất ở đầu
      var getOne = (S.cloud && window.CLCloud) ? window.CLCloud.fetchOne(latest.id) : api('GET', '/api/datasets/' + latest.id);
      return Promise.resolve(getOne).then(function (d) {
        if (window.__CLAPP && window.__CLAPP.loadData) {
          window.__CLAPP.loadData((d && d.payload) || {});
          toast('Đã tự nạp bản mới nhất: ' + latest.name + ' ✓', 'ok');
        }
      });
    }).catch(function () {});
  }

  // Tự áp phân quyền từ auth.web.js — hoạt động cả khi Module HTML là bản cũ chưa có bridge.
  function applyPermsFallback() {
    var r = role();
    var admin = (r === 'super_admin' || r === 'factory_admin');
    var sp = (S.user && S.user.stepPerms) || null;
    var perms = admin ? null : (sp && Object.keys(sp).length ? sp : null);
    // đặt cờ toàn cục để render() của HTML (bản mới) đọc được
    window.__STEP_PERMS = perms;
    if (typeof window.__canView !== 'function') window.__canView = function (s) { var p = window.__STEP_PERMS; return !p || p[s] !== 'none'; };
    if (typeof window.__canEditStep !== 'function') window.__canEditStep = function (s) { var p = window.__STEP_PERMS; return !p || p[s] === 'edit'; };
    // ẩn mục menu 'none' (độc lập, không cần bridge HTML)
    var nav = document.getElementById('nav');
    if (nav) {
      var as = nav.querySelectorAll('a[data-s]'), firstVisible = null;
      Array.prototype.forEach.call(as, function (a) {
        var ok = !perms || perms[a.dataset.s] !== 'none';
        a.style.display = ok ? '' : 'none';
        if (ok && !firstVisible) firstVisible = a;
      });
      var active = nav.querySelector('a.active');
      var activeHidden = active && perms && perms[active.dataset.s] === 'none';
      if ((!active || activeHidden) && firstVisible) firstVisible.click();
    }
  }

  // ---------- Phát hiện chế độ ẩn danh / InPrivate ----------
  // InPrivate xoá sạch dữ liệu khi đóng cửa sổ → luôn seed lại tài khoản mặc định (admin) =>
  // dùng như admin mà không giữ được phân quyền. Chặn để tránh lỗ hổng & nhầm lẫn.
  function detectIncognito() {
    return new Promise(function (resolve) {
      try {
        if (navigator.storage && navigator.storage.estimate) {
          navigator.storage.estimate().then(function (est) {
            var quota = est && est.quota || 0;
            try { console.log('[Charmlash] storage quota MB =', Math.round(quota / 1048576)); } catch (_) {}
            // Cửa sổ thường: quota rất lớn (thường >10GB). InPrivate/ẩn danh bị giới hạn nhỏ hơn nhiều.
            resolve(quota > 0 && quota < 3 * 1024 * 1024 * 1024); // < ~3GB => coi là ẩn danh
          }, function () { resolve(false); });
        } else { resolve(false); }
      } catch (e) { resolve(false); }
    });
  }
  function showInPrivateBlock() {
    removeEl('cl-overlay'); removeEl('cl-bar');
    var box = h('div', { style: 'max-width:460px;background:#fff;border-radius:14px;padding:26px 28px;text-align:center;box-shadow:0 16px 50px rgba(0,0,0,.3)' }, [
      h('div', { style: 'font-size:40px;margin-bottom:8px' }, ['🔒']),
      h('h3', { style: 'color:#E8185C;margin:0 0 10px' }, ['Không hỗ trợ chế độ InPrivate / Ẩn danh']),
      h('p', { style: 'color:#444;line-height:1.6;margin:0' }, ['Chế độ ẩn danh sẽ xoá sạch dữ liệu và phân quyền khi đóng cửa sổ, khiến tài khoản luôn về mặc định (toàn quyền admin). Vui lòng mở ứng dụng bằng ', h('b', {}, ['cửa sổ Edge/Chrome thường']), ' để dùng đúng phân quyền và lưu dữ liệu.']),
    ]);
    var ov = h('div', { id: 'cl-overlay', style: 'position:fixed;inset:0;z-index:100000;background:rgba(20,0,10,.75);display:flex;align-items:center;justify-content:center;padding:20px' }, [box]);
    document.body.appendChild(ov);
  }

  // ---------- Điểm vào ----------
  function boot() {
    injectStyle();
    detectIncognito().then(function (incognito) {
      if (incognito) return showInPrivateBlock();   // chặn hẳn trong InPrivate
      // Khôi phục phiên ĐÁM MÂY nếu đang ở chế độ cloud.
      var cloudMode = false; try { cloudMode = localStorage.getItem('cl_mode') === 'cloud'; } catch (e) {}
      if (window.CLCloud && window.CLCloud.configured() && cloudMode) {
        return window.CLCloud.init()
          .then(function (res) { if (res && res.profile) return startCloudSession(res.profile); return showLogin(); })
          .catch(function () { return showLogin(); });
      }
      if (!S.token) return showLogin();
      // Xác minh token còn hiệu lực + đồng bộ quyền mới nhất (đăng nhập cục bộ).
      api('GET', '/api/auth/me')
        .then(function (r) { setSession({ token: S.token, user: r.user, factory: r.factory, permissions: r.permissions }); startSession(); })
        .catch(function () { doLogout(true); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
