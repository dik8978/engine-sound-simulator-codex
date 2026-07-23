// Engine Sound Simulator - server
// - Serves the web UI (public/)
// - Receives OSC over UDP and forwards messages to browsers via WebSocket

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);
const OSC_PORT = parseInt(process.env.OSC_PORT || '9000', 10);

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- HTTP static server ----------
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', oscPort: OSC_PORT }));
});

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(s);
  }
}

// ---------- Minimal OSC parser (messages + bundles) ----------
function readPaddedString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('ascii', offset, end);
  // advance past nulls to 4-byte boundary
  let next = end + 1;
  next = offset + Math.ceil((next - offset) / 4) * 4;
  return [str, next];
}

function parseOscMessage(buf) {
  let [address, off] = readPaddedString(buf, 0);
  if (!address.startsWith('/')) return null;
  let args = [];
  if (off < buf.length) {
    let tags;
    [tags, off] = readPaddedString(buf, off);
    if (tags.startsWith(',')) {
      for (const t of tags.slice(1)) {
        switch (t) {
          case 'f': args.push(buf.readFloatBE(off)); off += 4; break;
          case 'i': args.push(buf.readInt32BE(off)); off += 4; break;
          case 'd': args.push(buf.readDoubleBE(off)); off += 8; break;
          case 'h': args.push(Number(buf.readBigInt64BE(off))); off += 8; break;
          case 's': case 'S': { let s; [s, off] = readPaddedString(buf, off); args.push(s); break; }
          case 'T': args.push(true); break;
          case 'F': args.push(false); break;
          case 'N': args.push(null); break;
          case 'b': { const len = buf.readInt32BE(off); off += 4 + Math.ceil(len / 4) * 4; args.push(null); break; }
          default: break; // unknown tag: stop being clever, skip
        }
      }
    }
  }
  return { address, args };
}

function parseOscPacket(buf, out) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    let off = 16; // "#bundle\0" + 8-byte timetag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off); off += 4;
      if (size <= 0 || off + size > buf.length) break;
      parseOscPacket(buf.subarray(off, off + size), out);
      off += size;
    }
  } else {
    const msg = parseOscMessage(buf);
    if (msg) out.push(msg);
  }
}

// ---------- OSC UDP listener ----------
const udp = dgram.createSocket('udp4');
udp.on('message', (buf, rinfo) => {
  const msgs = [];
  try { parseOscPacket(buf, msgs); } catch (e) { return; }
  for (const m of msgs) {
    broadcast({ type: 'osc', address: m.address, args: m.args, from: rinfo.address });
  }
});
udp.on('error', (e) => {
  console.error('OSC UDP error:', e.message);
});
udp.bind(OSC_PORT, () => {
  console.log(`OSC:  listening on udp://0.0.0.0:${OSC_PORT}`);
});

server.listen(HTTP_PORT, () => {
  console.log(`Web:  http://localhost:${HTTP_PORT}`);
});
