import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const port = 18787;
const server = spawn(process.execPath, ['relay-server/server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
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
const openClient = (role) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/relay?room=${room}&role=${role}`, { origin });
  socket.once('open', () => resolve(socket));
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

const host = await openClient('host');
const guest = await openClient('guest');
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
console.log('Relay text and binary forwarding passed');
