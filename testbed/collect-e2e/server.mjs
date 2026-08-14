// collect-e2e 测试站静态服务器
// 零依赖:仅使用 Node 内置模块。用法:node server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8788;
const DOWNLOAD_BYTES = 3 * 1024 * 1024;
const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

// 按扩展名返回 Content-Type;未知类型按二进制流处理
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendBrowserShellDownload(req, res) {
  const pattern = Buffer.from('Fan Browser Shell download fixture\n', 'utf8');
  const chunk = Buffer.alloc(DOWNLOAD_CHUNK_BYTES);
  for (let offset = 0; offset < chunk.length; offset += pattern.length) {
    pattern.copy(chunk, offset, 0, Math.min(pattern.length, chunk.length - offset));
  }

  const headers = {
    'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="fan-browser-shell-download.txt"',
    'Content-Length': DOWNLOAD_BYTES,
    'Content-Type': 'application/octet-stream',
  };
  res.writeHead(200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  let cancelled = false;
  let sent = 0;
  let timer = null;
  const cleanup = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
  req.once('aborted', cleanup);
  res.once('close', cleanup);

  const writeNext = () => {
    if (cancelled) return;
    if (sent >= DOWNLOAD_BYTES) {
      req.removeListener('aborted', cleanup);
      res.removeListener('close', cleanup);
      res.end();
      return;
    }

    const size = Math.min(chunk.length, DOWNLOAD_BYTES - sent);
    sent += size;
    const ready = res.write(chunk.subarray(0, size));
    const schedule = () => {
      timer = setTimeout(writeNext, 45);
    };
    if (ready) schedule();
    else res.once('drain', schedule);
  };

  writeNext();
}

const server = createServer(async (req, res) => {
  // 非法百分号编码(如 /%zz)会让 decodeURIComponent 抛 URIError——挡在 400,
  // 不能让一个畸形请求击穿整个测试站进程。
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  if (pathname === '/browser-shell-download') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('405 Method Not Allowed');
      return;
    }
    sendBrowserShellDownload(req, res);
    return;
  }
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(ROOT, relPath));

  // 阻止路径穿越(../)访问站点目录之外的文件
  if (!filePath.startsWith(ROOT) && filePath !== ROOT.slice(0, -sep.length)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`collect-e2e 测试站已启动: http://localhost:${PORT}/`);
});
