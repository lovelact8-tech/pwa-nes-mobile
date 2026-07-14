import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const port = 18787;
const accessKey = 'test-access-key-only';
const tokenSecret = 'test-signing-secret-at-least-32-characters';
const turnSecret = 'test-turn-shared-secret-at-least-32-characters';
const turnUrl = 'turn:100.125.58.33:3478?transport=udp';
const server = spawn(process.execPath, ['relay-server/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    RELAY_ACCESS_KEY: accessKey,
    RELAY_TOKEN_SECRET: tokenSecret,
    TURN_SHARED_SECRET: turnSecret,
    TURN_URLS: turnUrl,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('relay startup timeout')), 3000);
  server.once('error', reject);
  server.stderr.once('data', (data) => reject(new Error(data.toString())));
  server.stdout.on('data', (data) => {
    if (!data.toString().includes('PWA NES relay listening')) return;
    clearTimeout(timeout);
    resolve();
  });
});

const room = `test-${Date.now()}`;
const origin = 'https://lovelact8-tech.github.io';
const rejectedTicketResponse = await fetch(`http://127.0.0.1:${port}/ticket`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ roomId: room, accessKey: 'wrong-access-key' }),
});
assert.equal(rejectedTicketResponse.status, 401);

const ticketResponse = await fetch(`http://127.0.0.1:${port}/ticket`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ roomId: room, accessKey }),
});
assert.equal(ticketResponse.status, 200);
const tickets = await ticketResponse.json();
assert.ok(tickets.hostToken);
assert.ok(tickets.guestToken);

const openClient = (role, ticket) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/relay?room=${room}&role=${role}&ticket=${encodeURIComponent(ticket)}`, { origin });
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(data.toString());
    if (message.__relay === 'ready') resolve({ socket, ready: message });
  });
  socket.once('error', reject);
});
const waitForMessage = (socket, predicate) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('message timeout')), 3000);
  const listener = (data, isBinary) => {
    const value = isBinary ? data : data.toString();
    if (!predicate(value, isBinary)) return;
    clearTimeout(timeout);
    socket.off('message', listener);
    resolve(value);
  };
  socket.on('message', listener);
});

const hostClient = await openClient('host', tickets.hostToken);
const guestClient = await openClient('guest', tickets.guestToken);
const host = hostClient.socket;
const guest = guestClient.socket;
for (const ready of [hostClient.ready, guestClient.ready]) {
  assert.deepEqual(ready.turn.urls, [turnUrl]);
  assert.ok(Number(ready.turn.expiresAt) > Math.floor(Date.now() / 1000));
  const expectedCredential = crypto.createHmac('sha1', turnSecret).update(ready.turn.username).digest('base64');
  assert.equal(ready.turn.credential, expectedCredential);
}
const inputPromise = waitForMessage(guest, (data, binary) => !binary && JSON.parse(data).type === 'input');
host.send(JSON.stringify({ type: 'input', player: 1, buttons: ['A'], frame: 42 }));
assert.equal(JSON.parse(await inputPromise).frame, 42);

const rom = Buffer.from([0x4e, 0x45, 0x53, 0x1a]);
const romPromise = waitForMessage(guest, (data, binary) => binary && data.equals(rom));
host.send(rom);
assert.deepEqual(await romPromise, rom);

host.close();
guest.close();
server.kill('SIGTERM');
console.log('Relay TURN credentials, text, and binary forwarding passed');
