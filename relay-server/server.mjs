import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const maxRooms = Math.max(1, Number(process.env.MAX_ROOMS || 64));
const maxConnectionsPerIp = Math.max(2, Number(process.env.MAX_CONNECTIONS_PER_IP || 6));
const trustProxy = process.env.TRUST_PROXY === '1';
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://lovelact8-tech.github.io,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const rooms = new Map();
const connectionCounts = new Map();

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
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true }));
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
  const clientIp = getClientIp(request);
  const invalidRequest = url.pathname !== '/relay'
    || !allowedOrigins.has(origin)
    || !/^[a-zA-Z0-9_-]{12,64}$/.test(roomId)
    || !['host', 'guest'].includes(role)
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
  socket.once('close', () => removeSocket(socket));
  socket.once('error', () => removeSocket(socket));
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
