import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { currentUser } from './auth.mjs';
import { createApi, HttpError } from './api.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 1024 * 1024;

export function startServer(options = {}) {
  const dbFile = options.dbFile ?? process.env.DB_FILE ?? join(ROOT, 'data', 'zhixue.db');
  const db = openDb(dbFile);
  const route = createApi(db);

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');

    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      if (url.pathname.startsWith('/api/')) {
        const body = await readJson(req);
        const user = currentUser(db, req);
        const result = await route(req.method ?? 'GET', url.pathname, {
          body,
          res,
          user,
          ip: req.socket.remoteAddress,
        });
        if (result === undefined) throw new HttpError(404, 'E4004', '接口不存在');
        sendJson(res, 200, result);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'E1000', '方法不支持');
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      console.error('[server] 未预期错误', err);
      sendJson(res, 500, { error: { code: 'E5000', message: '服务端异常，请稍后重试' } });
    }
  });

  return {
    server,
    db,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => {
          try {
            db.close();
          } catch {
            /* 已关闭 */
          }
          resolveClose();
        });
      }),
  };
}

async function readJson(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'E1019', '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'E1020', '请求体不是合法 JSON');
  }
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function serveStatic(pathname, res) {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(DIST, safe === '/' ? 'index.html' : safe);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // 未命中静态文件：回落到 SPA 入口（前端用 hash 路由）
    filePath = join(DIST, 'index.html');
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('未找到页面，请先执行 npm run build 生成 dist/');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const { server } = startServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`智学节律 API + 静态资源：http://localhost:${port}`);
  });
}
