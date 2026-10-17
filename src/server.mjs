import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  WEB_DIR,
  DATA_DIR,
  THUMBS_DIR,
  PREVIEWS_DIR,
  WALLPAPERS_DIR,
  RENDER_THUMBS_DIR,
} from './config.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const SAFE_ID = /^[A-Za-z0-9._-]{1,96}$/;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, { code, hint } = {}) {
  sendJson(res, status, { error: { message, code: code ?? 'Error', hint: hint ?? '' } });
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(base, name) {
  if (!SAFE_ID.test(name)) return null;
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  return resolved;
}

async function serveFile(req, res, file, { immutable = false, download = false } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    sendError(res, 404, '文件不存在', { code: 'NotFound' });
    return;
  }
  if (!stat.isFile()) {
    sendError(res, 404, '不是文件');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const isAppShell = ['.html', '.js', '.mjs', '.css'].includes(ext);
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable
      ? 'public, max-age=31536000, immutable'
      : isAppShell
        ? 'no-store, must-revalidate'
        : 'public, max-age=30',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(file))}"`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      // ignore
    }
  });
  stream.pipe(res);
}

export function createWebServer(ctx) {
  const { logger, bus } = ctx;
  const clients = new Set();
  let lastBroadcast = 0;
  let broadcastTimer = null;

  function writeEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(event, data) {
    for (const res of clients) {
      try {
        writeEvent(res, event, data);
      } catch {
        clients.delete(res);
      }
    }
  }

  bus.on('invalidate', (event) => {
    const now = Date.now();
    if (now - lastBroadcast > 300) {
      lastBroadcast = now;
      broadcast('invalidate', event ?? {});
    } else if (!broadcastTimer) {
      broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        lastBroadcast = Date.now();
        broadcast('invalidate', { type: 'coalesced' });
      }, 320);
    }
  });

  logger.on('log', (entry) => {
    if (entry.level === 'error' || entry.level === 'warn' || entry.level === 'ok') {
      broadcast('log', entry);
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 25000);
  heartbeat.unref?.();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    try {
      // ---------------- media ----------------
      if (pathname === '/media/current.jpg') {
        const current = ctx.store.runtime.current;
        if (!current) return sendError(res, 404, '还没有当前壁纸');
        res.writeHead(302, { Location: `/media/render/${encodeURIComponent(current.key)}.jpg?v=${encodeURIComponent(current.appliedAt ?? '')}` });
        return res.end();
      }
      if (pathname.startsWith('/media/')) {
        const [, , kind, file] = pathname.split('/');
        if (!file) return sendError(res, 404, '缺文件名');
        const base = kind === 'thumb' ? THUMBS_DIR
          : kind === 'preview' ? PREVIEWS_DIR
          : kind === 'render' ? WALLPAPERS_DIR
          : kind === 'render-thumb' ? RENDER_THUMBS_DIR
          : null;
        if (!base) return sendError(res, 404, '未知媒体类型');
        const full = safeJoin(base, file);
        if (!full) return sendError(res, 400, '非法路径');
        const download = url.searchParams.get('dl') === '1';
        return serveFile(req, res, full, {
          immutable: kind !== 'render',
          download,
        });
      }
      // ---------------- SSE ----------------
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('event: hello\ndata: {}\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      // ---------------- API ----------------
      if (pathname === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, await ctx.actions.state());
      }
      if (pathname === '/api/photos' && req.method === 'GET') {
        return sendJson(res, 200, ctx.actions.listPhotos({
          limit: Math.min(400, Number(url.searchParams.get('limit')) || 120),
          offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
          filter: url.searchParams.get('filter') || 'all',
          category: url.searchParams.get('category') || '',
          q: url.searchParams.get('q') || '',
        }));
      }
      if (pathname === '/api/renders' && req.method === 'GET') {
        return sendJson(res, 200, ctx.actions.listRenders({
          limit: Math.min(500, Number(url.searchParams.get('limit')) || 200),
          offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
        }));
      }
      if (pathname === '/api/logs' && req.method === 'GET') {
        return sendJson(res, 200, { items: logger.recent(Math.min(300, Number(url.searchParams.get('limit')) || 80)) });
      }
      if (pathname === '/api/doctor' && req.method === 'GET') {
        return sendJson(res, 200, await ctx.actions.doctor({ probeModel: url.searchParams.get('probe') === '1' }));
      }

      if (pathname === '/api/scan' && req.method === 'POST') {
        if (ctx.scanning) return sendJson(res, 409, { error: { message: '扫描正在进行中' } });
        ctx.actions.startScan().catch((err) => logger.error(err.message));
        return sendJson(res, 202, { started: true });
      }

      if (pathname === '/api/pipeline/start' && req.method === 'POST') {
        return sendJson(res, 200, await ctx.actions.startPipeline());
      }
      if (pathname === '/api/pipeline/pause' && req.method === 'POST') {
        return sendJson(res, 200, ctx.actions.pausePipeline());
      }
      if (pathname === '/api/rotation/start' && req.method === 'POST') {
        return sendJson(res, 200, { enabled: await ctx.actions.startRotation() });
      }
      if (pathname === '/api/rotation/pause' && req.method === 'POST') {
        return sendJson(res, 200, { enabled: ctx.actions.pauseRotation() });
      }
      if (pathname === '/api/next' && req.method === 'POST') {
        const key = await ctx.actions.next();
        return sendJson(res, 200, { key });
      }
      if (pathname === '/api/apply' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.key) return sendError(res, 400, '缺少 key');
        const key = await ctx.actions.apply(String(body.key));
        return sendJson(res, 200, { key });
      }
      if (pathname === '/api/lockscreen/unify' && req.method === 'POST') {
        return sendJson(res, 200, await ctx.actions.unify());
      }
      if (pathname === '/api/restore' && req.method === 'POST') {
        return sendJson(res, 200, await ctx.actions.restore());
      }
      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        const config = await ctx.actions.updateSettings(body);
        return sendJson(res, 200, { ok: true, config });
      }
      if (pathname === '/api/styles' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, await ctx.actions.updateStyles(body));
      }
      if (pathname === '/api/retry' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, ctx.actions.retryFailed(body.key ?? null));
      }
      if (pathname === '/api/open-data' && req.method === 'POST') {
        execFile('open', [DATA_DIR], () => {});
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/reveal' && req.method === 'POST') {
        const body = await readBody(req);
        const key = String(body.key ?? '');
        const full = safeJoin(WALLPAPERS_DIR, `${key}.jpg`);
        if (!full) return sendError(res, 400, '非法 key');
        if (!fs.existsSync(full)) return sendError(res, 404, '文件不存在');
        execFile('open', ['-R', full], () => {});
        return sendJson(res, 200, { ok: true });
      }

      // ---------------- static web ----------------
      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const full = path.resolve(WEB_DIR, rel);
        if (!full.startsWith(path.resolve(WEB_DIR) + path.sep) && full !== path.join(path.resolve(WEB_DIR), 'index.html')) {
          return sendError(res, 400, '非法路径');
        }
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          return serveFile(req, res, full, { immutable: false });
        }
        if (!path.extname(pathname)) {
          return serveFile(req, res, path.join(WEB_DIR, 'index.html'));
        }
        return sendError(res, 404, '页面不存在');
      }

      sendError(res, 405, '不支持的请求');
    } catch (err) {
      logger.error(`API 错误 ${pathname}: ${err.message}`);
      sendError(res, err.statusCode ?? 500, err.message, { code: err.name, hint: err.hint });
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    broadcast,
    listen({ port, host }) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          if (err.code === 'EADDRINUSE') {
            err.message = `端口 ${port} 已被占用，换一个端口：PORT=${port + 1} npm start`;
          }
          reject(err);
        };
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    },
    async close() {
      clearInterval(heartbeat);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
      clients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
