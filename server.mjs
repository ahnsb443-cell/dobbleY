import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDatabase } from './lib/db.mjs';
import { createApi } from './lib/api.mjs';
import { headers } from './lib/security.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
export async function createApp({
  apiHandler = null,
  dataDir = process.env.DATA_DIR || path.join(root, '.data'),
  secureCookies = process.env.NODE_ENV === 'production',
  publicOrigin = process.env.PUBLIC_ORIGIN || '',
  setupToken = process.env.SETUP_TOKEN || '',
  allowLocalSetup = process.env.NODE_ENV !== 'production',
} = {}) {
  if (
    process.env.NODE_ENV === 'production' &&
    (!publicOrigin.startsWith('https://') || !secureCookies)
  )
    throw Error('Production requires HTTPS PUBLIC_ORIGIN and secure cookies.');
  const store = apiHandler ? null : await openDatabase(dataDir),
    api =
      apiHandler || createApi(store, { secureCookies, publicOrigin, setupToken, allowLocalSetup });
  const files = {
    '/': 'public/index.html',
    '/index.html': 'public/index.html',
    '/app.js': 'public/app.js',
    '/brand/logo.png': 'public/brand/logo.png',
    '/style.css': 'public/style.css',
    '/sw.js': 'public/sw.js',
    '/manifest.webmanifest': 'public/manifest.webmanifest',
    '/offline.html': 'public/offline.html',
    '/icons/icon-192.png': 'public/icons/icon-192.png',
    '/icons/icon-512.png': 'public/icons/icon-512.png',
  };
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route.startsWith('/api/')) return api(req, res);
    headers(res);
    const file = files[route];
    if (!file || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    try {
      const data = await readFile(path.join(root, file)),
        ext = path.extname(file),
        type = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.webmanifest': 'application/manifest+json',
          '.png': 'image/png',
        }[ext];
      res.writeHead(200, {
        'Content-Type': type + (ext === '.png' ? '' : '; charset=utf-8'),
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => store?.close());
  return { server, store };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createApp();
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () =>
    console.log('DOUBLE Y listening on ' + (process.env.PORT || 3000)),
  );
}
