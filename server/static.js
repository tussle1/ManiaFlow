/**
 * Static file server for the ManiaFlow UI.
 *
 * No framework, no bundler, no build step: `index.html` plus ES modules under `src/`,
 * served straight off disk. That keeps the project inspectable and the start-up path short.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.osu': 'text/plain; charset=utf-8',
  '.osz': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/**
 * Build a request handler that serves files from `root`.
 * Requests that do not match a file fall back to `index.html` so the client router owns paths.
 */
export function createStaticHandler(root) {
  const rootDir = resolve(root);

  return async function handle(request, response) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('Bad request');
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }

    // Resolve inside the root and refuse anything that escapes it.
    const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    let filePath = resolve(join(rootDir, relative));
    if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('Forbidden');
      return;
    }

    try {
      let info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = join(filePath, 'index.html');
        info = await stat(filePath);
      }
      const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'content-type': type,
        'content-length': info.size,
        // The UI is edited live during development; never let a browser pin a stale module.
        'cache-control': type.startsWith('text/') ? 'no-cache' : 'public, max-age=3600',
      };
      if (request.method === 'HEAD') {
        response.writeHead(200, headers);
        response.end();
        return;
      }
      response.writeHead(200, headers);
      createReadStream(filePath).pipe(response);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      // Unknown path: hand it to the client router unless it looks like a missing asset.
      if (extname(pathname) && pathname !== '/index.html') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end(`Not found: ${pathname}`);
        return;
      }
      const indexPath = join(rootDir, 'index.html');
      try {
        const info = await stat(indexPath);
        response.writeHead(200, { 'content-type': MIME['.html'], 'content-length': info.size });
        createReadStream(indexPath).pipe(response);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('Not found');
      }
    }
  };
}
