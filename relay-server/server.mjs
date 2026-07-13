import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const maxRooms = Math.max(1, Number(process.env.MAX_ROOMS || 64));
const maxConnectionsPerIp = Math.max(2, Number(process.env.MAX_CONNECTIONS_PER_IP || 6));
const trustProxy = process.env.TRUST_PROXY === '1';
const relayAccessKey = process.env.RELAY_ACCESS_KEY || '';
const tokenSecret = process.env.RELAY_TOKEN_SECRET || '';
const ticketTtlSeconds = Math.max(300, Math.min(86_400, Number(process.env.TICKET_TTL_SECONDS || 7200)));
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://lovelact8-tech.github.io,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const rooms = new Map();
const connectionCounts = new Map();
const ticketAttempts = new Map();

if (relayAccessKey.length < 16 || tokenSecret.length < 32) {
  console.error('RELAY_ACCESS_KEY must be at least 16 characters and RELAY_TOKEN_SECRET at least 32 characters');
  process.exit(1);
}

function sendControl(socket, type, extra = {}) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ __relay: type, ...extra }));
}

function getClientIp(request) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || 'unknown';
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    if (rooms.size >= maxRooms) return null;
    room = { host: null, guest: null, touchedAt: Date.now() };
    rooms.set(id, room);
  }
  return room;
}

function secretsEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function createTicket(roomId, role) {
  const payload = Buffer.from(JSON.stringify({
    roomId,
    role,
    expiresAt: Date.now() + ticketTtlSeconds * 1000,
    nonce: crypto.randomBytes(12).toString('base64url'),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyTicket(ticket, roomId, role) {
  try {
    const [payload, signature, extra] = String(ticket || '').split('.');
    if (!payload || !signature || extra) return false;
    const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest();
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return false;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value.roomId === roomId && value.role === role && Number(value.expiresAt) > Date.now();
  } catch (error) {
    return false;
  }
}

function allowTicketAttempt(clientIp) {
  const now = Date.now();
  const current = ticketAttempts.get(clientIp);
  if (!current || now - current.startedAt > 15 * 60 * 1000) {
    ticketAttempts.set(clientIp, { startedAt: now, count: 1 });
    return true;
  }
  current.count++;
  return current.count <= 8;
}

function writeJson(response, status, value, origin = '') {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (origin && allowedOrigins.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

function removeSocket(socket) {
  if (socket.countedIp) {
    const nextCount = Math.max(0, (connectionCounts.get(socket.countedIp) || 1) - 1);
    if (nextCount) connectionCounts.set(socket.countedIp, nextCount);
    else connectionCounts.delete(socket.countedIp);
    socket.countedIp = '';
  }
  const { roomId, role } = socket.relay || {};
  const room = rooms.get(roomId);
  if (!room || room[role] !== socket) return;
  room[role] = null;
  room.touchedAt = Date.now();
  const other = role === 'host' ? room.guest : room.host;
  if (other) sendControl(other, 'peer-left');
  if (!room.host && !room.guest) rooms.delete(roomId);
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin || '';
  if (request.url === '/health') {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (request.url === '/ticket' && request.method === 'OPTIONS') {
    if (!allowedOrigins.has(origin)) {
      writeJson(response, 403, { error: 'Forbidden' });
      return;
    }
    response.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    response.end();
    return;
  }
  if (request.url === '/ticket' && request.method === 'POST') {
    if (!allowedOrigins.has(origin)) {
      writeJson(response, 403, { error: '来源不允许' });
      return;
    }
    const clientIp = getClientIp(request);
    if (!allowTicketAttempt(clientIp)) {
      writeJson(response, 429, { error: '尝试次数过多，请稍后重试' }, origin);
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2048) request.destroy();
    });
    request.on('end', () => {
      try {
        const { roomId = '', accessKey = '' } = JSON.parse(body || '{}');
        if (!/^[a-zA-Z0-9_-]{12,64}$/.test(roomId) || !secretsEqual(accessKey, relayAccessKey)) {
          writeJson(response, 401, { error: '私人访问码错误' }, origin);
          return;
        }
        ticketAttempts.delete(clientIp);
        writeJson(response, 200, {
          hostToken: createTicket(roomId, 'host'),
          guestToken: createTicket(roomId, 'guest'),
          expiresIn: ticketTtlSeconds,
        }, origin);
      } catch (error) {
        writeJson(response, 400, { error: '请求格式错误' }, origin);
      }
    });
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('PWA NES relay');
});

const relay = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin || '';
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const roomId = url.searchParams.get('room') || '';
  const role = url.searchParams.get('role');
  const ticket = url.searchParams.get('ticket') || '';
  const clientIp = getClientIp(request);
  const invalidRequest = url.pathname !== '/relay'
    || !allowedOrigins.has(origin)
    || !/^[a-zA-Z0-9_-]{12,64}$/.test(roomId)
    || !['host', 'guest'].includes(role)
    || !verifyTicket(ticket, roomId, role)
    || (connectionCounts.get(clientIp) || 0) >= maxConnectionsPerIp;
  if (invalidRequest) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  relay.handleUpgrade(request, socket, head, (webSocket) => {
    connectionCounts.set(clientIp, (connectionCounts.get(clientIp) || 0) + 1);
    webSocket.countedIp = clientIp;
    webSocket.relay = { roomId, role };
    relay.emit('connection', webSocket);
  });
});

relay.on('connection', (socket) => {
  const { roomId, role } = socket.relay;
  socket.once('close', () => removeSocket(socket));
  socket.once('error', () => removeSocket(socket));
  const room = getRoom(roomId);
  if (!room) {
    socket.close(1013, '服务器房间已满');
    return;
  }
  if (room[role]?.readyState === WebSocket.OPEN) {
    socket.close(4009, role === 'host' ? '1P 已存在' : '2P 已存在');
    return;
  }
  room[role] = socket;
  room.touchedAt = Date.now();
  socket.isAlive = true;
  socket.windowStartedAt = Date.now();
  socket.windowBytes = 0;

  const other = role === 'host' ? room.guest : room.host;
  sendControl(socket, 'ready', { peerConnected: Boolean(other) });
  if (other) {
    sendControl(socket, 'peer-connected');
    sendControl(other, 'peer-connected');
  }

  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - socket.windowStartedAt > 10_000) {
      socket.windowStartedAt = now;
      socket.windowBytes = 0;
    }
    socket.windowBytes += data.length;
    if (socket.windowBytes > 32 * 1024 * 1024) {
      socket.close(1008, '传输速度超过限制');
      return;
    }
    room.touchedAt = now;
    const peerSocket = role === 'host' ? room.guest : room.host;
    if (peerSocket?.readyState === WebSocket.OPEN) peerSocket.send(data, { binary: isBinary });
  });
});

const heartbeat = setInterval(() => {
  for (const socket of relay.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

server.listen(port, host, () => {
  console.log(`PWA NES relay listening on http://${host}:${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of relay.clients) socket.close(1001, '服务器关闭');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
