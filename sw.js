/* Service Worker — CACHE-FIRST (mở app là chạy ngay, không chờ mạng).
 *
 * 27/8 — user chốt: "Mở từ cache trước sau đó kiểm tra bản mới để update".
 * Trước đây là NETWORK-FIRST: mỗi lần mở đều phải tải lại ~280KB (nén) rồi mới hiện được app,
 * mạng xưởng chậm là đứng chờ. Nay:
 *   1. Có trong cache → TRẢ NGAY (0 chờ mạng).
 *   2. Song song vẫn hỏi server ở NỀN; file đổi (ETag / Last-Modified / độ dài khác) thì
 *      ghi đè cache và BÁO cho trang → trang hiện băng-rôn "🔄 Đã có phiên bản mới" rồi
 *      tự tải lại (dùng đúng cơ chế sẵn có của app: window.__clNewVersion).
 *   3. Chưa có trong cache (lần đầu) → lấy mạng như thường rồi lưu lại.
 * Mất mạng vẫn mở được vì đã có cache. Supabase/CDN luôn đi thẳng ra mạng.
 */
var CACHE = 'puregroup-nhapdon-v5';
var ASSETS = [
  './',
  './index.html',
  './don-hang-v1.html',
  './engine.web.js',
  './auth.store.js',
  './auth.web.js',
  './cl.config.js',
  './cl.sync.js',
  './cl.project.js',
  './xlsx.full.min.js',
  './manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // addAll thất bại nếu 1 file lỗi → dùng từng file, bỏ qua file thiếu
    return Promise.all(ASSETS.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

var daThayBanMoi = false;   // đã phát hiện file trên server đổi (trong vòng đời SW này)
self.addEventListener('message', function (e) {
  if (e.data === 'skip-waiting') self.skipWaiting();
  /* Trang sắp tải lại để lấy bản mới → xoá sạch cache, để lần tải lại lấy HTML và JS cùng
     một bản từ mạng (trước đây tải lại vẫn ra bản cũ trong cache). */
  if (e.data === 'xoa-cache') {
    e.waitUntil(caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { return caches.delete(k); }));
    }).then(function () { if (e.source) { try { e.source.postMessage('cl-cache-cleared'); } catch (_) {} } }));
  }
  /* Trang hỏi lại lúc dựng xong — phòng khi tin nhắn "có bản mới" bắn ra trước khi trang
     kịp nghe (SW chạy song song với việc dựng trang). */
  if (e.data === 'hoi-ban-moi' && daThayBanMoi && e.source) {
    try { e.source.postMessage('cl-new-version'); } catch (_) {}
  }
});

// "Vân tay" một bản file để biết server đã có bản mới hay chưa.
function sig(res) {
  if (!res) return '';
  var h = res.headers;
  return (h.get('etag') || '') + '|' + (h.get('last-modified') || '') + '|' + (h.get('content-length') || '');
}
function baoBanMoi() {
  daThayBanMoi = true;
  return self.clients.matchAll({ includeUncontrolled: true }).then(function (cs) {
    cs.forEach(function (c) { try { c.postMessage('cl-new-version'); } catch (_) {} });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  // Chỉ xử lý GET cùng origin (app shell). Supabase/CDN để mạng lo.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  /* Lời gọi tự kiểm tra bản mới của trang (…?_v=…) phải đi THẲNG ra mạng, không đụng cache —
     chính nó đang so ETag để biết server có bản mới. */
  if (url.search && url.search.indexOf('_v=') >= 0) return;

  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (hit) {
      // hỏi server ở nền, bỏ qua cache HTTP để lấy đúng trạng thái mới nhất
      var net = fetch(url.pathname + url.search, { cache: 'no-cache', credentials: 'same-origin' })
        .then(function (res) {
          if (res && res.status === 200) {
            var doi = hit && sig(hit) !== sig(res);
            c.put(req, res.clone());
            if (doi) baoBanMoi();      // bản mới đã nằm trong cache → lần tải lại là bản mới
          }
          return res;
        })
        .catch(function () { return hit; });   // mất mạng → dùng cache
      // CÓ cache thì trả NGAY, việc hỏi server chạy tiếp ở nền
      if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
      return net;
    });
  }));
});
