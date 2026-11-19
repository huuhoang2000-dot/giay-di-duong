/* Service worker: lưu sẵn các file của app để chạy khi không có mạng.
   Mỗi lần sửa code, hãy tăng số phiên bản bên dưới (v1 -> v2 ...) để iPhone tải bản mới. */
const CACHE = 'giay-di-duong-v5';
// Bộ đọc chữ (thư mục ocr/, ~5 MB) để bộ nhớ riêng, chỉ tải khi dùng lần đầu và giữ qua các lần cập nhật app.
// Chỉ đổi tên này khi thay file trong ocr/.
const OCR_CACHE = 'giay-di-duong-ocr-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // app không gọi đi đâu khác

  // Mở app: luôn trả trang chính từ bộ nhớ đệm (chạy offline)
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(req))
    );
    return;
  }

  // Các file khác: lấy từ bộ nhớ đệm trước, không có mới tải từ mạng
  const target = url.pathname.includes('/ocr/') ? OCR_CACHE : CACHE;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(target).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
