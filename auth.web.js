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
  /* ⚠⚠ ĐÃ CẤU HÌNH SUPABASE THÌ MỌI VIỆC VỚI BẢN LƯU PHẢI ĐI ĐƯỜNG ĐÁM MÂY (sửa 3/9).
     Trước đây chỉ xét cờ S.cloud. Cờ đó chỉ bật trong startCloudSession, nên có lúc (đổi tài
     khoản, đăng xuất giữa lúc đang nạp, cl_mode bị xoá…) app rơi xuống lối CŨ dùng
     auth.store.js — kho trong máy, không có người dùng đám mây nào — và trả về đúng câu user
     chụp được: "Chưa đăng nhập hoặc phiên không hợp lệ". Máy đó nằm mãi với bản cũ trong máy
     dù mạng vẫn tốt. Bản chạy máy lẻ (chưa cấu hình Supabase) không ảnh hưởng gì. */
  function dungDamMay() {
    if (!window.CLCloud) return false;
    if (S.cloud) return true;
    try { return !!(window.CLCloud.configured && window.CLCloud.configured()); } catch (e) { return false; }
  }
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
  /* Lời nhắc XẾP CHỒNG LÊN NHAU theo chiều dọc, không đè khít một chỗ (sửa 28/8).
     Trước đây cái nào cũng nằm đúng "bottom:20px" nên vài cái hiện cùng lúc là bóng đổ của
     chúng cộng dồn thành một MẢNG ĐEN to sau lời nhắc. Trùng nội dung thì bỏ luôn cái sau. */
  function xepToast() {   // xếp lại chỗ đứng sau mỗi lần thêm/bớt — cái cũ nhất nằm dưới cùng
    [].slice.call(document.querySelectorAll('.cl-toast'))
      .forEach(function (t, i) { t.style.bottom = (20 + i * 46) + 'px'; });
  }
  function toast(msg, kind) {
    var dang = [].slice.call(document.querySelectorAll('.cl-toast'));
    for (var i = 0; i < dang.length; i++) if (dang[i].textContent === String(msg)) return;   // trùng lời thì thôi
    while (dang.length >= 4) { dang.shift().remove(); }                                      // nhiều quá thì bỏ cái cũ nhất
    var t = h('div', { class: 'cl-toast ' + (kind || '') , html: esc(msg) });
    document.body.appendChild(t); xepToast();
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); xepToast(); }, 300); }, 3200);
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
      '#cl-bar .who{line-height:1.2;white-space:nowrap}#cl-bar .who b{color:#1f1520}#cl-bar .who span{color:#8a6a78;font-size:11px}',
      '#cl-bar .cl-btn,#cl-bar .cl-input,#cl-bar select{white-space:nowrap}',
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
  var cloudRTChannel = null, _dsRTHen = null;
  function startCloudSession(profile) {
    setSession(cloudToSession(profile));
    S.cloud = true;
    try { localStorage.setItem('cl_mode', 'cloud'); } catch (e) {}
    startSession();
    // REALTIME: máy khác lưu dữ liệu → tự nạp bản mới nhất.
    try {
      if (!cloudRTChannel && window.CLCloud && window.CLCloud.subscribe) {
        window.CLCloud.subscribe(function (ev) {
          ev = ev || {};
          if (ev.table === 'profiles') {
            // Admin đổi phân quyền/cài đặt → user liên quan tự áp NGAY (không cần đăng nhập lại).
            var row = (ev.payload && (ev.payload.new || ev.payload.old)) || {};
            var myId = S.user && S.user.id;
            if (myId && String(row.id) === String(myId)) { try { applyLivePerms(); } catch (_) {} }
            return;
          }
          /* Dữ liệu (datasets) đổi từ máy khác → tự nạp bản mới nhất.
             ⚠ Từ 28/8 một lần lưu ghi NHIỀU dòng (chỉ mục + mỗi mã đơn 1 mảnh + ảnh), nên
             realtime bắn về mấy chục sự kiện liền nhau. Trước đây mỗi sự kiện là 1 lời nhắc
             + 1 lần nạp lại ⇒ mấy chục lời nhắc chồng khít lên nhau (bóng đổ cộng dồn, nhìn
             thành MẢNG ĐEN) và nạp lại mấy chục lần liên tiếp.
             Nay: bỏ qua dòng MẢNH (chúng chỉ là ruột của bản lưu, dòng CHỈ MỤC mới là thật),
             rồi gộp cả đợt thành MỘT lần nhắc + MỘT lần nạp. */
          var _r = (ev.payload && (ev.payload.new || ev.payload.old)) || {};
          if (_r.kind === 'orders-manh' || _r.kind === 'orders-anh') return;
          if (_dsRTHen) clearTimeout(_dsRTHen);
          _dsRTHen = setTimeout(function () {
            _dsRTHen = null;
            toast('Có dữ liệu mới từ máy khác — đang cập nhật…', 'ok');
            try { autoLoadLatest(true); } catch (_) {}
          }, 1200);
        }).then(function (ch) { cloudRTChannel = ch; });
      }
    } catch (e) {}
  }

  function doLogout(expired) {
    var t = S.token, wasCloud = S.cloud;
    try { dungCanh(); } catch (e) {}
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

    // Super admin: chọn XƯỞNG để XEM dữ liệu (cả chế độ đám mây). Đổi xưởng → tự nạp bản mới nhất của xưởng đó.
    var facSel = null;
    if (isSuper()) {
      facSel = h('select', { class: 'cl-input', style: 'padding:4px 8px;font-size:12px;width:auto', title: 'Xưởng đang xem (Super Admin)' });
      facSel.addEventListener('change', function () {
        localStorage.setItem(LS.activeFactory, facSel.value);
        try { autoLoadLatest(true); } catch (e) {}   // xem dữ liệu của xưởng vừa chọn
      });
      bar.appendChild(h('span', { class: 'cl-sub', style: 'font-size:11px;margin:0 2px 0 4px;opacity:.75' }, ['Xưởng:']));
      bar.appendChild(facSel);
      refreshFactories(facSel);
    }

    // Khối tài khoản: GỘP 1 DÒNG (tên · vai trò · xưởng) để thanh công cụ không bị xuống dòng.
    var _nm = S.user ? (S.user.display_name || S.user.username) : '';
    var _rl = ROLE_LABEL[role()] || role() || '';
    var _fc = S.factory ? S.factory.name : (isSuper() ? 'Toàn hệ thống' : '');
    var who = h('div', { class: 'who', title: _nm + (_rl ? ' · ' + _rl : '') + (_fc ? ' · ' + _fc : '') }, [
      h('b', {}, [_nm]),
      h('span', {}, [(_rl ? ' · ' + _rl : '') + (_fc ? ' · ' + _fc : '')]),
    ]);
    bar.appendChild(who);

    /* Chỉ còn MỘT nút ☁ Lưu (chốt 29/8 theo yêu cầu).
       · "⭳ Nạp" bỏ đi: xưởng chỉ giữ ĐÚNG MỘT bản lưu (bản cuối), mở app là tự có, không còn
         gì để chọn nữa.
       · "🛟 Cứu dữ liệu" bỏ đi: việc vá mảnh thiếu nay app tự làm lặng lẽ ngay lúc mở
         (xem vaManh() ở cl.sync.js + suaVaDon() bên dưới), không bắt người dùng bấm. */
    if (can('dataset:create')) bar.appendChild(h('button', { class: 'cl-btn sm ghost', title: 'Lưu dữ liệu hiện tại lên server (theo xưởng)', onclick: saveDataset }, ['☁ Lưu']));

    // Quản lý (User / Factory) — đám mây dùng Supabase, cục bộ dùng CLStore.
    if (can('user:read') || can('factory:create')) bar.appendChild(h('button', { class: 'cl-btn sm', onclick: (S.cloud ? openCloudAdminModal : openAdminModal) }, ['⚙ Quản lý']));

    bar.appendChild(h('button', { class: 'cl-btn sm danger', onclick: function () { doLogout(false); } }, ['Đăng xuất']));

    /* Lối vào bảng "Quay về một mốc thời gian": CHỮ NHỎ Ở CHÂN THANH BÊN, không phải nút trên
       thanh trên cùng (user đã chốt bỏ nút ở đó). Trước tính gọi bằng địa chỉ ?cuu=1 nhưng dán
       vào Edge thì dấu ? bị đổi thành %3F ⇒ "File not found". Bấm chữ là chắc ăn nhất.
       Ctrl+Shift+H hoặc gõ __CUU() trong Console cũng mở được. */
    try {
      var chan = document.querySelector('.sidebar-foot');
      if (chan && !document.getElementById('cl-lui') && can('dataset:read')) {
        chan.appendChild(h('br'));
        chan.appendChild(h('span', { id: 'cl-lui',
          style: 'opacity:.65;font-size:11px;text-decoration:underline;cursor:pointer',
          title: 'Xem lại các lần lưu trước và quay về một mốc (Ctrl+Shift+H)',
          onclick: function () { moKhoCuu(); } }, ['↩ Quay về mốc lưu trước']));
      }
    } catch (e) {}

    // Chèn vào hàng có ô tìm kiếm (header .topbar); fallback về body nếu không thấy.
    var host = document.querySelector('.topbar') || document.body;
    host.appendChild(bar);
    document.body.style.paddingTop = '';
    document.documentElement.classList.add('cl-role-' + (role() || 'x'));
  }

  function refreshFactories(sel) {
    var done = function (list) {
      S.factories = list || [];
      if (!sel) return;
      var active = localStorage.getItem(LS.activeFactory) || (S.factory && S.factory.id) || (list[0] && list[0].id) || '';
      sel.innerHTML = '';
      (list || []).forEach(function (f) { sel.appendChild(h('option', { value: f.id }, [f.code + ' · ' + f.name])); });
      if (active) sel.value = active;
      if (sel.value) localStorage.setItem(LS.activeFactory, sel.value);
    };
    // ĐÁM MÂY: lấy xưởng qua Supabase; cục bộ: qua API backend.
    if (dungDamMay() && window.CLCloud.listFactories) { window.CLCloud.listFactories().then(done).catch(function () {}); return; }
    if (!can('factory:read')) return;
    api('GET', '/api/factories').then(done).catch(function () {});
  }
  function factoryNameOf(fid) {
    var f = (S.factories || []).filter(function (x) { return x.id === fid; })[0];
    return f ? (f.code + ' · ' + f.name) : (fid || '—');
  }

  function targetFactoryForWrite() {
    if (isSuper()) return localStorage.getItem(LS.activeFactory) || (S.factories[0] && S.factories[0].id) || null;
    return S.factory && S.factory.id;
  }

  // ---------- Lưu dataset (multi-tenant) ----------
  /* MỖI XƯỞNG CHỈ MỘT BẢN LƯU (chốt 29/8 theo yêu cầu "chỉ dữ liệu lần sao lưu cuối").
     Trước đây ☁ Lưu hỏi tên rồi tạo một dòng MỚI mỗi lần, còn tự lưu ghi vào một ô cố định →
     máy chủ đầy bản cũ, mảnh mồ côi lẫn lộn, và chính đống đó làm app gom nhầm đơn của đợt
     trước. Nay cả lưu tay lẫn tự lưu đều ghi ĐÈ vào đúng một ô của xưởng; lưu tay xong thì
     soi lại rồi DỌN SẠCH mọi thứ còn lại. */
  function tenBanLuu() { return '⚙ Bản làm việc'; }
  function duocGhiXuong() {   // super admin đang XEM xưởng khác thì không được ghi đè lung tung
    if (!isSuper()) return true;
    var t = targetFactoryForWrite(), m = S.factory && S.factory.id;
    return !!(t && m && t === m);
  }
  function saveDataset() {
    if (!window.__CLAPP || !window.__CLAPP.hasData()) return toast('Chưa có dữ liệu để lưu — hãy nạp & xử lý file trước.', 'err');
    var payload = window.__CLAPP.getState();
    // ĐÁM MÂY: lưu qua Supabase (RLS gắn factory theo profile) + cache.
    if (dungDamMay()) {
      if (!duocGhiXuong()) return toast('Đang xem xưởng khác — không lưu đè. Chọn lại xưởng của bạn rồi lưu.', 'err');
      if (_moTam && !window.confirm('ĐANG XEM BẢN TẠM — còn thiếu ' + _moTamThieu + ' mảnh chưa lấy về được.\n\n' +
          'Lưu bây giờ là GHI ĐÈ bản thiếu này lên máy chủ, mấy đơn kia sẽ mất.\n\nVẫn lưu?')) return;
      var id = autoSaveId();
      if (!id) return toast('Tài khoản chưa được gán Xưởng — không lưu được.', 'err');
      // Bản lưu tay cũng chia mảnh + nén như bản tự lưu (68 đơn: 7MB → khoảng 1MB)
      var chiaMot = window.__CLAPP.chiaLuu();
      function luu(ep) {
        return (window.CLCloud.saveGoi && chiaMot)
          ? window.CLCloud.saveGoi({ id: id, name: tenBanLuu(), goi: chiaMot, epGhi: !!ep })
          : window.CLCloud.save({ id: id, name: tenBanLuu(), payload: payload });
      }
      var ghi = luu(false).catch(function (e) {
        /* Phanh chống co nhỏ đã chặn: hỏi người dùng cho rõ rồi mới ép ghi. */
        if (!/KHÔNG ghi đè/.test(String(e && e.message || ''))) throw e;
        if (!window.confirm(e.message + '\n\nVẫn muốn ghi đè bằng bản đang mở?')) throw new Error('Đã huỷ — máy chủ giữ nguyên bản cũ.');
        return luu(true);
      });
      toast('Đang lưu lên máy chủ…', 'ok');
      ghi.then(function (row) {
        try { localStorage.setItem('cl_ds_updated', JSON.stringify({ fid: (S.factory && S.factory.id), t: Date.now() })); } catch (_) {}
        toast('Đã lưu đám mây ✓', 'ok');
        var st = window.__CLAPP.getState();
        ghiMoNhanh(st, { id: id, nguon: 'lưu tay' });
        _choLuu = false; _luuLucNao = Date.now(); anBangBanMoi();
        /* User: "Ấn lưu nhưng không thấy có thông báo thành công". Lời nhắc chỉ hiện 3,2 giây,
           quay đi là mất. Nay để lại một dải nằm luôn trên đầu trang, có giờ và con số. */
        bangKetQua('✓ Đã lưu lên máy chủ lúc ' + new Date().toLocaleTimeString('vi-VN') + ' — ' +
                   (st.files || []).length + ' file · ' + (st.orders || []).length + ' dòng. ' +
                   'Mọi tài khoản trong xưởng sẽ thấy bản này. (bấm để đóng)', 'xanh');
        return soiRoiDon((row && row.id) || id);
      }).catch(function (e) { toast(e.message, 'err'); bangKetQua('✗ LƯU HỎNG: ' + (e && e.message || e) + ' (bấm để đóng)'); });
      return;
    }
    var fid = targetFactoryForWrite();
    if (!fid) return toast('Chưa chọn xưởng để lưu.', 'err');
    api('POST', '/api/datasets', { name: tenBanLuu(), factory_id: fid, payload: payload })
      .then(function () {
        // Báo cho các tab/tài khoản khác (cùng máy) biết có bản mới → họ tự cập nhật.
        try { localStorage.setItem('cl_ds_updated', JSON.stringify({ fid: fid, t: Date.now() })); } catch (_) {}
        toast('Đã lưu ✓ — các tài khoản khác sẽ tự cập nhật', 'ok');
      })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  // ---------- TỰ ĐỘNG LƯU bản làm việc (không cần bấm ☁ Lưu) ----------
  // Lưu vào 1 slot CỐ ĐỊNH theo xưởng (upsert đè) → đăng xuất/đăng nhập lại KHÔNG mất đơn đã xử lý.
  var _autoSaveT = null;
  /* ⚠⚠ MỘT XƯỞNG = MỘT Ô LƯU, VÀ Ô ĐÓ PHẢI GIỐNG NHAU TRÊN MỌI MÁY, MỌI TÀI KHOẢN (sửa 3/9).
     Bản cũ sinh một uuid NGẪU NHIÊN rồi cất trong localStorage của TỪNG trình duyệt. Hậu quả
     đúng như user báo: hoan.nm (Edge) tự lưu vào dòng A, ketoan.nd (Chrome) tự lưu vào dòng B —
     cùng một xưởng mà hai người ghi hai chỗ, nên "ấn Lưu rồi mà tài khoản khác không thấy dữ
     liệu mới", và mỗi người mở lên thấy một con số khác nhau (54 đơn / 10 đơn).
     Nay lấy thẳng id của XƯỞNG làm id bản lưu — ai tính cũng ra đúng một giá trị, không cần
     nhớ gì trong máy. (datasets.id và factories.id là hai bảng khác nhau nên trùng giá trị
     không sao; đây chính là "ô làm việc của xưởng đó".) */
  function autoSaveId() {
    var fid = S.factory && S.factory.id;
    return fid || null;
  }
  function doAutoSave() {
    try {
      /* Mấy lối "không lưu" dưới đây phải GỠ cờ chờ-lưu: giữ cờ mãi thì người canh bản mới
         không bao giờ dám nạp, máy đó nằm im với bản cũ (đúng lỗi 3/9). Riêng _moTam thì
         người canh đã tự xét lấy nên cứ để nguyên. */
      var thoi = function () { _choLuu = false; };
      if (!S.token || !can('dataset:create')) return thoi();
      if (!window.__CLAPP || !window.__CLAPP.hasData || !window.__CLAPP.hasData()) return thoi();
      if (_moTam) return;                   // ⚠ bản mở TẠM còn thiếu mảnh → tuyệt đối không tự lưu đè
      var id = autoSaveId(); if (!id) return thoi();
      if (!duocGhiXuong()) return thoi();   // đang xem xưởng khác → không tự lưu đè
      var ten = tenBanLuu();
      var xong = function () {
        try { var ind = document.getElementById('cl-autosave-ind'); if (ind) { ind.textContent = '✓ Đã tự lưu ' + new Date().toLocaleTimeString('vi-VN'); } } catch (_) {}
        // cập nhật luôn BẢN MỞ NHANH → mở lần sau là thấy đúng cái vừa lưu, kể cả mất mạng
        try { ghiMoNhanh(window.__CLAPP.getState(), { id: id, nguon: 'tự lưu' }); } catch (_) {}
        _choLuu = false;                  // đã lên máy chủ xong → người canh được phép làm việc lại
        _luuLucNao = Date.now();
      };
      /* CHIA MẢNH THEO MÃ ĐƠN (chốt 28/8): trước đây mỗi lần tự lưu đẩy CẢ KHO lên Supabase
         (68 đơn ≈ 7MB, mạng 5 Mbps mất ~11 giây), dù chỉ vừa sửa đúng một ô. Nay chỉ mảnh của
         đơn vừa đổi được nén rồi gửi lại (~52KB). Máy nào không có saveGoi thì vẫn chạy lối cũ. */
      if (dungDamMay() && window.CLCloud.saveGoi && window.__CLAPP.chiaLuu) {
        window.CLCloud.saveGoi({ id: id, name: ten, goi: window.__CLAPP.chiaLuu() }).then(xong).catch(function () {});
        return;
      }
      var payload = window.__CLAPP.getState();
      var rec = { id: id, name: ten, payload: payload };
      if (dungDamMay()) {
        window.CLCloud.save(rec).then(xong).catch(function () {});
      } else {
        var fid = targetFactoryForWrite(); if (fid) api('POST', '/api/datasets', { id: id, name: rec.name, factory_id: fid, payload: payload }).catch(function () {});
      }
    } catch (_) {}
  }
  function scheduleAutoSave() {
    _choLuu = true;                       // có sửa chưa lưu → người canh không được nạp đè
    if (_autoSaveT) clearTimeout(_autoSaveT);
    _autoSaveT = setTimeout(doAutoSave, 2500);
  }
  window.__CLAUTOSAVE = scheduleAutoSave;   // Module HTML gọi khi dữ liệu thay đổi

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
    var getList = (dungDamMay()) ? window.CLCloud.pull() : api('GET', '/api/datasets' + q);
    var superView = isSuper() && S.cloud;
    var curFid = targetFactoryForWrite();
    Promise.resolve(getList).then(function (list) {
      list = list || [];
      // Super admin (đám mây): chỉ hiện bản lưu của XƯỞNG đang chọn ở thanh công cụ.
      if (superView && curFid) list = list.filter(function (d) { return d.factory_id === curFid; });
      var rows = list.map(function (d) {
        var acts = [h('button', { class: 'cl-btn sm', onclick: function () { loadDataset(d.id); } }, ['Nạp'])];
        if (can('dataset:delete')) acts.push(h('button', { class: 'cl-btn sm danger', style: 'margin-left:6px', onclick: function () { delDataset(d.id, d.name); } }, ['Xóa']));
        var tds = [ h('td', {}, [d.name]) ];
        if (superView) tds.push(h('td', {}, [factoryNameOf(d.factory_id)]));
        tds.push(h('td', {}, [d.created_by || '—']));
        tds.push(h('td', {}, [new Date(d.updated_at).toLocaleString('vi-VN')]));
        tds.push(h('td', { style: 'text-align:right' }, acts));
        return h('tr', {}, tds);
      });
      var headCols = [h('th', {}, ['Tên'])];
      if (superView) headCols.push(h('th', {}, ['Xưởng']));
      headCols.push(h('th', {}, ['Người tạo'])); headCols.push(h('th', {}, ['Cập nhật'])); headCols.push(h('th', {}, ['']));
      var title = superView && curFid ? ('Nạp dữ liệu — ' + factoryNameOf(curFid)) : 'Nạp dữ liệu đã lưu';
      var body = h('div', {}, [
        rows.length
          ? h('table', { class: 'cl-table' }, [
              h('thead', {}, [h('tr', {}, headCols)]),
              h('tbody', {}, rows),
            ])
          : h('p', { class: 'cl-sub' }, [superView ? 'Xưởng này chưa có bản lưu nào. Đổi xưởng ở thanh công cụ để xem xưởng khác.' : 'Chưa có bản lưu nào cho xưởng này.']),
      ]);
      openModal(title, body);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function loadDataset(id) {
    var get = (dungDamMay()) ? (window.CLCloud.fetchGoi || window.CLCloud.fetchOne)(id) : api('GET', '/api/datasets/' + id);
    Promise.resolve(get).then(function (d) {
      var pl = (d && d.payload) || null;
      // Nạp tay cũng vậy: bản đọc ra rỗng thì báo, KHÔNG đè lên dữ liệu đang mở
      if (!pl || (!(pl.orders || []).length && !(pl.files || []).length))
        throw new Error('Bản lưu này đọc ra RỖNG — không nạp để khỏi xoá mất dữ liệu đang mở.');
      if (window.__CLAPP) window.__CLAPP.loadData(pl);
      closeModal();
      toast('Đã nạp "' + (d && d.name || '') + '" ✓', 'ok');
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function delDataset(id, name) {
    if (!window.confirm('Xóa bản lưu "' + name + '"?')) return;
    var del = (dungDamMay()) ? window.CLCloud.remove(id) : api('DELETE', '/api/datasets/' + id);
    Promise.resolve(del).then(function () { toast('Đã xóa ✓', 'ok'); openDatasetModal(); }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ================= QUẢN LÝ (ĐÁM MÂY): xưởng + user + phân quyền =================
  function cloudDefaultUserPerms() { return { s1:'view', s3:'view', s4:'view', s5:'view', s6:'view', s10:'view', s7:'view', s8:'view', s9:'view' }; }
  function openCloudAdminModal() {
    Promise.all([window.CLCloud.listFactories(), window.CLCloud.listProfiles()]).then(function (res) {
      var facs = res[0] || [], profs = res[1] || [];
      var myFid = S.factory && S.factory.id;   // Super Admin: mọi xưởng · Factory Admin: chỉ xưởng mình
      var pane = h('div', {});
      var tabU = h('div', { class: 'cl-tab on' }, ['👤 Người dùng']);
      var tabF = h('div', { class: 'cl-tab' }, ['🏭 Xưởng']);
      var body = h('div', {});
      function setTab(w) { tabU.classList.toggle('on', w === 'u'); tabF.classList.toggle('on', w === 'f'); body.innerHTML = ''; body.appendChild(w === 'u' ? usersPane() : facsPane()); }
      tabU.onclick = function () { setTab('u'); }; tabF.onclick = function () { setTab('f'); };

      function roleOpts(sel) { var s = h('select', { class: 'cl-input', style: 'padding:3px 6px' }); (isSuper() ? ['user','factory_admin','super_admin'] : ['user','factory_admin']).forEach(function (r) { s.appendChild(h('option', { value: r }, [ROLE_LABEL[r] || r])); }); if (sel) s.value = sel; return s; }
      function facOpts(sel, blank) { var s = h('select', { class: 'cl-input', style: 'padding:3px 6px' }); if (blank) s.appendChild(h('option', { value: '' }, ['—'])); var list = isSuper() ? facs : facs.filter(function (f) { return f.id === myFid; }); list.forEach(function (f) { s.appendChild(h('option', { value: f.id }, [f.code + ' · ' + f.name])); }); if (sel && !isSuper() && sel !== myFid) sel = myFid; if (sel) s.value = sel; return s; }

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
          window.CLCloud.createUser({ email: e, password: p, display_name: nm.value.trim() || e, role: role, factory_id: fid, step_perms: (role === 'user' ? cloudDefaultUserPerms() : null) })
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
        // Factory Admin chỉ quản lý user xưởng mình VÀ KHÔNG thấy/không đụng được tài khoản super_admin
        // (chỉ super admin mới phân quyền/quản lý super admin).
        var visProfs = isSuper() ? profs : profs.filter(function (u) { return u.factory_id === myFid && u.role !== 'super_admin'; });
        var rows = visProfs.map(function (u) {
          var rs = roleOpts(u.role); rs.onchange = function () { window.CLCloud.updateProfile(u.id, { role: rs.value, step_perms: (rs.value === 'user' ? (u.step_perms || cloudDefaultUserPerms()) : null) }).then(function () { toast('Đã đổi vai trò ✓', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); };
          var fs = facOpts(u.factory_id || '', true); fs.onchange = function () { window.CLCloud.updateProfile(u.id, { factory_id: fs.value || null }).then(function () { toast('Đã đổi xưởng ✓', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); };
          var acts = [];
          acts.push(h('button', { class: 'cl-btn sm ghost', onclick: function () { editCloudPerms(u); } }, ['Phân quyền']));
          acts.push(h('button', { class: 'cl-btn sm ghost', style: 'margin-left:5px', title: 'Đặt mật khẩu mới trực tiếp (không cần email)', onclick: function () { var np = window.prompt('Đặt mật khẩu MỚI cho ' + u.email + ' (tối thiểu 6 ký tự):'); if (np == null) return; if (String(np).length < 6) return toast('Mật khẩu tối thiểu 6 ký tự', 'err'); window.CLCloud.adminSetPassword(u.id, np).then(function () { toast('Đã đổi mật khẩu ✓', 'ok'); openCloudAdminModal(); }).catch(function (e) { toast(e.message, 'err'); }); } }, ['Đổi MK']));
          acts.push(h('button', { class: 'cl-btn sm ghost', style: 'margin-left:5px', onclick: function () { window.CLCloud.updateProfile(u.id, { active: u.active === false }).then(function () { openCloudAdminModal(); }).catch(function (e) { toast(e.message, 'err'); }); } }, [u.active === false ? 'Mở' : 'Khóa']));
          if (can('user:delete') && u.id !== (S.user && S.user.id) && window.CLCloud && window.CLCloud.deleteUser) acts.push(h('button', { class: 'cl-btn sm danger', style: 'margin-left:5px', title: 'XÓA VĨNH VIỄN tài khoản (không hồi phục)', onclick: function () {
            if (!window.confirm('XÓA VĨNH VIỄN tài khoản:\n\n' + (u.email || '') + '\n\nHành động KHÔNG THỂ hoàn tác. Tiếp tục?')) return;
            var typed = window.prompt('Gõ đúng email để xác nhận XÓA:\n' + (u.email || ''));
            if (typed == null) return;
            if (String(typed).trim().toLowerCase() !== String(u.email || '').trim().toLowerCase()) return toast('Email xác nhận không khớp — đã hủy xóa', 'err');
            window.CLCloud.deleteUser(u.id).then(function () { toast('Đã xóa tài khoản ✓', 'ok'); openCloudAdminModal(); }).catch(function (e) { toast(e.message, 'err'); });
          } }, ['Xóa']));
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
    // Tự động mở bản lưu cuối của xưởng ngay khi đăng nhập (bộ nhớ máy trước, máy chủ sau).
    try { autoLoadLatest(); } catch (e) { console.warn('autoLoadLatest', e); }
    // …rồi cắt cử người canh: tài khoản khác lưu bản mới thì máy này tự biết mà lấy về.
    try { batDauCanh(); } catch (e) { console.warn('batDauCanh', e); }
    // ?cuu=1 → mở bảng "Quay về một mốc thời gian" (việc dùng một lần, không có nút trên thanh)
    try { if (/[?&]cuu=1/.test(location.search)) setTimeout(moKhoCuu, 1200); } catch (e) {}
  }

  /* ===== MỞ APP LÀ CÓ DỮ LIỆU NGAY (chốt 29/8 theo yêu cầu) =====
     User: "Khi mở app vẫn hiển thị 0, vài phút sau mới hiển thị cứu dữ liệu. Tôi muốn mở app
     ra là phải có dữ liệu."
     Đường cũ bắt buộc đi 3 vòng hỏi máy chủ mới thấy đơn (danh sách → chỉ mục → từng lô mảnh),
     hỏng một vòng là rơi xuống quét-gom-tất-cả cả trăm dòng ⇒ ngồi nhìn số 0 mấy phút.
     Đường mới:
       B1. Dựng lại bản lưu cuối TỪ BỘ NHỚ MÁY và mở NGAY — không hỏi mạng câu nào.
       B2. Xong mới lặng lẽ đối chiếu máy chủ ở nền; máy chủ có bản mới hơn thì mới tải về.
     Luật cũ giữ nguyên: không bao giờ nạp bản RỖNG đè lên dữ liệu đang mở. */
  var _dangMo = null;   // { id, t } — bản lưu đang mở trên màn hình
  /* ⚠ MỞ TẠM = đang xem một bản CHƯA ĐỦ mảnh. Lúc này cấm tự lưu, và bấm ☁ Lưu thì phải hỏi
     lại cho rõ — ghi đè bản thiếu lên máy chủ là mất đơn thật. Cờ chỉ được gỡ khi nạp được
     bản đủ (từ máy chủ, hoặc chính người dùng dựng lại từ mốc cũ). */
  var _moTam = false, _moTamThieu = 0;
  function datMoTam(bat, thieu) {
    _moTam = !!bat; _moTamThieu = thieu || 0;
    try {
      var el = document.getElementById('cl-motam');
      if (!bat) { if (el) el.remove(); return; }
      if (!el) {
        el = h('div', { id: 'cl-motam', style: 'position:fixed;left:14px;bottom:96px;z-index:99998;background:#B00020;' +
          'color:#fff;font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:10px;max-width:480px;' +
          'box-shadow:0 6px 20px rgba(0,0,0,.28);line-height:1.45' });
        document.body.appendChild(el);
      }
      el.textContent = '⚠ Đang xem bản TẠM — thiếu ' + _moTamThieu + ' mảnh trong máy. Tự lưu đã khoá để khỏi ghi đè mất đơn.';
    } catch (e) {}
  }
  function banMoiNhatTrongMay() {
    if (!(dungDamMay() && window.CLCloud.listCached)) return null;
    var list = window.CLCloud.listCached() || [];
    if (isSuper()) { var f = targetFactoryForWrite(); if (f) list = list.filter(function (d) { return d.factory_id === f; }); }
    list = list.filter(function (d) { return !d.kind || d.kind === 'orders'; })
               .sort(function (a, b) { return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); });
    return list[0] || null;
  }
  // force=true → bỏ qua bước mở nhanh, đi thẳng máy chủ (đổi xưởng / tab khác vừa ghi bản mới)
  function autoLoadLatest(force) {
    if (!can('dataset:read')) return;
    if (!force && window.__CLAPP && window.__CLAPP.hasData && window.__CLAPP.hasData()) return;
    /* ⭑ B1: BẢN MỞ NHANH trong IndexedDB — MỘT bản ghi, mở là có ngay, không hỏi mạng, không
       phụ thuộc mấy chục mảnh rời, không sợ localStorage tràn (5MB không đủ cho kho kèm ảnh —
       đây chính là lý do mấy lần trước mở app vẫn trắng rồi mới cập nhật sau). */
    var bmn = (!force && dungDamMay() && window.CLCloud.docMoNhanh)
      ? window.CLCloud.docMoNhanh().catch(function () { return null; }) : Promise.resolve(null);
    return bmn.then(function (bm) {
      if (bm && bm.payload && window.__CLAPP && window.__CLAPP.loadData) {
        window.__CLAPP.loadData(bm.payload);
        datMoTam(false, 0);
        if (bm.id) _dangMo = { id: bm.id, t: String(bm.sv || '') };
        toast('Đã mở bản lưu trong máy: ' + bm.soFile + ' file · ' + bm.soDong + ' dòng ✓', 'ok');
        soTuNhan(bm.payload);            // nhớ mục tiêu ngay, kẻo nhãn rơi mất ở lần sau
        return doiChieuMayChu(true);
      }
      return moTuManh(force);
    });
  }
  // B2 (chỉ dùng khi chưa có bản mở nhanh): ghép lại từ mảnh rời trong localStorage
  function moTuManh(force) {
    var cuc = force ? null : banMoiNhatTrongMay();
    var nhanh = (cuc && dungDamMay() && window.CLCloud.napNhanh)
      ? window.CLCloud.napNhanh(cuc.id).catch(function () { return null; })
      : Promise.resolve(null);
    return nhanh.then(function (d) {
      var daMo = false;
      var pl = d && d.payload;
      if (pl && (pl.orders || []).length && window.__CLAPP && window.__CLAPP.loadData) {
        window.__CLAPP.loadData(pl);
        _dangMo = { id: cuc.id, t: String(cuc.updated_at || '') };
        daMo = true;
        var soDon = window.__CLAPP.maDonDangCo ? Object.keys(window.__CLAPP.maDonDangCo()).length : 0;
        if (d.__du === false) {
          /* Mở TẠM: trong máy còn thiếu mảnh. Nói thẳng, và KHOÁ tự lưu lại — bản thiếu mà ghi
             đè lên máy chủ là mất đơn thật (đúng vết xe đổ 28/8). */
          datMoTam(true, d.__thieu);
          toast('Đang mở TẠM ' + soDon + ' đơn từ bộ nhớ máy — còn thiếu ' + d.__thieu +
                ' mảnh, đang lấy nốt. Tự lưu đã TẠM KHOÁ.', 'err');
        } else {
          datMoTam(false, 0);
          ghiMoNhanh(pl, { id: cuc.id, sv: String(cuc.updated_at || ''), nguon: 'mảnh trong máy' });
          soTuNhan(pl);
          toast('Đã mở bản lưu cuối (' + soDon + ' đơn) ✓', 'ok');
        }
      }
      return doiChieuMayChu(daMo);
    });
  }
  // Đối chiếu với máy chủ: chỉ tải lại khi máy chủ thật sự có bản MỚI HƠN cái đang mở.
  function doiChieuMayChu(daMo) {
    var q = isSuper() ? ('?factoryId=' + (targetFactoryForWrite() || '')) : '';
    var getList = (dungDamMay()) ? window.CLCloud.pull() : api('GET', '/api/datasets' + q);
    return Promise.resolve(getList).then(function (list) {
      list = list || [];
      // Super admin (đám mây): pull() trả tất cả xưởng (theo RLS) → lọc theo XƯỞNG đang chọn để xem đúng.
      if (isSuper() && S.cloud) { var fid = targetFactoryForWrite(); if (fid) list = list.filter(function (d) { return d.factory_id === fid; }); }
      /* Không thấy bản lưu nào MÀ app cũng đang trắng → vẫn phải đi gom cứu. Trước đây thoát
         luôn ở đây, nên có cảnh: dữ liệu còn đủ trên máy chủ mà app ngồi im, không ai cứu. */
      if (!list.length) { if (!daMo) thuCuuTuMay(); return; }
      var latest = list[0];                            // bản mới nhất ở đầu
      if (daMo && _dangMo && latest.id === _dangMo.id && String(latest.updated_at || '') <= _dangMo.t) {
        /* Máy chủ không có gì mới → khỏi tải lại. NHƯNG vẫn phải soi xem bản đang mở có thiếu
           file so với nhãn không (bản trước bỏ sót đúng nhánh này: mở từ bản mở nhanh xong là
           thoát, tự vá không bao giờ chạy). */
        try { tuVaTheoNhan(window.__CLAPP.getState()); } catch (e) {}
        return;
      }
      // fetchGoi = đọc được cả bản lưu CHIA MẢNH lẫn bản lưu nguyên khối kiểu cũ
      var getOne = (dungDamMay()) ? (window.CLCloud.fetchGoi || window.CLCloud.fetchOne)(latest.id) : api('GET', '/api/datasets/' + latest.id);
      return Promise.resolve(getOne).then(function (d) {
        if (!(window.__CLAPP && window.__CLAPP.loadData)) return;
        /* ⚠ KHÔNG BAO GIỜ nạp một bản RỖNG đè lên dữ liệu đang mở (sự cố 28/8: nạp hụt 1 lần
           là màn hình trắng trơn, rồi lần tự lưu kế tiếp ghi đè luôn bản tốt trên máy chủ). */
        var pl = (d && d.payload) || null;
        if (!pl || (!(pl.orders || []).length && !(pl.files || []).length)) {
          if (window.__CLAPP.hasData && window.__CLAPP.hasData())
            toast('Bản lưu trên máy chủ đọc ra rỗng — GIỮ NGUYÊN dữ liệu đang mở, không nạp đè.', 'err');
          return;
        }
        window.__CLAPP.loadData(pl);
        _dangMo = { id: latest.id, t: String(latest.updated_at || '') };
        datMoTam(false, 0);                // lấy được bản đủ từ máy chủ → mở khoá tự lưu
        ghiMoNhanh(pl, { id: latest.id, sv: String(latest.updated_at || ''), nguon: 'máy chủ' });
        var soDon = window.__CLAPP.maDonDangCo ? Object.keys(window.__CLAPP.maDonDangCo()).length : 0;
        toast('Đã nạp bản lưu cuối từ máy chủ (' + soDon + ' đơn) ✓', 'ok');
        if (d.__va) suaVaDon(d.__va);      // phải vá mới mở được ⇒ ghi lại bản LÀNH (nhưng KHÔNG xoá gì)
        tuVaTheoNhan(pl);                  // nhãn nói 66 file mà chỉ có 55 ⇒ tự đi lấy lại, không hỏi
      });
    }).catch(function (e) {
      // Trước đây nuốt lỗi im lặng → app hiện màn trống mà không ai biết vì sao
      if (!daMo) { if (e && e.message) toast(e.message, 'err'); thuCuuTuMay(); return; }
      // đã có dữ liệu trên màn hình rồi thì đừng doạ, chỉ nói cho biết
      toast('Không hỏi được máy chủ — đang xem bản lưu trong máy.', 'ok');
    });
  }

  /* ===== NGƯỜI CANH BẢN MỚI (thêm 3/9) =====
     User: "Các tài khoản khác chưa cập nhật được phiên bản lưu mới nhất."
     Lý do của bản cũ: app CHỈ đi hỏi máy chủ đúng một lần — lúc mở trang. Sau đó ai lưu gì
     cũng mặc kệ, trừ khi hai tab nằm CÙNG một trình duyệt (sự kiện 'storage' chỉ chạy trong
     cùng một máy). Nên hoan.nm lưu 66 đơn ở máy này, còn tab của ketoan.nd bên máy kia đã mở
     từ sáng thì cứ nằm im với 10 đơn cũ — không sai chỗ nào, chỉ là chẳng ai đi hỏi lại.
     Nay cứ 25 giây (và mỗi lần quay lại tab / có mạng trở lại) hỏi máy chủ đúng MỘT dòng nhẹ:
     ô lưu của xưởng đổi lúc nào, ai ghi.
       · người khác vừa ghi, mình KHÔNG có sửa dở  → tự nạp bản mới, báo một dải xanh.
       · mình đang sửa dở / đang gõ trong ô        → KHÔNG giật màn hình, chỉ hiện dải cam có
                                                     nút "Lấy bản mới" để người dùng tự chọn.
       · bản trên máy chủ ÍT đơn hơn bản đang mở   → cũng chỉ hiện dải cam, không tự nuốt. */
  var _canhT = null;          // đồng hồ canh
  var _choLuu = false;        // có thay đổi chưa lưu xong
  var _banMoiT = null;        // mốc bản mới đang chờ người dùng lấy
  var _luuLucNao = 0;         // lúc MÁY NÀY ghi lên máy chủ lần gần nhất
  var _vaLuc = 0;             // lúc thử tự lấy lại bản đủ gần nhất
  var _soCanh = 0;            // đếm số lượt canh (để chẩn đoán)
  var _daNhacXuong = false;   // đã nhắc "chưa xác định được Xưởng" một lần
  var CANH_GIAY = 15;      // 3/9 lần 3: 25s → 15s cho "tự cập nhật" thấy nhanh hơn (chỉ 1 dòng nhẹ)
  var _loiCanh = '';          // câu lỗi gần nhất khi hỏi máy chủ (rỗng = đang đọc được)
  var _soLoiCanh = 0;         // số lượt hỏi hỏng LIỀN NHAU
  var _daChuaMu = 0;          // lúc tự chữa "mù với máy chủ" gần nhất

  /* ===== MÙ VỚI MÁY CHỦ → TỰ CHỮA (thêm 3/9 lần 3) =====
     Đo trên máy user 3/9: localStorage có 471 ô `clc_ds_` (~2MB) và KHÔNG có ô `sb-…-auth-token`
     nào — tức Supabase không ghi nổi khoá phiên, máy đó đăng nhập xong vẫn MÙ với máy chủ: mọi
     lệnh đọc trả về rỗng, app nằm mãi với bản cũ trong máy (đúng dải nâu "Đã dò 0 lần lưu").
     Trước đây mocMayChu() nuốt lỗi im lặng nên không ai biết. Nay hỏng 3 lượt liền mà máy VẪN
     CÓ MẠNG thì: dọn cache mảnh để chừa chỗ (mảnh lấy lại được từ máy chủ) → xin lại hồ sơ/phiên
     → thử mở lại bản mới nhất. Tối đa 5 phút một lần cho khỏi quần máy. */
  function khongDocDuocMayChu(loi) {
    _loiCanh = String(loi || 'không rõ'); _soLoiCanh++;
    try { console.warn('[CL] hỏi máy chủ hỏng (' + _soLoiCanh + ' lượt liền): ' + _loiCanh); } catch (_) {}
    if (_soLoiCanh < 3) return;
    try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return; } catch (_) {}
    if (Date.now() - _daChuaMu < 300000) return;
    _daChuaMu = Date.now();
    try { window.__CLAPP.ghiNhatKy('Không đọc được máy chủ (' + _loiCanh + ') — đang tự chữa phiên.'); } catch (_) {}
    toast('Không đọc được máy chủ (' + _loiCanh + ') — đang tự chữa để lấy dữ liệu mới…', 'err');
    try { if (window.CLCloud.donChoTrong) window.CLCloud.donChoTrong(); } catch (_) {}
    var xin = null;
    try { if (window.CLCloud.refreshProfile) xin = window.CLCloud.refreshProfile(); } catch (_) {}
    Promise.resolve(xin).catch(function () { return null; }).then(function () {
      try { autoLoadLatest(true); } catch (_) {}
    });
  }

  /* ⚠ SỬA 3/9 lần 3 — vì sao "tài khoản khác không tự cập nhật":
     Bản cũ coi "con trỏ đang nằm trong một ô nhập" là ĐANG SỬA DỞ nên KHÔNG nạp bản mới. Chỉ cần
     ai đó bấm vào ô "Tìm bảng Box" rồi để đấy là tab đó nằm im mãi với bản cũ — không sai chỗ nào,
     chỉ là bị chắn vĩnh viễn. Nay chỉ chắn khi thực sự CÒN ĐANG GÕ: có bấm phím trong 60 giây gần
     đây. Hết 60 giây không gõ gì thì coi như xong, app tự nạp.
     (Vẫn giữ hàng rào _choLuu — có sửa chưa lưu xong thì tuyệt đối không nạp đè.) */
  var _goPhimLuc = 0;
  try {
    document.addEventListener('keydown', function () { _goPhimLuc = Date.now(); }, true);
    document.addEventListener('paste', function () { _goPhimLuc = Date.now(); }, true);
  } catch (_) {}
  function dangGoTrongO() {
    try {
      var e = document.activeElement;
      if (!e) return false;
      var t = String(e.tagName || '').toUpperCase();
      var trongO = e.isContentEditable || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
      if (!trongO) return false;
      return (Date.now() - _goPhimLuc) < 60000;
    } catch (_) { return false; }
  }
  function anBangBanMoi() {
    _banMoiT = null;
    try { var el = document.getElementById('cl-banmoi'); if (el) el.remove(); } catch (_) {}
  }
  /* ⚠ ĐÃ BỎ DẢI CAM CÓ NÚT "⟳ Lấy bản mới" ở góc dưới bên trái (sửa 3/9 lần 3).
     User chốt: "Tất cả các tài khoản tự động cập nhật dữ liệu mới nhất" — nghĩa là KHÔNG bắt ai
     bấm nút nào nữa. Nay chỉ GHI NHỚ mốc đang chờ; người canh chạy 15 giây một lượt nên hễ hết
     việc chắn (lưu xong / thôi sửa dở) là nó TỰ NẠP ở lượt kế tiếp.
     Vẫn nhắc bằng lời nhắc 3 giây nhưng 3 phút một lần cho khỏi ồn — user cần biết máy chủ có
     bản mới mà mình đang sửa dở nên app chưa dám nạp đè. KHÔNG nuốt im lặng. */
  var _nhacBanMoi = 0;
  function hienBangBanMoi(t, lyDo) {
    _banMoiT = t;
    try {
      var el = document.getElementById('cl-banmoi'); if (el) el.remove();
      var s = String(lyDo || 'Có bản lưu MỚI HƠN trên máy chủ.');
      try { console.log('[CL] chờ nạp bản mới: ' + s); } catch (_) {}
      if (Date.now() - _nhacBanMoi > 180000) {
        _nhacBanMoi = Date.now();
        toast(s + ' App sẽ TỰ NẠP ngay khi bạn xong.', 'err');
      }
    } catch (_) {}
  }
  /* Nạp bản mới từ máy chủ đè lên màn hình. epTay=true nghĩa là người dùng đã tự bấm nút,
     lúc đó không cần cân nhắc gì nữa. Luật cũ vẫn giữ: KHÔNG BAO GIỜ nạp bản rỗng. */
  function layBanMoi(id, t, epTay) {
    if (!id || !(dungDamMay())) return;
    var getOne = (window.CLCloud.fetchGoi || window.CLCloud.fetchOne)(id);
    return Promise.resolve(getOne).then(function (d) {
      var pl = (d && d.payload) || null;
      if (!pl || (!(pl.orders || []).length && !(pl.files || []).length)) return;
      var cu = ((window.__CLAPP.getState() || {}).orders || []).length;
      var moi = (pl.orders || []).length;
      if (!epTay && cu > 0 && moi < cu) {
        hienBangBanMoi(t, 'Máy chủ có bản mới hơn nhưng ÍT đơn hơn bản đang mở (' + moi +
          ' dòng so với ' + cu + ' dòng) — không tự nạp đè.');
        return;
      }
      window.__CLAPP.loadData(pl);
      _dangMo = { id: id, t: String(t || '') };
      _choLuu = false;
      datMoTam(false, 0);
      ghiMoNhanh(pl, { id: id, sv: String(t || ''), nguon: 'máy chủ · bản mới' });
      soTuNhan(pl);
      anBangBanMoi();
      var soDon = window.__CLAPP.maDonDangCo ? Object.keys(window.__CLAPP.maDonDangCo()).length : 0;
      bangKetQua('⟳ Vừa nhận bản lưu MỚI từ máy chủ lúc ' + new Date().toLocaleTimeString('vi-VN') +
                 ' — ' + (pl.files || []).length + ' file · ' + moi + ' dòng · ' + soDon +
                 ' đơn. (bấm để đóng)', 'xanh');
    }).catch(function () {});
  }
  /* Màn hình đang THIẾU so với nhãn của lần Xử lý gần nhất ("💾 66 file · 1778 dòng")?
     Đây là cách duy nhất app tự biết mình đang cầm bản hụt mà không cần ai bấm gì. */
  function thieuSoVoiMucTieu() {
    try {
      if (!(window.__CLAPP && window.__CLAPP.getState)) return null;
      var st = window.__CLAPP.getState(); if (!st) return null;
      var can = soTuNhan(st); if (!can) return null;
      var coF = (st.files || []).length, coD = (st.orders || []).length;
      if (coF >= can.file && coD >= can.dong) return null;
      return { coF: coF, coD: coD, canF: can.file, canD: can.dong };
    } catch (e) { return null; }
  }
  function canhBanMoi() {
    _soCanh++;
    try {
      /* ⚠ dungDamMay() chứ KHÔNG phải cờ S.cloud (bài học 3/9, tu-cap-nhat-khi-co-ban-moi):
         cờ đó chỉ bật trong startCloudSession, mất cờ là người canh nằm im vĩnh viễn. */
      if (!S.token || !dungDamMay() || !window.CLCloud || !window.CLCloud.mocMayChu) return;
      if (!can('dataset:read')) return;
      var id = autoSaveId();
      if (!id) {                       // hồ sơ đọc hỏng ⇒ mất factory_id ⇒ không biết ô lưu nào
        if (!_daNhacXuong) { _daNhacXuong = true;
          toast('Tài khoản chưa xác định được Xưởng — chưa lấy được dữ liệu từ máy chủ. Tải lại trang (Ctrl+F5).', 'err'); }
        return;
      }
      /* CHƯA MỞ ĐƯỢC GÌ (mất mạng đúng lúc mở, máy chủ chập một nhịp…) → thử mở lại cho tử tế.
         ⚠ Việc này làm KỂ CẢ KHI TAB ĐANG ẨN: màn hình trắng thì phải lấp cho đầy, không đợi
         người dùng bấm sang tab mới chịu đi lấy. */
      if (!_dangMo || _dangMo.id !== id) {
        if (!(window.__CLAPP && window.__CLAPP.hasData && window.__CLAPP.hasData())) {
          try { autoLoadLatest(true); } catch (_) {}
        }
        return;
      }
      /* ⚠ SỬA 3/9 lần 3: TAB ẨN VẪN HỎI. Bản cũ bỏ lượt khi tab ẩn để đỡ đường truyền, nhưng
         xưởng mở app rồi chuyển sang tab khác cả buổi ⇒ đúng lúc cần thì vẫn là bản cũ, người
         dùng quay lại phải đợi. Một dòng `select id,updated_at,created_by` là vài trăm byte —
         rẻ hơn nhiều so với việc ngồi nhìn số liệu sai. */
      return window.CLCloud.mocMayChu(id).then(function (r) {
        /* KHÔNG NUỐT LỖI: mocMayChu nay trả { loi: … } khi đọc hỏng, phân biệt được với
           "máy chủ không có gì mới". Hỏng 3 lượt liền mà máy vẫn có mạng thì tự chữa. */
        if (!r || !r.updated_at) { khongDocDuocMayChu(r && r.loi); return; }
        _loiCanh = ''; _soLoiCanh = 0;
        var t = String(r.updated_at);
        if (t <= String(_dangMo.t || '')) {
          /* Máy chủ không có gì mới. NHƯNG nếu màn hình đang hụt so với nhãn thì phải tự đi lấy
             lại — không ngồi im. Đây chính là cảnh "tài khoản khác không cập nhật được": bản
             trong máy 10 file, nhãn nói 66 file, mà mốc thời gian thì không mới hơn. */
          var th = thieuSoVoiMucTieu();
          if (!th) { anBangBanMoi(); return; }
          if (_choLuu || _moTam || dangGoTrongO()) return;
          if (Date.now() - _vaLuc < 180000) return;         // 3 phút thử lại một lần, khỏi nặng máy
          _vaLuc = Date.now(); _daTuVa = false;             // cho phép tự vá thử lại
          toast('Đang thiếu ' + th.coF + '/' + th.canF + ' file — app tự lấy lại từ máy chủ…', 'ok');
          try { tuVaTheoNhan(window.__CLAPP.getState()); } catch (e) {}
          return;
        }
        /* CHÍNH MÁY NÀY vừa ghi (tự lưu / ☁ Lưu) → chỉ dời mốc, tuyệt đối không nạp lại,
           kẻo cứ mỗi lần sửa một ô là màn hình bị nạp đè một lần.
           ⚠ Phải xét CẢ "mình vừa lưu cách đây mấy giây", không chỉ xét created_by: cùng một
           người mở app trên hai máy vẫn phải thấy bản của nhau, nếu chỉ so tên người ghi thì
           máy thứ hai sẽ nằm im mãi — đúng cái lỗi đang phải sửa. */
        var toi = (window.CLCloud.getProfile() || {}).id;
        var vuaTuLuu = _luuLucNao && (Date.now() - _luuLucNao) < 120000;
        if (vuaTuLuu && toi && r.created_by && r.created_by === toi) { _dangMo.t = t; anBangBanMoi(); return; }
        if (_choLuu || _moTam || dangGoTrongO()) {
          /* Chỉ HOÃN, không bỏ: _dangMo.t vẫn là mốc cũ nên 15 giây nữa người canh lại thấy
             "máy chủ mới hơn" và thử lại — hết việc chắn là tự nạp, không cần ai bấm nút. */
          hienBangBanMoi(t, 'Tài khoản khác vừa lưu bản mới hơn — bạn đang sửa dở nên chưa nạp đè.');
          return;
        }
        return layBanMoi(id, t, false);
      });
    } catch (_) {}
  }
  function batDauCanh() {
    if (_canhT) return;
    _canhT = setInterval(canhBanMoi, CANH_GIAY * 1000);
    setTimeout(canhBanMoi, 8000);
    try {
      document.addEventListener('visibilitychange', function () { if (!document.hidden) canhBanMoi(); });
      window.addEventListener('online', function () { setTimeout(canhBanMoi, 1500); });
      window.addEventListener('focus', function () { canhBanMoi(); });
    } catch (_) {}
  }
  function dungCanh() { if (_canhT) { clearInterval(_canhT); _canhT = null; } anBangBanMoi(); }
  /* Bảng chẩn đoán một phát ra hết — lần sau khỏi phải mò từng thứ trên máy người dùng.
     Gõ __CHANDOAN() trong Console là thấy: ai đang đăng nhập, ô lưu nào, màn hình có gì,
     nhãn mục tiêu bao nhiêu, đang thiếu bao nhiêu, người canh có chạy không. */
  window.__CHANDOAN = function () {
    var st = null; try { st = window.__CLAPP.getState(); } catch (e) {}
    var hoSo = null; try { hoSo = window.CLCloud.getProfile(); } catch (e) {}
    return {
      build: (document.getElementById('build-tag') || {}).textContent,
      taiKhoan: hoSo && { email: hoSo.email, id: hoSo.id, role: hoSo.role, xuong: hoSo.factory_id },
      quyen: S.perms, oLuu: autoSaveId(), dangMo: _dangMo,
      manHinh: st && { file: (st.files || []).length, dong: (st.orders || []).length, nhan: st.source },
      mucTieu: (function () { try { return JSON.parse(localStorage.getItem(khoaMucTieu()) || 'null'); } catch (e) { return null; } })(),
      thieu: thieuSoVoiMucTieu(),
      boNhoMay: (function () { try { return Math.round(window.CLCloud.dungLuongMay() / 1024) + ' KB'; } catch (e) { return null; } })(),
      choLuu: _choLuu, moTam: _moTam, luuLucNao: _luuLucNao, vaLuc: _vaLuc,
      dangCanh: !!_canhT, soLuotCanh: _soCanh, tabAn: !!document.hidden,
      loiCanh: _loiCanh, soLoiCanhLienTiep: _soLoiCanh, chuaMuLuc: _daChuaMu,
      cauCuoi: _cauCuoi,
      banMoiChoNap: _banMoiT || ''
    };
  };
  /* ⚠ ĐÃ BỎ DẢI GÓC DƯỚI BÊN TRÁI (sửa 3/9 lần 3 — user: "Bỏ phần thông báo góc trái màn hình đi").
     Trước đây đây là dải NẰM LẠI ở góc dưới bên trái (#cl-ketqua): nó che mất chữ
     "↩ Quay về mốc lưu trước" và nằm mãi trên màn hình cho tới khi bấm. Nay KHÔNG vẽ gì nữa.
     ⚠⚠ Nhưng KHÔNG ĐƯỢC NUỐT LỖI (luật su-co-mat-du-lieu-28-8) — mọi câu vẫn ra đủ 4 chỗ:
       · lời nhắc 3 giây (toast) ở giữa dưới — chỗ user không phàn nàn
       · NHẬT KÝ của app (window.__CLAPP.ghiNhatKy) — đọc lại được sau
       · Console
       · _cauCuoi để __CHANDOAN() còn soi được câu gần nhất */
  var _cauCuoi = '';
  function bangKetQua(chu, mau) {
    try {
      var s = String(chu || '').replace(/\s*\(bấm để đóng\)\s*$/, '');
      _cauCuoi = new Date().toLocaleTimeString('vi-VN') + ' — ' + s;
      try { var cu = document.getElementById('cl-ketqua'); if (cu) cu.remove(); } catch (_) {}
      try { console.log('[CL] ' + s); } catch (_) {}
      try { window.__CLAPP.ghiNhatKy(s); } catch (_) {}
      toast(s, mau === 'xanh' ? 'ok' : 'err');
    } catch (e) {}
  }
  // Ghi BẢN MỞ NHANH vào IndexedDB — lần mở sau chỉ đọc đúng một bản ghi này là có dữ liệu
  function ghiMoNhanh(pl, meta) {
    try { if (window.CLCloud && window.CLCloud.luuMoNhanh) window.CLCloud.luuMoNhanh(pl, meta || {}); } catch (e) {}
  }
  /* ===== TỰ LẤY LẠI BẢN ĐỦ, KHÔNG BẮT NGƯỜI DÙNG CHỌN MỐC (thêm 29/8) =====
     User: "Không cần tôi chọn mốc. Luôn lấy dữ liệu lần cập nhật dùng được."
     Chính bản lưu mang sẵn nhãn của lần Xử lý gần nhất — vd "💾 66 file · 1778 dòng" (state.source,
     dựng ở chỗ đặt state.source lúc bấm Xử lý). Số file THỰC TẾ ít hơn nhãn nghĩa là bản lưu đã
     rụng mất đơn. Lúc đó app tự dò ngược từng mốc lưu, dựng lại, và CHỈ NHẬN khi ra ĐÚNG con số
     của nhãn — sai một con là bỏ, không đoán mò. Mỗi phiên làm một lần. */
  var _daTuVa = false;
  /* MỤC TIÊU = con số của lần Xử lý gần nhất, vd "💾 66 file · 1778 dòng" (state.source).
     ⚠ Phải NHỚ RA NGOÀI: dựng lại từ mảnh rời thì mất phần chung ⇒ mất luôn nhãn ⇒ lần sau
     hết đường tự kiểm. Nên thấy nhãn một lần là ghi vào máy, sau đó cứ theo đó mà soi. */
  function khoaMucTieu() { return 'cl_muctieu_' + ((S.factory && S.factory.id) || 'none'); }
  function soTuNhan(pl) {
    var m = String(pl && pl.source || '').match(/(\d+)\s*file\s*·\s*(\d+)\s*dòng/);
    if (m) {
      var c = { file: +m[1], dong: +m[2] };
      try {
        var cu = JSON.parse(localStorage.getItem(khoaMucTieu()) || 'null');
        if (!cu || c.file > cu.file || (c.file === cu.file && c.dong > cu.dong))
          localStorage.setItem(khoaMucTieu(), JSON.stringify(c));
      } catch (e) {}
      return c;
    }
    try { return JSON.parse(localStorage.getItem(khoaMucTieu()) || 'null'); } catch (e) { return null; }
  }
  /* ===== TỰ LẤY LẠI BẢN ĐỦ NHẤT CÓ THỂ (sửa 29/8 lần 2) =====
     Bản trước đòi khớp CHÍNH XÁC cả hai con số, không khớp thì bỏ hết — hụt đúng một mảnh là
     người dùng vẫn ngồi với bản thiếu. Nay: dựng thử từng mốc, GIỮ CÁI NHIỀU FILE NHẤT (không
     vượt quá mục tiêu), miễn là hơn cái đang mở thì lấy. Trúng đúng mục tiêu thì dừng luôn.
     Và LUÔN nói ra con số tìm được — không im lặng bỏ cuộc. */
  var _daTuVa = false;
  /* Ghi bản vừa lấy lại lên máy chủ + vào bản mở nhanh, rồi báo bằng DẢI nằm lại trên đầu trang */
  function chotBanDaVa(can, ghiChu) {
    var st = window.__CLAPP.getState();
    var coF = (st.files || []).length, coD = (st.orders || []).length;
    var du = coF >= can.file && coD >= can.dong;
    datMoTam(false, 0);
    ghiMoNhanh(st, { nguon: ghiChu });
    bangKetQua((du ? '✓ Đã tự lấy lại ĐỦ: ' : '⚠ Đã lấy lại được nhiều nhất: ') +
               coF + '/' + can.file + ' file · ' + coD + '/' + can.dong + ' dòng — ' + ghiChu +
               (du ? '. Đang ghi lên máy chủ…' : '. Kho lưu trữ chỉ còn bấy nhiêu.') + ' (bấm để đóng)',
               du ? 'xanh' : '');
    try { window.__CLAPP.ghiNhatKy('Tự lấy lại: ' + coF + '/' + can.file + ' file · ' + coD + '/' + can.dong + ' dòng — ' + ghiChu); } catch (e) {}
    if (duocGhiXuong() && window.CLCloud.saveGoi && window.__CLAPP.chiaLuu) {
      var sid = autoSaveId();
      if (sid) window.CLCloud.saveGoi({ id: sid, name: tenBanLuu(), goi: window.__CLAPP.chiaLuu() })
        .then(function () {
          /* Bản này do CHÍNH máy này vừa ghi → đóng dấu giờ để người canh bản mới khỏi tưởng
             người khác lưu rồi nạp lại, xoá mất đúng dải báo kết quả người dùng cần đọc. */
          _choLuu = false; _luuLucNao = Date.now(); anBangBanMoi();
          bangKetQua('✓ Đã lấy lại ' + coF + '/' + can.file + ' file · ' + coD + '/' + can.dong +
                     ' dòng và GHI LÊN MÁY CHỦ lúc ' + new Date().toLocaleTimeString('vi-VN') +
                     '. Mọi tài khoản trong xưởng sẽ thấy bản này. (bấm để đóng)', du ? 'xanh' : '');
        })
        .catch(function (e) { bangKetQua('✗ Lấy lại được nhưng GHI LÊN MÁY CHỦ HỎNG: ' + (e && e.message || e)); });
    }
  }
  /* ⭑ B1 — THÊM ĐƠN MỒ CÔI CÒN SÓT TRÊN MÁY CHỦ (đường chính, sửa 3/9).
     Đây là đường đã CHỨNG MINH chạy được trên dữ liệu thật: ảnh user gửi 3/9 cho thấy nó tìm ra
     đúng 12 mã đơn còn thiếu — C5-773P.1 · K47-772P · K21-796P.1 · CS596-765P · C127-766P.1 ·
     C41-775P · CS525-741P · LS25-262S · C213-797P · CS209-760P · K133-776P · CS490-778P (384 dòng)
     → 54+12 = 66 đơn, 1394+384 = 1778 dòng, khớp đúng nhãn.
     Bản trước tôi bỏ đường này đi vì sợ lôi đơn đợt cũ về. Nay giữ lại nhưng CÓ CHỐT: chỉ thêm
     khi cộng vào KHÔNG VƯỢT con số của nhãn. Và KHÔNG hỏi — user đã chốt "không cần tôi chọn". */
  function themDonMoCoi(plSot, can, coD) {
    if (!plSot || !(plSot.orders || []).length) return false;
    var daCo = window.__CLAPP.maDonDangCo();
    var mdThem = {}, dongThem = 0;
    (plSot.orders || []).forEach(function (o) {
      var m = String((o && o.maDon) || '');
      if (daCo[m]) return;
      mdThem[m] = 1; dongThem++;
    });
    var ds = Object.keys(mdThem);
    if (!ds.length) return false;
    if (coD + dongThem > can.dong) {
      bangKetQua('Kho còn ' + ds.length + ' đơn nữa (' + dongThem + ' dòng) nhưng thêm vào sẽ VƯỢT ' +
                 'mục tiêu ' + can.file + ' file · ' + can.dong + ' dòng nên CHƯA thêm — mấy đơn đó: ' +
                 ds.slice(0, 20).join(' · ') + (ds.length > 20 ? ' …' : '') +
                 '. Muốn xem thì bấm "↩ Quay về mốc lưu trước" ở góc dưới trái. (bấm để đóng)');
      return true;
    }
    var n = window.__CLAPP.themDonConSot(plSot);
    if (!n) return false;
    chotBanDaVa(can, 'thêm ' + ds.length + ' đơn còn sót trên máy chủ');
    return true;
  }
  function tuVaTheoNhan(pl) {
    try {
      if (_daTuVa) return;
      var can = soTuNhan(pl); if (!can) return;
      var coF = (pl.files || []).length, coD = (pl.orders || []).length;
      if (coF >= can.file && coD >= can.dong) return;              // không thiếu gì
      if (!(window.CLCloud && window.__CLAPP)) return;
      _daTuVa = true;
      toast('Bản lưu đang thiếu (' + coF + '/' + can.file + ' file) — đang tự tìm lại…', 'err');
      var b1 = (window.CLCloud.timDonConSot && window.__CLAPP.maDonDangCo && window.__CLAPP.themDonConSot)
        ? window.CLCloud.timDonConSot(window.__CLAPP.maDonDangCo()).catch(function () { return null; })
        : Promise.resolve(null);
      b1.then(function (plSot) {
        if (themDonMoCoi(plSot, can, coD)) return;                 // xong ở B1
        return doMocCu(pl, can, coF, coD);                         // B2: dò từng mốc lưu
      }).catch(function () {});
    } catch (e) {}
  }
  /* B2 — DỰ PHÒNG: dò ngược từng mốc lưu, giữ cái nhiều file nhất (không vượt mục tiêu). */
  function doMocCu(pl, can, coF, coD) {
    if (!(window.CLCloud.dsKho && window.CLCloud.dungLaiToiMoc)) return;
    return window.CLCloud.dsKho().then(function (kho) {
      var thay = {};
      kho.server.concat(kho.may).forEach(function (d) { if (d && d.id && !thay[d.id]) thay[d.id] = d; });
      var ph = {};
      Object.keys(thay).forEach(function (k) {
        var d = thay[k]; if (d.kind !== 'orders-manh') return;
        var t = String(d.updated_at || ''); if (!t) return;
        var p2 = t.slice(0, 16); if (!ph[p2] || t > ph[p2]) ph[p2] = t;
      });
      var mocs = Object.keys(ph).sort().reverse().map(function (k) { return ph[k]; }).slice(0, 12);
      var i = 0, tot = null, daThu = [];
      function thu() {
        if (i >= mocs.length) return xong();
        var T = new Date(new Date(mocs[i]).getTime() + 30000).toISOString(); i++;
        return window.CLCloud.dungLaiToiMoc(T).then(function (r) {
          var bc = (r && r.bc) || {};
          if (r && r.payload) {
            daThu.push(gioVN(T) + ' → ' + bc.file + 'f/' + bc.dong + 'd');
            var hopLe = bc.file <= can.file && bc.dong <= can.dong;
            var honCaiCu = bc.file > coF || (bc.file === coF && bc.dong > coD);
            var honCaiTot = !tot || bc.file > tot.bc.file || (bc.file === tot.bc.file && bc.dong > tot.bc.dong);
            if (hopLe && honCaiCu && honCaiTot) tot = { r: r, bc: bc, T: T };
            if (tot && tot.bc.file === can.file && tot.bc.dong === can.dong) return xong();
          }
          return thu();
        }).catch(function () { return thu(); });
      }
      function xong() {
        try { console.log('[CL] tự vá — mục tiêu ' + can.file + 'f/' + can.dong + 'd · đã thử: ' + daThu.join(' | ')); } catch (e) {}
        if (!tot) {
          bangKetQua('Kho lưu trữ không còn bản nào đủ hơn: đang mở ' + coF + '/' + can.file + ' file · ' +
                     coD + '/' + can.dong + ' dòng. Đã dò ' + daThu.length + ' lần lưu' +
                     (daThu.length ? (': ' + daThu.join(' · ')) : ' (không thấy lần lưu nào — kiểm tra mạng)') +
                     ' (bấm để đóng)');
          return;
        }
        tot.r.payload.source = pl.source || ('💾 ' + can.file + ' file · ' + can.dong + ' dòng');
        window.__CLAPP.loadData(tot.r.payload);
        chotBanDaVa(can, 'quay về mốc ' + gioVN(tot.T));
      }
      return thu();
    }).catch(function () {});
  }
  /* ===== VÁ XONG THÌ GHI LẠI BẢN LÀNH RỒI DỌN RÁC (thêm 29/8) =====
     Mở được nhờ vá nghĩa là bản lưu trên máy chủ đang hỏng chỉ mục. Ghi lại NGUYÊN bản (mọi
     mảnh gửi lại từ đầu), soi tận mắt thấy đủ mảnh, rồi mới xoá mọi thứ còn lại — cả trên máy
     chủ lẫn trong bộ nhớ máy. Lần mở sau chỉ còn đúng bản cuối, mở phát là có. */
  /* ⚠⚠ DỌN RÁC CHỈ KHI NGƯỜI DÙNG TỰ BẤM ☁ Lưu (sửa 29/8, sau khi user cần lấy lại bản 66 file).
     Bản trước dọn TỰ ĐỘNG ngay lúc mở app. Nhưng chính mấy dòng "rác" đó lại là bản chụp của
     những mốc TRƯỚC ĐÓ — muốn quay về mốc cũ (vd "Xử lý 66 file → 1778 dòng" lúc 14:41 28/8)
     thì phải còn chúng. Xoá tự động = cắt mất đường lùi.
     Nay: mở app KHÔNG xoá gì hết. Chỉ khi người dùng chủ động bấm ☁ Lưu — tức đã nhìn thấy dữ
     liệu trên màn hình và thấy đúng — app mới soi rồi dọn. */
  /* ⚠ MỘT LẦN MỖI PHIÊN. User 3/9: "Các thông báo này sao vẫn chạy liên tục" — mỗi lần máy khác
     ghi là realtime bắn về, app nạp lại, thấy chỉ mục hỏng, lại ghi bản lành, lại bắn realtime…
     thành vòng lặp. Ghi lành một lần là đủ. */
  var _daSuaVa = false;
  function suaVaDon(va) {
    try {
      if (_daSuaVa) return;
      _daSuaVa = true;
      if (!(dungDamMay() && window.CLCloud.saveGoi && window.__CLAPP && window.__CLAPP.chiaLuu)) return;
      if (!duocGhiXuong()) return;
      var id = autoSaveId(); if (!id) return;
      if (va && va.hong && va.hong.length)
        toast('⚠ Không tìm lại được ' + va.hong.length + ' đơn: ' + va.hong.slice(0, 5).join(', ') + (va.hong.length > 5 ? '…' : ''), 'err');
      if (va) toast('Bản lưu bị hỏng chỉ mục — đang ghi lại bản lành…', 'ok');
      window.CLCloud.saveGoi({ id: id, name: tenBanLuu(), goi: window.__CLAPP.chiaLuu() })
        .then(function () { _luuLucNao = Date.now();   // máy này vừa ghi → người canh khỏi nạp lại
                            toast('Đã ghi lại bản lành ✓ (chưa xoá gì — bấm ☁ Lưu khi thấy dữ liệu đã đúng)', 'ok'); })
        .catch(function (e) { toast('Ghi lại bản lành thất bại: ' + (e && e.message || e), 'err'); });
    } catch (_) {}
  }
  /* SOI RỒI MỚI DỌN: hỏi thẳng máy chủ xem bản vừa ghi đã ĐỦ mảnh chưa. Đủ mới xoá phần còn
     lại. Chưa đủ thì báo và KHÔNG xoá gì — xoá là không lấy lại được.
     CHỈ được gọi từ nút ☁ Lưu, không bao giờ tự chạy lúc mở app. */
  function soiRoiDon(id) {
    if (!(dungDamMay() && window.CLCloud.kiemTraBanLuu && window.CLCloud.donDep)) return;
    return window.CLCloud.kiemTraBanLuu(id).then(function (kq) {
      if (!kq || !kq.ok) {
        if (kq && kq.thieu > 0) toast('⚠ Bản vừa lưu còn thiếu ' + kq.thieu + ' mảnh trên máy chủ — CHƯA dọn gì cả. Bấm ☁ Lưu lần nữa.', 'err');
        return;
      }
      return window.CLCloud.donDep(kq.ids).then(function (r) {
        if (r && (r.server || r.may))
          toast('Đã dọn bản cũ: ' + (r.server || 0) + ' dòng trên máy chủ · ' + (r.may || 0) + ' trong máy ✓', 'ok');
      });
    }).catch(function () {});
  }
  /* Hai hàm cũ đã BỎ (29/8): "🛟 Cứu dữ liệu" và "dò đơn còn sót" — cả hai đều gom đơn từ
     MỌI bản lưu cũ nên hay lôi về cả đơn của đợt trước (user: "các đơn cũ dữ liệu thừa hãy xóa
     hết đi"). Nay app chỉ mở ĐÚNG bản lưu cuối; mảnh nào thiếu thì vá theo đúng mã đơn mà chính
     bản lưu đó liệt kê (vaManh() ở cl.sync.js), không nhặt thêm đơn lạ. */
  /* ===== QUAY VỀ MỘT MỐC THỜI GIAN (thêm 29/8) =====
     User: "Tôi muốn lấy dữ liệu đã cập nhật xử lý 66 file như dòng tô đỏ trong hình
     (14:41:14 28/8 — 66 file → 1778 dòng). Bản đó là bản dữ liệu đúng đầy đủ."
     Mở bảng này bằng cách thêm  ?cuu=1  vào cuối địa chỉ trang — KHÔNG thêm nút nào vào thanh
     trên cùng, vì đây là việc dùng một lần chứ không phải chức năng hằng ngày.
     Bảng chỉ ĐỌC và MỞ LÊN MÀN HÌNH, không ghi một chữ nào lên máy chủ. Nhìn thấy đúng số file
     và số dòng rồi thì tự bấm ☁ Lưu. */
  function gioVN(t) {
    if (!t) return '—';
    try { return new Date(t).toLocaleString('vi-VN'); } catch (_) { return String(t); }
  }
  function mocTuO(v) {              // '2026-08-28T14:45' (giờ máy) → chuỗi ISO để so với updated_at
    if (!v) return '';
    try { var d = new Date(v); return isNaN(d.getTime()) ? '' : d.toISOString(); } catch (_) { return ''; }
  }
  function moKhoCuu() {
    if (!(window.CLCloud && window.CLCloud.dsKho && window.CLCloud.dungLaiToiMoc))
      return toast('Bản app quá cũ — tải lại trang (Ctrl+F5).', 'err');
    var tin = h('div', { class: 'cl-sub' }, ['Đang quét kho lưu trữ…']);
    var bangMoc = h('div', { style: 'max-height:230px;overflow:auto;border:1px solid #eee;border-radius:6px;margin:8px 0' });
    var oMoc = h('input', { class: 'cl-input', type: 'datetime-local', step: '1', style: 'width:auto' });
    var kq = h('div', { style: 'margin:10px 0;font-size:14px;line-height:1.7' }, ['']);
    var nutMo = h('button', { class: 'cl-btn sm', style: 'margin-left:8px', onclick: function () { mo(); } }, ['② Mở bản này lên màn hình']);
    nutMo.disabled = true;
    var giu = null;

    function dung() {
      var moc = mocTuO(oMoc.value);
      kq.textContent = 'Đang dựng lại…'; nutMo.disabled = true; giu = null;
      window.CLCloud.dungLaiToiMoc(moc).then(function (r) {
        var bc = (r && r.bc) || {};
        if (!r || !r.payload) { kq.textContent = '✗ Không dựng được gì tới mốc này.'; return; }
        giu = r.payload;
        kq.innerHTML = '';
        kq.appendChild(h('div', {}, ['Tới ' + (moc ? gioVN(moc) : 'mới nhất') + ':']));
        kq.appendChild(h('div', { style: 'font-size:17px;font-weight:700;color:#E8185C' },
          [bc.file + ' file · ' + bc.dong + ' dòng · ' + bc.maDon + ' mã đơn']));
        if (bc.thieu) kq.appendChild(h('div', { class: 'cl-sub' }, ['(' + bc.thieu + ' mảnh đọc không ra)']));
        nutMo.disabled = false;
      }).catch(function (e) { kq.textContent = '✗ ' + (e && e.message || e); });
    }
    function mo() {
      if (!giu || !window.__CLAPP) return;
      if (!window.confirm('Mở bản này lên màn hình?\n\nDữ liệu đang hiện sẽ bị thay. Máy chủ CHƯA bị đụng tới — ' +
                          'xem thấy đúng rồi thì tự bấm ☁ Lưu, thấy sai thì tải lại trang là xong.')) return;
      window.__CLAPP.loadData(giu);
      datMoTam(false, 0);
      ghiMoNhanh(giu, { nguon: 'quay về mốc' });
      closeModal();
      toast('Đã mở bản dựng lại ✓ — kiểm số file/số dòng rồi bấm ☁ Lưu nếu đúng.', 'ok');
    }

    var than = h('div', {}, [
      h('p', { class: 'cl-sub' }, ['Mỗi lần lưu, mã đơn nào có thay đổi được ghi thành một mảnh mang mốc thời gian ' +
        'của lần lưu đó. Chọn một mốc, app sẽ lấy bản mới nhất của TỪNG mã đơn tính tới mốc ấy.']),
      tin, bangMoc,
      h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
        h('span', {}, ['Quay về lúc:']), oMoc,
        h('button', { class: 'cl-btn sm', onclick: function () { dung(); } }, ['① Dựng lại tới mốc này']),
        nutMo,
      ]),
      kq,
    ]);
    openModal('Quay về một mốc thời gian', than);

    window.CLCloud.dsKho().then(function (kho) {
      /* Một mảnh có thể vừa nằm trên máy chủ vừa nằm trong bộ nhớ máy → gộp theo id, không thì
         đếm đôi, người dùng nhìn con số lại hoang mang. */
      var thay = {};
      kho.server.concat(kho.may).forEach(function (d) { if (d && d.id && !thay[d.id]) thay[d.id] = d; });
      var tatCa = Object.keys(thay).map(function (k) { return thay[k]; });
      var manh = tatCa.filter(function (d) { return d.kind === 'orders-manh'; });
      // gộp theo PHÚT — một lần lưu ghi nhiều mảnh cùng lúc
      var theoPhut = {};
      manh.forEach(function (d) {
        var t = String(d.updated_at || ''); if (!t) return;
        var ph = t.slice(0, 16);
        if (!theoPhut[ph]) theoPhut[ph] = { t: t, n: 0 };
        theoPhut[ph].n++; if (t > theoPhut[ph].t) theoPhut[ph].t = t;
      });
      var ds = Object.keys(theoPhut).sort().reverse().map(function (k) { return theoPhut[k]; });
      tin.textContent = 'Kho còn ' + manh.length + ' mảnh khác nhau (máy chủ ' +
        kho.server.filter(function (d) { return d.kind === 'orders-manh'; }).length + ' · máy này ' +
        kho.may.filter(function (d) { return d.kind === 'orders-manh'; }).length + ') qua ' + ds.length + ' lần lưu.';
      bangMoc.innerHTML = '';
      if (!ds.length) { bangMoc.appendChild(h('p', { class: 'cl-sub', style: 'padding:8px' }, ['Kho trống — không còn mảnh nào để quay về.'])); return; }
      var rows = ds.slice(0, 60).map(function (x) {
        return h('tr', {}, [
          h('td', {}, [gioVN(x.t)]),
          h('td', {}, [x.n + ' mảnh']),
          h('td', { style: 'text-align:right' }, [
            h('button', { class: 'cl-btn sm ghost', onclick: function () {
              // đặt ô thời gian về mốc này (cộng thêm 30 giây cho chắc trọn đợt lưu)
              var d = new Date(new Date(x.t).getTime() + 30000);
              var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
              oMoc.value = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' +
                           p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
              dung();
            } }, ['Chọn mốc này']),
          ]),
        ]);
      });
      bangMoc.appendChild(h('table', { class: 'cl-table' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, ['Lần lưu']), h('th', {}, ['Số mảnh ghi']), h('th', {}, [''])])]),
        h('tbody', {}, rows),
      ]));
    }).catch(function (e) { tin.textContent = 'Quét kho lỗi: ' + (e && e.message || e); });
  }
  window.__CUU = moKhoCuu;      // gõ __CUU() trong Console cũng mở được
  try {
    document.addEventListener('keydown', function (e) {
      if (!e.ctrlKey || !e.shiftKey) return;
      if (String(e.key || '').toLowerCase() !== 'h') return;
      if (!S.token) return;
      e.preventDefault(); moKhoCuu();
    });
  } catch (e) {}

  /* Máy chủ không cho ra bản dùng được mà app cũng chưa có gì → gom mảnh còn sót trong bộ nhớ
     máy để cứu (thêm 28/8 sau sự cố). Không tự lưu đè lên máy chủ — để người dùng tự quyết. */
  function thuCuuTuMay() {
    try {
      if (!(window.CLCloud && window.CLCloud.gomTatCa)) return;
      if (window.__CLAPP && window.__CLAPP.hasData && window.__CLAPP.hasData()) return;
      /* Gom từ MỌI nguồn (bộ nhớ máy · mảnh trên máy chủ kể cả mồ côi · bản lưu nguyên khối
         kiểu cũ) — KHÔNG đi qua chỉ mục, vì chính chỉ mục là thứ đã hỏng. */
      window.CLCloud.gomTatCa().then(function (kq) {
        var pl = kq && kq.payload, bc = (kq && kq.bc) || {};
        if (!pl || !window.__CLAPP || !window.__CLAPP.loadData) return;
        window.__CLAPP.loadData(pl);
        toast('Đã CỨU ' + (bc.maDon || 0) + ' đơn · ' + (bc.dong || 0) + ' dòng (máy: ' + (bc.manhTrongMay || 0) +
              ' mảnh · máy chủ: ' + (bc.manhTrenServer || 0) + ' mảnh · bản cũ: ' + (bc.banNguyenKhoi || 0) +
              '). Kiểm lại rồi bấm ☁ Lưu.', 'ok');
      }).catch(function () {});
    } catch (_) {}
  }

  // Áp NGAY quyền/cài đặt mới cho user hiện tại khi admin đổi (nhận qua realtime profiles).
  function applyLivePerms() {
    if (!(window.CLCloud && window.CLCloud.refreshProfile)) return;
    window.CLCloud.refreshProfile().then(function (p) {
      if (!p) return;
      setSession(cloudToSession(p)); S.cloud = true;
      try { if (window.__CLAPP && window.__CLAPP.setGridRole) window.__CLAPP.setGridRole('admin'); } catch (e) {}
      try { if (window.__CLAPP && window.__CLAPP.setPerms) window.__CLAPP.setPerms(role(), (S.user && S.user.stepPerms) || null); } catch (e) {}
      try { applyPermsFallback(); } catch (e) {}
      try { buildBar(); } catch (e) {}
      toast('Cài đặt/phân quyền của bạn vừa được cập nhật ✓', 'ok');
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
    /* ⚠ CACHE LỆCH BẢN (sửa 3/9). Máy này từng đăng nhập đám mây (còn clc_profile trong máy)
       mà lần mở này CLCloud lại chưa cấu hình ⇒ cl.config.js / cl.sync.js nạp không đủ, thường
       là do Service Worker còn giữ bản cũ. Nếu cứ chạy tiếp, app rơi xuống chế độ MÁY LẺ:
       mọi lệnh đọc đi vào auth.store.js và trả về "Chưa đăng nhập hoặc phiên không hợp lệ",
       máy đó ngồi mãi với bản cũ trong máy (đúng ảnh user gửi 14:51).
       Xử lý: dọn cache rồi tải lại ĐÚNG MỘT LẦN (cờ trong sessionStorage nên không thể lặp). */
    try {
      var tungDamMay = !!localStorage.getItem('clc_profile');
      var chuaCauHinh = !(window.CLCloud && window.CLCloud.configured && window.CLCloud.configured());
      var daLamSach = sessionStorage.getItem('cl_dalamsach') === '1';
      /* Chỉ làm việc này trên WEB và khi thật sự CÓ cache để dọn. Mở bằng file:// (bản chạy
         tay, bộ kiểm thử) thì dọn cũng chẳng có gì mà tải lại chỉ làm mất thì giờ. */
      var laWeb = location.protocol === 'http:' || location.protocol === 'https:';
      var coCache = !!(window.caches && caches.keys) ||
                    !!(navigator.serviceWorker && navigator.serviceWorker.getRegistration);
      if (tungDamMay && chuaCauHinh && laWeb && coCache && !daLamSach &&
          typeof window.__clLamSachTaiLai === 'function') {
        sessionStorage.setItem('cl_dalamsach', '1');
        return window.__clLamSachTaiLai();
      }
    } catch (e) { console.warn('boot.camSachCache', e); }
    detectIncognito().then(function (incognito) {
      if (incognito) return showInPrivateBlock();   // chặn hẳn trong InPrivate
      // Khôi phục phiên ĐÁM MÂY nếu đang ở chế độ cloud.
      var cloudMode = false; try { cloudMode = localStorage.getItem('cl_mode') === 'cloud'; } catch (e) {}
      if (window.CLCloud && window.CLCloud.configured() && cloudMode) {
        /* ⭑ VÀO THẲNG BẰNG HỒ SƠ ĐÃ LƯU TRONG MÁY (sửa 29/8 theo yêu cầu "mở link là phải có
           dữ liệu … dù không có mạng vẫn xem được chứ không phải đợi load").
           Bản trước phải đợi CLCloud.init() — mà init() đi tải thư viện Supabase từ CDN rồi mới
           hỏi phiên. Mất mạng là bước đó hỏng ⇒ rơi xuống showLogin() ⇒ đứng ở màn đăng nhập,
           không xem được gì, dù dữ liệu nằm sẵn trong máy.
           Nay: có hồ sơ trong máy thì vào ngay; việc xác minh phiên chạy ở NỀN. Chỉ khi máy chủ
           trả lời rõ ràng là "hết phiên" mới bắt đăng nhập lại — mất mạng thì giữ nguyên. */
        var hoSo = null; try { hoSo = window.CLCloud.getProfile(); } catch (e) {}
        if (hoSo && hoSo.id) {
          startCloudSession(hoSo);
          window.CLCloud.init().then(function (res) {
            if (!res) return;
            if (res.profile) return;                        // phiên còn tốt
            if (res.offline) return;                        // không có mạng → cứ xem tiếp
            /* ⚠ Đọc hồ sơ hỏng KHÔNG phải là hết phiên. Đo được 3/9 trên máy user: khoá phiên
               trong máy còn hạn tới 08:12Z mà app vẫn hiện "Phiên đã hết hạn" rồi xoá sạch dữ
               liệu đang mở ⇒ máy đó không bao giờ lấy được bản mới. Nay chỉ đăng xuất khi máy
               chủ nói RÕ là không còn phiên. */
            if (res.hoSoHong) {
              toast('Chưa đọc được hồ sơ tài khoản (mạng chập) — vẫn xem được bản trong máy, app tự thử lại.', 'ok');
              return;
            }
            if (res.khongCoPhien) doLogout(true);           // máy chủ nói hết phiên → mới bắt đăng nhập
          }).catch(function () {});
          return;
        }
        return window.CLCloud.init()
          .then(function (res) { if (res && res.profile) return startCloudSession(res.profile); return showLogin(); })
          .catch(function () { return showLogin(); });
      }
      /* Đã cấu hình đám mây mà tới được đây nghĩa là chưa có phiên đám mây → BẮT ĐĂNG NHẬP,
         tuyệt đối không quay về lối đăng nhập cũ (kho trong máy): lối cũ làm S.cloud = false,
         app đọc bản lưu từ auth.store.js và không bao giờ thấy dữ liệu trên máy chủ. */
      try { if (window.CLCloud && window.CLCloud.configured && window.CLCloud.configured()) return showLogin(); }
      catch (e) { console.warn('boot.configured', e); }
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
