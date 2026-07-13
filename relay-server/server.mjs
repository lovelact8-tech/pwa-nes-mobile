import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const maxRooms = Number(process.env.MAX_ROOMS || 32);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://lovelact8-tech.github.io,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const rooms = new Map();

function sendControl(socket, type, extra = {}) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ __relay: type, ...extra }));
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
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Private NES relay');
});

const relay = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin || '';
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const roomId = url.searchParams.get('room') || '';
  const role = url.searchParams.get('role');
  if (url.pathname !== '/relay' || !allowedOrigins.has(origin) || !/^[a-zA-Z0-9_-]{12,64}$/.test(roomId) || !['host', 'guest'].includes(role)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  relay.handleUpgrade(request, socket, head, (webSocket) => {
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

  socket.on('pong', () => {
    socket.isAlive = true;
  });
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
    const peer = role === 'host' ? room.guest : room.host;
    if (peer?.readyState === WebSocket.OPEN) peer.send(data, { binary: isBinary });
  });
  socket.on('close', () => removeSocket(socket));
  socket.on('error', () => removeSocket(socket));
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
  const staleBefore = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, room] of rooms) {
    if (!room.host && !room.guest && room.touchedAt < staleBefore) rooms.delete(id);
  }
}, 30_000);

server.listen(port, host, () => {
  console.log(`Private NES relay listening on http://${host}:${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of relay.clients) socket.close(1001, '服务器关闭');
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
