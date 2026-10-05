// サンドボックス（販売 Worker の Commerce/SANDBOX.md 案B）で、購入完了ページを手元で試すための、手元だけのサーバー（追加の npm パッケージなし）
//
//   node tests/serve-sandbox.mjs           # リポジトリのルートで。http://localhost:8000/evevoice/thanks/
//   node tests/serve-sandbox.mjs 8001      # 番号を変えるとき
//
// 公開するページの CSP の connect-src は https://api.eivrad.com だけ。ここでは /evevoice/thanks/ を返すときだけ、
// 手元の wrangler dev（http://localhost:8787）を connect-src に足して返す（ファイルは書き換えない）。
// ページの JS は、localhost・127.0.0.1 で開いたときだけ http://localhost:8787 に聞く。
// 127.0.0.1 と ::1 だけで待ち受け、リポジトリの外と . で始まるもの（.git など）は返さない。

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_CONNECT = 'connect-src https://api.eivrad.com;';
const SANDBOX_CONNECT = 'connect-src https://api.eivrad.com http://localhost:8787;';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
};

// 購入完了ページの CSP に、手元の Worker を足す。公開の形（connect-src が api.eivrad.com だけ）が1回だけあることを確かめる。
export function sandboxThanksPage(html) {
  if (html.split(PUBLIC_CONNECT).length !== 2) throw new Error('購入完了ページの CSP の connect-src が想定の形ではありません');
  return html.replace(PUBLIC_CONNECT, SANDBOX_CONNECT);
}

// URL のパスから、返すファイルを決める。リポジトリの外・. で始まる部分を含むもの・壊れたパスは null。
export function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part.startsWith('.'))) return null;
  const file = path.resolve(ROOT, ...parts);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null;
  return decoded.endsWith('/') ? path.join(file, 'index.html') : file;
}

export function createSandboxServer() {
  return http.createServer(async (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
    const file = resolveFile(req.url || '/');
    if (!file) return send(404, 'not found');
    try {
      if ((await stat(file)).isDirectory()) {
        // GitHub Pages と同じく、/ の無いディレクトリは / 付きへ送る
        res.writeHead(301, { Location: `/${path.relative(ROOT, file).split(path.sep).join('/')}/` });
        return res.end();
      }
      let body = await readFile(file);
      if (path.relative(ROOT, file) === path.join('evevoice', 'thanks', 'index.html')) {
        body = Buffer.from(sandboxThanksPage(body.toString('utf8')), 'utf8');
      }
      // no-store にすると、ブラウザが戻るボタンのキャッシュ（bfcache）を使わなくなり、公開（GitHub Pages・max-age=600）と動きが変わる。
      // no-cache（毎回確かめる）にして、手元の変更はすぐ反映しつつ、戻ったときの動きを公開と揃える。
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return send(404, 'not found');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('番号（1〜65535）を指定してください');
    process.exit(2);
  }
  createSandboxServer().listen(port, '127.0.0.1', () => {
    console.log(`http://localhost:${port}/evevoice/thanks/ （Ctrl+C で止めます）`);
  });
  createSandboxServer().listen(port, '::1').on('error', () => {});
}
