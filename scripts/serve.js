// 本地静态服务器：node scripts/serve.js [端口]
//
// 只是为了让浏览器能以 http:// 打开这个 PWA——file:// 下 Service Worker 和
// ES Module 都会被浏览器拦掉。生产环境用的是 GitHub Pages，不需要它。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // 防目录穿越：规范化后必须仍在 ROOT 内
    const full = normalize(join(ROOT, path));
    if (!full.startsWith(ROOT + sep) && full !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(full);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: path + '/' }).end();
      return;
    }

    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // 开发时别缓存，否则改完代码刷新还是旧的
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(err));
    }
  }
});

server.listen(PORT, () => {
  console.log(`课程资料库 → http://localhost:${PORT}/`);
});
