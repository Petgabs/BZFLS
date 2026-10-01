// ---------------------------------------------------------------------------
// Development server.
//
// A deliberately tiny static file server for local work and live previews.
// Python's http.server works too, but it sends no Cache-Control headers, so
// browsers heuristic-cache the JS/CSS and you keep seeing a stale app after
// refreshing. This server sends "Cache-Control: no-store" on everything:
// every refresh is guaranteed to serve the current files from disk.
//
//   npm run dev          # serves on http://localhost:8080
//   PORT=3000 npm run dev
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';

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
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method not allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    send(response, 400, 'Bad request', { 'Content-Type': 'text/plain' });
    return;
  }

  // Directory requests resolve to index.html.
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = normalize(join(root, pathname));

  // Path traversal guard: everything must stay inside the repository.
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    send(response, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    send(response, 404, `Not found: ${pathname}`, { 'Content-Type': 'text/plain' });
    return;
  }
  if (!info.isFile()) {
    send(response, 404, `Not found: ${pathname}`, { 'Content-Type': 'text/plain' });
    return;
  }

  const headers = {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    // The whole point: never let a browser or proxy cache dev responses.
    'Cache-Control': 'no-store, must-revalidate',
    'Content-Length': info.size
  };

  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});

server.listen(port, host, () => {
  console.log(`Serving ${root}`);
  console.log(`Ready on http://${host}:${port} — no caching, every refresh is fresh.`);
});
