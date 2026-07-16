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
    var name = 'Project_' + nowStamp() + '.charmproj';
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
    var host = document.querySelector('#cl-bar') || document.querySelector('.topbar');
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
    wrap.appendChild(bExp); wrap.appendChild(bImp); wrap.appendChild(inp);
    // đặt trước nút Đăng xuất nếu có
    host.insertBefore(wrap, host.firstChild);
  }

  // thử chèn nhiều lần vì thanh user (#cl-bar) được dựng sau khi đăng nhập
  function tryInject(n) { injectButtons(); if (n > 0 && !document.getElementById('cl-proj-btns')) setTimeout(function () { tryInject(n - 1); }, 800); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { tryInject(15); });
  else tryInject(15);

  root.CLProject = { exportFile: exportFile, importFile: importFileObj };
})(typeof window !== 'undefined' ? window : this);
