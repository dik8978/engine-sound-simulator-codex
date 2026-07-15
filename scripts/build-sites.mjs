import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const serverDir = path.join(distDir, 'server');
const openaiDir = path.join(distDir, '.openai');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(serverDir, { recursive: true });
fs.mkdirSync(openaiDir, { recursive: true });

const assets = {};
for (const rel of walk(publicDir)) {
  const full = path.join(publicDir, rel);
  assets[`/${rel}`] = {
    body: fs.readFileSync(full, 'utf8'),
    type: mime[path.extname(rel)] || 'application/octet-stream',
  };
}
assets['/'] = assets['/index.html'];

const serverSource = `const ASSETS = ${JSON.stringify(assets)};\n\nexport default {\n  async fetch(request) {\n    const url = new URL(request.url);\n    const path = ASSETS[url.pathname] ? url.pathname : '/index.html';\n    const asset = ASSETS[path];\n    return new Response(asset.body, {\n      headers: {\n        'content-type': asset.type,\n        'cache-control': path === '/index.html' ? 'no-store' : 'public, max-age=3600',\n      },\n    });\n  },\n};\n`;

fs.writeFileSync(path.join(serverDir, 'index.js'), serverSource);
fs.copyFileSync(path.join(root, '.openai', 'hosting.json'), path.join(openaiDir, 'hosting.json'));

