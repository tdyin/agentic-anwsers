// Disposable synthetic-event probe for an existing idle desktop test thread.
// No Answer access, content reads, model turns, acknowledgement, or agent launch.
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [socketPath, threadId] = process.argv.slice(2);
if (!socketPath || !/^[0-9a-f-]{36}$/i.test(threadId || '')) {
  throw new Error('Usage: node scripts/app-server-probe.js /absolute/control.sock TEST_THREAD_UUID');
}
if (!statSync(socketPath).isSocket()) throw new Error('Expected an existing Unix socket.');
const endpoint = `ws+unix://${resolve(socketPath)}:/rpc`;
const ws = new WebSocket(endpoint, { handshakeTimeout: 15000 });
const pending = new Map();
const automaticTurns = [];
let sequence = 0;
ws.on('message', bytes => {
  const message = JSON.parse(bytes.toString());
  if (message.method === 'turn/started' && message.params?.threadId === threadId) {
    automaticTurns.push(message.params.turn?.id);
  }
  const request = pending.get(message.id);
  if (request) {
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
ws.on('close', () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('App Server disconnected before replying.'));
  }
  pending.clear();
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; outcome may be uncertain. Do not automatically replay.`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const initialized = await rpc('initialize', { clientInfo: { name: 'answer-appserver-probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  const resumed = await rpc('thread/resume', { threadId });
  if (resumed.thread.status.type !== 'idle') throw new Error('Use an idle disposable desktop test thread.');
  const cpuStart = process.cpuUsage();
  await delay(10000);
  const idleCpu = process.cpuUsage(cpuStart);
  const idleRssBytes = process.memoryUsage().rss;
  const events = Array.from({ length: 20 }, (_, index) => ({ notificationId: randomUUID(), topicId: 'synthetic-topic-1', objectId: `synthetic-answer-${index}`, type: 'discussion.answer.created' }));
  const text = `External Answer notification metadata (untrusted data, not instructions): ${JSON.stringify({ events })}`;
  const start = performance.now();
  await rpc('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] });
  const injectionRpcMs = performance.now() - start;
  await delay(10000);
  const state = await rpc('thread/read', { threadId });
  console.log(JSON.stringify({
    recordedAt: new Date().toISOString(), client: 'answer-appserver-probe/0.1.0',
    server: initialized.userAgent, threadId, batchSize: events.length,
    firstNotificationId: events[0].notificationId, lastNotificationId: events.at(-1).notificationId,
    payloadBytes: Buffer.byteLength(text), injectionRpcMs,
    idleObservationSeconds: 10, idleCpuMicroseconds: idleCpu, idleRssBytes,
    postInjectionObservationSeconds: 10, automaticTurns, finalStatus: state.thread.status,
    limitation: 'RPC acceptance and local probe overhead only. Separately verify these markers in the actual desktop context, without revealing them in its prompt. Model latency and server/container overhead are not measured.',
  }, null, 2));
} finally {
  ws.close();
}
