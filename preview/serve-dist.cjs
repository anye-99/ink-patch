// Minimal static file server for the extracted InkNotes web build.
// Usage: node serve-dist.cjs <rootDir> <port>
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, 'dist'));
const port = parseInt(process.argv[3] || '8099', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400); return res.end('bad request'); }

  let filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) return sendFile(path.join(filePath, 'index.html'), res);
    if (!err && st.isFile()) return sendFile(filePath, res);
    if (path.extname(filePath)) return sendFile(filePath, res); // real miss -> 404
    sendFile(path.join(root, 'index.html'), res);               // SPA fallback
  });
});

server.on('error', (e) => { console.error('server error: ' + e.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  console.log('inknotes preview: http://127.0.0.1:' + port + '/  (root: ' + root + ')');
});
