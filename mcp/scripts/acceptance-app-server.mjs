// Test-only protocol observer, preloaded into the disposable MCP container.
// Never included in the production image or used as actual Codex evidence.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const { WebSocketServer } = createRequire('/app/package.json')('ws');
const boot = randomUUID();
const server = new WebSocketServer({ host: '127.0.0.1', port: 3456 });
await new Promise(resolve => server.once('listening', resolve));
console.log(JSON.stringify({ fixture: 'app-server-boot', boot }));
const retriedThreads = new Set();
server.on('connection', socket => {
  const connection = randomUUID();
  let thread;
  socket.on('close', () => console.log(JSON.stringify({ fixture: 'closed', boot, thread, connection })));
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    assert.ok(['initialize', 'initialized', 'thread/resume', 'thread/inject_items'].includes(message.method));
    if (message.id === undefined) return;
    if (message.method === 'thread/resume') {
      thread = message.params.threadId;
      console.log(JSON.stringify({ fixture: 'connected', boot, thread, connection }));
      // Exercise reconnect before successful delivery, leaving an earlier closed
      // connection that must not be mistaken for a later revocation signal.
      if (!retriedThreads.has(thread)) { retriedThreads.add(thread); socket.close(); return; }
    }
    if (message.method === 'thread/inject_items') {
      assert.equal(message.params.threadId, thread);
      const text = message.params.items[0].content[0].text;
      const { events } = JSON.parse(text.slice(text.indexOf('\n') + 1));
      console.log(JSON.stringify({ fixture: 'injection', boot, thread, connection, payloadBytes: Buffer.byteLength(text), events }));
    }
    socket.send(JSON.stringify({ id: message.id, result: message.method === 'thread/resume' ? { thread: { id: message.params.threadId } } : {} }));
  });
});
