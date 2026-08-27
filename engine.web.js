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
  // Dải độ dài CHUẨN theo độ cong. LC+/LC/LB/LJ: 5–20mm (tiêu chuẩn 2026).
  var CURL_RANGE = { J:[4,20],B:[4,20],C:[4,20],CC:[4,20],D:[4,20],DD:[4,20], L:[5,16],M:[5,16],V:[5,16],'L+':[5,16],LD:[5,16], LJ:[5,20],LB:[5,20],LC:[5,20],'LC+':[5,20], 'Curl 1':[4,20] };
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
    /* MIX/SINGLE LẤY THEO ĐỘ DÀI, không tin cột khách ghi (chốt 18/8):
         · độ dài 1 giá trị (6mm · 13mm)      → Single
         · độ dài là KHOẢNG (6-13mm · 6~13mm) → Mix
       Đơn 792P (template mới) ghi "Mix" cho cả 34 dòng, trong đó 31 dòng chỉ có 1 độ dài
       ⇒ trước đây 31 ô đỏ E-MIX và bảng Mix ở bước 3 dựng sai. Cột khách ghi chỉ dùng khi
       KHÔNG đọc được độ dài. */
    var ms = String(raw.mixSingle == null ? '' : raw.mixSingle).trim();
    if (r) ms = (r.lo === r.hi) ? 'Single' : 'Mix';
    else if (/^mix$/i.test(ms)) ms = 'Mix';
    else if (/^single$/i.test(ms)) ms = 'Single';
    else if (ms === '') ms = 'Mix';
    var lineNum = Number(raw.line) || 0;
    // TÁCH mã sợi / nguyên liệu bị NỐI LIỀN (nhiều màu 1 đơn, không có xuống dòng) → chèn \n.
    //   Mã: tách sau độ dày (thickness) khi theo sau là chữ số (mã kế), đứng sau dấu chấm/chữ.
    //   NL:  tách trước 1 chữ IN HOA đứng ngay sau chữ số (vd "0.085H. Pink" → "0.085\nH. Pink").
    var thN = String(raw.thickness == null ? '' : raw.thickness).trim();
    /* Dấu phẩy có 2 nghĩa: TÁCH danh sách ("mã A, mã B") và DẤU THẬP PHÂN kiểu Việt ("0,07").
       Trước đây tách tất → "Ultra matte 0,07" bị bẻ thành 2 dòng "Ultra matte 0" / "07".
       → Che dấu thập phân lại trước khi tách, xong trả lại. Độ dày luôn dạng 0,xx nên chỉ
       che đúng "0," — không đụng dấu phẩy tách mã ("...Orange.7, 187.SKV..."). */
    function splitByComma(s){
      var PH = '\u0001';   // ký tự tạm, không bao giờ xuất hiện trong dữ liệu
      var t = String(s == null ? '' : s).replace(/\b0\s*,\s*(\d)/g, '0' + PH + '$1');
      if (!/[,;]/.test(t)) return null;
      var ps = t.split(/\s*[,;]\s*/)
        .map(function(x){ return x.split(PH).join(',').trim(); })
        .filter(function(x){ return x; });
      return ps.length > 1 ? ps.join('\n') : null;
    }
    function splitCodes(s){ s = String(s == null ? '' : s).trim(); if (s.indexOf('\n') >= 0) return s;
      var byC = splitByComma(s); if (byC) return byC;      // nhiều mã sợi 1 ô ngăn bằng "," hoặc ";" (vd "197.SKV.Orange.7, 187.SKV.SmokBlue.7")
      if (!thN) return s;
      try{ var re = new RegExp('(?<=[.A-Za-z])(' + thN.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')(?=\\d)','g'); var o = s.replace(re,'$1\n'); return o.split('\n').length > 1 ? o : s; }catch(e){ return s; } }
    function splitMats(s){ s = String(s == null ? '' : s).trim(); if (s.indexOf('\n') >= 0) return s;
      var byC = splitByComma(s); if (byC) return byC;
      var o = s.replace(/(0[.,]\d+)(?=[A-ZĐ])/g,'$1\n'); return o.split('\n').length > 1 ? o : s; }
    var _csNorm = splitCodes(raw.codeSoi);
    var _xuongMa = String(raw.xuongMa == null ? '' : raw.xuongMa).trim().toUpperCase() || xuongTuCode(_csNorm);
    return {
      seri: raw.seri,
      /* seriGoc = SỐ THỨ TỰ GỐC trong file khách, KHÔNG BAO GIỜ đổi.
         Cột seri bị ĐÁNH SỐ LẠI mỗi lần gộp file (1..N toàn bộ), nên mọi thứ cần nhớ theo
         từng dòng — "đã kiểm ô sai chuẩn", "cho phép sai chuẩn độ dài" — phải bám seriGoc,
         không thì nạp thêm 1 file là mất sạch. */
      seriGoc: (raw.seriGoc != null ? raw.seriGoc : raw.seri),
      maDon: String(raw.maDon || '').trim(),
      codeSoi: _csNorm, detail: raw.detail || '',
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
      /* Ưu tiên CỘT đánh dấu của file khách; cột trống thì đọc ĐUÔI "-TH"/"-HY" của Code Sợi
         (kể cả do người dùng gõ tay ở bước 2) — xem xuongTuCode. */
      xuongMa: _xuongMa,   // TH · HY · '' (ND)
      xuongTH: !!raw.xuongTH || _xuongMa === 'TH',
      _colorBlocks: (raw._colorBlocks && raw._colorBlocks.length) ? raw._colorBlocks : null,   // phân bổ mix màu do admin nhập (per-dòng)
      /* HÀNG PREMADE (mẫu 2026): cột "Số Line" ghi chữ "Premade" thay vì con số → hàng đặt
         sẵn, KHÔNG cuốn dải line, chỉ tính SỐ HỘP. Giữ cờ để các bước sau đừng đòi bảng Mix
         và đừng báo "thiếu dây" cho mấy dòng này (C213-785P, 20/8/2026). */
      premade: !!raw.premade || /premade/i.test(String(raw.lineRaw == null ? '' : raw.lineRaw)),
      soMau: Number(raw.soMau) || 0,     // mẫu 2026: cột "Số màu" (Mix Color mấy màu)
      _manual: !!raw._manual,
    };
  }
  /* ===== MÃ KEO CHUẨN =====
     Danh sách mã keo được phép dùng. Ô "Loại Keo" trong Bảng Keo ghi mã ngoài danh sách này
     → tô đỏ và tính vào Ô sai chuẩn. Chỉ soi những chuỗi CÓ DẠNG mã keo (chữ+số chấm số,
     VD Nau155C.2) để không báo nhầm mấy dòng ghi chú bằng lời. */
  var KEO_STD = [
    'Trong250G.2', 'Trong450G.2', 'Nau155C.2', 'Nau155C.3', 'CamTQN75.2',
    'NauBNC500.2', 'NauBNC500.3', 'Cam837.2', 'Cam837.3', 'Vang80.2', 'Vang80.3',
    'XanhLX70.2', 'XanhLX70.3', 'Trang850T.25', 'Trang850T.3',
    'XanhBlu150.2', 'XanhBlu150.3'
  ];
  function keoNorm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }
  var KEO_STD_SET = (function () { var m = {}; KEO_STD.forEach(function (k) { m[keoNorm(k)] = k; }); return m; })();
  var KEO_CODE_RE = /^[A-Za-z][A-Za-z0-9]*\s*\.\s*\d+$/;
  function badKeoCodes(s) {
    return String(s == null ? '' : s).split(/[\n,;\/]+/)
      .map(function (x) { return x.trim(); })
      .filter(function (c) { return c && KEO_CODE_RE.test(c) && !KEO_STD_SET[keoNorm(c)]; });
  }
  // Hậu tố hàng đặc biệt gắn ở cuối Code Sợi / Mã Đơn (có thể nhiều tầng: -LZ-DU)
  var SPECIAL_TAGS = ['LZ', '1ES', '2ES', 'DU', 'U', 'W'];
  var SPECIAL_SUF_RE = new RegExp('(?:-(?:' + SPECIAL_TAGS.join('|') + '))+$', 'i');
  /* ===== ĐUÔI "-TH" / "-HY" GÕ TAY TRONG CODE SỢI = KÝ HIỆU XƯỞNG NGOÀI (chốt 27/8) =====
     User: "Kể cả khi sửa trực tiếp từ step 2 bảng nhập đơn có đuôi TH, HY thì cũng hiểu đó là
     hàng Thanh Hóa. Như vậy step 5 sẽ phải tô màu code sợi TH đó và bảng in line thì không có
     code sợi TH đó."
     Trước đây cờ xưởng CHỈ đọc từ CỘT đánh dấu trong file khách; gõ tay "-TH" vào Code Sợi thì
     app coi như một code sợi bình thường ⇒ (1) báo E-CODE "thiếu độ dài", (2) bước 5 không tô
     nền vàng, (3) bản in Tổng hợp Line vẫn in hàng của xưởng Thanh Hóa.
     Đuôi xưởng có thể đứng LẪN với hậu tố hàng đặc biệt ("...-LZ-TH" · "...-TH-LZ"). */
  var XUONG_SUF_RE = /-(TH|HY)$/i;
  function boDuoiXuong(code) {
    var x = String(code == null ? '' : code).trim();
    for (var i = 0; i < 4; i++) {
      var y = x.replace(SPECIAL_SUF_RE, '').replace(XUONG_SUF_RE, '');
      if (y === x) break; x = y;
    }
    return x;
  }
  /** Xưởng suy từ đuôi Code Sợi: 'TH' · 'HY' · '' (nhiều code 1 ô → lấy cái đầu tiên thấy). */
  function xuongTuCode(code) {
    var ds = String(code == null ? '' : code).split(/\r?\n/);
    for (var i = 0; i < ds.length; i++) {
      var x = ds[i].trim(); if (!x) continue;
      for (var k = 0; k < 4; k++) {
        var m = x.match(XUONG_SUF_RE);
        if (m) return m[1].toUpperCase();
        var y = x.replace(SPECIAL_SUF_RE, '');
        if (y === x) break; x = y;
      }
    }
    return '';
  }
  function validateOrder(o, opt) {
    opt = opt || {}; var minMM = opt.minMM || MM_MIN, maxMM = opt.maxMM || MM_MAX, errs = [];
    var push = function (col, code, level, msg) { errs.push({ seri: o.seri, col: col, code: code, level: level, msg: msg }); };
    // Code sợi có thể mang HẬU TỐ HÀNG ĐẶC BIỆT do chính app gắn vào lúc đọc đơn
    // (laser/liigos→LZ, easy fan→1ES/2ES, <số>D-U→DU, hàng U/W…). Phải bỏ hậu tố rồi mới
    // xét "thiếu độ dài", nếu không "131.SKV.10-LZ" bị báo sai chuẩn oan.
    // …và bỏ luôn đuôi XƯỞNG ("-TH" · "-HY") gõ tay, nếu không "229.SPK2S.7-TH" bị báo oan
    var _codeBase = boDuoiXuong(o.codeSoi);
    if (!/\.\d+$/.test(_codeBase)) push('codeSoi', 'E-CODE', 'error', '"' + o.codeSoi + '" thiếu độ dài — kỳ vọng <mã>.<số>');
    var rg = parseRange(o.length);
    if (!rg) push('length', 'E-LEN', 'error', 'Độ dài "' + o.length + '" không đọc được');
    else if (rg.lo > rg.hi) push('length', 'E-LEN', 'error', '"' + o.length + '" dải không hợp lệ (đầu > cuối)');
    else {
      // KIỂM TỪNG ĐỘ CONG (không lấy hợp): mỗi độ cong CÓ SỐ thì dải độ dài của dòng
      // phải nằm trong chuẩn của CHÍNH độ cong đó. Vd dòng 12-20mm có L+ (5-16) → SAI CHUẨN,
      // dù trong dòng còn LB (5-20). Danh sách chuẩn: CURL_RANGE.
      var _ck = Object.keys(o.curls || {}), bad = [];
      if (_ck.length) {
        _ck.forEach(function (k) {
          var cr = CURL_RANGE[k] || [minMM, maxMM];
          if (rg.lo < cr[0] || rg.hi > cr[1]) bad.push(k + ' ' + cr[0] + '-' + cr[1] + 'mm');
        });
      } else if (rg.lo < minMM || rg.hi > maxMM) bad.push(minMM + '-' + maxMM + 'mm');
      if (bad.length) {
        // Đơn khách CÓ THỂ làm ngoài chuẩn → bấm "Cho phép sai chuẩn" cho ĐÚNG ô đó
        // (opt.lenApproved['<mã đơn>|<seri>'] = true) → hạ xuống CẢNH BÁO để vẫn sinh được dữ liệu.
        var _la = opt.lenApproved || {};
        var _ok = _la[(o.maDon || '') + '|' + (o.seriGoc != null ? o.seriGoc : o.seri)] ||
                  _la[(o.maDon || '') + '|' + o.seri];      // khoá cũ — giữ cho project đã lưu
        var _msg = '"' + o.length + '" vượt chuẩn độ cong: ' + bad.join(', ');
        if (_ok) push('length', 'W-LEN-OK', 'warn', _msg + ' — đã được cho phép');
        else push('length', 'E-LEN', 'error', _msg + ' (tiêu chuẩn độ cong 2026)');
      }
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
    // Gọi được KHÔNG KÈM opt (lúc đọc từng file mới chỉ cần thống kê nhanh) — thiếu dòng
    // này thì phần kiểm mã keo bên dưới nổ "Cannot read properties of undefined".
    opt = opt || {};
    var orders = rawList.map(normalizeOrder), errors = [], seen = {};
    orders.forEach(function (o) {
      var k = o.maDon + '#' + o.seri;
      if (seen[k]) errors.push({ maDon: o.maDon, seri: o.seri, col: 'seri', code: 'E-DUP', level: 'error', msg: 'Trùng Seri ' + o.seri });
      seen[k] = 1;
      // gắn maDon vào từng lỗi — Seri có thể trùng giữa các file/mã đơn khác nhau
      validateOrder(o, opt).forEach(function (e) { e.maDon = o.maDon; e.seriGoc = o.seriGoc; errors.push(e); });
    });
    // Mã keo ngoài danh sách chuẩn → ô sai chuẩn (gắn kèm chỉ số dòng keo để tô đúng ô)
    (opt.keoRows || []).forEach(function (k, i) {
      var bad = badKeoCodes(k && k.loaiKeo);
      if (!bad.length) return;
      errors.push({ seri: 0, keoIdx: i, maDon: k.maDon, col: 'loaiKeo', code: 'E-KEO', level: 'error',
        msg: 'Mã keo ' + bad.map(function (c) { return '"' + c + '"'; }).join(', ') + ' không có trong danh sách chuẩn' });
    });
    /* 1 ĐỘ DÀY DÙNG 2 LOẠI KEO → ô sai chuẩn ở Bảng Keo (user chốt 21/8: cứ mặc định là báo,
       để tự kiểm). Gắn keoIdx để giao diện tô đúng dòng. */
    var _amb = timKeoNhapNhang(opt.keoRows || []);
    if (Object.keys(_amb).length) (opt.keoRows || []).forEach(function (k, i) {
      var ds = keoNhapNhangCuaDong(_amb, k); if (!ds) return;
      errors.push({ seri: 0, keoIdx: i, maDon: k.maDon, col: 'doDay', code: 'E-KEO2', level: 'error',
        msg: '1 độ dày sử dụng ' + ds.length + ' loại keo (' + ds.join(', ') + ')' });
    });
    var FORMAT_CODES = ['E-MIX', 'E-STAR'];
    var isErr = function (e) { return e.level === 'error'; };
    // lỗi mã keo KHÔNG thuộc dòng đơn nào → không tính vào "dòng hỏng"
    var errRows = {}; errors.forEach(function (e) { if (isErr(e) && !/^E-KEO/.test(e.code)) errRows[e.maDon + '#' + e.seri] = 1; });
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
    /* Sửa ô "LINES" (cột chữ, vd "16 lines" / "Premade") thì SỐ LINE dùng để tính dây phải đổi
       theo — không thì bảng vẫn hiện số mới mà dây tính theo số cũ (chốt 22/8). */
    if (col === 'lineRaw') {
      next.line = Number(String(value == null ? '' : value).replace(/lines?/i, '').trim()) || 0;
      next.premade = /premade/i.test(String(value == null ? '' : value));
    }
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
    var carry = { material: o.material || o.detail || '', thickness: o.thickness || '', ghiChuKeo: o.ghiChuKeo || '',
                  xuongTH: !!o.xuongTH, xuongMa: o.xuongMa || (o.xuongTH ? 'TH' : '') };
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
            // cờ cmix: dòng SINH RA TỪ TÁCH MIX MÀU → bước 5 tô màu cho dễ nhận
            expandOrder(sub, mix, strategy, colorBlocks).forEach(function (r) { r.cmix = true; acc.push(r); });
          });
          return acc;
        }
      }
    }
    if (o.mixSingle === 'Single') {
      var r = parseRange(o.length), smm = r ? r.lo : NaN;
      for (curl in curls) {
        sl = strategy(o, { mm: smm, mixQty: o.line, qty: curls[curl] }, { rangeTotal: o.line });
        if (sl) rows.push({ codeSoi: o.codeSoi, length: o.length, mm: smm, curl: curl, sl: sl, maDon: o.maDon, mixSingle: 'Single', material: carry.material, thickness: carry.thickness, ghiChuKeo: carry.ghiChuKeo, xuongTH: carry.xuongTH, xuongMa: carry.xuongMa });
      }
      return rows;
    }
    // o.mixDist = phân bổ mm RIÊNG (dùng cho dòng đã TÁCH THEO MÀU); nếu không có → tra bảng mix chung
    var dist = (o.mixDist && Object.keys(o.mixDist).length) ? o.mixDist : resolveMixDist(mix, o), rangeTotal = 0; for (mm in dist) rangeTotal += dist[mm];
    for (curl in curls) {
      for (mm in dist) {
        sl = strategy(o, { mm: +mm, mixQty: dist[mm], qty: curls[curl] }, { rangeTotal: rangeTotal });
        if (sl) rows.push({ codeSoi: o.codeSoi, length: o.length, mm: +mm, curl: curl, sl: sl, maDon: o.maDon, mixSingle: 'Mix', material: carry.material, thickness: carry.thickness, ghiChuKeo: carry.ghiChuKeo, xuongTH: carry.xuongTH, xuongMa: carry.xuongMa });
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
      /* HÀNG PREMADE (cột "Số Line" ghi chữ "Premade") — hàng đặt sẵn, CHỈ TÍNH SỐ HỘP,
         không cuốn dải line. Phải chặn ở đây: Độ Dài của nó vẫn là dải (5-13mm) và khối
         "Mix Length" có cột 5-13mm, nên không chặn là app cấp cho nó phân bổ mm của cột đó
         rồi sinh dải khống (C213-785P: +320 dải). Số hộp vẫn cộng bình thường ở bước 6. */
      if (o.premade) return;
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
  // "hàng màu / sợi màu / màu" (trong bảng keo) = lớp sợi MÀU
  var isColorMat = function (a) { var s = normTxt(a).replace(/hàng|sợi|loại/g, '').replace(/[.,;:]/g, ' ').replace(/\s+/g, ' ').trim(); return s === 'màu' || s === 'mầu' || s === 'mau'; };
  // Nhận diện 1 dòng đơn có phải "hàng màu" không: xét Code Sợi · Tên Gọi NL · Phân Loại · Ghi Chú
  //  → có từ "màu/color" HOẶC tên màu tiếng Anh (Blue/Pink/Violet/Mocha/Espresso/Chocolate…).
  //  (Tên màu CHỈ xét ở Code Sợi + Tên Gọi NL để TRÁNH nhầm "Black Mink" ở cột Phân Loại.)
  var COLOR_KW = /(màu|mầu|mau|colou?r)/i;
  // Tên màu sợi mi hay gặp. Bổ sung 13/8: pecan (= Dark Brown) · honey — đơn 774P dùng,
  // khách chú thích ngay trong file ("Pecan: Dark Brown") nhưng app chưa biết là màu.
  var COLOR_NAME = /\b(blue|pink|hpink|h\.?pink|violet|purple|lilac|brown|green|yellow|orange|navy|teal|beige|cream|mocha|espresso|esp|chocolate|coffee|caramel|wine|burgundy|nude|red|pecan|honey)\b/i;
  var isColorComp = function (comp) {
    var f = comp || {};
    var kw = [f.codeSoi, f.material, f.detail, f.loaiHang, f.label, f.ghiChu].join(' ');
    if (COLOR_KW.test(kw)) return true;
    return COLOR_NAME.test([f.codeSoi, f.material].join(' '));
  };
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
    /* MỖI DÒNG LÀ MỘT MỤC. Ô "Loại Sợi" hay có nhiều nguyên liệu xếp theo dòng
       ("Faux Mink⏎Super Silk") — đúng như app hiện lên và như người dùng gõ vào. PS() gộp
       xuống dòng thành dấu cách nên trước đây dính lại thành MỘT tên "Faux Mink Super Silk",
       chẳng khớp nguyên liệu nào. Đổi xuống dòng thành dấu ';' để tách như dấu phẩy. */
    var s = ' ' + PS(String(text == null ? '' : text).replace(/\r?\n+/g, ' ; ')) + ' ';
    var lo = null, hi = null, spec = 0, m, dsMm = null;
    /* "N mm TRỞ LÊN / TRỞ XUỐNG / TRỞ ĐI" — phải bóc TRƯỚC mấy nhánh dưới. Đơn K54-754P ghi
       "cho độ dài từ 7mm trở lên": nhánh "từ N" cũ lấy đúng lo=7 nhưng để LẠI chữ "trở lên",
       chữ đó rơi xuống phần tách nguyên liệu → quy tắc đòi nguyên liệu chứa "trở lên" nên
       KHÔNG dòng nào khớp ⇒ cả độ dày 0.10 (Mocha + Faux Mink) mất keo, 23 dòng trống.
       Bắt luôn dạng KHÔNG có chữ "từ" ("7mm trở lên") — nhánh "đúng N mm" sẽ hiểu sai thành
       chỉ mm 7. */
    if ((m = s.match(/(?:t[ừu]\s*)?(\d+)\s*(?:mm)?\s*(?:tr[ởo]\s*(?:l[êe]n|đi)|ho[ặa]c\s*(?:h[ơo]n|l[ớo]n\s*h[ơo]n|cao\s*h[ơo]n)|v[àa]\s*h[ơo]n)/i))) { lo = +m[1]; hi = 999; spec = 2; s = s.replace(m[0], ' '); }
    else if ((m = s.match(/(?:đ[ếe]n\s*)?(\d+)\s*(?:mm)?\s*(?:tr[ởo]\s*xu[ốo]ng|ho[ặa]c\s*(?:[íi]t\s*h[ơo]n|nh[ỏo]\s*h[ơo]n|th[ấa]p\s*h[ơo]n))/i))) { lo = 0; hi = +m[1]; spec = 2; s = s.replace(m[0], ' '); }
    else if ((m = s.match(/(?:từ|from)\s*(\d+)\s*(?:mm)?\s*(?:đến|tới|->|~|–|-)\s*(\d+)\s*mm/i))) { lo = +m[1]; hi = +m[2]; spec = 3; s = s.replace(m[0], ' '); } // từ N đến M mm (khoảng kín)
    else if ((m = s.match(/(\d+)\s*[~–-]\s*(\d+)\s*mm/i))) { lo = +m[1]; hi = +m[2]; spec = 3; s = s.replace(m[0], ' '); }            // N~M mm (khoảng kín)
    else if ((m = s.match(/(?:>=|≥|từ)\s*(\d+)\s*(?:mm)?/i))) { lo = +m[1]; hi = 999; spec = 2; s = s.replace(m[0], ' '); }        // từ N / >=N (GỒM N)
    else if ((m = s.match(/(?:>|trên)\s*(\d+)\s*(?:mm)?/i))) { lo = +m[1] + 1; hi = 999; spec = 2; s = s.replace(m[0], ' '); }     // trên N / >N (KHÔNG gồm N)
    else if ((m = s.match(/(?:<=|≤|đến|tối\s*đa)\s*(\d+)\s*(?:mm)?/i))) { lo = 0; hi = +m[1]; spec = 2; s = s.replace(m[0], ' '); } // đến/tối đa N / <=N (GỒM N)
    else if ((m = s.match(/(?:<|dưới)\s*(\d+)\s*(?:mm)?/i))) { lo = 0; hi = +m[1] - 1; spec = 2; s = s.replace(m[0], ' '); }       // dưới N / <N (KHÔNG gồm N)
    /* LIỆT KÊ nhiều mm rời nhau: "4mm-5mm-6mm" · "4mm, 5mm, 6mm" · "4mm và 6mm" (đơn K47-772P
       ghi "độ dài 4mm-5mm-6mm"). Nhánh "đúng N mm" bên dưới chỉ lấy được 4mm rồi bỏ 5·6, mà
       phần "-5mm-6mm" còn lại rơi xuống chỗ tách nguyên liệu thành rác "- mm- mm" ⇒ quy tắc
       đòi một nguyên liệu không tồn tại, cả đơn KHÔNG dòng nào có keo.
       Giữ ĐÚNG danh sách trong dsMm (không suy ra khoảng kín) để "4mm và 9mm" không kéo theo 5…8. */
    else if ((m = s.match(/\d+\s*mm(?:\s*(?:[-–~,\/]|v[àa])\s*\d+\s*mm)+/i))) {
      dsMm = (m[0].match(/\d+/g) || []).map(Number);
      lo = Math.min.apply(null, dsMm); hi = Math.max.apply(null, dsMm); spec = 3;
      s = s.replace(m[0], ' ');
    }
    else if ((m = s.match(/(\d+)\s*mm/i))) { lo = +m[1]; hi = +m[1]; spec = 3; s = s.replace(m[0], ' '); }                        // đúng N mm
    /* "Tất cả (các) độ dài" = KHÔNG ràng buộc độ dài → xoá khỏi phần chữ.
       Trước chỉ nhận "tất cả độ dài"; khách ghi "Tất cả CÁC độ dài" (672P) thì còn lại
       "các độ dài" và bị hiểu thành TÊN NGUYÊN LIỆU ⇒ quy tắc keo 0.05 không khớp dòng nào. */
    s = s.replace(/t[ấa]t\s*c[ảa](\s*(?:c[áa]c|cả|mọi)?\s*độ\s*d\S*)?/gi, ' ');
    s = s.replace(/(?:^|\s)(?:c[áa]c|mọi|to[àa]n\s*bộ)?\s*độ\s*d[àa]i(?=\s|$)/gi, ' ');
    /* LƯỚI AN TOÀN: mấy chữ chỉ hướng còn sót lại (khách ghi kiểu khác, vd "10mm hoặc hơn")
       TUYỆT ĐỐI không được thành tên nguyên liệu — thà bỏ điều kiện còn hơn khớp sai. */
    s = s.replace(/tr[ởo]\s*(?:l[êe]n|xu[ốo]ng|đi)|ho[ặa]c\s*(?:h[ơo]n|l[ớo]n\s*h[ơo]n|nh[ỏo]\s*h[ơo]n)|v[àa]\s*h[ơo]n/gi, ' ');
    /* ĐIỀU KIỆN THEO ĐỘ CONG (đơn 750P): khách ghi thẳng trong Ghi Chú
         "6-8mm cho các độ cong không phải LB, LC, LJ, LC+"
         "Độ cong LB, LC, LJ, LC+"
       Trước đây cụm này bị cắt thành TÊN NGUYÊN LIỆU ("cho các độ cong không phải LB", "LC"…)
       → không dòng nào khớp → cả độ dày 0.15 mất keo. Giờ bóc riêng ra thành phạm vi độ cong
       và XÓA khỏi phần tên nguyên liệu. */
    // nuốt luôn chữ nối đứng trước ("… cho các độ cong …") kẻo còn lại chữ "cho" thành tên nguyên liệu
    var curlOnly = null, curlNot = null,
        mcu = s.match(/(?:\b(?:cho|dùng|áp\s*dụng|với|của|theo)\s+)*(?:các\s*)?độ\s*cong\b([\s\S]*)$/i);
    if (mcu) {
      var seg = mcu[1], phu = /không\s*phải|ngoại\s*trừ|\btrừ\b|\bkhác\b|\bngoài\b/i.test(seg);
      var ds = (seg.toUpperCase().match(CURL_TOKEN_RE) || []).filter(function (k) { return CURLS.indexOf(k) >= 0; });
      if (ds.length) {
        if (phu) curlNot = ds; else curlOnly = ds;
        s = s.replace(mcu[0], ' ');
      }
    }
    /* LOẠI TRỪ NGUYÊN LIỆU: "0.05 Tất cả độ dài TRỪ hàng Ultra Matte 0.05" — nghĩa là mọi
       nguyên liệu 0.05 TRỪ Ultra Matte. Trước đây cụm "trừ hàng Ultra Matte" bị hiểu thành
       tên nguyên liệu cần khớp → hiểu NGƯỢC HẲN ý khách. Bóc riêng ra thành danh sách cấm.
       (Chạy SAU phần độ cong để "không phải LB, LC…" đã được lấy ra trước.) */
    var matsNot = null, mneg = s.match(/\b(?:tr[ừu]|ngo[ạa]i\s*tr[ừu]|kh[ôo]ng\s*ph[ảa]i|except)\s+([\s\S]*)$/i);
    if (mneg) { matsNot = mneg[1]; s = s.replace(mneg[0], ' '); }
    var thickRaw = s.match(/\d+(?:[.,]\d+)?/g) || [];
    s = s.replace(/\d+(?:[.,]\d+)?/g, ' ');
    /* Tách nguyên liệu: ngoài "/ , ; ·" còn phải nhận "và" và "&" (đơn 774P ghi
       "cho hàng Mink và hàng màu" — trước đây dính thành MỘT tên không có thật, hai dòng
       keo Nau155C.2/.3 chẳng khớp dòng nào, 5.520 dây mất keo). Bỏ luôn chữ nối đứng đầu
       mỗi mục ("cho", "dùng cho", "áp dụng cho"…) kẻo nó thành một phần của tên. */
    var tachMat = function (txt) {
      return String(txt == null ? '' : txt).replace(/\d+(?:[.,]\d+)?/g, ' ')
        .split(/[\/,;·]|\s+v[àa]\s+|\s*&\s*/).map(function (t) {
          return t.replace(/^\s*(?:cho|d[ùu]ng cho|d[ùu]ng|[áa]p d[ụu]ng cho|[áa]p d[ụu]ng|v[ớo]i|c[ủu]a)\s+/i, '').replace(/\s+/g, ' ').trim();
        })
        .filter(function (t) { return t && !/^mm$/i.test(t) && t !== '-' && t !== '.'; })
        .filter(function (t) { return !NOT_MAT_RE.test(t.replace(/\s+/g, ' ').trim()); })
        .filter(function (t) { return !laRacMat(t); });
    };
    matsNot = matsNot ? tachMat(matsNot) : null;
    if (matsNot && !matsNot.length) matsNot = null;
    var mats = s.split(/[\/,;·]|\s+v[àa]\s+|\s*&\s*/).map(function (t) {
      return t.replace(/^\s*(?:cho|d[ùu]ng cho|d[ùu]ng|[áa]p d[ụu]ng cho|[áa]p d[ụu]ng|v[ớo]i|c[ủu]a)\s+/i, '').replace(/\s+/g, ' ').trim();
    })
      .filter(function (t) { return t && !/^mm$/i.test(t) && t !== '-' && t !== '.'; })
      /* Ghi chú kiểu "Cho cả đơn", "Dùng chung", "Áp dụng toàn bộ"… KHÔNG phải tên nguyên liệu.
         Nhận nhầm thì quy tắc keo đòi khớp một nguyên liệu không tồn tại → không dòng nào khớp,
         cả đơn mất keo (đơn 356P từng bị: 76 dòng đều phải mượn keo trong cột của khách). */
      .filter(function (t) { return !NOT_MAT_RE.test(t.replace(/\s+/g, ' ').trim()); })
      .filter(function (t) { return !laRacMat(t); });
    return { lo: lo, hi: hi, spec: spec, dsMm: dsMm, thickRaw: thickRaw, thicks: thickRaw.map(thickKey), mats: mats,
             matsNot: matsNot, curlOnly: curlOnly, curlNot: curlNot };
  }
  // Nhận diện tên độ cong trong câu — token DÀI trước để "LC+" không bị cắt thành "LC", "CC" không thành "C"
  var CURL_TOKEN_RE = new RegExp('(?:' + CURLS.slice().sort(function (a, b) { return b.length - a.length; })
    .map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')(?![A-Z])', 'g');
  /* Rule có ràng buộc độ cong thì chỉ dùng cho ĐÚNG nhóm độ cong của nó.
     dacBiet = true  → nhóm LB/LC/LJ/LC+ (nhóm "keo 2mm")
     dacBiet = false → mọi độ cong còn lại */
  function ruleHopCurl(r, dacBiet) {
    if (r.curlOnly && r.curlOnly.length)
      return r.curlOnly.some(function (k) { return isOverrideCurl(k) === dacBiet; });
    if (r.curlNot && r.curlNot.length) {
      var nhom = CURLS.filter(function (k) { return isOverrideCurl(k) === dacBiet; });
      return nhom.some(function (k) { return r.curlNot.indexOf(k) < 0; });   // còn độ cong nào chưa bị loại
    }
    return true;
  }
  /* Cụm chữ chỉ phạm vi áp dụng, KHÔNG phải tên nguyên liệu. Khớp cả câu (^…$) để không
     cắt nhầm tên thật (vd "Cashmere Silk cho hàng chung" vẫn giữ nguyên là nguyên liệu). */
  var NOT_MAT_RE = /^(cho\s+)?(cả|toàn\s*bộ|toàn|tất\s*cả|mọi|chung|dùng\s*chung|áp\s*dụng)([\s\S]*)?$|^(cho|dùng|áp\s*dụng|theo|như)\s+.*(đơn|hàng|bảng|trên|dưới|này)$|^(đơn|hàng|bảng|các|những)$|^(các|mọi|toàn\s*bộ)?\s*độ\s*(dài|cong|dày)$/i;
  /* ===== GHI CHÚ CHỈ NHẬN "TÊN NGUYÊN LIỆU THẬT" (chốt 27/8) =====
     Cột Ghi Chú là câu chữ tự do, mà `parseKeoCond` cắt phần chữ còn lại ra làm TÊN NGUYÊN
     LIỆU. Câu nói suông thành "nguyên liệu" thì quy tắc đòi khớp một thứ không tồn tại ⇒ độ
     dày đó MẤT KEO. Đã vấp nhiều lần và mỗi lần lại một câu khác:
       · 265S  "Keo xanh blue 150BT 2mm"                    (chặn được vì có chữ "keo")
       · 737P  "Khách đã xác nhận dùng keo như bảng sau"     (chặn được vì có chữ "keo")
       · 776P  "Khách đã xác nhận"  ← KHÔNG có chữ "keo" nên lọt ⇒ độ dày 0.10 và 0.085 mất keo
     Nên ĐỔI CHIỀU: chỉ nhận khi trông GIỐNG tên nguyên liệu — có từ khoá nguyên liệu / tên màu
     / chữ "màu" / đúng dạng code sợi. Câu nào không có thì coi như KHÔNG ràng buộc nguyên liệu
     (vẫn giữ điều kiện độ dày · độ dài của dòng keo đó).
     Cột "Loại Sợi" là cột CÓ CẤU TRÚC nên KHÔNG lọc — khách ghi gì thì tin. */
  var MAT_KW = /(mink|silk|matte|mờ|faux|premium|super|ultra|velvet|\bvel\b|cashmere|flat|glossy|laser|liigos|easy\s*fan|easyfan|pr\s*fan|prfan|volume|lash|premade|hybrid|camellia|chocolate|cocoa|caf[eé]|noir|espresso|mocha|caramel|honey|pecan|wine|raku|cappuccino|neon|silver|nude|beige|cream|bordeaux|ghiaccio|tip|line)/i;
  function laTenMatThat(x) {
    var t = String(x == null ? '' : x).trim();
    if (!t) return false;
    if (laCodeSoi(t)) return true;                 // code sợi ("3.MK.7")
    if (COLOR_KW.test(t) || COLOR_NAME.test(t)) return true;   // "hàng màu" · "Bordeaux" · "Blue"…
    return MAT_KW.test(t);
  }
  function locMatGhiChu(list) { return (list || []).filter(laTenMatThat); }
  /* RÁC còn lại sau khi bóc điều kiện độ dài — TUYỆT ĐỐI không được thành "tên nguyên liệu",
     vì quy tắc keo sẽ đòi khớp một nguyên liệu không tồn tại ⇒ cả đơn mất keo (đơn K47-772P):
       · "độ dài 4mm-5mm-6mm"      → còn "- mm- mm"
       · "từ độ dài 7mm trở lên"   → còn "từ"
     Bỏ số · dấu · chữ "mm" đi mà không còn chữ nào, hoặc chỉ còn 1 từ nối, thì đó là rác. */
  function laRacMat(t) {
    var x = String(t == null ? '' : t).replace(/\bmm\b/gi, ' ')
      .replace(/[^A-Za-zÀ-ỹ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!x) return true;
    return /^(t[ừu]|k[ểe] t[ừu]|cho|d[ùu]ng|[áa]p d[ụu]ng|v[ớo]i|c[ủu]a|theo|nh[ưu]|trong|v[àa]|đ[ếe]n|t[ớo]i|l[êe]n|xu[ốo]ng)$/i.test(x);
  }
  /** keoRows → rules[{maDon, glue, mats[], thick[] (khóa chữ số), lo, hi, spec}]. */
  // Chuẩn hoá tên keo: "Nau155C. 2" → "Nau155C.2"
  function cleanKeoName(s) { return PS(s).replace(/\s*\.\s*/g, '.').replace(/\s+/g, ' ').trim(); }
  // 1 ô "Loại Keo" GỘP nhiều keo (xuống dòng/phẩy) + Ghi Chú map từng keo theo ĐỘ DÀI
  //  (vd "Từ 4 đến 5mm dùng keo Nau155C.2 / Từ 6mm dùng keo Nau155C.3")
  //  → TÁCH thành nhiều rule, mỗi keo 1 dải độ dài. Không map được chắc chắn → trả null (giữ hành vi cũ).
  /** Độ dày của 1 dòng keo (cột Độ Dày + độ dày nhúng trong Loại Sợi) → khóa chữ số. */
  function thicksOfKeoRow(k) {
    var _dd = String(k.doDay || ''), out = [];
    (_dd.match(/0[.,]\d+/g) || []).forEach(function (d) { var t = thickKey(d); if (t) out.push(t); });
    _dd = _dd.replace(/0[.,]\d+/g, ' ');
    (_dd.match(/\d+/g) || []).forEach(function (n) { var t = thickKey(n); if (t) out.push(t); });
    return out.concat(parseKeoCond(k.loaiSoi || '').thicks);
  }
  function splitKeoByNote(k, thicks, matsFallback) {
    if (k._daTach) return null;    // dòng đã được tách sẵn thành nhiều dòng thật → đừng tách lại
    var names = PS(k.loaiKeo).split(/[\r\n,;]+/).map(cleanKeoName).filter(Boolean);
    var gh = PS(k.ghiChu); if (!gh || !/\d/.test(gh)) return null;
    /* Khách còn 1 kiểu ghi nữa: ô "Mã Keo" chỉ ghi MỘT keo, keo thứ hai nằm trong Ghi Chú —
       vd 744P: ô ghi "XanhBLu150.2", ghi chú "XanhBLu150.2 cho độ dài 6-8mm; Keo XanhBLu150.3
       cho độ dài từ 9mm trở lên". Trước đây chỉ nhìn ô Mã Keo nên bỏ sót keo .3, mọi mm đều
       ăn keo .2. Giờ nhặt thêm tên keo trong ghi chú (dạng <chữ><số>.<số>).
       An toàn: chỉ chấp nhận khi ô Mã Keo CÓ MẶT trong ghi chú — tức là ghi chú thật sự đang
       nói về chính dòng keo này, không phải chú thích linh tinh. */
    (gh.match(/[A-Za-z][A-Za-z0-9]*\s*\.\s*\d+/g) || []).forEach(function (n) {
      var c = cleanKeoName(n); if (c) names.push(c);
    });
    var seenN = {}, uniq = [];
    names.forEach(function (n) { var key = n.replace(/\s+/g, '').toLowerCase(); if (!seenN[key]) { seenN[key] = 1; uniq.push(n); } });
    if (uniq.length < 2) return null;
    var cellN = cleanKeoName(PS(k.loaiKeo).split(/[\r\n,;]+/)[0] || '').replace(/\s+/g, '').toLowerCase();
    if (cellN && !seenN[cellN]) return null;
    /* NGĂN ĐOẠN: xuống dòng · ";" · và cả khi khách viết LIỀN 1 DÒNG nối bằng "và/&/,"
       (769P: "XanhLX70.2 cho 6-8mm và XanhLX70.3 cho 9-14mm"). Cách chắc ăn: cắt theo VỊ TRÍ
       của từng tên keo — mỗi đoạn chạy từ tên keo này tới ngay trước tên keo kế tiếp. */
    var lines = gh.split(/\r?\n|;/);
    (function () {
      var moc = [];
      uniq.forEach(function (kn) {
        try {
          var re = new RegExp(kn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\s*\\.\\s*'), 'i');
          var m = gh.match(re); if (m && m.index != null) moc.push({ i: m.index, kn: kn });
        } catch (e) {}
      });
      if (moc.length < 2) return;
      moc.sort(function (a2, b2) { return a2.i - b2.i; });
      var doan = moc.map(function (x, j) { return gh.slice(x.i, j + 1 < moc.length ? moc[j + 1].i : gh.length); });
      // chỉ dùng cách cắt này khi MỖI đoạn có điều kiện độ dài riêng — nếu không, giữ cách cũ
      var du = doan.every(function (d) {
        var lc = d;
        uniq.forEach(function (nm) { try { var re2 = new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\s*\\.\\s*'), 'gi'); lc = lc.replace(re2, ' '); } catch (e) {} });
        var c2 = parseKeoCond(lc); return c2.lo != null || c2.hi != null;
      });
      if (du) lines = doan;
    })();
    var made = [];
    uniq.forEach(function (kn) {
      var knN = kn.replace(/\s+/g, '').toLowerCase(), line = null;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].replace(/\s+/g, '').toLowerCase().indexOf(knN) >= 0) { line = lines[i]; break; }
      }
      if (!line) return;
      // bỏ MỌI tên keo khỏi dòng để đọc độ dài không nhiễu bởi chữ số trong tên keo
      var lc = line;
      uniq.forEach(function (nm) { try { var re = new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\s*\\.\\s*'), 'gi'); lc = lc.replace(re, ' '); } catch (e) {} });
      var c = parseKeoCond(lc);
      if (c.lo == null && c.hi == null) return;               // không có điều kiện độ dài rõ ràng → bỏ (an toàn)
      made.push({ maDon: k.maDon, glue: kn, mats: matsFallback || [], thick: (thicks || []).slice(), lo: c.lo, hi: c.hi, spec: c.spec });
    });
    return made.length >= 2 ? made : null;
  }
  /* Bung dòng keo "1 ô nhiều quy tắc" thành NHIỀU DÒNG THẬT trong bảng keo.
     Trước đây app chỉ vẽ mấy dòng tách ra cho ĐẸP (chữ xanh, không sửa được) còn dữ liệu vẫn
     là 1 dòng — bóc sai thì không sửa được ở đâu cả. Giờ chúng là dòng thật: sửa ô nào là
     keo tính lại theo ô đó. Ghi chú gốc giữ ở dòng đầu để còn đối chiếu với đơn khách. */
  function keoRangeText(r) {
    if (r.lo != null && r.hi != null && r.hi < 900) return r.lo === r.hi ? (r.lo + 'mm') : (r.lo + '-' + r.hi + 'mm');
    if (r.lo != null) return 'từ ' + r.lo + 'mm';
    if (r.hi != null && r.hi < 900) return 'đến ' + r.hi + 'mm';
    return '';
  }
  /* ===== SINH BẢNG KEO TỪ CỘT "KEO NHIỆT" CỦA DÒNG ĐƠN (chốt 19/8) =====
     Nhiều đơn khách KHÔNG kèm Bảng Keo, keo ghi thẳng ở từng dòng ("XanhLX70.2",
     "XanhLX70.2 cho 6-8mm và XanhLX70.3 cho 9-14mm"). Trước đây app chỉ lặng lẽ mượn ô đó
     để điền keo, còn bước 4 báo "đơn không có bảng keo" nên không xem/sửa được.
     → Gom các dòng đơn theo (mã đơn · keo ghi · nguyên liệu · độ dày) thành DÒNG BẢNG KEO
     đúng dạng cũ; ghi chú giữ nguyên văn để phần bung "keo theo độ dài" chạy như thường. */
  function sinhKeoTuDonHang(orders, daCoKeo) {
    var nhom = {}, out = [], theoSoi = {};
    (orders || []).forEach(function (o) {
      var keo = PS(o.ghiChuKeo); if (!keo) return;
      if (daCoKeo && daCoKeo[o.maDon]) return;                 // đơn đã có bảng keo thật → bỏ qua
      var mat = PS(o.material || o.detail || '').replace(/0[.,]\d+/g, ' ').replace(/\s+/g, ' ').trim();
      var day = PS(o.thickness);
      var mas = keo.match(/[A-Za-zĐđ][A-Za-z0-9]*\s*\.\s*\d+/g) || [];
      var coDieuKien = /\d\s*mm|cho\b|từ\b|đến\b|dưới\b|trên\b/i.test(keo) || mas.length > 1;
      /* KEO KHÁC NHAU THEO ĐỘ DÀI mà khách KHÔNG ghi chữ: cùng loại sợi + độ dày nhưng dòng
         5-8mm ghi keo .2, dòng 9-12mm ghi keo .3 (đơn 769P, sợi 0.15). Gom dải mm của từng
         mã keo để suy ra cột Độ Dài — không thì mọi mm đều ăn mã keo đầu tiên. */
      var gk = o.maDon + '|' + mat + '|' + day;
      var g = theoSoi[gk] || (theoSoi[gk] = { keo: {}, coDK: false });
      if (coDieuKien) g.coDK = true;
      else {
        var r = parseRange(o.length);
        var ô = g.keo[keo] || (g.keo[keo] = { lo: null, hi: null });
        if (r) { if (ô.lo == null || r.lo < ô.lo) ô.lo = r.lo; if (ô.hi == null || r.hi > ô.hi) ô.hi = r.hi; }
      }
      var k = o.maDon + '|' + keo + '|' + mat + '|' + day;
      if (nhom[k]) return;
      var row = {
        maDon: o.maDon,
        loaiKeo: mas.length ? mas.map(cleanKeoName).join(', ') : keo,
        loaiSoi: mat, doDay: day, doDai: '',
        ghiChu: coDieuKien ? keo : '',
        _gk: gk, _keoGoc: keo, tuSinh: true
      };
      nhom[k] = row; out.push(row);
    });
    /* Điền cột Độ Dài cho nhóm có TỪ 2 MÃ KEO trở lên và các dải KHÔNG chồng nhau.
       Chồng nhau (không đoán được ý khách) thì để trống như cũ, an toàn hơn là đoán bừa. */
    Object.keys(theoSoi).forEach(function (gk) {
      var g = theoSoi[gk], ten = Object.keys(g.keo);
      if (g.coDK || ten.length < 2) return;
      var ds = ten.map(function (t) { return { t: t, lo: g.keo[t].lo, hi: g.keo[t].hi }; })
                  .filter(function (x) { return x.lo != null; });
      if (ds.length !== ten.length) return;
      ds.sort(function (a2, b2) { return a2.lo - b2.lo; });
      for (var i = 1; i < ds.length; i++) if (ds[i].lo <= ds[i - 1].hi) return;   // chồng dải → bỏ qua
      ds.forEach(function (x) {
        out.forEach(function (r) {
          if (r._gk === gk && r._keoGoc === x.t) r.doDai = (x.lo === x.hi) ? (x.lo + 'mm') : (x.lo + '-' + x.hi + 'mm');
        });
      });
    });
    out.forEach(function (r) { delete r._gk; delete r._keoGoc; });
    return out;
  }
  function expandKeoRows(keoRows) {
    var out = [];
    (keoRows || []).forEach(function (k) {
      var split = (k && !k._daTach && PS(k.ghiChu))
        ? splitKeoByNote(k, thicksOfKeoRow(k), parseKeoCond(k.loaiSoi || '').mats) : null;
      if (!split || split.length < 2) { out.push(k); return; }
      split.forEach(function (r, i) {
        var row = {
          maDon: k.maDon, loaiKeo: r.glue, loaiSoi: PS(k.loaiSoi), doDay: PS(k.doDay),
          doDai: keoRangeText(r) || PS(k.doDai),
          ghiChu: i === 0 ? PS(k.ghiChu) : '',
          _daTach: 1,
        };
        if (k._manual) row._manual = 1;
        out.push(row);
      });
    });
    return out;
  }
  /* CỘT "HÀNG XƯỞNG THANH HÓA" — dùng chung cho CẢ HAI template (cũ và 2026).
     Nhận theo 2 đường: (1) tiêu đề ghi TH / Thanh Hoá; (2) tiêu đề TRỐNG thì soi 2 cột ngay
     sau cột tổng ("Tổng Số Hộp" ở mẫu cũ · "Tổng" ở mẫu 2026) — cột nào MỌI ô có chữ đều là
     "TH" thì đó là cột đánh dấu. KHÔNG quét cả bề ngang vì bảng phụ bên phải cũng có ô "TH"
     của riêng nó (đơn 774P) → gắn nhầm dòng. */
  /** Ô đánh dấu xưởng → mã ngắn: TH · HY · '' (ND/Nam Định = xưởng nhà, không gắn đuôi). */
  function maXuongCuaO(v) {
    var t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) return null;
    if (/^(th|thanh\s*ho[áa])$/.test(t)) return 'TH';
    if (/^(hy|h[ưu]ng\s*y[êe]n)$/.test(t)) return 'HY';
    if (/^(n[dđ]|nam\s*[dđ][ịi]nh)$/.test(t)) return '';     // xưởng nhà → giữ nguyên code sợi
    return null;
  }
  /* Ký hiệu hàng đặc biệt nhận từ chữ trong dòng đơn:
     laser/liigos→LZ · easy fan single/1S→1ES · easy fan double/2S→2ES · <số>D-U (vd 3D-U)→DU

     EASY FAN: khách ghi 2 kiểu, phải nhận CẢ HAI (chốt 21/8 — đơn K54-754P ghi "1S EasyFan"
     và "16Lines . 1S Easy Fan" nên trước đây không ra đuôi 1ES):
       · viết chữ:    "easy fan single" / "easy fan double"
       · viết tắt số: "1S" (single) / "2S" (double) nằm cùng ô với "easy fan"/"easyfan"
     Xét TRONG TỪNG Ô (dòng đơn ghép các ô bằng " ¦ "): ô đó phải có CẢ chữ "easy fan" LẪN
     "1S"/"2S". Không quét cả dòng, vì code sợi kiểu "229.SPK2S.7" hay ".2S." sẽ bị nhận nhầm
     thành hàng double.
     "1S" phải là một TỪ RIÊNG: trước là ký tự không phải chữ-số, sau cũng vậy — nhờ đó
     "16Lines" (1 rồi 6), "1ST", "229.SPK2S.7" đều không dính. */
  var EF = /easy\s*fan/i;
  function efSo(so) {
    var reSo = new RegExp('(?:^|[^A-Za-z0-9])' + so + '\\s*S(?![A-Za-z0-9])');
    var reChu = new RegExp('easy\\s*fan\\s*' + (so === '1' ? 'single' : 'double'), 'i');
    return function (s) {
      var o = String(s == null ? '' : s).split('¦');
      for (var i = 0; i < o.length; i++) {
        if (!EF.test(o[i])) continue;
        if (reChu.test(o[i]) || reSo.test(o[i])) return true;
      }
      return false;
    };
  }
  var SPECIAL_SYM = [
    ['LZ',  /laser|liigos/i],
    ['1ES', efSo('1')],
    ['2ES', efSo('2')],
    ['DU',  /\d\s*d\s*[-\/]\s*u/i]
  ];
  /* Mỗi mẫu có thể là RegExp hoặc hàm — dùng chung một chỗ thử để 2 bộ đọc (mẫu cũ · mẫu 2026)
     không bao giờ lệch nhau. */
  function khopKyHieu(mau, s) {
    return (typeof mau === 'function') ? !!mau(s) : mau.test(s);
  }
  /* KÝ HIỆU HÀNG ĐẶC BIỆT (LZ · 1ES · 2ES · DU): xuất hiện ở MỌI dòng → gắn vào MÃ ĐƠN;
     chỉ vài dòng → gắn vào CODE SỢI của đúng mấy dòng đó. Dùng CHUNG cho cả 2 template. */
  function apKyHieuDacBiet(out, maDon) {
    var dsMoTa = [];
    SPECIAL_SYM.forEach(function (p) {
      var sym = p[0], hit = out.filter(function (o) { return o._kw && o._kw[sym]; });
      if (!hit.length) return;
      if (hit.length === out.length) {
        // mã đơn khách hay có dấu "-" ở cuối ("CS185-") → bỏ bớt để không thành "CS185--LZ"
        var suf = '-' + sym, don = function (m) { return String(m || '').replace(/-+$/, '') + suf; };
        out.forEach(function (o) { o.maDon = don(o.maDon); });
        maDon = don(maDon); dsMoTa.push(sym + ' (cả đơn → mã đơn)');
      } else {
        hit.forEach(function (o) { o.codeSoi += '-' + sym; });
        dsMoTa.push(sym + ' (' + hit.length + ' dòng → code sợi)');
      }
    });
    out.forEach(function (o) { delete o._kw; });
    return { maDon: maDon, dsMoTa: dsMoTa };
  }
  function timCotXuongTH(H, aoa, hr, endIdx) {
    for (var i = 0; i < H.length; i++) {
      var h = PS(H[i]).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!h) continue;
      if (/thanh\s*ho[áa]/.test(h) || h === 'th' || /^x[ưu]ởng(\s|$)/.test(h)) return i;
    }
    if (!(endIdx >= 0)) return -1;
    for (var c = endIdx + 1; c <= endIdx + 2; c++) {
      var dem = 0, sach = true;
      for (var r = hr + 1; r < aoa.length; r++) {
        var v = PS((aoa[r] || [])[c]); if (!v) continue;
        if (maXuongCuaO(v) !== null) dem++; else { sach = false; break; }
      }
      if (sach && dem > 0) return c;
    }
    return -1;
  }
  /* ===== ĐỌC Ô "ĐỘ DÀY" CỦA BẢNG KEO =====
     Kiểu ghi ĐỘ DÀY (tránh nhập nhằng dấu phẩy):
       · số THẬP PHÂN "0.07 / 0,085 / 0.10" → dấu phẩy là dấu thập phân, giữ nguyên
       · MÃ độ dày NGUYÊN "6,7,85,10" → dấu phẩy là dấu TÁCH LIST
     Khách còn viết kèm ĐIỀU KIỆN ĐỘ DÀI ngay trong ô này: "15 (6-8mm)" / "15 (9-13mm)"
     (đơn K21-761P). Mấy số trong ngoặc / dải "6-8mm" là ĐỘ DÀI, KHÔNG phải độ dày — trước
     đây bóc bừa thành độ dày 6 và 8 nên:
       · quy tắc keo XanhBLu150.2 ăn cả sợi 0.06/0.08 (sai keo, im lặng), và
       · bộ cảnh báo tưởng độ dày 0.06 có 2 keo (Cam837.2 vs XanhBLu150.2) → BÁO OAN (21/8).
     tachDoDay() trả riêng { thicks, dai } để buildKeoRules dùng "dai" làm điều kiện độ dài. */
  function _thicksTho(s) {
    var out = [];
    (s.match(/0[.,]\d+/g) || []).forEach(function (d) { var t = thickKey(d); if (t) out.push(t); });
    s = s.replace(/0[.,]\d+/g, ' ');
    (s.match(/\d+/g) || []).forEach(function (n) { var t = thickKey(n); if (t) out.push(t); });
    return out;
  }
  function tachDoDay(doDay) {
    var s = String(doDay == null ? '' : doDay), dai = [];
    s = s.replace(/\(([^)]*)\)/g, function (_m, x) { dai.push(x); return ' '; });          // phần trong ngoặc
    s = s.replace(/\d+\s*[-~]\s*\d+\s*mm/gi, function (x) { dai.push(x); return ' '; });  // dải "6-8mm"
    return { thicks: _thicksTho(s), dai: dai.join(' ').replace(/\s+/g, ' ').trim() };
  }
  function thicksOfDoDay(doDay) { return tachDoDay(doDay).thicks; }
  /* ===== 1 ĐỘ DÀY DÙNG 2 LOẠI KEO MÀ KHÔNG PHÂN BIỆT ĐƯỢC → CẢNH BÁO (chốt 21/8) =====
     Cùng một ĐỘ DÀY mà khách ghi ≥2 mã keo khác nhau, và mấy dòng đó KHÔNG có thông tin gì để
     phân biệt → app không có căn cứ chọn: TÔ MÀU + tính vào "ô sai chuẩn" cho user tự kiểm.
     "CÓ thông tin phân biệt" = cột Loại Sợi hoặc Độ Dài có chữ, HOẶC Ghi Chú chứa ĐIỀU KIỆN
     THẬT (dải mm / độ dày / phạm vi độ cong). Ghi chú chỉ là câu nói suông thì KHÔNG tính —
     `parseKeoCond` bóc cả câu thành "tên nguyên liệu" nên không thể tin mats. Ca thật:
       · 785P độ dày 0.07/0.05 — Loại Sợi ghi rõ "GHIACCIO 0.07" / "BORDEAUX 0.05" → KHÔNG báo
       · 672P "4-8mm" vs "9-18mm" · 731P "7-9mm" vs "10-14mm" · 754P "từ 7mm trở lên" vs
         "4-6mm" · 750P "6-8mm … không phải LB/LC/LJ/LC+" → có điều kiện → KHÔNG báo
       · 775P độ dày 0.05 — cả 2 dòng chỉ ghi "Khách đã xác nhận dùng keo này" (ghi chú THỪA,
         không phân biệt gì) → BÁO
       · 754P độ dày 0.06 — cả 3 cột trống → BÁO */
  function keoCoDieuKien(k) {
    if (!k) return false;
    if (PS(k.loaiSoi) || PS(k.doDai)) return true;
    // dải độ dài viết KÈM trong ô Độ Dày: "15 (6-8mm)" vs "15 (9-13mm)" → phân biệt được
    if (tachDoDay(k.doDay).dai) return true;
    var gh = PS(k.ghiChu); if (!gh) return false;
    var c = parseKeoCond(gh);
    return c.lo != null || (c.thicks && c.thicks.length > 0) || !!c.curlOnly || !!c.curlNot || /đ[ộo]\s*cong/i.test(gh);
  }
  function timKeoNhapNhang(keoRows) {
    var nhom = {};
    (keoRows || []).forEach(function (k) {
      var glue = cleanKeoName(PS(k.loaiKeo)); if (!glue) return;
      if (keoCoDieuKien(k)) return;                 // có căn cứ phân biệt → không phải ca nhập nhằng
      thicksOfDoDay(k.doDay).forEach(function (t) {
        var key = k.maDon + '|' + t, g = nhom[key] || (nhom[key] = []);
        if (g.indexOf(glue) < 0) g.push(glue);
      });
    });
    var out = {};
    Object.keys(nhom).forEach(function (key) { if (nhom[key].length >= 2) out[key] = nhom[key].slice().sort(); });
    return out;
  }
  /** Dòng Bảng Keo này có nằm trong nhóm nhập nhằng không → trả về danh sách keo đang tranh nhau. */
  function keoNhapNhangCuaDong(amb, k) {
    if (!amb || !k) return null;
    if (keoCoDieuKien(k)) return null;
    var ds = thicksOfDoDay(k.doDay);
    for (var i = 0; i < ds.length; i++) { var g = amb[k.maDon + '|' + ds[i]]; if (g) return g; }
    return null;
  }
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
          c.mats = locMatGhiChu(c.mats);       // câu nói suông KHÔNG được thành tên nguyên liệu
          if (!c.thickRaw.length && !c.mats.length && c.lo == null && !c.curlOnly && !c.curlNot) return;
          rules.push({ maDon: k.maDon, glue: PS(k.loaiKeo), mats: c.mats, thick: c.thicks, lo: c.lo, hi: c.hi, spec: c.spec,
                       dsMm: c.dsMm || null,
                       curlOnly: c.curlOnly || null, curlNot: c.curlNot || null, matsNot: c.matsNot || null });
        });
        return;
      }
      var len = parseKeoCond(k.doDai || '');
      /* Cột "Loại Sợi" ghi thẳng CODE SỢI (template mới: "3.MK.7") → phải giữ NGUYÊN VĂN,
         không đưa qua parseKeoCond vì hàm đó bóc số ra thành độ dày rồi băm tên thành rác
         (⇒ đơn 792P không dòng nào có keo). */
      var codeSoiRule = PS(k.loaiSoi || '').split(/[\n,;\/]+/).map(function (x) { return PS(x); }).filter(laCodeSoi);
      var soi = codeSoiRule.length ? { mats: codeSoiRule, thicks: [], lo: null, hi: null, spec: 0, curlOnly: null, curlNot: null, matsNot: null }
                                   : parseKeoCond(k.loaiSoi || '');   // Loại Sợi có thể nhúng độ dày ("0,07; 0,085")
      var ghi = parseKeoCond(k.ghiChu || '');    // Ghi Chú thường chứa điều kiện ĐỘ DÀI (vd "dưới 10mm", "từ 10mm")
      // Cột Độ Dày = chỉ chứa độ dày. Xử lý 2 kiểu ghi (tránh nhập nhằng dấu phẩy):
      //  · số THẬP PHÂN "0.07 / 0,085 / 0.10" → giữ nguyên (dấu phẩy là dấu thập phân)
      //  · MÃ độ dày NGUYÊN "6,7,85,10" hoặc "7,10" → dấu phẩy là dấu tách LIST (không phải thập phân)
      var _dd = tachDoDay(k.doDay), dayThicks = _dd.thicks;
      var thicks = dayThicks.concat(soi.thicks);
      /* Điều kiện ĐỘ DÀI: ưu tiên cột Độ Dài → dải ghi KÈM trong ô Độ Dày ("15 (6-8mm)")
         → Loại Sợi → Ghi Chú. */
      if (len.lo == null && _dd.dai) { var _dl = parseKeoCond(_dd.dai); if (_dl.lo != null) len = _dl; }
      if (len.lo == null && soi.lo != null) { len = soi; }
      var _ghDescLen = (PS(k.loaiSoi) || PS(k.doDay) || PS(k.doDai)) && /(^|[\s("'•*-])keo(\s|$)/i.test(PS(k.ghiChu));
      if (len.lo == null && ghi.lo != null && !_ghDescLen) { len = ghi; }
      // NGUYÊN LIỆU: ưu tiên cột Loại Sợi; nếu TRỐNG thì lấy từ Ghi Chú (khách hay ghi "chỉ dùng cho ... Cashmere Silk")
      // → giữ ràng buộc nguyên liệu để không khớp nhầm keo giữa các loại sợi khác nhau.
      /* Trừ khi ghi chú là loại "map keo theo độ dài" (có nhắc MÃ KEO trong đó) — lúc đó
         parseKeoCond cắt nhầm cả cụm "XanhBLu cho độ dài" thành tên nguyên liệu, làm quy tắc
         không khớp với nguyên liệu nào cả rồi rơi hết vào keo mặc định. */
      var ghNoteHasGlue = /[A-Za-z][A-Za-z0-9]*\s*\.\s*\d+/.test(PS(k.ghiChu));
      /* GHI CHÚ CHỈ MÔ TẢ MÃ KEO → KHÔNG PHẢI ĐIỀU KIỆN (chốt 18/8).
         Cột thuộc tính đã có điều kiện mà Ghi Chú lại nhắc chữ "keo" thì đó là câu mô tả:
           · 265S: "Keo xanh blue 150BT 2mm" → trước đây thành nguyên liệu "Keo xanh blue BT"
             + độ dài 2mm ⇒ 7/7 dòng KHÔNG có keo.
           · 737P: "Khách đã xác nhận dùng keo như bảng sau" → thành "nguyên liệu" ⇒ 0.10 mất keo.
         Điều kiện thật của khách nằm ở cột Độ Dày/Loại Sợi/Độ Dài, cứ theo đó mà tra. */
      var ghDesc = hasStructured && /(^|[\s("'•*-])keo(\s|$)/i.test(gh);
      var mats = soi.mats.length ? soi.mats : ((ghNoteHasGlue || ghDesc) ? [] : locMatGhiChu(ghi.mats));
      // Độ dày: ưu tiên cột Độ Dày; nếu cột này trống thì lấy từ Ghi Chú.
      if (!dayThicks.length && !soi.thicks.length && ghi.thicks.length && !ghDesc) { thicks = ghi.thicks; }
      // Ô keo GỘP nhiều keo + ghi chú map theo độ dài → TÁCH mỗi keo 1 dải (mỗi mm ra đúng 1 keo).
      var split = splitKeoByNote(k, thicks, soi.mats);
      if (split) { split.forEach(function (r) { rules.push(r); }); return; }
      rules.push({
        maDon: k.maDon, glue: cleanKeoName(k.loaiKeo),
        mats: mats, thick: thicks,
        lo: len.lo, hi: len.hi, spec: len.spec, dsMm: len.dsMm || null,
        // phạm vi ĐỘ CONG (nếu ghi chú có nói) — ưu tiên Ghi Chú, rồi Loại Sợi, rồi Độ Dài
        curlOnly: ghi.curlOnly || soi.curlOnly || len.curlOnly || null,
        curlNot:  ghi.curlNot  || soi.curlNot  || len.curlNot  || null,
        matsNot:  soi.matsNot  || ghi.matsNot  || len.matsNot  || null,
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
  /** Điểm khớp giữa nguyên liệu của DÒNG ĐƠN và danh sách tên trong quy tắc keo (−1 = không khớp). */
  /* Cột "Loại Sợi" của Bảng Keo có đơn ghi thẳng CODE SỢI ("3.MK.7", "150.SMK.7") thay vì tên
     nguyên liệu (template mới, đơn K21-792P). Nhận dạng để so với Code Sợi của dòng, không thì
     quy tắc chẳng khớp nguyên liệu nào ⇒ cả đơn không có keo. */
  var CODE_SOI_RE = /^\d+[A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.\d+$/;
  function laCodeSoi(x) { return CODE_SOI_RE.test(String(x == null ? '' : x).replace(/\s+/g, '')); }
  function khopCodeSoi(a, comp) {
    var an = String(a == null ? '' : a).replace(/\s+/g, '').toLowerCase();
    var cs = String((comp && comp.codeSoi) || '').split(/\r?\n/);
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i].replace(/\s+/g, '').toLowerCase().replace(/-(?:nc|th)$/g, '');
      if (c && c === an) return true;
    }
    return false;
  }
  function diemKhopMat(list, mat, comp) {
    var hit = -1;
    (list || []).forEach(function (a) {
      // Bảng Keo ghi CODE SỢI ở cột Loại Sợi → so đúng code sợi của dòng
      if (laCodeSoi(a)) { if (khopCodeSoi(a, comp)) hit = Math.max(hit, 60); return; }
      // "hàng màu/sợi màu/màu" → khớp mọi sợi MÀU (không chứa Mink/Silk)
      if (isColorMat(a)) { if (isColorComp(comp)) hit = Math.max(hit, 30); return; }
      // "hàng Mink" / "sợi Mink" = mọi sợi có chữ Mink → bỏ chữ chỉ loại đứng đầu
      var an = normTxt(a).replace(/\d+(?:[.,]\d+)?/g, ' ').replace(/^(?:hàng|sợi|loại)\s+/, '').replace(/\s+/g, ' ').trim();
      if (!an) return;
      if (mat === an) hit = Math.max(hit, an.length + 50);        // khớp chính xác
      // CHỈ 1 CHIỀU: material của dòng CHỨA tên rule ("premium faux mink" chứa "faux mink" → rule
      // Faux Mink áp được, nhưng rule "Premium Faux Mink" KHÔNG áp cho dòng "Faux Mink")
      else if (mat.indexOf(an) >= 0) hit = Math.max(hit, an.length);
    });
    return hit;
  }
  function glueFor(rules, comp, out) {
    var mat = normTxt(comp.material).replace(/\d+(?:[.,]\d+)?/g, ' ').replace(/\s+/g, ' ').trim();
    var mm = Number(comp.mm);
    // Code sợi có thể mang NHIỀU độ dày (vd "0.07/0.08") → khớp nếu BẤT KỲ độ dày nào nằm trong rule
    var compThicks = (String(comp.thickness == null ? '' : comp.thickness).match(/\d+(?:[.,]\d+)?/g) || []).map(thickKey).filter(function (x) { return x; });
    var tk = compThicks[0] || '';
    var best = null, bestScore = -1, dsBest = [];
    (rules || []).forEach(function (r) {
      if (comp.maDon && r.maDon && r.maDon !== comp.maDon) return;
      var hasMat = r.mats && r.mats.length, hasThick = r.thick && r.thick.length;
      if (!hasMat && !hasThick && r.lo == null && !r.curlOnly && !r.curlNot && !(r.matsNot && r.matsNot.length)) return;   // quy tắc rỗng → bỏ
      // đang tra cho MỘT NHÓM ĐỘ CONG cụ thể → rule của nhóm kia không được xen vào
      if (comp.curlNhom != null && !ruleHopCurl(r, !!comp.curlNhom)) return;
      // ---- ĐIỀU KIỆN LỌC CỨNG: vi phạm bất kỳ → LOẠI ----
      if (r.lo != null) { if (!isFinite(mm) || mm < r.lo || mm > r.hi) return; }
      // khách LIỆT KÊ từng mm ("4mm-5mm-6mm") → chỉ đúng mấy mm đó mới khớp, không suy ra khoảng kín
      if (r.dsMm && r.dsMm.length && r.dsMm.indexOf(mm) < 0) return;
      // Sợi MÀU khớp quy tắc keo màu theo ĐỘ DÀI, BỎ ràng buộc độ dày (điều kiện độ dày trong ghi chú là cho Super Silk).
      var ruleColor = !!(r.mats && r.mats.some(isColorMat)), compColor = ruleColor && isColorComp(comp);
      if (hasThick && !compColor) {
        var thit = false;
        for (var _t = 0; _t < compThicks.length; _t++) { if (r.thick.indexOf(compThicks[_t]) >= 0) { thit = true; break; } }
        if (!thit) return;
      }
      // NGUYÊN LIỆU BỊ LOẠI TRỪ ("… trừ hàng Ultra Matte") → khớp cái nào là LOẠI rule luôn
      if (r.matsNot && r.matsNot.length && mat && diemKhopMat(r.matsNot, mat, comp) >= 0) return;
      var matHit = 0;
      if (hasMat) {
        var chiCodeSoi = r.mats.every(laCodeSoi);
        if (!mat && !chiCodeSoi) return;
        var hit = diemKhopMat(r.mats, mat, comp);
        if (hit < 0) return;
        matHit = hit;
      }
      // ---- CHẤM ĐIỂM theo THỨ TỰ ƯU TIÊN: Material > Thickness > Length ----
      // Material trọng số cao nhất (rule chỉ-định-material luôn thắng); rồi Thickness; rồi Length
      // (khoảng độ dài đặc hiệu spec3 > nửa hở spec2 > tất cả spec0) chỉ để phá hoà bậc thấp nhất.
      var score = (matHit + (hasMat ? 1 : 0)) * 1000000 + (hasThick ? 1000 : 0) + (r.spec || 0);
      /* HOÀ ĐIỂM mà 2 keo KHÁC NHAU = app không có căn cứ chọn (775P độ dày 0.05: 2 quy tắc
         y hệt nhau, chỉ khác mã keo). Gom lại vào out.tranh để nơi gọi biết mà lấy keo theo
         BẢNG CHI TIẾT thay vì im lặng lấy quy tắc đầu tiên. */
      if (score > bestScore) { best = r; bestScore = score; dsBest = [r.glue]; }
      else if (score === bestScore && r.glue && dsBest.indexOf(r.glue) < 0) dsBest.push(r.glue);
    });
    if (out) out.tranh = (dsBest.length > 1) ? dsBest.slice().sort() : null;
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
      var g = glueFor(rules, { maDon: comp.maDon, material: comp.material || comp.detail || '', thickness: comp.thickness, mm: mm, codeSoi: comp.codeSoi, detail: comp.detail, loaiHang: comp.loaiHang, label: comp.label, ghiChu: comp.ghiChu });
      if (g) return g;
    }
    return glueFor(rules, comp);   // fallback: theo mm thật
  }
  /** Keo khách ghi ĐÍCH DANH cho nhóm độ cong LB/LC/LJ/LC+ — không có thì trả ''. */
  function glueForCurlOnly(rules, comp) {
    var rs = (rules || []).filter(function (r) {
      return r.curlOnly && r.curlOnly.length && r.curlOnly.some(isOverrideCurl);
    });
    if (!rs.length) return '';
    return glueFor(rs, Object.assign({}, comp, { curlNhom: true }));
  }
  /** Tất cả mã keo của 1 dòng đơn (duyệt từng mm trong dải) — dùng cho Tổng hợp Box. */
  function orderGlues(rules, o) {
    var rg = parseRange(o.length); if (!rg) return [];
    var seen = {}, out = [];
    for (var mm = rg.lo; mm <= rg.hi; mm++) {
      var g = glueFor(rules, { maDon: o.maDon, material: o.material || o.detail || '', thickness: o.thickness, mm: mm, codeSoi: o.codeSoi, detail: o.detail, loaiHang: o.loaiHang, label: o.label, ghiChu: o.ghiChu });
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
  /** Code sợi của dòng độ cong mới: gắn đuôi "-NC" (nhiều code 1 ô thì gắn từng dòng). */
  /** Ô cột xưởng ghi "TH" / "Thanh Hóa" → hàng do xưởng Thanh Hóa làm. */
  var LA_TH = /^(th|thanh\s*ho[áa])$/i;
  /** Code sợi hàng xưởng ngoài: gắn đuôi "-TH" / "-HY" (nhiều code 1 ô thì gắn từng dòng). */
  function themXuong(code, ma) {
    ma = String(ma || '').toUpperCase(); if (!ma) return code;
    var re = new RegExp('-' + ma + '$');
    return String(code == null ? '' : code).split(/\r?\n/)
      .map(function (x) { x = x.trim(); return x ? (re.test(x) ? x : x + '-' + ma) : x; })
      .join('\n');
  }
  function themTH(code) { return themXuong(code, 'TH'); }
  function themNC(code) {
    return String(code == null ? '' : code).split(/\r?\n/)
      .map(function (x) { x = x.trim(); return x ? (/-NC$/.test(x) ? x : x + '-NC') : x; })
      .join('\n');
  }
  function buildCuonBoxSheet(data1, orders, keoRules, keoMalformed, keoHasRules) {
    keoMalformed = keoMalformed || {};
    keoHasRules = keoHasRules || {};
    // nhóm theo MÃ ĐƠN + Code Sợi (cùng code ở 2 đơn khác nhau không gộp lẫn)
    orders = orders || []; var meta = {};
    orders.forEach(function (o) { meta[o.maDon + '|' + o.codeSoi + '|' + o.length] = o; });
    var tree = {};
    data1.forEach(function (r) {
      /* Hàng của xưởng NGOÀI (TH · HY) tách nhóm riêng: cùng code sợi mà nơi làm khác nhau
         thì KHÔNG gộp, và code sợi hiện kèm đuôi "-TH" / "-HY" cho xưởng dễ nhìn. */
      var _xm = String(r.xuongMa || (r.xuongTH ? 'TH' : '')).toUpperCase();
      var ck = r.maDon + '|' + r.codeSoi + (_xm ? '|' + _xm : '');
      var c = tree[ck] || (tree[ck] = { maDon: r.maDon, codeSoi: r.codeSoi, xuongMa: _xm, xuongTH: _xm === 'TH', rows: {}, order: [], total: 0 });
      /* TÁCH DÒNG THEO TỪNG DẢI MIX — chốt 21/8 (đảo lại quyết định 13/8).
         Trước gộp mấy dải cùng phủ 1 mm vào 1 dòng (740P: 6-14 · 7-14 · 7-15 · 7-16mm đều phủ
         mm 11) vì bảng chưa hiện dải nên 4 dòng trông y hệt nhau. Giờ cột "S/M" ghi luôn DẢI,
         nên tách lại từng dòng theo ĐÚNG số lượng của từng bảng Mix — xưởng cuốn theo bảng
         nào biết ngay số của bảng đó, khỏi tự trừ.
         Keo không đổi: keo tra theo (nguyên liệu · độ dày · mm) — cả ba vẫn nằm trong khóa.
         TÁCH theo material + độ dày vẫn giữ: cùng code sợi khác material (Premium Faux Mink ≠
         Faux Mink) phải là 2 component riêng với keo riêng. */
      var key = r.mm + '|' + (r.material || '') + '|' + (r.thickness || '') + '|' + (r.mixSingle || '') + '|' + (r.length || '');
      var g = c.rows[key];
      if (!g) { g = c.rows[key] = { length: r.length, lengths: [], mm: r.mm, curls: {}, tong: 0, keoSet: {}, keo2mmSet: {}, material: r.material || '', thickness: r.thickness || '', mixSingle: r.mixSingle || '' }; c.order.push(key); }
      if (r.cmix) { g.cmix = true; c.cmix = true; }   // dòng tách từ Mix nhiều màu → tô màu ở bước 5
      if (g.lengths.indexOf(r.length) < 0) g.lengths.push(r.length);   // các dải đã gộp (để tra nguồn)
      g.curls[r.curl] = (g.curls[r.curl] || 0) + r.sl; g.tong += r.sl; c.total += r.sl;
      // KEO TRA THEO TỪNG DÒNG data1 (material + độ dày + mm CỦA CHÍNH DÒNG) — không qua meta gộp
      var k1 = '', k2 = '', ambRow = false;
      if (keoMalformed[r.maDon]) {
        // BẢNG KEO SAI CẤU TRÚC → TUYỆT ĐỐI KHÔNG điền keo (kể cả fallback), chờ user sửa
        k1 = ''; k2 = '';
      } else {
        if (keoRules && keoRules.length) {
          var _ctx = { maDon: r.maDon, material: r.material || '', thickness: r.thickness, mm: r.mm, codeSoi: r.codeSoi, detail: r.detail, loaiHang: r.loaiHang, label: r.label, ghiChu: r.ghiChu };
          // độ cong THƯỜNG: bỏ qua quy tắc chỉ dành riêng cho LB/LC/LJ/LC+
          var _tr = {};
          k1 = glueFor(keoRules, Object.assign({}, _ctx, { curlNhom: false }), _tr);
          /* LB/LC/LJ/LC+: nếu khách CÓ ghi rõ keo cho mấy độ cong này thì dùng ĐÚNG keo đó
             (750P: "Độ cong LB, LC, LJ, LC+" → XanhBLu150.2). Không ghi thì giữ nguyên luật
             cũ — "keo 2mm" = keo của dải ngắn nhất. */
          var _kCurl = glueForCurlOnly(keoRules, _ctx);
          k2 = _kCurl || glueForShort(keoRules, _ctx);
          /* TRA RA 2 KEO CÙNG ĐIỂM → KHÔNG ĐOÁN: lấy đúng keo khách ghi ở BẢNG CHI TIẾT của
             dòng đó, đánh dấu để bước 5 tô ô "Keo nhiệt" cho user soi lại (21/8). */
          if (_tr.tranh) { k1 = r.ghiChuKeo || ''; if (!_kCurl) k2 = k1; ambRow = true; }
        }
        /* CHỈ mượn cột "Keo Nhiệt" của khách khi đơn đó KHÔNG CÓ Bảng Keo nào dùng được.
           Đơn CÓ Bảng Keo mà tra không ra thì phải ĐỂ TRỐNG — trước đây lặng lẽ lấy keo trong
           cột của khách, nên xoá một dòng trong Bảng Keo vẫn thấy có keo (mà là keo lạ, không
           hề có trong bảng), tưởng app tính đúng. Trống mới thấy ngay là bảng còn thiếu. */
        if (!k1 && !keoHasRules[r.maDon]) k1 = r.ghiChuKeo || '';
        if (!k2) k2 = k1;
      }
      if (k1) g.keoSet[k1] = 1;
      if (k2) g.keo2mmSet[k2] = 1;
      if (ambRow) g.keoAmb = true;   // ô "Keo nhiệt" ở bước 5 tô cảnh báo để dễ soi lại
    });
    var rows = [], grand = 0, stt = 0, grandCurls = {};
    CURLS.forEach(function (k) { grandCurls[k] = 0; });
    Object.keys(tree).sort().forEach(function (ck) {
      var c = tree[ck], subCurls = {};
      CURLS.forEach(function (k) { subCurls[k] = 0; });
      // Sắp trong 1 code sợi: theo TÊN GỌI NGUYÊN LIỆU trước (để cùng code khác material
      // KHÔNG lẫn lộn), rồi độ dài, rồi mm.
      var smOf = function (g) { return /single/i.test(g.mixSingle || (meta[c.maDon + '|' + c.codeSoi + '|' + g.length] || {}).mixSingle || '') ? 0 : 1; };
      c.order.sort(function (a, b) {
        var A = c.rows[a], B = c.rows[b];
        var ma = A.material || '', mb = B.material || '';
        if (ma !== mb) return ma < mb ? -1 : 1;      // giữ: cùng code khác nguyên liệu không lẫn
        var sa = smOf(A), sb = smOf(B);
        if (sa !== sb) return sa - sb;               // Single trước, Mix sau
        if (A.mm !== B.mm) return A.mm - B.mm;        // mm bé → lớn
        return A.length < B.length ? -1 : (A.length > B.length ? 1 : 0);
      });
      // Trường hợp đặc biệt: 1 code sợi có ≥2 tên gọi nguyên liệu khác nhau → cờ để tô màu.
      var matSet = {};
      c.order.forEach(function (key) { matSet[c.rows[key].material || ''] = 1; });
      var multiMat = Object.keys(matSet).length > 1;
      /* Đuôi "-TH" chỉ để HIỆN (bảng bước 5, 2 bảng Σ, bản in, file xuất). Mọi chỗ tra
         cứu — meta đơn, tra keo, đối chiếu số khách — vẫn dùng c.codeSoi GỐC. */
      var codeHien = themXuong(c.codeSoi, c.xuongMa);
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
        var base = { maDon: c.maDon, codeSoi: codeHien, xuongTH: !!c.xuongTH, xuongMa: c.xuongMa || '', length: g.length,
                     lengths: (g.lengths && g.lengths.length ? g.lengths.slice().sort() : [g.length]),
                     mm: g.mm, box: m.box || '—', mixSingle: g.mixSingle || m.mixSingle || 'Mix',
                     material: g.material || m.material || '', thickness: g.thickness || m.thickness || '', multiMat: multiMat, cmix: !!g.cmix, keoAmb: !!g.keoAmb };
        // Nếu có độ cong đặc biệt và keo 2mm KHÁC keo chuẩn → TÁCH 2 dòng, mỗi dòng 1 keo đúng
        if (hasOvr && keo2mm && keo2mm !== keo) {
          if (normTot > 0) rows.push(Object.assign({ type: 'row', stt: ++stt, curls: normC, tong: normTot, keo: keo, keo2mm: keo2mm }, base));
          /* Dòng độ cong MỚI (LB/LC/LJ/LC+ ăn keo 2mm) → code sợi thêm đuôi "-NC" để phân
             biệt với dòng thường cùng code (chốt 13/8). Đuôi này theo suốt: bảng bước 5,
             2 bảng Σ, bản in và file xuất — đều đọc từ chính dòng này. */
          rows.push(Object.assign({ type: 'row', stt: ++stt, curls: ovrC, tong: ovrTot, keo: keo2mm, keo2mm: keo2mm, ovrRow: true },
                                  base, { codeSoi: themXuong(themNC(c.codeSoi), c.xuongMa) }));
        } else {
          var curls = {}; CURLS.forEach(function (k) { curls[k] = g.curls[k] || 0; });
          rows.push(Object.assign({ type: 'row', stt: ++stt, curls: curls, tong: g.tong, keo: keo, keo2mm: keo2mm }, base));
        }
      });
      rows.push({ type: 'subtotal', maDon: c.maDon, codeSoi: codeHien, xuongTH: !!c.xuongTH, xuongMa: c.xuongMa || '', curls: subCurls, tong: c.total, multiMat: multiMat, cmix: !!c.cmix }); grand += c.total;
    });
    rows.push({ type: 'grand', curls: grandCurls, tong: grand });
    return { rows: rows, grand: grand, summary: buildSummary(data1) };
  }

  /* ---------------- pipeline ---------------- */
  function runPipeline(input) {
    var opt = input.opt || {};
    // truyền keoRows vào bước kiểm tra để soi luôn mã keo ngoài danh sách chuẩn
    var s1 = runStep1(input.rawOrders, Object.assign({}, opt, { keoRows: input.keoRows || [] }));
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
    var keoAmbig = timKeoNhapNhang(input.keoRows);
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
    var cuonSheet = buildCuonBoxSheet(data1, s1.orders, keoRules, keoMalformed, keoUsable);
    var keoByOrder = {};
    var maDons = {}; s1.orders.forEach(function (o) { maDons[o.maDon] = 1; });
    Object.keys(maDons).forEach(function (m) { keoByOrder[m] = (input.keoRows || []).filter(function (k) { return k.maDon === m; }); });
    /* ĐỐI CHIẾU VỚI SỐ KHÁCH TỰ TÍNH (chỉ có ở template 2026).
       Khách gửi kèm bảng mm theo từng độ cong, tính bằng SỢI; app tính bằng DÂY
       (1 dây = 2 sợi) nên nhân 2 rồi so từng ô (code sợi × mm × độ cong).
       Lệch chỗ nào chỉ ra chỗ đó — bắt được cả lỗi app lẫn lỗi khách gõ. */
    var doiChieu = null;
    if (input.khachCuon && input.khachCuon.rows && input.khachCuon.rows.length) {
      var APP = {}, KH = {}, keys = {}, only = {};
      input.khachCuon.rows.forEach(function (rw) { only[rw.maDon] = 1; });   // chỉ soi đơn CÓ số khách gửi
      (cuonSheet.rows || []).forEach(function (rw) {
        if (rw.type !== 'row' || !only[rw.maDon]) return;
        CURLS.forEach(function (k) {
          var q = (rw.curls && rw.curls[k]) || 0; if (!q) return;
          var key = rw.maDon + '|' + rw.codeSoi + '|' + rw.mm + '|' + k;
          APP[key] = (APP[key] || 0) + q * SOI_PER_LINE; keys[key] = 1;
        });
      });
      input.khachCuon.rows.forEach(function (rw) {
        CURLS.forEach(function (k) {
          var q = (rw.curls && rw.curls[k]) || 0; if (!q) return;
          var key = rw.maDon + '|' + rw.codeSoi + '|' + rw.mm + '|' + k;
          KH[key] = (KH[key] || 0) + q; keys[key] = 1;
        });
      });
      var list = Object.keys(keys), diffs = [];
      list.forEach(function (key) {
        var a = APP[key] || 0, b = KH[key] || 0;
        if (a === b) return;
        var pr = key.split('|');
        diffs.push({ maDon: pr[0], codeSoi: pr[1], mm: +pr[2], curl: pr[3], app: a, khach: b });
      });
      var appTot = 0, khTot = 0, byOrder = {};
      list.forEach(function (key) {
        var a = APP[key] || 0, b = KH[key] || 0, md = key.split('|')[0];
        appTot += a; khTot += b;
        // tách theo TỪNG MÃ ĐƠN: giao diện chỉ báo về mấy file vừa nạp nên phải cộng riêng
        var o = byOrder[md] || (byOrder[md] = { cells: 0, diffs: 0, appSoi: 0, khachSoi: 0 });
        o.cells++; o.appSoi += a; o.khachSoi += b; if (a !== b) o.diffs++;
      });
      doiChieu = { cells: list.length, matched: list.length - diffs.length, diffs: diffs,
                   appSoi: appTot, khachSoi: khTot, byOrder: byOrder };
    }
    return { orders: s1.orders, errors: s1.errors, stats: s1.stats, mixLabel: mixLabel, data1: data1, lineByOrder: lineByOrder, cuon: cuon, cuonSheet: cuonSheet, keoByOrder: keoByOrder, keoRules: keoRules, keoMalformed: keoMalformed, keoAmbig: keoAmbig, doiChieu: doiChieu };
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
  /* ============ BẢNG MIX CỦA KHÁCH — khối "Mix Length" (DÙNG CHUNG 2 MẪU) ============
     Chốt 20/08/2026 (yêu cầu của Hoàn): mẫu 2026 KHÔNG dựng bảng Mix từ "Bảng Mix Chi Tiết"
     bên phải nữa — số lượng dải ở bảng đó (nhất là hàng Mix Color) không đáng tin. Cả hai
     mẫu giờ chỉ lấy số lượng ở BẢNG HỘP + khối "Mix Length" ở đầu sheet, rồi tự sinh bảng
     Line / Keo / Mix y như mẫu cũ; Mix nhiều màu thì admin điền tay ở bước 3.
     hrSkip = dòng header bảng đơn (cũng có chữ "Độ Dài"...) → bỏ qua để không nhận nhầm. */
  /* ===== BẢNG MIX MÀU NẰM NGANG (chốt 22/8, đơn C213-785P) =====
     Khách có 2 cách ghi bảng màu của 1 dải:
       (a) NẰM DỌC  — từng cặp "9mm | Tên màu" xuống dưới  (xem khối colorCols bên dưới)
       (b) NẰM NGANG— ô dải, bên phải là TRỤC mm (6 7 8 … 13), mỗi dòng dưới là 1 màu:
              6-13mm | 6 | 7 | 8 | … | 13
              32.MK.LViolet.85 | 1 | 1 | 1 | … | 1
              33.MK.Violet.85  | 1 | 1 | 1 | … | 1
     Kiểu (b) trước đây bị đọc thành 8 CỘT DẢI mới tên "6","7"…"13" → bảng Mix hiện 16 ô đỏ
     "mm ngoài dải" và app vẫn đòi điền tay bảng Mix Màu, dù khách đã ghi đủ màu.
     Trả về { cols, blocks } khi đúng kiểu (b); null thì cứ xử lý như cột dải bình thường. */
  function khoiMauNgang(aoa, r, cc) {
    var head = aoa[r] || [], cols = [], mms = [], j, s, m;
    for (j = cc + 1; j < head.length; j++) {
      s = PS(head[j]); if (!s) break;
      m = s.match(/^(\d{1,2})$/); if (!m) break;      // SỐ TRẦN (không có "mm") = trục mm nằm ngang
      cols.push(j); mms.push(+m[1]);
    }
    if (cols.length < 2) return null;
    var blocks = [], q, rw, ten, dist, tong, v;
    for (q = r + 1; q < aoa.length; q++) {
      rw = aoa[q] || []; ten = PS(rw[cc]).trim();
      if (!ten) { if (blocks.length) break; else continue; }
      if (/^\d+\s*mm$/i.test(ten)) break;             // dưới là cột mm → là cột dải kiểu dọc, không phải khối ngang
      dist = {}; tong = 0;
      for (j = 0; j < cols.length; j++) { v = PN(rw[cols[j]]); if (v > 0) { dist[mms[j]] = (dist[mms[j]] || 0) + v; tong += v; } }
      if (!tong) { if (blocks.length) break; else continue; }
      blocks.push({ color: ten, dist: dist, lines: tong });
    }
    return blocks.length ? { cols: cols, blocks: blocks } : null;
  }
  function parseMixLengthBlocks(aoa, hrSkip, maDon, colEnd) {
    var r, row, i, v, q, rw;
    /* colEnd = cột BẮT ĐẦU của bảng khác nằm cùng dòng bên phải (mẫu 2026: cột "Mã BR" của
       Bảng Mix Chi Tiết). Không chặn thì quét lan sang bảng đó và nhận nhầm mấy ô "8mm"/"3"
       thành cột dải (Gui Xuong 2026 ra 6 dải thay vì 2). Mẫu cũ không truyền → quét hết dòng. */
    var CE = (colEnd != null && colEnd > 0) ? colEnd : Infinity;
    // 3. bảng Mix của khách: dòng "Mix Length" + các dòng "4mm".."20mm".
    //    QUÉT TOÀN SHEET, nhận NHIỀU bảng Mix (kể cả nhiều bảng cùng dải khác số line,
    //    hoặc nhiều bảng nằm cạnh nhau trên cùng dòng). Header dải có thể kèm
    //    số line: "6~13mm (16 Lines)" → lineCounts; không ghi thì pipeline tự lấy tổng cột.
    var mixSheets = [];
    for (r = 0; r < aoa.length; r++) {
      if (r === hrSkip) continue;
      row = aoa[r] || [];
      for (i = 0; i < row.length; i++) {
        if (PS(row[i]).toLowerCase() !== 'mix length') continue;
        var mi = i;
        var ranges = [], rangeCols = [], lineCounts = [], ci, mauNgang = {}, boQuaCot = {};
        for (ci = mi + 1; ci < row.length && ci < CE; ci++) {
          v = PS(row[ci]);
          if (!v) continue;
          if (boQuaCot[ci]) continue;        // cột thuộc BẢNG MÀU NẰM NGANG đã nhận ở trên

          if (v.toLowerCase() === 'mix length') break;   // gặp bảng Mix kế bên → dừng bảng này
          var lm = v.match(/\((\d+)\s*lines?\)/i);       // "6~13mm (16 Lines)"
          // BỎ MỌI khoảng trắng: khách hay ghi "12-20 mm" / "6 ~ 13 mm" → khóa phải là "12-20mm"
          // (khớp normalizeLength của dòng đơn). Trước đây có dấu cách là cột bị BỎ QUA → mất bảng Mix.
          var rg = v.replace(/\(.*?\)/g, '').replace(/\s+/g, '').toLowerCase().replace(/~/g, '-');
          /* Tên dải có thể kèm CHÚ THÍCH phía sau: "8-13mm - mix color lash -" (đơn 676P).
             Trước đây khớp cả chuỗi nên cột đó bị bỏ → app báo "không có bảng Mix cho dải
             này" và thiếu dây. Giờ chỉ lấy phần DẢI ở ĐẦU, phần chữ sau bỏ qua. */
          var _mrg = rg.match(/^\*?\d+(?:-\d+)?mm/); if (_mrg) rg = _mrg[0];
          if (!parseRange(rg.replace(/mm$/, ''))) continue;   // không phải cột dải → bỏ qua
          /* Ô dải này thực ra là đầu BẢNG MÀU NẰM NGANG (trục mm ở bên phải) → lấy bảng màu,
             KHÔNG nhận thêm cột dải nào nữa (mấy ô "6".."13" bên phải không phải dải). */
          var _kmn = khoiMauNgang(aoa, r, ci);
          if (_kmn) {
            mauNgang[rg] = _kmn.blocks;
            _kmn.cols.forEach(function (c0) { boQuaCot[c0] = 1; });
            continue;                        // bỏ cả trục mm của nó, rồi quét tiếp (bảng dải có thể còn ở bên phải)
          }
          ranges.push(rg); rangeCols.push(ci); lineCounts.push(lm ? +lm[1] : null);
        }
        if (!ranges.length) continue;
        /* SỐ LINE của từng cột: mẫu cũ ghi ngay trên header "6~13mm (16 Lines)"; mẫu 2026
           ghi ở dòng "Lines Check" cuối khối ("8-Lines" / "16-Lines"). Đọc CẢ HAI để 2 bảng
           CÙNG DẢI khác số line không bị gộp làm một — C213-785P có 6-13mm 8 Lines (hàng
           thường) và 6-13mm 16 Lines (dòng Mix Color), gộp là thiếu đúng một nửa số dải.
           Cột không ghi (vd 5-13mm của hàng Premade) để null → pipeline lấy tổng cột. */
        (function () {
          for (var q0 = r + 1; q0 < aoa.length && q0 <= r + 40; q0++) {
            var rw0 = aoa[q0] || [], hit = false;
            for (var z0 = 0; z0 < rw0.length; z0++) {
              if (PS(rw0[z0]).toLowerCase().replace(/\s+/g, ' ') === 'lines check') { hit = true; break; }
            }
            if (!hit) continue;
            rangeCols.forEach(function (cc, j0) {
              if (lineCounts[j0] != null) return;
              var lm0 = PS(rw0[cc]).match(/(\d+)\s*-?\s*lines?/i);
              if (lm0) lineCounts[j0] = +lm0[1];
            });
            break;
          }
        })();
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
        /* Bảng màu ghi NẰM NGANG cũng là bảng màu của dải đó — gộp vào colorBlocks để bước 3
           tự điền sẵn (khách đã ghi đủ thì không phải điền tay nữa). Kiểu dọc có trước thì
           giữ nguyên, không ghi đè. */
        Object.keys(mauNgang).forEach(function (k) {
          if (!colorBlocksByRange[k]) colorBlocksByRange[k] = mauNgang[k];
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
    return mixSheets;
  }

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
    // Ô "Mã Đơn" của khách có 2 kiểu: CHỈ mã đơn ("256S") hoặc CÓ CẢ mã KH ("LS343-256S").
    // Nếu chỉ có mã đơn mà TÊN FILE ghi liền "MãKH-MãĐơn" (vd "...LS63-256S - HY") → lấy thêm mã KH
    // từ tên file (chỉ khi ĐÚNG mã đơn đó và viết liền, tránh đoán sai với "- 355P - K68 -").
    if (maDon && /^\d+[A-Za-z]+(?:\.\d+)*$/.test(maDon)) {
      var fk = String(fileName || '').match(/([A-Za-z]{1,5}\d+)-(\d+[A-Za-z]+(?:\.\d+)*)/);
      if (fk && fk[2] === maDon) maDon = fk[1] + '-' + maDon;
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
    var curlCol = {}, curlNote = {}, curlRemap = [], curlHeaders = {};
    CURLS.forEach(function (k) { curlCol[k] = -1; });
    (function () {
      var endIdx = findCol(H, 'Tổng Số Hộp');
      var end = (endIdx > 0 ? endIdx : H.length);
      for (var i = (col.mix >= 0 ? col.mix + 1 : 0); i < end; i++) {
        var raw = PS(H[i]); if (!raw) continue;
        var k = curlOf(raw);
        if (k && curlCol[k] < 0) {
          curlCol[k] = i;
          curlHeaders[k] = raw;   // GIỮ tiêu đề GỐC của cột độ cong (để so sánh tiêu đề giữa 2 đơn)
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
    /* CỘT "HÀNG XƯỞNG THANH HÓA" (đơn C185-743P: cột AA, TIÊU ĐỀ TRỐNG, ô ghi "TH").
       Nhận theo 2 đường: (1) tiêu đề có chữ Thanh Hoá/TH; (2) không có tiêu đề thì tìm
       cột mà MỌI ô có chữ trong vùng dữ liệu đều là "TH" — cột số (độ cong, số hộp) tự
       loại vì không khớp. Dòng nào có dấu này thì code sợi ở Bảng Line Cuốn gắn đuôi
       "-TH" để bộ phận line biết là KHÔNG làm code đó. Số liệu KHÔNG đổi. */
    var colXuongTH = timCotXuongTH(H, aoa, hr, findCol(H, 'Tổng Số Hộp'));
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
      SPECIAL_SYM.forEach(function (p) { if (khopKyHieu(p[1], _rowTxt)) _kw[p[0]] = 1; });
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
        seri: Math.round(sttN), seriGoc: Math.round(sttN), maDon: maDon, codeSoi: code,
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
        xuongMa: colXuongTH >= 0 ? (maXuongCuaO(row[colXuongTH]) || '') : '',   // TH · HY · '' (ND)
        xuongTH: colXuongTH >= 0 && LA_TH.test(PS(row[colXuongTH])),   // giữ tương thích chỗ cũ
        _kw: _kw,
      });
    }
    if (!out.length) return null;
    // Áp ký hiệu đặc biệt: XUẤT HIỆN Ở MỌI DÒNG → gắn vào MÃ ĐƠN (676P-LZ);
    //                      chỉ MỘT SỐ dòng → gắn vào CODE SỢI dòng đó (3.MK.7-LZ).
    var _ap = apKyHieuDacBiet(out, maDon);
    var specialApplied = _ap.dsMoTa; maDon = _ap.maDon;
    // 3. bảng Mix của khách: khối "Mix Length" — xem parseMixLengthBlocks (dùng chung 2 mẫu)
    var mixSheets = parseMixLengthBlocks(aoa, hr, maDon);
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
      var lastSoi = '', lastDay = '', batDau = false, soTrong = 0;
      for (q = r + 1; q < aoa.length; q++) {
        rw = aoa[q] || [];
        var dd = di >= 0 ? PS(rw[di]) : '', mk = PS(rw[ki]);
        var ls = si >= 0 ? PS(rw[si]) : '', ld = li >= 0 ? PS(rw[li]) : '';
        if (!dd && !mk && !ls && !ld) {
          /* Dòng TRỐNG ngay dưới tiêu đề: nhiều đơn khách chừa 1 dòng cho thoáng
             (vd CS123-738P: tiêu đề dòng 38, để trống 39, dữ liệu từ 40). Trước đây
             gặp dòng trống là dừng luôn → báo "đơn không có bảng keo trong file".
             Chỉ dừng khi bảng ĐÃ có dữ liệu; chưa có thì bỏ qua tối đa 3 dòng trống. */
          if (batDau) break;
          if (++soTrong > 3) break;
          continue;
        }
        batDau = true;
        if (!mk) continue;
        if (ls) lastSoi = ls; else if (ld) ls = lastSoi;   // kế thừa ô gộp khi có Độ Dài
        if (dd) lastDay = dd; else if (ld) dd = lastDay;
        var gh = gi >= 0 ? PS(rw[gi]) : '';
        // GIỮ NGUYÊN GỐC: mỗi mã keo = 1 dòng, giữ Ghi Chú thật của khách.
        // Không bung chữ tự do ở đây nữa — việc bung thành QUY TẮC keo được chuyển
        // sang buildKeoRules() để Bảng Keo (Step 4) hiển thị đúng dữ liệu gốc,
        // còn Step 5/6 vẫn gán keo y như cũ.
        // ô Độ Dày ghi MÔ TẢ KEO ("Keo nâu 2mm") thay vì số → coi như trống, lấy độ dày từ Ghi Chú
        if (/keo/i.test(dd.normalize('NFD').replace(/[\u0300-\u036f]/g,'')) && !/0[.,]\d/.test(dd)) dd = '';
        keoRows.push({ maDon: maDon, loaiKeo: mk.replace(/[()]/g,'').trim(), loaiSoi: ls, doDay: dd, doDai: ld, ghiChu: gh });
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
    /* SỐ DẢI KHÁCH KHAI — nguồn CHUẨN để đối chiếu (theo quy chuẩn xưởng):
       cột ngay BÊN PHẢI "Tổng Số Hộp" (thường là Y hoặc Z, cột nào có số liệu).
       Mỗi dòng = số dải của dòng đó (vd 40 hộp × 20 lines ÷ 2 = 400). Cộng lại = tổng dải khách khai.
       ĐÁNG TIN hơn ô "Lines CLS" ở đầu sheet — ô đó khách hay ghi theo LINE hoặc ghi nhầm. */
    meta.tongDaiKhai = (function () {
      var hcol = findCol(H, 'Tổng Số Hộp');
      if (hcol < 0) return null;
      for (var c = hcol + 1; c <= hcol + 3; c++) {
        var sum = 0, n = 0;
        for (var rr = hr + 1; rr < aoa.length; rr++) {
          var v = Number((aoa[rr] || [])[c]);
          if (isFinite(v) && v) { sum += v; n++; }
        }
        if (n >= 3) { meta.tongDaiCol = c; return sum; }   // cột đầu tiên CÓ số liệu
      }
      return null;
    })();
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
    meta.curlHeaders = curlHeaders;     // { độ cong: tiêu đề GỐC } — để so sánh tiêu đề độ cong giữa 2 đơn
    meta.curlNotes = curlNote;          // vd { "L+": "( tem LC)" } — ghi chú độ cong từ header, hiện ở Box
    meta.specialSym = specialApplied;   // vd ["LZ (cả đơn → mã đơn)"] — ký hiệu hàng đặc biệt đã áp
    return { rawOrders: out, mixSheets: mixSheets, keoRows: keoRows, keoNotes: null, curlNotes: curlNote, meta: meta };
  }

  /* =====================================================================
   * TEMPLATE ĐƠN GỬI XƯỞNG 2026 (bản khách đổi từ tháng 8/2026)
   * ---------------------------------------------------------------------
   * Khác template cũ ở CHỖ ĐỌC, còn ra thì vẫn đúng cấu trúc nội bộ cũ
   * (rawOrders / mixSheets / keoRows / meta) nên toàn bộ pipeline, Step 2-6,
   * in ấn, packing slip... dùng lại y nguyên.
   *
   * Ba bảng nối nhau bằng cột "No":
   *   1) BẢNG CHÍNH   (header có "Số Line" + "Code nguyên liệu"): 1 dòng = 1 code sợi
   *      trong 1 sản phẩm, các cột độ cong tính theo HỘP.
   *   2) BẢNG MIX CHI TIẾT (header "Mã BR | No | Label Name | MM | Nguyên Liệu |
   *      Keo Đã Fix | Số Line"): bung mỗi dòng chính ra từng mm.
   *      → đây là nguồn của ĐỘ DÀI (dòng Single) và của bảng Mix.
   *   3) BẢNG MM      (header "** No | Phân Loại | ... | MM | <độ cong>"): cùng 124 dòng
   *      nhưng tính theo SỢI — chính là bảng cuốn khách tự tính, giữ lại để ĐỐI CHIẾU.
   *
   * KEO: template mới KHÔNG còn "Bảng keo" (danh sách quy tắc). Khách fix sẵn keo
   * từng dòng → ta lấy nguyên keo đó rồi DỰNG LẠI bảng keo theo đúng dạng cũ
   * (Loại Sợi | Độ Dày | Độ Dài | Mã Keo) để Step 4 và bản in không phải đổi gì.
   * ===================================================================== */
  /** Nhận diện template 2026: có bảng Mix Chi Tiết (cặp tiêu đề "Mã BR" + "Keo Đã Fix"). */
  function isGuiXuong2026(aoa) {
    if (!aoa || !aoa.length) return false;
    for (var r = 0; r < Math.min(aoa.length, 80); r++) {
      var row = aoa[r] || [], br = false, fix = false;
      for (var i = 0; i < row.length; i++) {
        var v = PS(row[i]).toLowerCase();
        if (v === 'mã br') br = true;
        if (v === 'keo đã fix') fix = true;
      }
      if (br && fix) return true;
    }
    return false;
  }

  function parseGuiXuong2026(aoa, fileName) {
    if (!aoa || !aoa.length) return null;
    var r, i, row, v;
    var num = function (x) { var n = Number(x); return isFinite(n) ? n : null; };
    var mmOf = function (x) { var n = parseInt(String(x == null ? '' : x).replace(/[^\d]/g, ''), 10); return isFinite(n) ? n : null; };

    // ---- A. Mã Đơn: ưu tiên ô khai trong sheet, tên file bổ sung mã KH (giống bản cũ) ----
    var maDon = '';
    var fm = String(fileName || '').match(/(\d+[A-Za-z]+(?:\.\d+)*)/);
    if (fm) maDon = fm[1];
    for (r = 0; r < Math.min(aoa.length, 5); r++) {
      row = aoa[r] || [];
      for (i = 0; i < row.length; i++) {
        if (PS(row[i]).toLowerCase() === 'mã đơn') {
          /* GIỮ NGUYÊN cả dấu "-" ở cuối: "CS185-" nghĩa là mã KH = CS185, CHƯA có mã đơn.
             Cắt dấu đi thì app hiểu nhầm CS185 là mã đơn. splitMd() tách ra kh='CS185', don=''. */
          v = PS((aoa[r + 1] || [])[i]).trim();
          if (v && !(maDon && maDon !== v && maDon.indexOf(v) === 0)) maDon = v;
          r = 99; break;
        }
      }
    }
    if (maDon && /^\d+[A-Za-z]+(?:\.\d+)*$/.test(maDon)) {
      var fk = String(fileName || '').match(/([A-Za-z]{1,5}\d+)-(\d+[A-Za-z]+(?:\.\d+)*)/);
      if (fk && fk[2] === maDon) maDon = fk[1] + '-' + maDon;
    }

    // ---- B. Bảng Mix Chi Tiết ----
    var dh = -1, DC = null;
    for (r = 0; r < aoa.length && dh < 0; r++) {
      row = aoa[r] || [];
      var cBR = -1, cFix = -1;
      for (i = 0; i < row.length; i++) {
        v = PS(row[i]).toLowerCase();
        if (v === 'mã br') cBR = i;
        if (v === 'keo đã fix') cFix = i;
      }
      if (cBR >= 0 && cFix >= 0) {
        dh = r;
        DC = { br: cBR, no: findCol(row, 'No', true), label: findCol(row, 'Label Name'),
               mm: findCol(row, 'MM', true), nl: findCol(row, 'Nguyên Liệu'),
               keo: cFix, line: findCol(row, 'Số Line') };
      }
    }
    if (dh < 0 || !DC || DC.no < 0 || DC.mm < 0) return null;
    var detail = [], byNo = {};
    for (r = dh + 1; r < aoa.length; r++) {
      row = aoa[r] || [];
      var no = num(row[DC.no]);
      if (!PS(row[DC.br]) || no == null || no <= 0) continue;
      var d = { br: PS(row[DC.br]), no: Math.round(no), label: PS(row[DC.label]),
                mm: PS(row[DC.mm]), nl: PS(row[DC.nl]), keo: PS(row[DC.keo]),
                line: PN(row[DC.line]) };
      detail.push(d);
      (byNo[d.no] = byNo[d.no] || []).push(d);
    }
    if (!detail.length) return null;

    // ---- C. Bảng chính ----
    var hr = -1, H = null;
    for (r = 0; r < aoa.length; r++) {
      row = aoa[r] || [];
      var hasLine = false, hasCode = false, hasMM = false;
      for (i = 0; i < row.length; i++) {
        v = PS(row[i]).toLowerCase();
        if (v === 'số line') hasLine = true;
        if (v.indexOf('code') >= 0 && v.indexOf('nguyên liệu') >= 0) hasCode = true;
        if (v === 'mm') hasMM = true;                    // bảng mm ở dưới cũng có "Số Line"? → loại bằng cột MM
      }
      if (hasLine && hasCode && !hasMM) { hr = r; H = row; break; }
    }
    if (hr < 0) return null;
    var col = {
      stt: (function () { for (var k = 0; k < H.length; k++) if (/^no\.?$/i.test(PS(H[k]))) return k; return -1; })(),
      soLine: findCol(H, 'Số Line'), danhMuc: findCol(H, 'Sản phẩm'),
      code: findCol(H, 'Code'), soMau: findCol(H, 'Số màu'), laser: findCol(H, 'Laser'),
      keo: findCol(H, 'Keo', true), gcXuong: findCol(H, 'Ghi chú (Xưởng'),
      gcKC: findCol(H, 'Ghi chú (KC'), length: findCol(H, 'Độ Dài'), tong: findCol(H, 'Tổng'),
    };
    if (col.stt < 0 || col.code < 0) return null;

    // Cột độ cong: nằm giữa "Độ Dài" và "Tổng". Khớp tên như bản cũ; cột lạ (Curl2/Curl3)
    // KHÔNG đoán bừa — nếu có số liệu sẽ báo ở meta.curlUnmapped để chặn bước sau.
    function curlOf(raw) {
      var core = PS(raw).replace(/\(.*?\)/g, '').trim(); if (!core) return null;
      for (var j = 0; j < CURLS.length; j++) if (CURLS[j].toLowerCase() === core.toLowerCase()) return CURLS[j];
      var first = core.split(/\s+/)[0];
      for (var j2 = 0; j2 < CURLS.length; j2++) if (CURLS[j2].toLowerCase() === first.toLowerCase()) return CURLS[j2];
      return null;
    }
    var curlCol = {}, curlHeaders = {}, curlWarnings = [];
    CURLS.forEach(function (k) { curlCol[k] = -1; });
    var cStart = (col.length >= 0 ? col.length : col.stt) + 1;
    var cEnd = col.tong > 0 ? col.tong : H.length;
    for (i = cStart; i < cEnd; i++) {
      var raw = PS(H[i]); if (!raw) continue;
      var k = curlOf(raw);
      if (k && curlCol[k] < 0) { curlCol[k] = i; curlHeaders[k] = raw; }
    }
    /* KHÔNG cảnh báo cột lạ chỉ vì có tên lạ: template 2026 luôn chừa sẵn 2 cột trống
       Curl2/Curl3, báo mỗi đơn thì thành nhiễu. Cột lạ mà CÓ SỐ LIỆU vẫn bị bắt ở
       meta.curlUnmapped bên dưới — chỗ đó mới thật sự nguy hiểm (mất số). */

    // cột đánh dấu hàng xưởng Thanh Hóa (bên phải cột "Tổng")
    var colTH26 = timCotXuongTH(H, aoa, hr, col.tong);
    var out = [];
    for (r = hr + 1; r < aoa.length; r++) {
      row = aoa[r] || [];
      var stt = num(row[col.stt]);
      if (stt == null || stt <= 0) { if (out.length) break; else continue; }
      stt = Math.round(stt);
      var code = PS(row[col.code]); if (!code || code.charAt(0) === '#') continue;
      var ds = byNo[stt] || [];
      // ĐỘ DÀI: dòng Mix lấy dải ở cột "Độ Dài" (bỏ hậu tố ".20"); dòng Single
      // không ghi gì nên lấy mm từ Bảng Mix Chi Tiết.
      var lenRaw = PS(col.length >= 0 ? row[col.length] : '');
      var isMix = !!lenRaw;
      var length = isMix ? lenRaw.replace(/\.\d+\s*$/, '') : (ds.length ? ds[0].mm : '');
      var gcX = PS(col.gcXuong >= 0 ? row[col.gcXuong] : '');    // "Faux Mink 0.085"
      var thick = (gcX.match(/0[.,]\d+/) || [])[0] || '';
      if (!thick) { var cm = code.match(/\.(\d+)$/); if (cm) thick = cm[1]; }
      /* QUY TẮC CHỐT 20/08/2026 (Hoàn): CHỈ hàng "MULTI COLOR" luôn là sợi độ dày 0.085 —
         "Mix Color" thì GIỮ NGUYÊN độ dày khách ghi (đã chốt lại chiều 20/8, đừng gộp 2 loại).
         Đặt cứng ở đây thì mục F dựng bảng keo cũng lấy 0.085 (info đọc chính o.thickness)
         ⇒ hai bên cùng khóa, keo điền được. */
      if (/multi\s*colou?r/i.test(gcX + ' ' + code + ' ' + PS(col.danhMuc >= 0 ? row[col.danhMuc] : ''))) thick = '0.085';
      var curls = {};
      CURLS.forEach(function (k) {
        var ci = curlCol[k];
        if (ci >= 0) { var q2 = PN(row[ci]); if (q2) curls[k] = q2; }
      });
      var soLineRaw = PS(col.soLine >= 0 ? row[col.soLine] : '');
      out.push({
        seri: stt, seriGoc: stt, maDon: maDon, codeSoi: code,
        detail: PS(col.danhMuc >= 0 ? row[col.danhMuc] : ''),
        xuongMa: colTH26 >= 0 ? (maXuongCuaO(row[colTH26]) || '') : '',
        xuongTH: colTH26 >= 0 && LA_TH.test(PS(row[colTH26])),
        _kw: (function () { var k = {}; if (col.laser >= 0 && /laser|liigos/i.test(PS(row[col.laser]))) k.LZ = 1; return k; })(),
        length: length, mixSingle: isMix ? 'Mix' : 'Single', curls: curls,
        line: PN(soLineRaw.replace(/lines?/i, '').trim()), lineRaw: soLineRaw,
        /* PHÂN LOẠI suy từ CỘT "SỐ LINE" của Bảng Hộp (chốt 20/08/2026) — trước lấy ở bảng
           dải line bên dưới, giờ không đọc bảng đó nữa. Ghi chữ "Premade" = hàng đặt sẵn
           (chỉ tính hộp, không cuốn dải); có số line = hàng Classic. */
        loaiHang: /premade/i.test(soLineRaw) ? 'Premade' : (soLineRaw ? 'Classic' : ''),
        premade: /premade/i.test(soLineRaw),
        /* SỐ MÀU: mẫu 2026 ghi Code nguyên liệu là chữ "Mix Color" rồi khai số màu ở cột
           riêng (vd 2). Mang theo để bước 3 sinh đủ N ô tên màu cho admin điền tay. */
        soMau: col.soMau >= 0 ? PN(row[col.soMau]) : 0,
        ghiChu: PS(col.gcKC >= 0 ? row[col.gcKC] : ''),
        ghiChuKeo: PS(col.keo >= 0 ? row[col.keo] : ''),      // KEO KHÁCH ĐÃ FIX
        material: gcX, thickness: thick,
        label: PS(col.danhMuc >= 0 ? row[col.danhMuc] : ''),
      });
    }
    if (!out.length) return null;

    /* Ký hiệu hàng đặc biệt (LZ…) phải áp NGAY ở đây — mã đơn có thể đổi (CS185- → CS185-LZ),
       mà bảng Mix và bảng keo bên dưới đều khóa theo mã đơn. Áp muộn là mix/keo tra không ra. */
    var _ap26 = apKyHieuDacBiet(out, maDon);
    maDon = _ap26.maDon;

    /* ---- D. BẢNG DẢI LINE bên dưới (khách tự tính, từ dòng ~86) ----
       Chốt 20/08/2026: app KHÔNG lấy SỐ LƯỢNG từ bảng này nữa (số của khách hay sai, nhất là
       hàng Mix Color) — chỉ lấy TỔNG để đối chiếu với tổng dải app tự tính. Phân Loại cũng
       không lấy ở đây nữa mà suy từ cột "Số Line" của Bảng Hộp.
       ĐƠN VỊ của bảng này khách ghi KHÔNG NHẤT QUÁN giữa các file:
         · "Gui Xuong 2026.xlsx"  → SỢI  (Σ 8400 = 2 × 4200 dải)
         · K21-792P · C213-785P   → DẢI  (Σ 128000 · 5520, khớp thẳng)
       → quy về DẢI bằng cách so với chính Bảng Hộp: Σ(số hộp × số line ÷ 2). Đúng gấp đôi
       thì hiểu là SỢI, chia 2; còn lại giữ nguyên. */
    var khachCuon = null, tongBangDuoi = null, bangDuoiRows = [];
    (function () {
      var mr = -1, MH = null;
      for (var r2 = 0; r2 < aoa.length; r2++) {
        var rw3 = aoa[r2] || [], hasPL = false, hasMM2 = false, hasNo = false;
        for (var i2 = 0; i2 < rw3.length; i2++) {
          var v2 = PS(rw3[i2]).toLowerCase();
          if (v2 === 'phân loại') hasPL = true;
          if (v2 === 'mm') hasMM2 = true;
          if (/^\**\s*no\.?$/.test(v2)) hasNo = true;
        }
        if (hasPL && hasMM2 && hasNo) { mr = r2; MH = rw3; break; }
      }
      if (mr < 0) return;
      var cNo = -1, cPL = findCol(MH, 'Phân Loại'), cMM = findCol(MH, 'MM', true), cTot = findCol(MH, 'Tổng');
      /* Cột "Keo Đã Fix" + "Nguyên Liệu" NGAY TRONG bảng mm: đây mới là chỗ khách sửa keo
         theo từng mm (vd 130.SKV.7 dùng .2 cho 4-10mm, .3 từ 11mm). Bảng Mix Chi Tiết bên
         phải có cột cùng tên nhưng khách không phải lúc nào cũng sửa cả hai. */
      var cKeoFix = findCol(MH, 'Keo Đã Fix'), cNL = findCol(MH, 'Nguyên Liệu');
      for (var k2 = 0; k2 < MH.length; k2++) if (/^\**\s*no\.?$/i.test(PS(MH[k2]))) { cNo = k2; break; }
      if (cNo < 0 || cMM < 0) return;
      var mCurl = {};
      CURLS.forEach(function (k) { mCurl[k] = -1; });
      for (var c3 = cMM + 1; c3 < MH.length; c3++) {
        var k3 = curlOf(PS(MH[c3]));
        if (k3 && mCurl[k3] < 0) mCurl[k3] = c3;
      }
      var rows2 = [], tong = 0, mauByNo = {}, mauOrd = {};
      for (var r3 = mr + 1; r3 < aoa.length; r3++) {
        var rw4 = aoa[r3] || [], n4 = num(rw4[cNo]);
        if (n4 == null || n4 <= 0) { if (rows2.length) break; else continue; }
        var cs = {};
        CURLS.forEach(function (k) { var ci2 = mCurl[k]; if (ci2 >= 0) { var q3 = PN(rw4[ci2]); if (q3) cs[k] = q3; } });
        var _nl = cNL >= 0 ? PS(rw4[cNL]) : '';
        rows2.push({ no: Math.round(n4), mm: mmOf(rw4[cMM]), curls: cs,
          nl: _nl, keo: cKeoFix >= 0 ? PS(rw4[cKeoFix]) : '' });   // codeSoi gắn sau
        /* TÊN MÀU (code sợi) của dòng Mix Color: bảng này ghi rõ từng mm dùng màu nào
           (No.45 → 33.MK.Violet.85 · 32.MK.LViolet.85). Chỉ lấy TÊN (không lấy số lượng)
           để bước 3 điền sẵn vào Bảng Mix Màu, khỏi phải gõ tay. */
        if (_nl) {
          var _k = Math.round(n4), _m = mauOrd[_k] || (mauOrd[_k] = {});
          if (!_m[_nl]) { _m[_nl] = 1; (mauByNo[_k] = mauByNo[_k] || []).push(_nl); }
        }
        // ô "Tổng" của bảng này khách ghi thẳng con số (vd " 157000,0") chứ không phải chữ
        // → không dò được theo tên, cộng lại từ các cột độ cong cho chắc.
        CURLS.forEach(function (k) { tong += cs[k] || 0; });
      }
      /* MIX COLOR: Bảng Hộp chỉ ghi Code nguyên liệu là chữ "Mix Color" + Số màu = N. Lấy
         ĐÚNG N tên màu ở bảng dưới điền vào Code Sợi (ngăn bằng \n) — từ đó Bảng Mix Màu ở
         bước 3 hiện sẵn tên thật, Line Cuốn tách được theo màu, và ô "Mix Color" hết bị báo
         đỏ E-CODE. Chỉ lấy TÊN, số lượng vẫn ĐIỀN TAY (số của khách ở bảng đó không tin được). */
      out.forEach(function (o) {
        var ds = mauByNo[o.seri];
        if (!ds || ds.length < 2 || String(o.codeSoi || '').indexOf('\n') >= 0) return;
        if ((PN(o.soMau) || 0) !== ds.length) return;      // số màu khai phải khớp số tên tìm được
        o.codeSoi = ds.join('\n');
      });
      bangDuoiRows = rows2;      // để mục F dựng bảng keo (chỉ đọc CHỮ: Nguyên Liệu + Keo Đã Fix)
      if (!rows2.length || !tong) return;
      // QUY VỀ DẢI: so với chính Bảng Hộp (Σ số hộp × số line ÷ 2) — gấp đôi thì là SỢI.
      var expDai = 0;
      out.forEach(function (o) {
        var t2 = 0; CURLS.forEach(function (k) { t2 += o.curls[k] || 0; });
        expDai += t2 * (PN(String(o.lineRaw || '').replace(/lines?/i, '').trim()) || 0) / 2;
      });
      expDai = Math.round(expDai);
      tongBangDuoi = (expDai > 0 && Math.round(tong) === expDai * 2) ? Math.round(tong / 2) : Math.round(tong);
    })();

    /* ---- E. Bảng Mix: từ khối "Mix Length" ở đầu sheet — Y NHƯ MẪU CŨ ----
       Chốt 20/08/2026: KHÔNG dựng từ "Bảng Mix Chi Tiết" bên phải nữa. Bảng đó khai số
       lượng dải theo từng mm/từng màu nhưng khách hay ghi sai (C213-785P: hàng Mix Color
       No.45 ghi thiếu một nửa), mà nó lại là nguồn duy nhất nên sai là cả đơn sai. Khối
       "Mix Length" + dòng "Lines Check" là thứ khách vẫn điền đúng và giống mẫu cũ.
       Mix nhiều màu: colorBlocks chỉ có khi khách ghi cặp "mm | tên màu" (mẫu cũ);
       mẫu 2026 không ghi vậy → colorBlocks rỗng → admin ĐIỀN TAY ở bước 3. */
    var mixSheets = parseMixLengthBlocks(aoa, hr, maDon, DC.br);
    var mixWarnings = [];

    /* ---- F. Bảng keo: SINH RA từ "Keo Đã Fix" của BẢNG CHI TIẾT ----
       Mẫu 2026 KHÔNG có Bảng Keo quy tắc (khác mẫu cũ — mẫu cũ có bảng "Độ Dày | Mã Keo"
       riêng, cứ đọc bảng đó, TUYỆT ĐỐI không sinh lại). Ở mẫu 2026 keo khách đã fix theo
       từng mm nằm ở cột "Keo Đã Fix": ưu tiên BẢNG DẢI LINE bên dưới (chỗ khách thật sự sửa,
       vd 130.SKV.7 dùng .2 cho 4-10mm và .3 từ 11mm), thiếu thì lấy Bảng Mix Chi Tiết.
       Đây là đọc CHỮ (nguyên liệu + mã keo), KHÔNG phải số lượng — vẫn đúng nguyên tắc
       "số lượng chỉ lấy ở Bảng Hộp". */
    var keoRows = [];
    (function () {
      /* Tra nguyên liệu/độ dày theo TỪNG code sợi. Dòng Mix Color có NHIỀU code trong 1 ô
         (33.MK.Violet.85 · 32.MK.LViolet.85) → phải tách ra, không thì 2 màu đó không tra được
         độ dày và keo bị để trống ở bước 5. */
      var info = {};
      out.forEach(function (o) {
        String(o.codeSoi || '').split(/\r?\n/).forEach(function (cd) {
          cd = cd.trim(); if (cd && !info[cd]) info[cd] = { mat: o.material, thick: o.thickness };
        });
      });
      var byMat = {}, matOrder = [];
      var nguon = bangDuoiRows.some(function (r) { return r.nl && r.keo; }) ? bangDuoiRows : detail;
      nguon.forEach(function (d) {
        if (!d.nl || !d.keo) return;
        var m = byMat[d.nl];
        if (!m) { m = byMat[d.nl] = { g: {}, order: [] }; matOrder.push(d.nl); }
        var g = m.g[d.keo];
        if (!g) { g = m.g[d.keo] = {}; m.order.push(d.keo); }
        var mm = mmOf(d.mm); if (mm != null) g[mm] = 1;
      });
      var daCo = {};
      matOrder.forEach(function (nl) {
        var m = byMat[nl], one = m.order.length === 1, f = info[nl] || {};
        m.order.forEach(function (gk) {
          var mms = Object.keys(m.g[gk]).map(Number).sort(function (a, b) { return a - b; });
          var row = {
            maDon: maDon, loaiKeo: gk,
            loaiSoi: f.mat || nl, doDay: f.thick || '',
            // 1 nguyên liệu chỉ 1 keo → không ràng buộc độ dài; nhiều keo → tách theo dải mm
            doDai: (one || !mms.length) ? '' : (mms[0] === mms[mms.length - 1] ? (mms[0] + 'mm') : (mms[0] + '-' + mms[mms.length - 1] + 'mm')),
            ghiChu: 'Keo khách đã fix trong đơn',
          };
          /* Nhiều code sợi có thể cùng 1 nguyên liệu (dòng Mix Color: 2 màu đều là
             "Mix Colour 0.07") → quy tắc y hệt nhau, chỉ giữ 1 dòng cho khỏi trùng. */
          var sig = [row.loaiKeo, row.loaiSoi, row.doDay, row.doDai].join('|');
          if (daCo[sig]) return; daCo[sig] = 1;
          keoRows.push(row);
        });
      });
    })();

    // ---- G. meta ----
    var meta = { maDon: maDon, template: 2026 };
    for (r = 0; r < Math.min(aoa.length, 5); r++) {
      row = aoa[r] || [];
      for (i = 0; i < row.length; i++) {
        var h2 = PS(row[i]).toUpperCase(), below = (aoa[r + 1] || [])[i];
        if (h2 === 'KH' && meta.khach == null) meta.khach = PS(below);
        if (h2 === 'CLS' && meta.tongKhay == null) meta.tongKhay = PN(below);
        /* "Lines Clas" khách ghi KHÔNG NHẤT QUÁN đơn vị: file "Gui Xuong 2026" ghi theo SỢI
           (525 × 16 = 8400), K21-792P và C213-785P ghi theo DẢI (128000 · 5520). Giữ số gốc ở
           tongSoiKhai, còn số để ĐỐI CHIẾU thì lấy tổng bảng dải line đã quy về DẢI ở mục D
           (xem tongBangDuoi) — bên đó so được với chính Bảng Hộp nên biết chắc đơn vị. */
        if (/^LINES\s+CLAS/.test(h2) && meta.tongSoiKhai == null) meta.tongSoiKhai = PN(below);
        if (h2 === 'EASYFAN' && meta.easyFan == null) meta.easyFan = PN(below);
        if (h2 === 'YY-W' && meta.yyW == null) meta.yyW = PN(below);
        if (h2 === 'PRFAN' && meta.prFan == null) meta.prFan = PN(below);
      }
    }
    meta.tongHopKhai = out.reduce(function (s, o) {
      var t = 0; CURLS.forEach(function (k) { t += o.curls[k] || 0; }); return s + t;
    }, 0);
    /* KHÔNG gửi bảng dải line vào pipeline nữa → bỏ luôn đối chiếu TỪNG Ô (số khách trong đó
       sai, soi từng ô chỉ ra hàng trăm ô đỏ vô nghĩa). Chỉ giữ TỔNG DẢI để đối chiếu — chảy
       vào panel "Đối chiếu" thường trực ở bước 5 qua meta.tongDaiKhai. */
    meta.khachCuon = null;
    if (tongBangDuoi != null) meta.tongDaiKhai = tongBangDuoi;
    meta.tongDay = (tongBangDuoi != null) ? tongBangDuoi : meta.tongSoiKhai;
    meta.curlWarnings = curlWarnings.concat(mixWarnings);
    meta.curlUnmapped = (function () {
      var mapped = {}; CURLS.forEach(function (k) { if (curlCol[k] >= 0) mapped[curlCol[k]] = 1; });
      var res = [];
      for (var c4 = cStart; c4 < cEnd; c4++) {
        if (mapped[c4]) continue;
        var cnt = 0;
        for (var r5 = hr + 1; r5 < aoa.length; r5++) {
          var st5 = num((aoa[r5] || [])[col.stt]); if (st5 == null || st5 <= 0) continue;
          if (PN(aoa[r5][c4])) cnt++;
        }
        if (cnt > 0) res.push({ col: c4, header: PS(H[c4]), count: cnt });
      }
      return res;
    })();
    meta.curlRemap = [];
    meta.curlHeaders = curlHeaders;
    meta.curlNotes = {};
    meta.specialSym = _ap26.dsMoTa;
    return { rawOrders: out, mixSheets: mixSheets, keoRows: keoRows, keoNotes: null, curlNotes: {}, meta: meta };
  }

  /** Cửa vào CHUNG: tự nhận template rồi gọi đúng bộ đọc. */
  function parseGuiXuongAny(aoa, fileName) {
    return isGuiXuong2026(aoa) ? parseGuiXuong2026(aoa, fileName) : parseGuiXuongSheet(aoa, fileName);
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
          var rg = v.replace(/\(.*?\)/g, '').replace(/\s+/g, '').toLowerCase().replace(/~/g, '-');
          var _mrg = rg.match(/^\*?\d+(?:-\d+)?mm/); if (_mrg) rg = _mrg[0];   // bỏ chú thích sau tên dải
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
    buildKeoRules: buildKeoRules, expandKeoRows: expandKeoRows, glueFor: glueFor, glueForShort: glueForShort, orderGlues: orderGlues,
    OVERRIDE_2MM_CURLS: OVERRIDE_2MM_CURLS, isOverrideCurl: isOverrideCurl,
    parseKeoCond: parseKeoCond, thickKey: thickKey,
    thicksOfDoDay: thicksOfDoDay, tachDoDay: tachDoDay, timKeoNhapNhang: timKeoNhapNhang, keoNhapNhangCuaDong: keoNhapNhangCuaDong,
    keoCoDieuKien: keoCoDieuKien,
    buildData1: buildData1, buildLineMatrix: buildLineMatrix, STRATEGIES: STRATEGIES,
    buildCuonBox: buildCuonBox, buildCuonBoxSheet: buildCuonBoxSheet, buildSummary: buildSummary,
    runPipeline: runPipeline,
    parseNhapDonRows: parseNhapDonRows, parseLabelRows: parseLabelRows,
    parseKeoRows: parseKeoRows, parseWorkbookData: parseWorkbookData,
    parseGuiXuongSheet: parseGuiXuongSheet, parseMixColorAOA: parseMixColorAOA,
    parseMixLengthBlocks: parseMixLengthBlocks, khoiMauNgang: khoiMauNgang,
    sinhKeoTuDonHang: sinhKeoTuDonHang,
    parseGuiXuong2026: parseGuiXuong2026, isGuiXuong2026: isGuiXuong2026, parseGuiXuongAny: parseGuiXuongAny,
    SPECIAL_TAGS: SPECIAL_TAGS, SPECIAL_SUF_RE: SPECIAL_SUF_RE,
    KEO_STD: KEO_STD, badKeoCodes: badKeoCodes,
    sample: { MM_233S: MM_233S, MIX_233S: MIX_233S, ORDERS_233S: ORDERS_233S, KEO_233S: KEO_233S, MIX_SHEETS_233S: MIX_SHEETS_233S },
  };
  if (root) root.NhapDonEngine = api;
})(typeof window !== 'undefined' ? window : this);
