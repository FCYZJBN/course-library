// Service Worker：让这个工具离线也能用
//
// 策略：应用外壳在安装时预缓存，其余同源请求走「缓存优先 + 回填」。
// 之所以能这么简单粗暴，是因为整个应用没有后端——同源的每个 URL 都是静态资源，
// 内容不会变；会变的是数据库里的数据，那些本来就不经过网络。
//
// pdf.js 和它的 worker、还有 169 份 cMap（合计约 1.9MB）刻意不预缓存：
// 只有真的导入 PDF 时才用得上，预缓存会让第一次打开白白多下 2MB。
// 它们会在第一次被用到时经下面的 fetch 逻辑自动落进缓存。

const VERSION = 'v2';
const CACHE = `course-library-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/seed.js',
  './js/classifier.js',
  './js/extractor.js',
  './js/exporter.js',
  './js/folder-export.js',
  './js/search.js',
  './vendor/jszip.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // 逐个加而不是 addAll：任何一个 404 都不该让整次安装失败
      await Promise.all(
        PRECACHE.map((url) => cache.add(url).catch((err) => console.warn('预缓存失败：', url, err)))
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 只接管同源；blob:（导出的 zip）和其它域一律放行
  if (url.origin !== self.location.origin) return;

  // 本地开发用网络优先：否则改完代码刷新还是缓存里的旧版本，白折腾半天
  const isDev = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (isDev) {
    e.respondWith(fetch(request).catch(() => caches.match(request, { ignoreSearch: true })));
    return;
  }

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;

      try {
        const res = await fetch(request);
        // 只缓存成功的完整响应；206 之类的部分响应塞进缓存会污染后续读取
        if (res.ok && res.status === 200) cache.put(request, res.clone());
        return res;
      } catch (err) {
        // 离线又没缓存：导航请求回退到首页，让应用至少能起来
        if (request.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
