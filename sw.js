/* アプリ本体をキャッシュして、2回目以降はオフラインでも起動できるようにする */
const SHELL = 'bml-shell-v3';
const SHELL_FILES = [
  './', './index.html', './css/style.css',
  './js/app.js', './js/metrics.js', './js/geom.js', './js/ball.js',
  './js/chart.js', './js/reference.js', './js/loader.js', './js/events.js', './js/config.js',
  './vendor/tasks-vision/vision_bundle.mjs',
  './vendor/tasks-vision/wasm/vision_wasm_internal.js',
  './vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // 1つ失敗しても全体を失敗させない
    await Promise.allSettled(SHELL_FILES.map((f) => c.add(f)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL && !k.startsWith('bml-models')).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // モデル本体は app 側が Cache Storage で管理するので触らない
  if (url.pathname.includes('/models/')) return;

  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    if (cached) {
      // 裏で更新をとりにいく（次回反映）
      e.waitUntil((async () => {
        try {
          const fresh = await fetch(e.request);
          if (fresh.ok) (await caches.open(SHELL)).put(e.request, fresh.clone());
        } catch { /* オフライン時は何もしない */ }
      })());
      return cached;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(SHELL)).put(e.request, res.clone());
      return res;
    } catch (err) {
      return new Response('オフラインです', { status: 503 });
    }
  })());
});
