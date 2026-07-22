/* =============================================================================
 *  engine.web.js — BẢN TRÌNH DUYỆT của engine Nhập Đơn (Module 1)
 *  DÙNG CHO WEB APP HTML: nạp bằng <script src="engine.web.js"></script>.
 *  KHÔNG dùng import/export → tránh lỗi khi lỡ mở bằng Windows Script Host.
 *  Sau khi nạp, dùng qua:  window.NhapDonEngine
 *  (Logic giống hệt thư mục engine/ nhưng gói 1 file classic-script.)
 * ========================================================================== */
(function (root) {
  'use strict';

  // Nếu bị chạy bằng Windows Script Host (cscript/wscript) → báo & thoát.
  if (typeof WScript !== 'undefined') {
    WScript.Echo('File này là script cho WEB. Hãy mở web app bằng trình duyệt, đừng chạy bằng Windows Script Host.');
    return;
  }

  /* ---------------- constants ---------------- */
  // Thứ tự độ cong CHUẨN — CỐ ĐỊNH 16 cột theo cấu trúc đơn gửi xưởng (chốt 10/07)
  var CURLS = ['J','B','C','CC','D','DD','L','M','V','L+','LD','LC+','LC','LB','LJ','Curl 1'];
  var RANGES = ['5-7mm','4-7mm','13-17mm','6-14mm','13-16mm','6-13mm','4-12mm','4-13mm','5-13mm','7-14mm','8-14mm','7-13mm','4-8mm'];
  var MM_MIN = 4, MM_MAX = 20, SOI_PER_LINE = 2;
  // TIÊU CHUẨN ĐỘ CONG 2026 — dải size (mm) cho phép theo TỪNG NHÓM độ cong:
  //   J·B·C·CC·D·DD: 4–20mm · L·M·V·L+·LD: 5–16mm · LJ·LB·LC·LC+: 5–18mm
  var CURL_RANGE = { J:[4,20],B:[4,20],C:[4,20],CC:[4,20],D:[4,20],DD:[4,20], L:[5,16],M:[5,16],V:[5,16],'L+':[5,16],LD:[5,16], LJ:[5,18],LB:[5,18],LC:[5,18],'LC+':[5,18], 'Curl 1':[4,20] };
  var round2 = function (n) { return Math.round((n + Number.EPSILON) * 100) / 100; };

  function normalizeLength(len) {
    if (len == null) return '';
    var s = String(len).trim().toLowerCase().replace(/\s|mm/g, '').replace('~', '-');
    return s === '' ? '' : s + 'mm';
  }
  function parseRange(lenNorm) {
    // chấp nhận biến thể có dấu * đầu (vd *5-13mm — dải Mix riêng trong đơn khách)
    var s = String(lenNorm).replace(/mm$/i, '');
    var m = s.match(/^\*?(\d+)-(\d+)$/); if (m) return { lo: +m[1], hi: +m[2] };
    var o = s.match(/^\*?(\d+)$/); if (o) return { lo: +o[1], hi: +o[1] };
    return null;
  }

  /* ---------------- STEP 1 — Nhập Đơn ---------------- */
  function normalizeOrder(raw) {
    var lenNorm = normalizeLength(raw.length), r = parseRange(lenNorm);
    // curls: map {độ cong: SL} — 1 dòng có thể nhiều độ cong (đúng cấu trúc sheet)
    var curls = {}, k, v;
    if (raw.curls && typeof raw.curls === 'object') {
      for (k in raw.curls) { v = Number(raw.curls[k]) || 0; if (v) curls[String(k).trim()] = v; }
    } else if (raw.curl) {
      v = Number(raw.sl) || 0; if (v) curls[String(raw.curl).trim()] = v;
    }
    var keys = Object.keys(curls), total = 0;
    keys.forEach(function (kk) { total += curls[kk]; });
    // Mix/Single: chuẩn hoá hoa thường; giữ giá trị lạ để validate tô đỏ
    var ms = String(raw.mixSingle == null ? '' : raw.mixSingle).trim();
    if (/^mix$/i.test(ms)) ms = 'Mix';
    else if (/^single$/i.test(ms)) ms = 'Single';
    else if (ms === '') ms = r && r.lo === r.hi ? 'Single' : 'Mix';
    var lineNum = Number(raw.line) || 0;
    // TÁCH mã sợi / nguyên liệu bị NỐI LIỀN (nhiều màu 1 đơn, không có xuống dòng) → chèn \n.
    //   Mã: tách sau độ dày (thickness) khi theo sau là chữ số (mã kế), đứng sau dấu chấm/chữ.
    //   NL:  tách trước 1 chữ IN HOA đứng ngay sau chữ số (vd "0.085H. Pink" → "0.085\nH. Pink").
    var thN = String(raw.thickness == null ? '' : raw.thickness).trim();
    function splitByComma(s){ if (/[,;]/.test(s)) { var ps = s.split(/\s*[,;]\s*/).map(function(x){return x.trim();}).filter(function(x){return x;}); if (ps.length > 1) return ps.join('\n'); } return null; }
    function splitCodes(s){ s = String(s == null ? '' : s).trim(); if (s.indexOf('\n') >= 0) return s;
      var byC = splitByComma(s); if (byC) return byC;      // nhiều mã sợi 1 ô ngăn bằng "," hoặc ";" (vd "197.SKV.Orange.7, 187.SKV.SmokBlue.7")
      if (!thN) return s;
      try{ var re = new RegExp('(?<=[.A-Za-z])(' + thN.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')(?=\\d)','g'); var o = s.replace(re,'$1\n'); return o.split('\n').length > 1 ? o : s; }catch(e){ return s; } }
    function splitMats(s){ s = String(s == null ? '' : s).trim(); if (s.indexOf('\n') >= 0) return s;
      var byC = splitByComma(s); if (byC) return byC;
      var o = s.replace(/(0[.,]\d+)(?=[A-ZĐ])/g,'$1\n'); return o.split('\n').length > 1 ? o : s; }
    return {
      seri: raw.seri, maDon: String(raw.maDon || '').trim(),
      codeSoi: splitCodes(raw.codeSoi), detail: raw.detail || '',
      length: lenNorm,
      mixSingle: ms,
      curls: curls,
      curl: keys[0] || '',
      sl: total, line: lineNum,
      lineRaw: String(raw.lineRaw != null ? raw.lineRaw : (lineNum ? lineNum + ' lines' : '')).trim(),
      loaiHang: String(raw.loaiHang != null ? raw.loaiHang : (ms === 'Single' ? '' : lenNorm)).trim(),
      ghiChu: String(raw.ghiChu == null ? '' : raw.ghiChu).trim(),
      ghiChuKeo: String(raw.ghiChuKeo == null ? '' : raw.ghiChuKeo).trim(),
      material: splitMats(raw.material != null ? raw.material : (raw.detail || '')),
      thickness: thN,
      label: raw.label == null ? '' : String(raw.label).trim(),
      mixDist: (raw.mixDist && typeof raw.mixDist === 'object') ? raw.mixDist : null,
      _colorBlocks: (raw._colorBlocks && raw._colorBlocks.length) ? raw._colorBlocks : null,   // phân bổ mix màu do admin nhập (per-dòng)
      _manual: !!raw._manual,
    };
  }
  function validateOrder(o, opt) {
    opt = opt || {}; var minMM = opt.minMM || MM_MIN, maxMM = opt.maxMM || MM_MAX, errs = [];
    var push = function (col, code, level, msg) { errs.push({ seri: o.seri, col: col, code: code, level: level, msg: msg }); };
    if (!/\.\d+$/.test(o.codeSoi)) push('codeSoi', 'E-CODE', 'error', '"' + o.codeSoi + '" thiếu độ dài — kỳ vọng <mã>.<số>');
    var rg = parseRange(o.length);
    if (!rg) push('length', 'E-LEN', 'error', 'Độ dài "' + o.length + '" không đọc được');
    else {
      // Dải cho phép = HỢP các nhóm độ cong CÓ trong dòng (tiêu chuẩn 2026)
      var _ck = Object.keys(o.curls || {}), _vlo = minMM, _vhi = maxMM;
      if (_ck.length) { _vlo = 99; _vhi = 0; _ck.forEach(function (k) { var cr = CURL_RANGE[k] || [minMM, maxMM]; if (cr[0] < _vlo) _vlo = cr[0]; if (cr[1] > _vhi) _vhi = cr[1]; }); }
      if (rg.lo > rg.hi) push('length', 'E-LEN', 'error', '"' + o.length + '" dải không hợp lệ (đầu > cuối)');
      else if (rg.lo < _vlo || rg.hi > _vhi) push('length', 'E-LEN', 'error', '"' + o.length + '" vượt dải cho phép (' + _vlo + '-' + _vhi + 'mm) theo tiêu chuẩn độ cong 2026');
      else if (/^\*/.test(o.length)) push('length', 'E-STAR', 'error', '"' + o.length + '" sai cấu trúc chuẩn (đúng: ' + o.length.replace(/^\*/, '') + ') — thừa dấu *');
    }
    // Mix/Single: giá trị hợp lệ + kiểm tra CHÉO với độ dài
    if (o.mixSingle !== 'Mix' && o.mixSingle !== 'Single') {
      push('mixSingle', 'E-MIX', 'error', 'Giá trị "' + o.mixSingle + '" không hợp lệ — chỉ nhận Mix hoặc Single');
    } else if (rg) {
      if (o.mixSingle === 'Mix' && rg.lo === rg.hi)
        push('mixSingle', 'E-MIX', 'error', 'Mix phải là khoảng dạng 5-13mm hoặc 5~13mm');
      if (o.mixSingle === 'Single' && rg.lo !== rg.hi)
        push('mixSingle', 'E-MIX', 'error', 'Single phải là 1 giá trị dạng 5mm, 6mm…');
    }
    var curlKeys = Object.keys(o.curls || {});
    if (curlKeys.length === 0) push('curl', 'E-CURL', 'error', 'Thiếu độ cong');
    else curlKeys.forEach(function (k) {
      if (CURLS.indexOf(k) < 0) push('curl', 'E-CURL', 'error', 'Độ cong "' + k + '" không hợp lệ');
    });
    if (!(o.sl > 0)) push('sl', 'E-SL', 'error', 'Số lượng phải > 0');
    if (!o.label) push('label', 'W-LBL', 'warn', 'Thiếu nội dung nhãn — điền theo quy chuẩn KH');
    return errs;
  }
  function runStep1(rawList, opt) {
    var orders = rawList.map(normalizeOrder), errors = [], seen = {};
    orders.forEach(function (o) {
      var k = o.maDon + '#' + o.seri;
      if (seen[k]) errors.push({ maDon: o.maDon, seri: o.seri, col: 'seri', code: 'E-DUP', level: 'error', msg: 'Trùng Seri ' + o.seri });
      seen[k] = 1;
      // gắn maDon vào từng lỗi — Seri có thể trùng giữa các file/mã đơn khác nhau
      validateOrder(o, opt).forEach(function (e) { e.maDon = o.maDon; errors.push(e); });
    });
    var FORMAT_CODES = ['E-MIX', 'E-STAR'];
    var isErr = function (e) { return e.level === 'error'; };
    var errRows = {}; errors.forEach(function (e) { if (isErr(e)) errRows[e.maDon + '#' + e.seri] = 1; });
    var stats = {
      total: orders.length,
      errorCells: errors.filter(isErr).length,   // gồm CẢ lỗi cấu trúc E-MIX/E-STAR
      mixFormatCells: errors.filter(function (e) { return FORMAT_CODES.indexOf(e.code) >= 0; }).length,
      warnCells: errors.filter(function (e) { return e.level === 'warn'; }).length,
      validRows: orders.length - Object.keys(errRows).length,
      mix: orders.filter(function (o) { return o.mixSingle === 'Mix'; }).length,
      single: orders.filter(function (o) { return o.mixSingle === 'Single'; }).length,
    };
    return { orders: orders, errors: errors, stats: stats };
  }
  function editCell(order, col, value, opt) {
    var next = Object.assign({}, order, { curls: Object.assign({}, order.curls || {}) });
    if (col === 'length') next.length = normalizeLength(value);
    else if (col === 'sl' || col === 'line') next[col] = Number(value) || 0;
    else if (col.indexOf('curl:') === 0) {
      var ck = col.slice(5), cv = Number(value) || 0;
      if (cv) next.curls[ck] = cv; else delete next.curls[ck];
    } else next[col] = typeof value === 'string' ? value.trim() : value;
    if (col === 'length') { var r = parseRange(next.length); next.mixSingle = r && r.lo === r.hi ? 'Single' : 'Mix'; }
    if (col === 'mixSingle') {
      if (/^mix$/i.test(next.mixSingle)) next.mixSingle = 'Mix';
      else if (/^single$/i.test(next.mixSingle)) next.mixSingle = 'Single';
    }
    var keys = Object.keys(next.curls), total = 0;
    keys.forEach(function (kk) { total += next.curls[kk]; });
    next.curl = keys[0] || ''; next.sl = total;
    return { order: next, errors: validateOrder(next, opt) };
  }

  /* ---------------- STEP 2 — Mix / Label ---------------- */
  function buildMix(mmList, matrix, ranges) {
    ranges = ranges || RANGES;   // đơn khách có bộ dải riêng (vd 4-8mm, 5-13mm, *5-13mm)
    var mix = {};
    mmList.forEach(function (mm, i) {
      var row = matrix[i] || {}; mix[mm] = {};
      ranges.forEach(function (rg, j) { var v = Number(row[j]) || 0; if (v) mix[mm][rg] = v; });
    });
    return mix;
  }
  function MixLabel() { this.byOrder = {}; }
  MixLabel.prototype.set = function (m, mix) { this.byOrder[m] = mix; return this; };
  MixLabel.prototype.get = function (m) { return this.byOrder[m] || {}; };
  function mixOfRange(mix, rg) { var o = {}; for (var mm in mix) if (mix[mm][rg]) o[+mm] = mix[mm][rg]; return o; }
  function totalOfRange(mix, rg) { var d = mixOfRange(mix, rg), s = 0; for (var k in d) s += d[k]; return s; }
  /**
   * KHÓA BẢNG MIX = dải + số line ("6-13mm|18") — hai bảng Mix cùng dải nhưng khác
   * số line (16/18/20 Lines) là 2 bảng ĐỘC LẬP, không được gộp.
   * sheetRangeInfo(sheet) → {ranges, lines, keys, labels}:
   *   lines[j] = số line ghi trên header "(16 Lines)"; không ghi thì = TỔNG CỘT (bất biến
   *   đã kiểm chứng trên dữ liệu thật: tổng sợi của cột dải = Số Line của dòng đơn khớp).
   */
  function sheetRangeInfo(sheet) {
    var ranges = sheet.ranges || RANGES;
    var lines = ranges.map(function (_rg, j) {
      if (sheet.lineCounts && sheet.lineCounts[j] != null) return sheet.lineCounts[j];
      var sum = 0; (sheet.matrix || []).forEach(function (row) { sum += Number(row[j]) || 0; });
      return sum;
    });
    var keys = ranges.map(function (rg, j) { return rg + '|' + lines[j]; });
    var labels = {};
    keys.forEach(function (k, j) { labels[k] = ranges[j] + ' (' + lines[j] + ' Lines)'; });
    return { ranges: ranges, lines: lines, keys: keys, labels: labels };
  }
  /**
   * Tra bảng phân bổ mm cho 1 dòng đơn Mix theo thứ tự ưu tiên:
   *   1. đúng dải + đúng số line  ("6-13mm|18")
   *   2. đúng dải, chỉ có 1 biến thể số line → dùng biến thể đó
   *   3. khóa trần "6-13mm" (tương thích mix cũ không key theo line)
   */
  function resolveMixDist(mix, o) {
    var norm = o.length;
    var d = mixOfRange(mix, norm + '|' + o.line);
    if (Object.keys(d).length) return d;
    var pref = norm + '|', hits = {}, mm, k;
    for (mm in mix) for (k in mix[mm]) if (k.indexOf(pref) === 0) hits[k] = 1;
    var hk = Object.keys(hits);
    if (hk.length === 1) return mixOfRange(mix, hk[0]);
    return mixOfRange(mix, norm);
  }

  /* ---------------- STEP 3 — DATA 1 + Line ---------------- */
  /* QUY TẮC ĐÃ CHỐT (khớp 100% file Excel): Dây per-mm = SL × số sợi ÷ 2.
   *   Mix: số sợi = mix[mm][dải] · Single: số sợi = cột Line (vd 18).
   *   Kiểm chứng 233S: Mix=3970, Single=540, Dây=4510. */
  var STRATEGIES = {
    DAY: function (_o, e) { return round2((e.qty * e.mixQty) / SOI_PER_LINE); },
    EXACT_MIX: function (_o, e) { return e.mixQty; },
    PROPORTIONAL: function (_o, e, ctx) { return round2((e.qty * e.mixQty) / (ctx.rangeTotal || 1)); },
    MULTIPLY: function (_o, e) { return e.qty * e.mixQty; },
  };
  function expandOrder(o, mix, strategy, colorBlocks) {
    strategy = strategy || STRATEGIES.DAY;
    var curls = (o.curls && Object.keys(o.curls).length) ? o.curls : (o.curl ? (function(){var c={};c[o.curl]=o.sl;return c;})() : {});
    var rows = [], curl, mm, sl;
    // mỗi dòng data1 MANG THEO material/độ dày/keo khách ghi của CHÍNH DÒNG ĐƠN sinh ra nó
    // (2 dòng đơn cùng code sợi có thể khác material → không được tra keo qua meta gộp)
    var carry = { material: o.material || o.detail || '', thickness: o.thickness || '', ghiChuKeo: o.ghiChuKeo || '' };
    // TÁCH THEO MÀU: dòng Mix có NHIỀU code sợi (mix nhiều màu) → tách MỖI code = 1 component,
    // dùng phân bổ mm RIÊNG của màu đó (colorBlocks theo THỨ TỰ khớp code sợi). Tổng dây bảo toàn.
    if (o.mixSingle !== 'Single' && !o.mixDist && (colorBlocks || (o._colorBlocks && o._colorBlocks.length))) {
      var codesS = String(o.codeSoi || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
      if (codesS.length > 1) {
        var rk = String(o.length || '').toLowerCase().replace(/~/g, '-'); if (!/mm$/.test(rk)) rk += 'mm';
        // ưu tiên phân bổ mix màu ADMIN NHẬP cho CHÍNH dòng này (_colorBlocks); nếu không có → tra colorBlocks theo dải
        var blocks = (o._colorBlocks && o._colorBlocks.length === codesS.length) ? o._colorBlocks
                   : (colorBlocks && colorBlocks[o.maDon] && colorBlocks[o.maDon][rk]);
        if (blocks && blocks.length === codesS.length) {
          var matsS = String(o.material || o.detail || '').split(/\r?\n/).map(function (x) { return x.trim(); });
          var acc = [];
          codesS.forEach(function (code, i) {
            var sub = {}; for (var kk in o) sub[kk] = o[kk];
            sub.codeSoi = code; sub.material = matsS[i] || o.material; sub.detail = matsS[i] || o.detail;
            sub.mixDist = blocks[i].dist;   // phân bổ mm riêng của màu này
            expandOrder(sub, mix, strategy, colorBlocks).forEach(function (r) { acc.push(r); });
          });
          return acc;
        }
      }
    }
    if (o.mixSingle === 'Single') {
      var r = parseRange(o.length), smm = r ? r.lo : NaN;
      for (curl in curls) {
        sl = strategy(o, { mm: smm, mixQty: o.line, qty: curls[curl] }, { rangeTotal: o.line });
        if (sl) rows.push({ codeSoi: o.codeSoi, length: o.length, mm: smm, curl: curl, sl: sl, maDon: o.maDon, mixSingle: 'Single', material: carry.material, thickness: carry.thickness, ghiChuKeo: carry.ghiChuKeo });
      }
      return rows;
    }
    // o.mixDist = phân bổ mm RIÊNG (dùng cho dòng đã TÁCH THEO MÀU); nếu không có → tra bảng mix chung
    var dist = (o.mixDist && Object.keys(o.mixDist).length) ? o.mixDist : resolveMixDist(mix, o), rangeTotal = 0; for (mm in dist) rangeTotal += dist[mm];
    for (curl in curls) {
      for (mm in dist) {
        sl = strategy(o, { mm: +mm, mixQty: dist[mm], qty: curls[curl] }, { rangeTotal: rangeTotal });
        if (sl) rows.push({ codeSoi: o.codeSoi, length: o.length, mm: +mm, curl: curl, sl: sl, maDon: o.maDon, mixSingle: 'Mix', material: carry.material, thickness: carry.thickness, ghiChuKeo: carry.ghiChuKeo });
      }
    }
    return rows;
  }
  function buildData1(orders, mixSource, opt) {
    opt = opt || {}; var strategy = opt.strategy || STRATEGIES.DAY;
    var cb = opt.colorBlocks || null;
    var getMix = function (o) { return (mixSource && typeof mixSource.get === 'function') ? mixSource.get(o.maDon) : mixSource; };
    var out = [];
    orders.forEach(function (o) {
      var has = (o.curls && Object.keys(o.curls).length) || o.curl;
      if (!has || !(o.sl > 0)) return;
      expandOrder(o, getMix(o) || {}, strategy, cb).forEach(function (r) { out.push(r); });
    });
    return out;
  }
  function buildLineMatrix(mix, opt) {
    opt = opt || {}; var per = opt.soiPerLine || SOI_PER_LINE;
    var ranges = opt.ranges || RANGES;   // bộ dải động theo nguồn dữ liệu
    var line = {}, colTotal = {}, rowTotal = {}, grand = 0;
    ranges.forEach(function (r) { colTotal[r] = 0; });
    for (var mm in mix) {
      line[mm] = {}; rowTotal[mm] = 0;
      ranges.forEach(function (r) {
        var v = mix[mm][r];
        if (v) { var l = round2(v / per); line[mm][r] = l; colTotal[r] = round2(colTotal[r] + l); rowTotal[mm] = round2(rowTotal[mm] + l); grand = round2(grand + l); }
      });
    }
    return { line: line, colTotal: colTotal, rowTotal: rowTotal, grand: grand, ranges: ranges };
  }

  /* ---------------- KEO RULES — tra keo theo (Material · Độ dày · mm) ---------------- */
  // Bảng keo của khách = danh sách QUY TẮC, không phải lookup theo Code Sợi:
  //   1 Material có thể nhiều keo theo khoảng chiều dài (5~8mm → Nau155C.2 · 9~13mm → Nau155C.3),
  //   1 quy tắc có thể chỉ ghi Độ dày (0,07; 0,085) hoặc chỉ ghi Material.
  var normTxt = function (s) { return PS(s).toLowerCase().replace(/\s+/g, ' '); };
  /**
   * Chuẩn hoá ĐỘ DÀY về "khóa chữ số" để so khớp 2 cách ghi của khách:
   * dòng đơn ghi 5 / 6 / 7 / 85 / 10 — bảng keo ghi 0.05 / 0.06 / 0.07 / 0.085 / 0.10.
   * thickKey(5) = thickKey('0.05') = '5' · thickKey(85) = thickKey('0.085') = '85' · thickKey(10) = thickKey('0.10') = '1'.
   */
  function thickKey(x) {
    var n = parseFloat(String(x == null ? '' : x).replace(',', '.'));
    if (!isFinite(n)) return '';
    var s = String(n).replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
    return s || '0';
  }
  /**
   * Phân tích 1 đoạn điều kiện keo (cột có cấu trúc HOẶC 1 dòng chữ tự do
   * kiểu "5~8mm 0.07/0.085/0.10 Premium Faux Mink"):
   *   - điều kiện độ dài: "5~8mm" · "từ 9mm" · "đến/dưới/tối đa 8mm" · "9mm" · "tất cả độ dài" (không ràng buộc)
   *   - độ dày: các số còn lại (0.07/0.085…)
   *   - material: phần chữ còn lại, tách theo "/" "," ";" ("Premium Faux Mink/Super Silk")
   * spec = độ đặc hiệu của điều kiện độ dài (3 dải kín/1 giá trị · 2 nửa hở · 0 không ràng buộc).
   */
  function parseKeoCond(text) {
    var s = ' ' + PS(text) + ' ';
    var lo = null, hi = null, spec = 0, m;
    if ((m = s.match(/(\d+)\s*[~–-]\s*(\d+)\s*mm/i))) { lo = +m[1]; hi = +m[2]; spec = 3; s = s.replace(m[0], ' '); }            // N~M mm (khoảng kín)
    else if ((m = s.match(/(?:>=|≥|từ)\s*(\d+)\s*(?:mm)?/i))) { lo = +m[1]; hi = 999; spec = 2; s = s.replace(m[0], ' '); }        // từ N / >=N (GỒM N)
    else if ((m = s.match(/(?:>|trên)\s*(\d+)\s*(?:mm)?/i))) { lo = +m[1] + 1; hi = 999; spec = 2; s = s.replace(m[0], ' '); }     // trên N / >N (KHÔNG gồm N)
    else if ((m = s.match(/(?:<=|≤|đến|tối\s*đa)\s*(\d+)\s*(?:mm)?/i))) { lo = 0; hi = +m[1]; spec = 2; s = s.replace(m[0], ' '); } // đến/tối đa N / <=N (GỒM N)
    else if ((m = s.match(/(?:<|dưới)\s*(\d+)\s*(?:mm)?/i))) { lo = 0; hi = +m[1] - 1; spec = 2; s = s.replace(m[0], ' '); }       // dưới N / <N (KHÔNG gồm N)
    else if ((m = s.match(/(\d+)\s*mm/i))) { lo = +m[1]; hi = +m[1]; spec = 3; s = s.replace(m[0], ' '); }                        // đúng N mm
    s = s.replace(/tất\s*cả(\s*độ\s*d\S*)?/gi, ' ');
    var thickRaw = s.match(/\d+(?:[.,]\d+)?/g) || [];
    s = s.replace(/\d+(?:[.,]\d+)?/g, ' ');
    var mats = s.split(/[\/,;·]/).map(function (t) { return t.replace(/\s+/g, ' ').trim(); })
      .filter(function (t) { return t && !/^mm$/i.test(t) && t !== '-' && t !== '.'; });
    return { lo: lo, hi: hi, spec: spec, thickRaw: thickRaw, thicks: thickRaw.map(thickKey), mats: mats };
  }
  /** keoRows → rules[{maDon, glue, mats[], thick[] (khóa chữ số), lo, hi, spec}]. */
  function buildKeoRules(keoRows) {
    var rules = [];
    (keoRows || []).forEach(function (k) {
      if (!PS(k.loaiKeo)) return;
      // FORMAT CHỮ TỰ DO: cột thuộc tính (Loại Sợi/Độ Dày/Độ Dài) trống, quy tắc nằm
      // trong Ghi Chú — mỗi DÒNG = 1 quy tắc. Bung tại đây (không đụng dữ liệu hiển thị)
      // vd "0.05 Faux Mink tất cả độ dài\n5~8mm 0.07/0.085/0.10 Premium Faux Mink".
      var hasStructured = PS(k.loaiSoi) || PS(k.doDay) || PS(k.doDai);
      var gh = PS(k.ghiChu);
      if (!hasStructured && gh && /\d/.test(gh)) {
        gh.split(/\r?\n/).forEach(function (ln) {
          var c = parseKeoCond(ln);
          if (!c.thickRaw.length && !c.mats.length && c.lo == null) return;
          rules.push({ maDon: k.maDon, glue: PS(k.loaiKeo), mats: c.mats, thick: c.thicks, lo: c.lo, hi: c.hi, spec: c.spec });
        });
        return;
      }
      var len = parseKeoCond(k.doDai || '');
      var soi = parseKeoCond(k.loaiSoi || '');   // Loại Sợi có thể nhúng độ dày ("0,07; 0,085")
      var ghi = parseKeoCond(k.ghiChu || '');    // Ghi Chú thường chứa điều kiện ĐỘ DÀI (vd "dưới 10mm", "từ 10mm")
      var thicks = parseKeoCond(k.doDay || '').thicks.concat(soi.thicks);
      // Điều kiện ĐỘ DÀI: ưu tiên cột Độ Dài; nếu trống lấy từ Loại Sợi, rồi Ghi Chú.
      if (len.lo == null && soi.lo != null) { len = soi; }
      if (len.lo == null && ghi.lo != null) { len = ghi; }
      rules.push({
        maDon: k.maDon, glue: PS(k.loaiKeo),
        mats: soi.mats, thick: thicks,
        lo: len.lo, hi: len.hi, spec: len.spec,
      });
    });
    return rules;
  }
  /**
   * Tra keo cho 1 component {maDon, material, thickness, mm}.
   * Quy tắc phải THỎA MỌI điều kiện nó có (độ dài · độ dày · material) — vi phạm là LOẠI.
   * Chọn quy tắc PHÙ HỢP NHẤT: điều kiện độ dài đặc hiệu hơn thắng (5~8mm > từ 9mm > tất cả);
   * cùng mức thì material khớp DÀI hơn thắng ("Premium Faux Mink" > "Faux Mink");
   * quy tắc không có điều kiện nào bị bỏ qua (tránh khớp bừa mọi dòng).
   */
  function glueFor(rules, comp) {
    var mat = normTxt(comp.material).replace(/\d+(?:[.,]\d+)?/g, ' ').replace(/\s+/g, ' ').trim();
    var mm = Number(comp.mm);
    var tk = thickKey(comp.thickness);
    var best = null, bestScore = -1;
    (rules || []).forEach(function (r) {
      if (comp.maDon && r.maDon && r.maDon !== comp.maDon) return;
      var hasMat = r.mats && r.mats.length, hasThick = r.thick && r.thick.length;
      if (!hasMat && !hasThick && r.lo == null) return;   // quy tắc rỗng → bỏ
      // ---- ĐIỀU KIỆN LỌC CỨNG: vi phạm bất kỳ → LOẠI ----
      if (r.lo != null) { if (!isFinite(mm) || mm < r.lo || mm > r.hi) return; }
      if (hasThick) { if (!tk || r.thick.indexOf(tk) < 0) return; }
      var matHit = 0;
      if (hasMat) {
        if (!mat) return;
        var hit = -1;
        r.mats.forEach(function (a) {
          var an = normTxt(a).replace(/\d+(?:[.,]\d+)?/g, ' ').replace(/\s+/g, ' ').trim();
          if (!an) return;
          if (mat === an) hit = Math.max(hit, an.length + 50);        // khớp chính xác
          // CHỈ 1 CHIỀU: material của dòng CHỨA tên rule ("premium faux mink" chứa "faux mink" → rule
          // Faux Mink áp được, nhưng rule "Premium Faux Mink" KHÔNG áp cho dòng "Faux Mink")
          else if (mat.indexOf(an) >= 0) hit = Math.max(hit, an.length);
        });
        if (hit < 0) return;
        matHit = hit;
      }
      // ---- CHẤM ĐIỂM theo THỨ TỰ ƯU TIÊN: Material > Thickness > Length ----
      // Material trọng số cao nhất (rule chỉ-định-material luôn thắng); rồi Thickness; rồi Length
      // (khoảng độ dài đặc hiệu spec3 > nửa hở spec2 > tất cả spec0) chỉ để phá hoà bậc thấp nhất.
      var score = (matHit + (hasMat ? 1 : 0)) * 1000000 + (hasThick ? 1000 : 0) + (r.spec || 0);
      if (score > bestScore) { best = r; bestScore = score; }
    });
    return best ? best.glue : '';
  }
  // ===== OVERRIDE KEO THEO ĐỘ CONG (cấu hình chung, KHÔNG hardcode theo đơn) =====
  // Quy chuẩn công ty: các độ cong này LUÔN dùng "Keo 2mm" (keo của DẢI NGẮN NHẤT),
  // bất kể quy tắc độ dài. Sửa danh sách ở đây để đổi cấu hình.
  var OVERRIDE_2MM_CURLS = ['LB', 'LC', 'LJ', 'LC+'];
  function isOverrideCurl(k) { return OVERRIDE_2MM_CURLS.indexOf(k) >= 0; }
  /** "Keo 2mm" cho (material, thickness): keo áp cho DẢI NGẮN NHẤT — tra tại mm nhỏ nhất có rule khớp. */
  function glueForShort(rules, comp) {
    for (var mm = 1; mm <= 30; mm++) {
      var g = glueFor(rules, { maDon: comp.maDon, material: comp.material || comp.detail || '', thickness: comp.thickness, mm: mm });
      if (g) return g;
    }
    return glueFor(rules, comp);   // fallback: theo mm thật
  }
  /** Tất cả mã keo của 1 dòng đơn (duyệt từng mm trong dải) — dùng cho Tổng hợp Box. */
  function orderGlues(rules, o) {
    var rg = parseRange(o.length); if (!rg) return [];
    var seen = {}, out = [];
    for (var mm = rg.lo; mm <= rg.hi; mm++) {
      var g = glueFor(rules, { maDon: o.maDon, material: o.material || o.detail || '', thickness: o.thickness, mm: mm });
      if (g && !seen[g]) { seen[g] = 1; out.push(g); }
    }
    return out;
  }

  /* ---------------- STEP 4 — Cuốn · Box ---------------- */
  function buildSummary(data1) {
    var single = 0, mix = 0;
    data1.forEach(function (r) { if (r.mixSingle === 'Single') single += r.sl; else mix += r.sl; });
    return { day: single + mix, single: single, mix: mix };
  }
  function buildCuonBox(data1, orders) {
    orders = orders || []; var meta = {};
    orders.forEach(function (o) { meta[o.codeSoi + '|' + o.length] = o; });
    var tree = {};
    data1.forEach(function (r) {
      var c = tree[r.codeSoi] || (tree[r.codeSoi] = { length: {}, total: 0 });
      var L = c.length[r.length] || (c.length[r.length] = { curl: {}, total: 0 });
      L.curl[r.curl] = (L.curl[r.curl] || 0) + r.sl; L.total += r.sl; c.total += r.sl;
    });
    var rows = [], grand = 0, grandCurls = {};
    CURLS.forEach(function (k) { grandCurls[k] = 0; });
    Object.keys(tree).sort().forEach(function (code) {
      var c = tree[code], subCurls = {};
      CURLS.forEach(function (k) { subCurls[k] = 0; });
      Object.keys(c.length).forEach(function (len) {
        var L = c.length[len], m = meta[code + '|' + len] || {}, curls = {};
        CURLS.forEach(function (k) { curls[k] = L.curl[k] || 0; subCurls[k] += curls[k]; grandCurls[k] += curls[k]; });
        rows.push({ type: 'row', codeSoi: code, length: len, curls: curls, tong: L.total, mixSingle: m.mixSingle || 'Mix' });
      });
      rows.push({ type: 'subtotal', codeSoi: code, curls: subCurls, tong: c.total }); grand += c.total;
    });
    rows.push({ type: 'grand', curls: grandCurls, tong: grand });
    return { rows: rows, grand: grand, summary: buildSummary(data1) };
  }
  /** Bảng IN chi tiết per-MM: rows theo (code,length,mm) + subtotal + grand.
   *  keoRules (tuỳ chọn): tra "Keo nhiệt" cho TỪNG dòng theo (material, thickness, mm) —
   *  cùng 1 dải nhưng mm khác nhau có thể ra keo khác nhau. Không tra được → fallback
   *  cột Keo Nhiệt khách ghi sẵn trên dòng đơn (ghiChuKeo). */
  function buildCuonBoxSheet(data1, orders, keoRules, keoMalformed) {
    keoMalformed = keoMalformed || {};
    // nhóm theo MÃ ĐƠN + Code Sợi (cùng code ở 2 đơn khác nhau không gộp lẫn)
    orders = orders || []; var meta = {};
    orders.forEach(function (o) { meta[o.maDon + '|' + o.codeSoi + '|' + o.length] = o; });
    var tree = {};
    data1.forEach(function (r) {
      var ck = r.maDon + '|' + r.codeSoi;
      var c = tree[ck] || (tree[ck] = { maDon: r.maDon, codeSoi: r.codeSoi, rows: {}, order: [], total: 0 });
      // TÁCH DÒNG theo material + độ dày: cùng code sợi nhưng khác material
      // (Premium Faux Mink ≠ Faux Mink) phải là 2 component riêng với keo riêng
      var key = r.length + '|' + r.mm + '|' + (r.material || '') + '|' + (r.thickness || '');
      var g = c.rows[key];
      if (!g) { g = c.rows[key] = { length: r.length, mm: r.mm, curls: {}, tong: 0, keoSet: {}, keo2mmSet: {}, material: r.material || '', thickness: r.thickness || '' }; c.order.push(key); }
      g.curls[r.curl] = (g.curls[r.curl] || 0) + r.sl; g.tong += r.sl; c.total += r.sl;
      // KEO TRA THEO TỪNG DÒNG data1 (material + độ dày + mm CỦA CHÍNH DÒNG) — không qua meta gộp
      var k1 = '', k2 = '';
      if (keoMalformed[r.maDon]) {
        // BẢNG KEO SAI CẤU TRÚC → TUYỆT ĐỐI KHÔNG điền keo (kể cả fallback), chờ user sửa
        k1 = ''; k2 = '';
      } else {
        if (keoRules && keoRules.length) {
          k1 = glueFor(keoRules, { maDon: r.maDon, material: r.material || '', thickness: r.thickness, mm: r.mm });
          // OVERRIDE: "Keo 2mm" (keo dải ngắn nhất) cho các độ cong LB/LC/LJ/LC+
          k2 = glueForShort(keoRules, { maDon: r.maDon, material: r.material || '', thickness: r.thickness, mm: r.mm });
        }
        if (!k1) k1 = r.ghiChuKeo || '';
        if (!k2) k2 = k1;
      }
      if (k1) g.keoSet[k1] = 1;
      if (k2) g.keo2mmSet[k2] = 1;
    });
    var rows = [], grand = 0, stt = 0, grandCurls = {};
    CURLS.forEach(function (k) { grandCurls[k] = 0; });
    Object.keys(tree).sort().forEach(function (ck) {
      var c = tree[ck], subCurls = {};
      CURLS.forEach(function (k) { subCurls[k] = 0; });
      // Sắp trong 1 code sợi: theo TÊN GỌI NGUYÊN LIỆU trước (để cùng code khác material
      // KHÔNG lẫn lộn), rồi độ dài, rồi mm.
      c.order.sort(function (a, b) {
        var A = c.rows[a], B = c.rows[b];
        var ma = A.material || '', mb = B.material || '';
        if (ma !== mb) return ma < mb ? -1 : 1;
        if (A.length !== B.length) return A.length < B.length ? -1 : 1;
        return A.mm - B.mm;
      });
      // Trường hợp đặc biệt: 1 code sợi có ≥2 tên gọi nguyên liệu khác nhau → cờ để tô màu.
      var matSet = {};
      c.order.forEach(function (key) { matSet[c.rows[key].material || ''] = 1; });
      var multiMat = Object.keys(matSet).length > 1;
      c.order.forEach(function (key) {
        var g = c.rows[key], m = meta[c.maDon + '|' + c.codeSoi + '|' + g.length] || {};
        var keo = Object.keys(g.keoSet || {}).join(', ');
        var keo2mm = Object.keys(g.keo2mmSet || {}).join(', ');
        // tách độ cong THƯỜNG vs ĐẶC BIỆT (LB/LC/LJ/LC+); cộng dồn subtotal/grand toàn bộ trước
        var normC = {}, ovrC = {}, normTot = 0, ovrTot = 0, hasOvr = false;
        CURLS.forEach(function (k) {
          var v = g.curls[k] || 0; subCurls[k] += v; grandCurls[k] += v;
          if (isOverrideCurl(k)) { ovrC[k] = v; normC[k] = 0; ovrTot += v; if (v) hasOvr = true; }
          else { normC[k] = v; ovrC[k] = 0; normTot += v; }
        });
        var base = { maDon: c.maDon, codeSoi: c.codeSoi, length: g.length, mm: g.mm, box: m.box || '—', mixSingle: m.mixSingle || 'Mix', material: g.material || m.material || '', thickness: g.thickness || m.thickness || '', multiMat: multiMat };
        // Nếu có độ cong đặc biệt và keo 2mm KHÁC keo chuẩn → TÁCH 2 dòng, mỗi dòng 1 keo đúng
        if (hasOvr && keo2mm && keo2mm !== keo) {
          if (normTot > 0) rows.push(Object.assign({ type: 'row', stt: ++stt, curls: normC, tong: normTot, keo: keo, keo2mm: keo2mm }, base));
          rows.push(Object.assign({ type: 'row', stt: ++stt, curls: ovrC, tong: ovrTot, keo: keo2mm, keo2mm: keo2mm, ovrRow: true }, base));
        } else {
          var curls = {}; CURLS.forEach(function (k) { curls[k] = g.curls[k] || 0; });
          rows.push(Object.assign({ type: 'row', stt: ++stt, curls: curls, tong: g.tong, keo: keo, keo2mm: keo2mm }, base));
        }
      });
      rows.push({ type: 'subtotal', maDon: c.maDon, codeSoi: c.codeSoi, curls: subCurls, tong: c.total, multiMat: multiMat }); grand += c.total;
    });
    rows.push({ type: 'grand', curls: grandCurls, tong: grand });
    return { rows: rows, grand: grand, summary: buildSummary(data1) };
  }

  /* ---------------- pipeline ---------------- */
  function runPipeline(input) {
    var opt = input.opt || {};
    var s1 = runStep1(input.rawOrders, opt);
    // MIX: key theo "dải|số line" — nhiều bảng Mix cùng mã đơn được GỘP THEO KHÓA,
    // 2 bảng cùng dải khác số line vẫn độc lập (khóa khác nhau)
    var mixLabel = new MixLabel(), rangeInfo = {};
    (input.mixSheets || []).forEach(function (s) {
      var info = sheetRangeInfo(s);
      var keyed = buildMix(s.mmList, s.matrix, info.keys);
      var acc = mixLabel.byOrder[s.maDon];
      if (!acc) mixLabel.set(s.maDon, keyed);
      else for (var mm in keyed) { acc[mm] = acc[mm] || {}; for (var k in keyed[mm]) acc[mm][k] = keyed[mm][k]; }
      var ri = rangeInfo[s.maDon] || (rangeInfo[s.maDon] = { keys: [], labels: {} });
      info.keys.forEach(function (kk) { if (ri.keys.indexOf(kk) < 0) ri.keys.push(kk); ri.labels[kk] = info.labels[kk]; });
    });
    var keoRules = buildKeoRules(input.keoRows);
    // PHÁT HIỆN BẢNG KEO SAI CẤU TRÚC theo từng mã đơn:
    //  - đơn CÓ dòng keo nhưng cột Độ Dày chứa CHỮ (vd "Keo nâu 2mm") → lệch cột, sai cấu trúc; HOẶC
    //  - không tạo được quy tắc keo dùng được nào.
    var keoHasRows = {}, keoBadStruct = {};
    (input.keoRows || []).forEach(function (k) {
      if (!String(k.loaiKeo || '').trim()) return;
      keoHasRows[k.maDon] = 1;
      if (/[a-zA-Z]/.test(String(k.doDay || '').replace(/mm/gi, ''))) keoBadStruct[k.maDon] = 1;
    });
    var keoUsable = {};
    keoRules.forEach(function (r) { if ((r.mats && r.mats.length) || (r.thick && r.thick.length) || r.lo != null) keoUsable[r.maDon] = 1; });
    var keoMalformed = {};
    Object.keys(keoHasRows).forEach(function (m) { if (keoBadStruct[m] || !keoUsable[m]) keoMalformed[m] = 1; });
    // Bản đồ colorBlocks theo mã đơn + dải (chuẩn hoá khóa) → dùng để TÁCH dòng mix nhiều màu per code
    var colorBlocksByOrder = {};
    (input.mixSheets || []).forEach(function (s) {
      if (!s.colorBlocks) return;
      var mcb = colorBlocksByOrder[s.maDon] || (colorBlocksByOrder[s.maDon] = {});
      Object.keys(s.colorBlocks).forEach(function (rg) {
        var rk = String(rg).toLowerCase().replace(/~/g, '-'); if (!/mm$/.test(rk)) rk += 'mm';
        mcb[rk] = s.colorBlocks[rg];
      });
    });
    var data1 = buildData1(s1.orders, mixLabel, { strategy: opt.strategy || STRATEGIES.DAY, colorBlocks: colorBlocksByOrder });
    var lineByOrder = {};
    Object.keys(rangeInfo).forEach(function (m) {
      var lm = buildLineMatrix(mixLabel.get(m), { soiPerLine: opt.soiPerLine, ranges: rangeInfo[m].keys });
      lm.labels = rangeInfo[m].labels;   // key "6-13mm|18" → nhãn hiển thị "6-13mm (18 Lines)"
      lineByOrder[m] = lm;
    });
    var cuon = buildCuonBox(data1, s1.orders);
    var cuonSheet = buildCuonBoxSheet(data1, s1.orders, keoRules, keoMalformed);
    var keoByOrder = {};
    var maDons = {}; s1.orders.forEach(function (o) { maDons[o.maDon] = 1; });
    Object.keys(maDons).forEach(function (m) { keoByOrder[m] = (input.keoRows || []).filter(function (k) { return k.maDon === m; }); });
    return { orders: s1.orders, errors: s1.errors, stats: s1.stats, mixLabel: mixLabel, data1: data1, lineByOrder: lineByOrder, cuon: cuon, cuonSheet: cuonSheet, keoByOrder: keoByOrder, keoRules: keoRules, keoMalformed: keoMalformed };
  }

  /* ---------------- PARSER WORKBOOK (AOA từ SheetJS) ---------------- */
  // normalize('NFC'): file Excel của khách hay dùng Unicode tổ hợp (NFD) — "Số" ≠ "Số" nếu không chuẩn hoá
  var PS = function (v) {
    if (v == null) return '';
    var s = String(v);
    if (s.normalize) s = s.normalize('NFC');
    return s.trim();
  };
  var PN = function (v) { return Number(v) || 0; };
  function findCol(headers, name, exact) {
    var norm = function (x) { return PS(x).toLowerCase().replace(/\s+/g, ' '); };
    var target = norm(name);
    for (var i = 0; i < headers.length; i++) {
      var h = norm(headers[i]);
      if (exact ? h === target : (h && h.indexOf(target) >= 0)) return i;
    }
    return -1;
  }
  /** Sheet "Nhập Đơn" (AOA, header dòng 1) → rawOrders. */
  function parseNhapDonRows(aoa) {
    if (!aoa || !aoa.length) return [];
    var H = aoa[0] || [];
    var col = {
      seri: findCol(H, 'Seri', true), maDon: findCol(H, 'Mã Đơn'),
      codeSoi: findCol(H, 'Code Sợi'), ghiChu: findCol(H, 'Ghi Chú'),
      lines: findCol(H, 'Lines', true),
      detail: findCol(H, 'Detail'), material: findCol(H, 'Material'),
      thickness: findCol(H, 'Thickness'), length: findCol(H, 'Length'),
      mix: findCol(H, 'Mix/Single'), loaiHang: findCol(H, 'Loại Hàng'),
      label: findCol(H, 'Label Đơn'),
    };
    var curlCol = {};
    CURLS.forEach(function (k) { curlCol[k] = findCol(H, k, true); });
    var out = [];
    for (var r = 1; r < aoa.length; r++) {
      var row = aoa[r] || [];
      var seri = row[col.seri];
      if (seri == null || PS(seri) === '') continue;
      var curls = {};
      CURLS.forEach(function (k) {
        var v = curlCol[k] >= 0 ? PN(row[curlCol[k]]) : 0;
        if (v) curls[k] = v;
      });
      var lineRaw = col.lines >= 0 ? PS(row[col.lines]) : '';
      var line = PN(lineRaw.replace(/lines?/i, '').trim());
      var lengthV = col.length >= 0 ? row[col.length] : '';
      if (typeof lengthV === 'number') lengthV = String(lengthV);
      out.push({
        seri: Math.round(PN(seri)) || PS(seri),
        maDon: PS(row[col.maDon]), codeSoi: PS(row[col.codeSoi]),
        detail: PS(col.detail >= 0 ? row[col.detail] : ''),
        length: PS(lengthV),
        mixSingle: PS(col.mix >= 0 ? row[col.mix] : ''),
        curls: curls, line: line, lineRaw: lineRaw,
        loaiHang: PS(col.loaiHang >= 0 ? row[col.loaiHang] : ''),
        ghiChuKeo: PS(col.ghiChu >= 0 ? row[col.ghiChu] : ''),
        material: PS(col.material >= 0 ? row[col.material] : ''),
        thickness: PS(col.thickness >= 0 ? row[col.thickness] : ''),
        label: PS(col.label >= 0 ? row[col.label] : ''),
      });
    }
    return out;
  }
  /** Sheet "Label" → mixSheets[{maDon, mmList, matrix, ranges}]. */
  function parseLabelRows(aoa) {
    if (!aoa || !aoa.length) return [];
    var sheets = [], cur = null, mmColIdx = -1;
    for (var r = 0; r < aoa.length; r++) {
      var row = aoa[r] || [], mmIdx = -1, i;
      for (i = 0; i < row.length; i++) if (PS(row[i]).toUpperCase() === 'MM') { mmIdx = i; break; }
      if (mmIdx >= 0) {
        var ranges = [];
        for (i = mmIdx + 1; i < row.length; i++) {
          var v = PS(row[i]);
          if (v) ranges.push(v.toLowerCase().replace('~', '-'));
        }
        cur = { maDon: PS(row[mmIdx - 1]), mmList: [], matrix: [], ranges: ranges };
        mmColIdx = mmIdx;
        sheets.push(cur);
        continue;
      }
      if (!cur) continue;
      var mm = PN(row[mmColIdx]);
      if (!mm) continue;
      cur.mmList.push(mm);
      cur.matrix.push(cur.ranges.map(function (_, j) { return PN(row[mmColIdx + 1 + j]); }));
    }
    // bỏ các dòng mm cuối toàn 0 (sheet thật thường có mm dự phòng 18, 19, 20…)
    sheets.forEach(function (s) {
      var allZero = function (arr) { for (var i = 0; i < arr.length; i++) if (arr[i]) return false; return true; };
      while (s.mmList.length && allZero(s.matrix[s.matrix.length - 1])) {
        s.mmList.pop();
        s.matrix.pop();
      }
    });
    return sheets.filter(function (s) { return s.mmList.length; });
  }
  /** Sheet "Bảng Keo" → keoRows. */
  function parseKeoRows(aoa) {
    if (!aoa || !aoa.length) return [];
    var hr = -1, H = [], r;
    for (r = 0; r < Math.min(aoa.length, 10); r++) {
      if (findCol(aoa[r] || [], 'Loại Keo') >= 0) { hr = r; H = aoa[r]; break; }
    }
    if (hr < 0) return [];
    var col = {
      maDon: findCol(H, 'Mã Đơn'), keo: findCol(H, 'Loại Keo'),
      soi: findCol(H, 'Loại Sợi'), day: findCol(H, 'Độ dày'),
      dai: findCol(H, 'Độ Dài'), ghiChu: findCol(H, 'Ghi Chú'),
    };
    var out = [];
    for (r = hr + 1; r < aoa.length; r++) {
      var row = aoa[r] || [];
      if (!PS(row[col.maDon]) || !PS(row[col.keo])) continue;
      out.push({
        maDon: PS(row[col.maDon]), loaiKeo: PS(row[col.keo]),
        loaiSoi: PS(col.soi >= 0 ? row[col.soi] : ''),
        doDay: PS(col.day >= 0 ? row[col.day] : ''),
        doDai: PS(col.dai >= 0 ? row[col.dai] : ''),
        ghiChu: PS(col.ghiChu >= 0 ? row[col.ghiChu] : ''),
      });
    }
    return out;
  }
  function parseWorkbookData(sheets) {
    return {
      rawOrders: parseNhapDonRows(sheets.nhapDon),
      mixSheets: parseLabelRows(sheets.label),
      keoRows: parseKeoRows(sheets.keo),
    };
  }

  /**
   * PARSER ĐƠN KHÁCH — sheet "GỬI XƯỞNG" (file "Đơn gửi xưởng - <mã đơn> - <KH> - ...").
   * Chuẩn hoá về đúng cấu trúc Nhập Đơn nội bộ:
   *   - Bảng đơn (header có "Số Line" + "Single/Mix"): STT→Seri, Code NG.Liệu→Code Sợi,
   *     Số Line "24Lines"→24, Độ Dài giữ nguyên (kể cả dải * như *5~13mm),
   *     12 cột độ cong (Curl 1 → LC), Danh Mục→Label, Tên Gọi→Detail.
   *   - Bảng Mix của khách (dòng "Mix Length"): dải × mm → mixSheets (ranges động).
   *   - Bảng keo (Độ Dày | Mã Keo) → keoRows.
   *   - Meta: KH, tổng khay (CLS), tổng dây (Lines CLS) — để đối chiếu sau xử lý.
   * Trả null nếu sheet không đúng format.
   */
  function parseGuiXuongSheet(aoa, fileName) {
    if (!aoa || !aoa.length) return null;
    var i, r, q, row, rw, v;
    // mã đơn từ tên file: "Đơn gửi xưởng - 483P - C177 - ..." → 483P; "355P.1" → 355P.1 (giữ hậu tố .N)
    var maDon = '';
    var fm = String(fileName || '').match(/(\d+[A-Za-z]+(?:\.\d+)*)/);
    if (fm) maDon = fm[1];
    // ƯU TIÊN Mã Đơn khai TRONG SHEET (dòng đầu: header "Mã Đơn", giá trị ở dòng dưới) —
    // 2 file 355P và 355P.1 là 2 ĐƠN KHÁC NHAU dù tên file gần giống
    for (r = 0; r < Math.min(aoa.length, 5); r++) {
      row = aoa[r] || [];
      for (i = 0; i < row.length; i++) {
        if (PS(row[i]).toLowerCase() === 'mã đơn') {
          v = PS((aoa[r + 1] || [])[i]);
          // file copy thường ĐỔI TÊN (355P.1) nhưng ruột sheet vẫn ghi mã cũ (355P)
          // → tên file thắng khi nó MỞ RỘNG mã trong sheet; ngược lại tin sheet
          if (v && !(maDon && maDon !== v && maDon.indexOf(v) === 0)) maDon = v;
          r = 99; break;
        }
      }
    }
    // 1. tìm header bảng đơn: dòng có cả "Số Line" và "Single/Mix"
    var hr = -1, H = null;
    for (r = 0; r < aoa.length; r++) {
      row = aoa[r] || [];
      var hasSoLine = false, hasMix = false;
      for (i = 0; i < row.length; i++) {
        v = PS(row[i]).toLowerCase();
        if (v.indexOf('số line') >= 0) hasSoLine = true;
        if (v.indexOf('single/mix') >= 0 || v.indexOf('mix/single') >= 0) hasMix = true;   // 2 cách khách đặt tên cột
      }
      if (hasSoLine && hasMix) { hr = r; H = row; break; }
    }
    if (hr < 0) return null;
    var col = {
      stt: findCol(H, 'STT', true), soLine: findCol(H, 'Số Line'),
      code: findCol(H, 'Code'), doDay: findCol(H, 'Độ Dày'),
      nhom: findCol(H, 'Nhóm'), danhMuc: -1,
      tenGoi: findCol(H, 'Tên Gọi'), keoNhiet: findCol(H, 'Keo Nhiệt'),
      ghiChu: findCol(H, 'Ghi Chú', true),   // cột Ghi Chú THẬT của đơn khách (khác Keo Nhiệt)
      length: findCol(H, 'Độ Dài'), mix: findCol(H, 'Single/Mix'),
    };
    if (col.mix < 0) col.mix = findCol(H, 'Mix/Single');
    // Phân Loại: ưu tiên header chứa "Phân Loại" ("Danh Mục / Phân Loại");
    // fallback "Danh Mục" nhưng KHÔNG phải cột Code (header code của khách có thể
    // ghi "Code NG.Liệu (CLS) / - Danh Mục (FreMade) -" → tránh bắt nhầm)
    col.danhMuc = findCol(H, 'Phân Loại');
    if (col.danhMuc < 0) {
      for (i = 0; i < H.length; i++) {
        v = PS(H[i]).toLowerCase();
        if (v.indexOf('danh mục') >= 0 && v.indexOf('code') < 0) { col.danhMuc = i; break; }
      }
    }
    // Nhận diện ĐỘ CONG từ header: bỏ ghi chú "( )", khớp EXACT lõi; nếu không khớp thì lấy TỪ ĐẦU TIÊN.
    //   vd "L+ ( tem LC)" → "L+" · "B curl Label J" → "B" · "CC Curl Label C" → "CC" (header khách ghi lộn xộn).
    function curlOf(raw) {
      var core = PS(raw).replace(/\(.*?\)/g, '').trim(); if (!core) return null;
      for (var j = 0; j < CURLS.length; j++) if (CURLS[j].toLowerCase() === core.toLowerCase()) return CURLS[j];
      var first = core.split(/\s+/)[0];
      for (var j2 = 0; j2 < CURLS.length; j2++) if (CURLS[j2].toLowerCase() === first.toLowerCase()) return CURLS[j2];
      return null;
    }
    var curlCol = {}, curlNote = {}, curlRemap = [];
    CURLS.forEach(function (k) { curlCol[k] = -1; });
    (function () {
      var endIdx = findCol(H, 'Tổng Số Hộp');
      var end = (endIdx > 0 ? endIdx : H.length);
      for (var i = (col.mix >= 0 ? col.mix + 1 : 0); i < end; i++) {
        var raw = PS(H[i]); if (!raw) continue;
        var k = curlOf(raw);
        if (k && curlCol[k] < 0) {
          curlCol[k] = i;
          var coreExact = raw.replace(/\(.*?\)/g, '').trim();
          if (coreExact.toLowerCase() === k.toLowerCase()) { var note = raw.replace(coreExact, '').trim(); if (note) curlNote[k] = note; }
          else curlRemap.push({ col: i, header: raw, curl: k });   // header ghi lộn xộn → GHI LẠI để kiểm tra
        }
      }
    })();
    // tương thích file cũ: cột nào chưa map thì thử khớp chính xác nguyên header
    CURLS.forEach(function (k) { if (curlCol[k] < 0) curlCol[k] = findCol(H, k, true); });
    // CỨU ĐƠN LỆCH HEADER: nếu vùng độ cong (giữa Single/Mix và Tổng Số Hộp) có ĐÚNG 16 cột
    // mà khớp-theo-tên còn THIẾU → map theo VỊ TRÍ chuẩn (J B C CC D DD L M V L+ LD LC+ LC LB LJ Curl 1)
    // → KHÔNG mất số độ cong dù header ghi sai/lệch.
    (function () {
      var endIdx = findCol(H, 'Tổng Số Hộp'); if (endIdx <= 0 || col.mix < 0) return;
      var region = endIdx - (col.mix + 1), mapped = 0;
      CURLS.forEach(function (k) { if (curlCol[k] >= 0) mapped++; });
      if (region === CURLS.length && mapped < CURLS.length) {
        CURLS.forEach(function (k, j) { curlCol[k] = col.mix + 1 + j; });
      }
    })();
    // KIỂM TRA CẤU TRÚC ĐỘ CONG: cột giữa "Single/Mix" và "Tổng Số Hộp" phải khớp chuẩn 16 cột
    var curlWarnings = [];
    (function(){
      var endIdx = findCol(H, 'Tổng Số Hộp');
      var hdr = [], i2, v2;
      for (i2 = col.mix + 1; i2 < (endIdx > 0 ? endIdx : H.length); i2++) {
        v2 = PS(H[i2]); if (!v2) continue;
        hdr.push(curlOf(v2) || v2.replace(/\(.*?\)/g, '').trim());   // quy về tên độ cong chuẩn nếu nhận diện được
      }
      var extras = hdr.filter(function (v) { return CURLS.indexOf(v) < 0; });
      var inStruct = hdr.filter(function (v) { return CURLS.indexOf(v) >= 0; });
      var expected = CURLS.filter(function (k) { return inStruct.indexOf(k) >= 0; });
      if (extras.length) curlWarnings.push('Cột độ cong LẠ ngoài cấu trúc: ' + extras.join(', '));
      if (inStruct.join('|') !== expected.join('|')) curlWarnings.push('Thứ tự cột độ cong LỆCH cấu trúc chuẩn (đúng: ' + expected.join(' ') + ')');
    })();
    // Ký hiệu HÀNG ĐẶC BIỆT (không phân biệt hoa/thường). Quét MỌI cột của từng dòng đơn:
    //  laser/liigos→LZ · easy fan single→1ES · easy fan double→2ES · <số>D-U (vd 3D-U)→DU
    var SPECIAL_SYM = [
      ['LZ',  /laser|liigos/i],
      ['1ES', /easy\s*fan\s*single/i],
      ['2ES', /easy\s*fan\s*double/i],
      ['DU',  /\d\s*d\s*[-\/]\s*u/i]
    ];
    // 2. đọc dòng đơn (bỏ dòng #REF!/#N/A/trống)
    var out = [];
    for (r = hr + 1; r < aoa.length; r++) {
      row = aoa[r] || [];
      var stt = row[col.stt];
      if (stt == null || PS(stt) === '') continue;
      var sttN = Number(stt);
      if (!isFinite(sttN) || sttN <= 0) continue;
      var code = PS(row[col.code]), len = PS(row[col.length]);
      if (!code || code.charAt(0) === '#' || len.charAt(0) === '#') continue;
      var _rowTxt = row.map(PS).join(' ¦ '), _kw = {};
      SPECIAL_SYM.forEach(function (p) { if (p[1].test(_rowTxt)) _kw[p[0]] = 1; });
      var curls = {};
      CURLS.forEach(function (k) {
        var ci = curlCol[k];
        if (ci >= 0) { var q2 = PN(row[ci]); if (q2) curls[k] = q2; }
      });
      // KHÔNG bỏ dòng có Mã + Độ dài dù chưa dò được ô độ cong (đơn lệch cấu trúc) → GIỮ để hiện & sửa.
      // Chỉ bỏ dòng RỖNG thật (không có cả mã lẫn độ dài).
      if (!Object.keys(curls).length && !code && !len) continue;
      var soLineRaw = PS(col.soLine >= 0 ? row[col.soLine] : '');
      out.push({
        seri: Math.round(sttN), maDon: maDon, codeSoi: code,
        detail: PS(col.danhMuc >= 0 ? row[col.danhMuc] : ''),   // Detail = cột "Danh Mục / Phân Loại"
        length: len, mixSingle: PS(row[col.mix]), curls: curls,
        line: PN(soLineRaw.replace(/lines?/i, '').trim()),
        lineRaw: soLineRaw,
        loaiHang: PS(col.nhom >= 0 ? row[col.nhom] : ''),      // Loại Hàng = cột "Nhóm" của đơn khách
        ghiChu: PS(col.ghiChu >= 0 ? row[col.ghiChu] : ''),    // Ghi Chú nguyên văn từ file khách
        ghiChuKeo: PS(col.keoNhiet >= 0 ? row[col.keoNhiet] : ''),
        material: PS(col.tenGoi >= 0 ? row[col.tenGoi] : ''),
        thickness: PS(col.doDay >= 0 ? row[col.doDay] : ''),
        label: PS(col.danhMuc >= 0 ? row[col.danhMuc] : ''),
        _kw: _kw,
      });
    }
    if (!out.length) return null;
    // Áp ký hiệu đặc biệt: XUẤT HIỆN Ở MỌI DÒNG → gắn vào MÃ ĐƠN (676P-LZ);
    //                      chỉ MỘT SỐ dòng → gắn vào CODE SỢI dòng đó (3.MK.7-LZ).
    var specialApplied = [];
    SPECIAL_SYM.forEach(function (p) {
      var sym = p[0], hit = out.filter(function (o) { return o._kw && o._kw[sym]; });
      if (!hit.length) return;
      if (hit.length === out.length) { var suf = '-' + sym; out.forEach(function (o) { o.maDon += suf; }); maDon += suf; specialApplied.push(sym + ' (cả đơn → mã đơn)'); }
      else { hit.forEach(function (o) { o.codeSoi += '-' + sym; }); specialApplied.push(sym + ' (' + hit.length + ' dòng → code sợi)'); }
    });
    out.forEach(function (o) { delete o._kw; });
    // 3. bảng Mix của khách: dòng "Mix Length" + các dòng "4mm".."20mm".
    //    QUÉT TOÀN SHEET, nhận NHIỀU bảng Mix (kể cả nhiều bảng cùng dải khác số line,
    //    hoặc nhiều bảng nằm cạnh nhau trên cùng dòng). Header dải có thể kèm
    //    số line: "6~13mm (16 Lines)" → lineCounts; không ghi thì pipeline tự lấy tổng cột.
    var mixSheets = [];
    for (r = 0; r < aoa.length; r++) {
      if (r === hr) continue;
      row = aoa[r] || [];
      for (i = 0; i < row.length; i++) {
        if (PS(row[i]).toLowerCase() !== 'mix length') continue;
        var mi = i;
        var ranges = [], rangeCols = [], lineCounts = [], ci;
        for (ci = mi + 1; ci < row.length; ci++) {
          v = PS(row[ci]);
          if (!v) continue;
          if (v.toLowerCase() === 'mix length') break;   // gặp bảng Mix kế bên → dừng bảng này
          var lm = v.match(/\((\d+)\s*lines?\)/i);       // "6~13mm (16 Lines)"
          var rg = v.replace(/\(.*?\)/g, '').trim().toLowerCase().replace('~', '-');
          if (!parseRange(rg.replace(/mm$/, ''))) continue;   // không phải cột dải → bỏ qua
          ranges.push(rg); rangeCols.push(ci); lineCounts.push(lm ? +lm[1] : null);
        }
        if (!ranges.length) continue;
        // CỘT MIX MÀU: dưới header không phải số mà là CẶP "9mm | Tên màu" (mỗi cặp = 1 sợi,
        // 1 Mix chứa nhiều màu/code sợi — vd 8~12mm 18 Lines = Pink×4 + H.Pink×5 + L.Violet×4 + Violet×5).
        // Nhận diện: ô đầu tiên dưới header khớp "<n>mm" và ô bên phải có chữ → đếm cặp theo mm.
        var colorCols = {}, colorBlocksByRange = {};
        ranges.forEach(function (_rg, j) {
          var cc0 = rangeCols[j];
          for (var q2 = r + 1; q2 < aoa.length; q2++) {
            var cell0 = PS((aoa[q2] || [])[cc0]);
            if (!cell0) continue;
            if (/^\d+\s*mm$/i.test(cell0) && PS((aoa[q2] || [])[cc0 + 1])) {
              var cnt = {}, started = false, blocks = [], cur = null;
              for (var q3 = r + 1; q3 < aoa.length; q3++) {
                var m2 = PS((aoa[q3] || [])[cc0]).match(/^(\d+)\s*mm$/i);
                var colr = PS((aoa[q3] || [])[cc0 + 1]).trim();
                if (m2 && colr) {
                  cnt[+m2[1]] = (cnt[+m2[1]] || 0) + 1; started = true;
                  // gom CẶP thành KHỐI MÀU theo thứ tự (mỗi màu liên tiếp = 1 khối = 1 code sợi)
                  if (!cur || cur.color !== colr) { cur = { color: colr, dist: {}, lines: 0 }; blocks.push(cur); }
                  cur.dist[+m2[1]] = (cur.dist[+m2[1]] || 0) + 1; cur.lines++;
                } else if (started) break;
              }
              colorCols[j] = cnt;
              colorBlocksByRange[ranges[j]] = blocks;   // khóa theo dải "8-12mm" → [{color,dist,lines}...]
            }
            break;   // chỉ xét ô không-rỗng ĐẦU TIÊN dưới header
          }
        });
        var mmList = [], matrix = [];
        for (q = r + 1; q < aoa.length; q++) {
          rw = aoa[q] || [];
          var mmm = PS(rw[mi]).match(/^(\d+)\s*mm$/i);
          if (!mmm) { if (mmList.length) break; else continue; }
          var mmCur = +mmm[1];
          mmList.push(mmCur);
          matrix.push(rangeCols.map(function (cc, j2) {
            return colorCols[j2] ? (colorCols[j2][mmCur] || 0) : PN(rw[cc]);
          }));
        }
        var allZero = function (arr) { for (var z = 0; z < arr.length; z++) if (arr[z]) return false; return true; };
        while (mmList.length && allZero(matrix[matrix.length - 1])) { mmList.pop(); matrix.pop(); }
        if (mmList.length) mixSheets.push({ maDon: maDon, mmList: mmList, matrix: matrix, ranges: ranges, lineCounts: lineCounts, colorBlocks: colorBlocksByRange });
        i = ci - 1;   // tiếp tục quét từ vị trí dừng (bảng kế bên nếu có)
      }
    }
    // 4. bảng keo: header có "Mã Keo"/"Loại Keo" (+ tuỳ chọn: Loại Sợi/Nguyên Liệu, Độ Dày, Độ Dài).
    //    Đọc ĐỦ CỘT để dựng QUY TẮC keo: 1 Material có thể nhiều keo theo khoảng chiều dài.
    //    Ô GỘP (merged): dòng phụ chỉ có Độ Dài + Mã Keo → kế thừa Loại Sợi/Độ Dày dòng trên.
    var keoRows = [];
    for (r = 0; r < aoa.length; r++) {
      if (r === hr) continue;   // header bảng đơn cũng có "Độ Dày"/"Độ Dài" → bỏ qua
      row = aoa[r] || [];
      var di = -1, ki = -1, si = -1, li = -1, gi = -1;
      for (i = 0; i < row.length; i++) {
        v = PS(row[i]).toLowerCase();
        if (v === 'độ dày' || v === 'độ dày keo') di = i;
        if (v === 'mã keo' || v === 'loại keo') ki = i;
        if (v === 'loại sợi' || v === 'nguyên liệu' || v === 'tên gọi nguyên liệu' || v === 'tên gọi' || v === 'material') si = i;
        if (v === 'độ dài' || v === 'độ dài (mm)') li = i;
        if (v === 'ghi chú') gi = i;
      }
      if (ki < 0 || (di < 0 && si < 0 && li < 0)) continue;   // cần Mã Keo + ít nhất 1 cột thuộc tính
      var lastSoi = '', lastDay = '';
      for (q = r + 1; q < aoa.length; q++) {
        rw = aoa[q] || [];
        var dd = di >= 0 ? PS(rw[di]) : '', mk = PS(rw[ki]);
        var ls = si >= 0 ? PS(rw[si]) : '', ld = li >= 0 ? PS(rw[li]) : '';
        if (!dd && !mk && !ls && !ld) break;
        if (!mk) continue;
        if (ls) lastSoi = ls; else if (ld) ls = lastSoi;   // kế thừa ô gộp khi có Độ Dài
        if (dd) lastDay = dd; else if (ld) dd = lastDay;
        var gh = gi >= 0 ? PS(rw[gi]) : '';
        // GIỮ NGUYÊN GỐC: mỗi mã keo = 1 dòng, giữ Ghi Chú thật của khách.
        // Không bung chữ tự do ở đây nữa — việc bung thành QUY TẮC keo được chuyển
        // sang buildKeoRules() để Bảng Keo (Step 4) hiển thị đúng dữ liệu gốc,
        // còn Step 5/6 vẫn gán keo y như cũ.
        keoRows.push({ maDon: maDon, loaiKeo: mk, loaiSoi: ls, doDay: dd, doDai: ld, ghiChu: gh });
      }
      break;
    }
    // 5. meta đối chiếu: KH, tổng khay (CLS), tổng dây (Lines CLS)
    var meta = { maDon: maDon };
    for (r = 0; r < Math.min(aoa.length, 5); r++) {
      row = aoa[r] || [];
      for (i = 0; i < row.length; i++) {
        var h = PS(row[i]).toUpperCase();
        var below = (aoa[r + 1] || [])[i];
        if (h === 'KH' && meta.khach == null) meta.khach = PS(below);
        if (h === 'CLS' && meta.tongKhay == null) meta.tongKhay = PN(below);
        if (h === 'LINES CLS' && meta.tongDay == null) meta.tongDay = PN(below);
      }
    }
    // CỘT trong vùng độ cong CÓ SỐ LIỆU nhưng KHÔNG nhận diện được độ cong → NGUY CƠ MẤT DỮ LIỆU (sẽ chặn bước sau)
    meta.curlUnmapped = (function () {
      var mappedSet = {}; CURLS.forEach(function (k) { if (curlCol[k] >= 0) mappedSet[curlCol[k]] = 1; });
      var endU = findCol(H, 'Tổng Số Hộp'); endU = endU > 0 ? endU : H.length;
      var res = [];
      for (var ci = (col.mix >= 0 ? col.mix + 1 : 0); ci < endU; ci++) {
        if (mappedSet[ci]) continue;
        var cnt = 0;
        for (var rr = hr + 1; rr < aoa.length; rr++) {
          var st = aoa[rr] && aoa[rr][col.stt]; if (st == null || PS(st) === '') continue;
          var nn = Number(st); if (!isFinite(nn) || nn <= 0) continue;
          if (PN(aoa[rr][ci])) cnt++;
        }
        if (cnt > 0) res.push({ col: ci, header: PS(H[ci]), count: cnt });
      }
      return res;
    })();
    meta.curlWarnings = curlWarnings;   // [] = cấu trúc độ cong khớp chuẩn
    meta.curlRemap = curlRemap;         // [{col,header,curl}] — header lộn xộn đã quy đổi (để kiểm tra ở Danh sách lỗi)
    meta.curlNotes = curlNote;          // vd { "L+": "( tem LC)" } — ghi chú độ cong từ header, hiện ở Box
    meta.specialSym = specialApplied;   // vd ["LZ (cả đơn → mã đơn)"] — ký hiệu hàng đặc biệt đã áp
    return { rawOrders: out, mixSheets: mixSheets, keoRows: keoRows, keoNotes: null, curlNotes: curlNote, meta: meta };
  }

  /* Parse RAW vùng "Mix Length + cặp (9mm | tên màu)" (dán tay) → mixSheets có colorBlocks.
     Dùng CHÍNH logic của parseGuiXuongSheet để nhập thủ công Mix nhiều màu khớp 100% auto. */
  function parseMixColorAOA(aoa, maDon) {
    if (!aoa || !aoa.length) return [];
    maDon = maDon || '';
    var mixSheets = [], r, i, v, q, rw;
    for (r = 0; r < aoa.length; r++) {
      var row = aoa[r] || [];
      for (i = 0; i < row.length; i++) {
        if (PS(row[i]).toLowerCase() !== 'mix length') continue;
        var mi = i, ranges = [], rangeCols = [], lineCounts = [], ci;
        for (ci = mi + 1; ci < row.length; ci++) {
          v = PS(row[ci]); if (!v) continue;
          if (v.toLowerCase() === 'mix length') break;
          var lm = v.match(/\((\d+)\s*lines?\)/i);
          var rg = v.replace(/\(.*?\)/g, '').trim().toLowerCase().replace('~', '-');
          if (!parseRange(rg.replace(/mm$/, ''))) continue;
          ranges.push(rg); rangeCols.push(ci); lineCounts.push(lm ? +lm[1] : null);
        }
        if (!ranges.length) continue;
        var colorCols = {}, colorBlocksByRange = {};
        ranges.forEach(function (_rg, j) {
          var cc0 = rangeCols[j];
          for (var q2 = r + 1; q2 < aoa.length; q2++) {
            var cell0 = PS((aoa[q2] || [])[cc0]); if (!cell0) continue;
            if (/^\d+\s*mm$/i.test(cell0) && PS((aoa[q2] || [])[cc0 + 1])) {
              var cnt = {}, started = false, blocks = [], cur = null;
              for (var q3 = r + 1; q3 < aoa.length; q3++) {
                var m2 = PS((aoa[q3] || [])[cc0]).match(/^(\d+)\s*mm$/i);
                var colr = PS((aoa[q3] || [])[cc0 + 1]).trim();
                if (m2 && colr) {
                  cnt[+m2[1]] = (cnt[+m2[1]] || 0) + 1; started = true;
                  if (!cur || cur.color !== colr) { cur = { color: colr, dist: {}, lines: 0 }; blocks.push(cur); }
                  cur.dist[+m2[1]] = (cur.dist[+m2[1]] || 0) + 1; cur.lines++;
                } else if (started) break;
              }
              colorCols[j] = cnt; colorBlocksByRange[ranges[j]] = blocks;
            }
            break;
          }
        });
        var mmList = [], matrix = [];
        for (q = r + 1; q < aoa.length; q++) {
          rw = aoa[q] || [];
          var mmm = PS(rw[mi]).match(/^(\d+)\s*mm$/i);
          if (!mmm) { if (mmList.length) break; else continue; }
          var mmCur = +mmm[1]; mmList.push(mmCur);
          matrix.push(rangeCols.map(function (cc, j2) { return colorCols[j2] ? (colorCols[j2][mmCur] || 0) : PN(rw[cc]); }));
        }
        var allZero = function (arr) { for (var z = 0; z < arr.length; z++) if (arr[z]) return false; return true; };
        while (mmList.length && allZero(matrix[matrix.length - 1])) { mmList.pop(); matrix.pop(); }
        if (mmList.length) mixSheets.push({ maDon: maDon, mmList: mmList, matrix: matrix, ranges: ranges, lineCounts: lineCounts, colorBlocks: colorBlocksByRange });
        i = ci - 1;
      }
    }
    return mixSheets;
  }

  /* ---------------- dữ liệu mẫu 233S ---------------- */
  var MM_233S = [4,5,6,7,8,9,10,11,12,13,14,15,16,17];
  var MIX_233S = [
    [0,4,0,0,0,0,2,1,0,0,0,0,1],[6,4,0,0,0,0,2,1,2,0,0,0,1],[6,5,0,2,0,2,2,2,2,0,0,0,1],
    [6,5,0,2,0,2,2,2,2,2,0,2,1],[0,0,0,2,0,2,2,2,2,2,2,2,1],[0,0,0,2,0,3,2,2,2,3,2,3,0],
    [0,0,0,2,0,3,2,2,2,3,2,3,0],[0,0,0,2,0,2,2,2,2,3,3,3,0],[0,0,0,2,0,2,2,2,2,2,3,3,0],
    [0,0,4,2,5,2,0,2,2,2,3,2,0],[0,0,4,2,5,0,0,0,0,1,3,0,0],[0,0,4,0,4,0,0,0,0,0,0,0,0],
    [0,0,3,0,4,0,0,0,0,0,0,0,0],[0,0,3,0,0,0,0,0,0,0,0,0,0]];
  // 39 đơn THẬT từ sheet "Nhập Đơn" — curls = {độ cong: SL}
  var ORDERS_233S = [
    { seri:1,  maDon:'233S', codeSoi:'158.BSC.5',             detail:'Velvet Faux Mink', length:'6~14',  mixSingle:'Mix',    curls:{M:20},                    line:18, label:'6~14' },
    { seri:2,  maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'6~14',  mixSingle:'Mix',    curls:{M:10},                    line:18, label:'6~14' },
    { seri:3,  maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'13~16', mixSingle:'Mix',    curls:{M:10},                    line:18, label:'13~16' },
    { seri:4,  maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'6~13',  mixSingle:'Mix',    curls:{M:10},                    line:18, label:'6~13' },
    { seri:5,  maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'4~12',  mixSingle:'Mix',    curls:{J:10},                    line:18, label:'4~12' },
    { seri:6,  maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'4~13',  mixSingle:'Mix',    curls:{B:10},                    line:18, label:'4~13' },
    { seri:7,  maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'4~7',   mixSingle:'Mix',    curls:{B:10},                    line:18, label:'4~7' },
    { seri:8,  maDon:'233S', codeSoi:'158.BSC.5',             detail:'Velvet Faux Mink', length:'6~14',  mixSingle:'Mix',    curls:{C:10, CC:10},             line:18, label:'6~14' },
    { seri:9,  maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'6~14',  mixSingle:'Mix',    curls:{C:20, CC:20},             line:18, label:'6~14' },
    { seri:10, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'4~7',   mixSingle:'Mix',    curls:{C:10},                    line:18, label:'4~7' },
    { seri:11, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'5~7',   mixSingle:'Mix',    curls:{M:10},                    line:18, label:'5~7' },
    { seri:12, maDon:'233S', codeSoi:'247.MKPS.10',           detail:'Ultra Faux Mink',  length:'6~13',  mixSingle:'Mix',    curls:{C:20},                    line:18, label:'6~13' },
    { seri:13, maDon:'233S', codeSoi:'247.MKPS.10',           detail:'Ultra Faux Mink',  length:'5~13',  mixSingle:'Mix',    curls:{CC:10},                   line:18, label:'5~13' },
    { seri:14, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'13~17', mixSingle:'Mix',    curls:{CC:10},                   line:18, label:'13~17' },
    { seri:15, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'7~14',  mixSingle:'Mix',    curls:{D:10},                    line:18, label:'7~14' },
    { seri:16, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'6~13',  mixSingle:'Mix',    curls:{L:10},                    line:18, label:'6~13' },
    { seri:17, maDon:'233S', codeSoi:'247.MKPS.10',           detail:'Ultra Faux Mink',  length:'6~13',  mixSingle:'Mix',    curls:{L:10},                    line:18, label:'6~13' },
    { seri:18, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'6~14',  mixSingle:'Mix',    curls:{LD:10},                   line:18, label:'6~14' },
    { seri:19, maDon:'233S', codeSoi:'247.MKPS.10',           detail:'Ultra Faux Mink',  length:'6~14',  mixSingle:'Mix',    curls:{LD:10},                   line:18, label:'6~14' },
    { seri:20, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'7~13',  mixSingle:'Mix',    curls:{V:10},                    line:18, label:'7~13' },
    { seri:21, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'7',     mixSingle:'Single', curls:{CC:10},                   line:18, label:'' },
    { seri:22, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'8',     mixSingle:'Single', curls:{CC:10},                   line:18, label:'' },
    { seri:23, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'9',     mixSingle:'Single', curls:{CC:10},                   line:18, label:'' },
    { seri:24, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'10',    mixSingle:'Single', curls:{CC:10},                   line:18, label:'' },
    { seri:25, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'11',    mixSingle:'Single', curls:{CC:10},                   line:18, label:'' },
    { seri:26, maDon:'233S', codeSoi:'245.MKPS.7',            detail:'Ultra Faux Mink',  length:'12',    mixSingle:'Single', curls:{CC:10},                   line:18, label:'' },
    { seri:27, maDon:'233S', codeSoi:'212.SKV.MochaMousse.7', detail:'Milky brownx5, Natural Brownx5, Coffee Brownx5, Chocolate brownx5', length:'4~8', mixSingle:'Mix', curls:{C:10}, line:5, label:'4~8' },
    { seri:28, maDon:'233S', codeSoi:'28.MK.DB.85',           detail:'Milky brownx5, Natural Brownx5, Coffee Brownx5, Chocolate brownx5', length:'4~8', mixSingle:'Mix', curls:{C:10}, line:5, label:'4~8' },
    { seri:29, maDon:'233S', codeSoi:'107.SKS.Cafe.85',       detail:'Milky brownx5, Natural Brownx5, Coffee Brownx5, Chocolate brownx5', length:'4~8', mixSingle:'Mix', curls:{C:10}, line:5, label:'4~8' },
    { seri:30, maDon:'233S', codeSoi:'31.MK.BC.85',           detail:'Milky brownx5, Natural Brownx5, Coffee Brownx5, Chocolate brownx5', length:'4~8', mixSingle:'Mix', curls:{C:10}, line:5, label:'4~8' },
    { seri:31, maDon:'233S', codeSoi:'212.SKV.MochaMousse.7', detail:'Milky Brown',      length:'6~13',  mixSingle:'Mix',    curls:{C:10},                    line:18, label:'6~13' },
    { seri:32, maDon:'233S', codeSoi:'29.MK.DBH.85',          detail:'Honey Brown',      length:'6~13',  mixSingle:'Mix',    curls:{C:10},                    line:18, label:'6~13' },
    { seri:33, maDon:'233S', codeSoi:'28.MK.DB.85',           detail:'Natural Brown',    length:'6~13',  mixSingle:'Mix',    curls:{B:10, CC:10, M:10, LD:10}, line:18, label:'6~13' },
    { seri:34, maDon:'233S', codeSoi:'132.SKS.Wland.5',       detail:'Deep Brown',       length:'6~13',  mixSingle:'Mix',    curls:{CC:10},                   line:18, label:'6~13' },
    { seri:35, maDon:'233S', codeSoi:'135.SKS.Wland.85',      detail:'Deep Brown',       length:'6~13',  mixSingle:'Mix',    curls:{B:10, C:10, L:10},        line:18, label:'6~13' },
    { seri:36, maDon:'233S', codeSoi:'76.MK.BC.5',            detail:'Chocolate Brown',  length:'6~13',  mixSingle:'Mix',    curls:{CC:10, M:10},             line:18, label:'6~13' },
    { seri:37, maDon:'233S', codeSoi:'31.MK.BC.85',           detail:'Chocolate Brown',  length:'6~13',  mixSingle:'Mix',    curls:{LD:10},                   line:18, label:'6~13' },
    { seri:38, maDon:'233S', codeSoi:'60.MK.BC.10',           detail:'Chocolate Brown',  length:'6~13',  mixSingle:'Mix',    curls:{C:10, L:10},              line:18, label:'6~13' },
    { seri:39, maDon:'233S', codeSoi:'107.SKS.Cafe.85',       detail:'Coffee Brown',     length:'6~13',  mixSingle:'Mix',    curls:{C:10, M:10},              line:18, label:'6~13' },
  ];
  var KEO_233S = [
    { maDon:'233S', loaiKeo:'XanhLX70.2', loaiSoi:'',            doDay:'0.1',  doDai:'', ghiChu:'' },
    { maDon:'233S', loaiKeo:'Nau155C.2',  loaiSoi:'',            doDay:'0.05', doDai:'', ghiChu:'' },
    { maDon:'233S', loaiKeo:'Cam837.2',   loaiSoi:'0,07; 0,085', doDay:'',     doDai:'', ghiChu:'' },
  ];
  var MIX_SHEETS_233S = [{ maDon:'233S', mmList: MM_233S, matrix: MIX_233S }];

  /* ---------------- export ra window ---------------- */
  var api = {
    CURLS: CURLS, RANGES: RANGES, MM_MIN: MM_MIN, MM_MAX: MM_MAX, SOI_PER_LINE: SOI_PER_LINE,
    normalizeLength: normalizeLength, parseRange: parseRange,
    runStep1: runStep1, editCell: editCell,
    buildMix: buildMix, MixLabel: MixLabel, mixOfRange: mixOfRange, totalOfRange: totalOfRange,
    sheetRangeInfo: sheetRangeInfo, resolveMixDist: resolveMixDist,
    buildKeoRules: buildKeoRules, glueFor: glueFor, glueForShort: glueForShort, orderGlues: orderGlues,
    OVERRIDE_2MM_CURLS: OVERRIDE_2MM_CURLS, isOverrideCurl: isOverrideCurl,
    parseKeoCond: parseKeoCond, thickKey: thickKey,
    buildData1: buildData1, buildLineMatrix: buildLineMatrix, STRATEGIES: STRATEGIES,
    buildCuonBox: buildCuonBox, buildCuonBoxSheet: buildCuonBoxSheet, buildSummary: buildSummary,
    runPipeline: runPipeline,
    parseNhapDonRows: parseNhapDonRows, parseLabelRows: parseLabelRows,
    parseKeoRows: parseKeoRows, parseWorkbookData: parseWorkbookData,
    parseGuiXuongSheet: parseGuiXuongSheet, parseMixColorAOA: parseMixColorAOA,
    sample: { MM_233S: MM_233S, MIX_233S: MIX_233S, ORDERS_233S: ORDERS_233S, KEO_233S: KEO_233S, MIX_SHEETS_233S: MIX_SHEETS_233S },
  };
  if (root) root.NhapDonEngine = api;
})(typeof window !== 'undefined' ? window : this);
