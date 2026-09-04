/* =====================================================================
 * cl.project.js — Xuất / Mở FILE PROJECT (.charmproj)
 * ---------------------------------------------------------------------
 * Lưu TOÀN BỘ trạng thái Step 1→6 + thiết lập ra 1 file JSON để:
 *   - Lưu trữ dài hạn (>6 tháng) trên máy / ổ mạng nội bộ.
 *   - Xóa đơn cũ khỏi Database cho gọn, khi cần chỉ mở lại file là khôi phục,
 *     KHÔNG phải import Excel hay chạy lại các bước.
 * Nạp SAU app (dùng window.__CLAPP). Expose: window.CLProject
 * ===================================================================== */
(function (root) {
  'use strict';
  var MAGIC = 'charmlash-nhapdon-project';

  function nowStamp() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }
  function p2(n) { return ('0' + n).slice(-2); }
  function ngayVN(d) { d = d || new Date(); return p2(d.getDate()) + '-' + p2(d.getMonth() + 1) + '-' + d.getFullYear(); }
  function ngayKhoa(d) { d = d || new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function nhac(chu, kieu) { try { if (root.__CLTOAST) root.__CLTOAST(chu, kieu); } catch (_) {} 
                             try { if (root.__CLAPP && root.__CLAPP.ghiNhatKy) root.__CLAPP.ghiNhatKy(chu); } catch (_) {} }

  /* =====================================================================
   * TỰ XUẤT PROJECT MỖI NGÀY (thêm 4/9 theo yêu cầu user)
   * ---------------------------------------------------------------------
   * User: "mỗi ngày (hoặc mỗi lần bấm ☁ Lưu) app tự tải một file .charmproj về
   * file dự án đơn hàng (tên có ngày tháng)".
   * Trình duyệt KHÔNG cho trang web tự chọn thư mục — nên làm hai đường:
   *   ① Người dùng bấm "📁 Thư mục tự lưu" một lần, chọn đúng thư mục dự án Đơn hàng.
   *      Từ đó app GHI THẲNG file vào thư mục đó, không qua Downloads, không hỏi lại.
   *      (Chrome/Edge nhớ quyền theo thư mục; lần mở app sau nếu trình duyệt hỏi lại thì
   *       app xin quyền ngay lúc bấm ☁ Lưu — đó là một cú bấm thật nên xin được.)
   *   ② Chưa chọn thư mục thì rơi về cách cũ: tải xuống thư mục Downloads, và CHỈ làm khi
   *      người dùng vừa bấm ☁ Lưu (không có cú bấm thì trình duyệt chặn tải tự động).
   * Mỗi ngày đúng MỘT file: `Đơn hàng 04-09-2026.charmproj`.
   * ===================================================================== */
  var DB_TEN = 'cl_proj', KHO_TEN = 'h', KHOA_TM = 'thuMuc';
  function moDB() {
    return new Promise(function (ok, ng) {
      try {
        var rq = indexedDB.open(DB_TEN, 1);
        rq.onupgradeneeded = function () { try { rq.result.createObjectStore(KHO_TEN); } catch (_) {} };
        rq.onsuccess = function () { ok(rq.result); };
        rq.onerror = function () { ng(rq.error); };
      } catch (e) { ng(e); }
    });
  }
  function luuTayCam(h) {
    return moDB().then(function (db) {
      return new Promise(function (ok, ng) {
        var t = db.transaction(KHO_TEN, 'readwrite');
        t.objectStore(KHO_TEN).put(h, KHOA_TM);
        t.oncomplete = function () { ok(true); }; t.onerror = function () { ng(t.error); };
      });
    });
  }
  function docTayCam() {
    return moDB().then(function (db) {
      return new Promise(function (ok) {
        try {
          var t = db.transaction(KHO_TEN, 'readonly');
          var r = t.objectStore(KHO_TEN).get(KHOA_TM);
          r.onsuccess = function () { ok(r.result || null); }; r.onerror = function () { ok(null); };
        } catch (_) { ok(null); }
      });
    }).catch(function () { return null; });
  }
  function coApiThuMuc() { return typeof root.showDirectoryPicker === 'function'; }

  function chonThuMuc() {
    if (!coApiThuMuc()) { alert('Trình duyệt này không cho chọn thư mục. Hãy dùng Chrome hoặc Edge (bản mới).'); return; }
    root.showDirectoryPicker({ mode: 'readwrite' }).then(function (h) {
      return luuTayCam(h).then(function () {
        try { localStorage.setItem('cl_proj_tenTM', h.name || ''); } catch (_) {}
        veNutThuMuc();
        nhac('Đã chọn thư mục tự lưu Project: ' + (h.name || ''), 'ok');
        return tuXuatNeuCanNgay(true);        // làm luôn một bản cho hôm nay
      });
    }).catch(function () {});                 // người dùng bấm Huỷ → im
  }

  function khoaNgay() {
    var prof = (root.CLCloud && root.CLCloud.getProfile && root.CLCloud.getProfile()) || null;
    return 'cl_proj_tuxuat_' + ((prof && prof.factory_id) || 'none');
  }
  function daXuatHomNay() {
    try { return localStorage.getItem(khoaNgay()) === ngayKhoa(); } catch (_) { return false; }
  }
  function danhDauDaXuat() { try { localStorage.setItem(khoaNgay(), ngayKhoa()); } catch (_) {} }

  function goiProject() {
    var st = root.__CLAPP.getState();
    var prof = (root.CLCloud && root.CLCloud.getProfile && root.CLCloud.getProfile()) || null;
    return {
      magic: MAGIC, version: 1, exportedAt: new Date().toISOString(),
      factory: prof ? { id: prof.factory_id } : null,
      state: st
    };
  }

  /* coCuChi = đang nằm trong một cú bấm thật của người dùng (bấm ☁ Lưu / bấm chọn thư mục).
     Không có cú bấm thì CHỈ được ghi vào thư mục đã chọn, tuyệt đối không tự tải xuống —
     trình duyệt chặn tải tự động và sẽ hiện cảnh báo khó hiểu cho người dùng. */
  function tuXuatNeuCanNgay(coCuChi) {
    try {
      if (daXuatHomNay()) return Promise.resolve(false);
      if (!(root.__CLAPP && root.__CLAPP.getState)) return Promise.resolve(false);
      var st = root.__CLAPP.getState();
      if (!(st && st.orders && st.orders.length)) return Promise.resolve(false);   // chưa có gì thì thôi
      var ten = 'Đơn hàng ' + ngayVN() + '.charmproj';
      var blob = new Blob([JSON.stringify(goiProject())], { type: 'application/json' });
      return docTayCam().then(function (h) {
        if (!h) {
          if (!coCuChi) return false;                 // không có thư mục + không có cú bấm → để lần sau
          taiVeMay(ten, blob); danhDauDaXuat();
          nhac('Đã tự lưu bản Project hôm nay: ' + ten + ' (trong Downloads — bấm "📁 Thư mục tự lưu" để đổi chỗ)', 'ok');
          return true;
        }
        return xinQuyen(h, coCuChi).then(function (duoc) {
          if (!duoc) {
            if (!coCuChi) return false;
            taiVeMay(ten, blob); danhDauDaXuat();
            nhac('Chưa xin được quyền ghi thư mục — đã tải ' + ten + ' vào Downloads.', 'err');
            return true;
          }
          return h.getFileHandle(ten, { create: true })
            .then(function (fh) { return fh.createWritable(); })
            .then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
            .then(function () {
              danhDauDaXuat();
              nhac('Đã tự lưu bản Project hôm nay vào thư mục ' + (h.name || '') + ': ' + ten, 'ok');
              return true;
            })
            .catch(function (e) {
              if (coCuChi) { taiVeMay(ten, blob); danhDauDaXuat(); }
              nhac('Ghi Project vào thư mục hỏng (' + (e && e.message || e) + ')' + (coCuChi ? ' — đã tải vào Downloads.' : ''), 'err');
              return !!coCuChi;
            });
        });
      });
    } catch (e) { return Promise.resolve(false); }
  }
  function xinQuyen(h, coCuChi) {
    try {
      if (!h.queryPermission) return Promise.resolve(true);
      return h.queryPermission({ mode: 'readwrite' }).then(function (q) {
        if (q === 'granted') return true;
        if (!coCuChi || !h.requestPermission) return false;
        return h.requestPermission({ mode: 'readwrite' }).then(function (r) { return r === 'granted'; });
      }).catch(function () { return false; });
    } catch (_) { return Promise.resolve(false); }
  }
  function taiVeMay(ten, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = ten;
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  function exportFile() {
    if (!root.__CLAPP || !root.__CLAPP.getState) { alert('Chưa sẵn sàng dữ liệu.'); return; }
    var st = root.__CLAPP.getState();
    if (!(st && (st.orders && st.orders.length || st.files && st.files.length))) {
      if (!confirm('Chưa có dữ liệu để lưu. Vẫn xuất file rỗng?')) return;
    }
    var prof = (root.CLCloud && root.CLCloud.getProfile && root.CLCloud.getProfile()) || null;
    var proj = {
      magic: MAGIC, version: 1, exportedAt: new Date().toISOString(),
      factory: prof ? { id: prof.factory_id } : null,
      state: st
    };
    var name = 'Đơn hàng ' + ngayVN() + ' ' + nowStamp().slice(-4) + '.charmproj';
    var blob = new Blob([JSON.stringify(proj)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 100);
    try { if (root.__CLAPP.log) root.__CLAPP.log('Đã xuất ' + name); } catch (_) {}
  }

  function importFileObj(file) {
    if (!file) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var proj = JSON.parse(rd.result);
        if (!proj || proj.magic !== MAGIC || !proj.state) { alert('File không đúng định dạng Project (.charmproj).'); return; }
        if (!root.__CLAPP || !root.__CLAPP.loadData) { alert('Chưa sẵn sàng để mở.'); return; }
        if (!confirm('Mở Project sẽ THAY dữ liệu đang hiển thị bằng dữ liệu trong file. Tiếp tục?')) return;
        root.__CLAPP.loadData(proj.state);
        alert('Đã mở Project ✓ (' + (proj.exportedAt ? new Date(proj.exportedAt).toLocaleString('vi-VN') : '') + ')');
      } catch (e) { alert('Không đọc được file: ' + e.message); }
    };
    rd.readAsText(file);
  }

  // ---- Chèn 2 nút vào thanh trên cùng ----
  function injectButtons() {
    if (document.getElementById('cl-proj-btns')) return;
    // Luôn gắn vào ĐẦU thanh trên (nhóm trái) cho bố cục ổn định — trước đây nếu thanh tài
    // khoản đã dựng xong thì 2 nút này lại nhảy sang cụm bên phải.
    var host = document.querySelector('.topbar') || document.querySelector('#cl-bar');
    if (!host) return;
    var wrap = document.createElement('span');
    wrap.id = 'cl-proj-btns';
    wrap.style.cssText = 'display:inline-flex;gap:6px;margin-right:8px';
    var bExp = document.createElement('button');
    bExp.className = 'btn sm ghost'; bExp.textContent = '⬇ Xuất Project';
    bExp.title = 'Lưu toàn bộ dự án (Step 1→6) ra file .charmproj';
    bExp.onclick = exportFile;
    var bImp = document.createElement('button');
    bImp.className = 'btn sm ghost'; bImp.textContent = '⬆ Mở Project';
    bImp.title = 'Mở file .charmproj để khôi phục toàn bộ trạng thái';
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.charmproj,application/json'; inp.style.display = 'none';
    inp.onchange = function () { if (inp.files && inp.files[0]) importFileObj(inp.files[0]); inp.value = ''; };
    bImp.onclick = function () { inp.click(); };
    /* Nút chọn THƯ MỤC TỰ LƯU — bấm một lần, từ đó mỗi ngày app tự ghi một bản Project vào đó */
    var bTM = document.createElement('button');
    bTM.className = 'btn sm ghost'; bTM.id = 'cl-proj-tm';
    bTM.onclick = chonThuMuc;
    wrap.appendChild(bExp); wrap.appendChild(bImp);
    if (coApiThuMuc()) wrap.appendChild(bTM);
    wrap.appendChild(inp);
    // đặt trước nút Đăng xuất nếu có
    host.insertBefore(wrap, host.firstChild);
  }

  function veNutThuMuc() {
    var b = document.getElementById('cl-proj-tm'); if (!b) return;
    var ten = ''; try { ten = localStorage.getItem('cl_proj_tenTM') || ''; } catch (_) {}
    b.textContent = ten ? ('📁 ' + ten) : '📁 Thư mục tự lưu';
    b.title = ten
      ? ('Mỗi ngày app tự ghi một bản Project vào thư mục "' + ten + '". Bấm để đổi thư mục khác.')
      : 'Chọn thư mục để mỗi ngày app tự ghi một bản Project vào đó (thay vì tải vào Downloads)';
  }

  // thử chèn nhiều lần vì thanh user (#cl-bar) được dựng sau khi đăng nhập
  function tryInject(n) {
    injectButtons(); veNutThuMuc();
    if (n > 0 && !document.getElementById('cl-proj-btns')) setTimeout(function () { tryInject(n - 1); }, 800);
  }
  /* Đã chọn thư mục rồi thì khỏi đợi ai bấm gì: 45 giây sau khi mở app (lúc dữ liệu đã về) tự
     ghi bản của hôm nay. Chưa chọn thư mục thì im — đường tải xuống cần một cú bấm thật. */
  setTimeout(function () { try { tuXuatNeuCanNgay(false); } catch (_) {} }, 45000);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { tryInject(15); });
  else tryInject(15);

  root.CLProject = { exportFile: exportFile, importFile: importFileObj,
                     tuXuatNeuCanNgay: tuXuatNeuCanNgay, chonThuMuc: chonThuMuc,
                     daXuatHomNay: daXuatHomNay };
})(typeof window !== 'undefined' ? window : this);
