// Service Worker: 画面ファイルだけをキャッシュし、ゲームの通信（/api）は常にネットワークへ
const CACHE = 'bingo-shell-v2';
const SHELL = [
  '/',
  '/play',
  '/host',
  '/screen',
  '/offline.html',
  '/css/style.css',
  '/js/common.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
  // 電波マップ：圏外でも画面を開いて「不通」を記録できるように
  '/signal',
  '/signal.webmanifest',
  '/js/signal.js',
  '/js/signal-core.js',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/icons/signal.svg',
  '/icons/signal-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/') || url.pathname === '/manifest.webmanifest') return;

  // ネットワーク優先（常に最新版）→ 失敗時だけキャッシュ
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(url.pathname);
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('/offline.html');
        return Response.error();
      }),
  );
});
