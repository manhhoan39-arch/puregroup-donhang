/* Service Worker — NETWORK-FIRST: online LUÔN lấy bản mới nhất (không cần Ctrl+Shift+R),
 * offline mới dùng cache. Cache "app shell" (HTML + JS) để mở được khi mất mạng.
 * Các lời gọi Supabase/CDN luôn đi thẳng ra mạng. */
var CACHE = 'puregroup-nhapdon-v3';
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

self.addEventListener('message', function (e) { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  // Chỉ xử lý GET cùng origin (app shell). Supabase/CDN để mạng lo.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // NETWORK-FIRST: ưu tiên mạng (bản mới nhất) → lưu cache; mất mạng mới dùng cache.
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
      return res;
    }).catch(function () { return caches.match(req); })
  );
});
