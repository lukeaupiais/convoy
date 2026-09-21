import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

/** Serves only the built UI's known paths from an explicit release directory. */
export function createStaticAssets(directory) {
  if (!isAbsolute(directory)) throw new Error('Static asset directory must be absolute.');

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return false;
    }
    const name = pathname === '/' || pathname === '/index.html'
      ? 'index.html'
      : pathname === '/favicon.svg'
        ? 'favicon.svg'
        : /^\/assets\/[A-Za-z0-9._-]+$/.test(pathname)
          ? pathname.slice(1)
          : null;
    if (!name) return false;
    const file = join(directory, name);
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (!info.isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const extension = name.slice(name.lastIndexOf('.'));
    res.writeHead(200, {
      'Content-Type': contentTypes[extension] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': name === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    return true;
  };
}
