import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { AgentRegistry } from '../src/agents.js';
import { AppServerClient } from '../src/app-server.js';
import { startNotifications } from '../src/notifications.js';

const threadA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const threadB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
async function until(predicate, message) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  assert.fail(message);
}

async function fixture(t, { uncertainFirst = false } = {}) {
  const rows = [];
  const streams = new Map();
  const deliveries = [];
  const methods = [];
  let pageReads = 0;
  let streamOpens = 0;
  let onPage = () => {};
  const json = (res, data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: status, data }));
  };
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith('/user/login/email')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const id = JSON.parse(raw).e_mail.startsWith('alice') ? '1' : '2';
      return json(res, { id, access_token: id });
    }
    const user = req.headers.authorization?.slice(7);
    if (!['1', '2'].includes(user)) return json(res, null, 401);
    if (url.pathname.endsWith('/notification/agent/events')) {
      streamOpens++;
      if (!streams.has(user)) streams.set(user, new Set());
      streams.get(user).add(res);
      res.on('close', () => streams.get(user).delete(res));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ready\ndata: {}\n\n');
      return;
    }
    if (url.pathname.endsWith('/notification/agent/page')) {
      pageReads++;
      onPage(user);
      const after = url.searchParams.get('after');
      const through = url.searchParams.get('through') ?? String(Math.max(0, ...rows.filter(row => row.recipientId === user).map(row => Number(row.notificationId))));
      const events = rows.filter(row => row.recipientId === user && BigInt(row.notificationId) > BigInt(after) && BigInt(row.notificationId) <= BigInt(through));
      return json(res, { events, after: events.at(-1)?.notificationId ?? after, through, hasMore: false });
    }
    if (url.pathname.endsWith('/question/info')) return json(res, { id: url.searchParams.get('id') }, url.searchParams.get('id') === '999' ? 403 : 200);
    assert.fail(`Unexpected Answer request: ${url.pathname}`);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => sockets.once('listening', resolve));
  sockets.on('connection', ws => ws.on('message', raw => {
    const message = JSON.parse(raw);
    methods.push(message.method);
    if (message.method === 'initialized') return;
    if (message.method === 'thread/inject_items') {
      const text = message.params.items[0].content[0].text;
      deliveries.push({ thread: message.params.threadId, ...JSON.parse(text.slice(text.indexOf('\n') + 1)) });
      if (uncertainFirst && deliveries.length === 1) return;
    }
    ws.send(JSON.stringify({ id: message.id, result: message.method === 'thread/resume' ? { thread: { id: message.params.threadId } } : {} }));
  }));
  const config = { agents: [
    { id: 'alice', token: 'a'.repeat(32), email: 'alice@example.com', password: 'secret', appServer: { url: `ws://127.0.0.1:${sockets.address().port}`, threadId: threadA } },
    { id: 'bob', token: 'b'.repeat(32), email: 'bob@example.com', password: 'secret', appServer: { url: `ws://127.0.0.1:${sockets.address().port}`, threadId: threadB } },
  ] };
  const registry = new AgentRegistry({ baseUrl: `http://127.0.0.1:${http.address().port}`, readConfig: () => config });
  let stop;
  t.after(async () => {
    await stop?.();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise(resolve => sockets.close(resolve));
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });
  return {
    rows, streams, deliveries, methods, config, registry,
    get pageReads() { return pageReads; }, get streamOpens() { return streamOpens; },
    set onPage(value) { onPage = value; },
    add(id, recipientId = '1', extra = {}) {
      const row = { notificationId: id, recipientId, actorId: '3', topicId: '10', objectId: id, kind: 'answer.created', ...extra };
      rows.push(row);
      return row;
    },
    emit(id, user = '1') {
      for (const res of streams.get(user) ?? []) res.write(`event: notification\ndata: {"notificationId":"${id}"}\n\n`);
    },
    start(options = {}) { stop = startNotifications(registry, { intervalMs: 10, retryMs: 10, batchMs: 10, ...options }); },
  };
}

test('real HTTP/SSE and WebSocket workers reconcile overlap, isolate users, filter permissions, and revoke without tool requests', async t => {
  const f = await fixture(t);
  f.add('1'); f.add('2', '2'); f.add('3', '1', { actorId: '1' }); f.add('4', '1', { topicId: '999' });
  f.onPage = user => { if (user === '1') { f.onPage = () => {}; f.emit('1'); } };
  f.start();
  await until(() => f.deliveries.length === 2, 'both principals receive unread snapshots');
  await delay(60);
  assert.deepEqual(f.deliveries.flatMap(batch => batch.events.map(event => [batch.thread, event.notificationId])).sort(), [[threadA, '1'], [threadB, '2']]);
  f.add('5'); f.add('6'); f.emit('5'); f.emit('6');
  await until(() => f.deliveries.some(batch => batch.events.some(event => event.notificationId === '6')), 'live burst delivered');
  assert.equal(f.deliveries.filter(batch => batch.events.some(event => ['5', '6'].includes(event.notificationId))).length, 1, 'burst is coalesced');
  const reads = f.pageReads;
  await delay(100);
  assert.equal(f.pageReads, reads, 'no idle forum polling');
  assert.ok(f.methods.every(method => !method.startsWith('turn/') && method !== 'thread/start'));
  assert.equal(f.rows.length, 6, 'delivery performs no acknowledgement writes');
  f.config.agents.shift();
  await until(() => f.streams.get('1').size === 0, 'hot credential removal closes live Answer access');
  f.add('7', '2'); f.emit('7', '2');
  await until(() => f.deliveries.some(batch => batch.thread === threadB && batch.events.some(event => event.notificationId === '7')), 'other principal remains live');
  assert.equal(f.registry.entries.length, 1);
});

test('reconnect catches missed unread rows once without replaying delivered IDs', async t => {
  const f = await fixture(t);
  f.config.agents.splice(1);
  f.add('1');
  f.start();
  await until(() => f.deliveries.length === 1, 'first event delivered');
  f.add('2');
  for (const stream of f.streams.get('1')) stream.destroy();
  await until(() => f.deliveries.length === 2, 'missed row recovered after reconnect');
  assert.deepEqual(f.deliveries.flatMap(batch => batch.events.map(event => event.notificationId)), ['1', '2']);
  assert.equal(f.streamOpens, 2);
});

test('uncertain injection is retained unread but suppressed from automatic reconnect replay', async t => {
  const f = await fixture(t, { uncertainFirst: true });
  f.config.agents.splice(1);
  f.add('1');
  const statuses = [];
  f.start({ clientFactory: options => new AppServerClient({ ...options, timeoutMs: 80 }), report: (_id, status) => statuses.push(status) });
  await until(() => f.streamOpens >= 2 && statuses.includes('delivery_uncertain'), 'uncertain send reconnects');
  await delay(100);
  assert.equal(f.deliveries.length, 1, 'uncertain event is not silently replayed');
  assert.equal(f.rows.length, 1, 'event remains in Answer');
  f.add('2'); f.emit('2');
  await until(() => f.deliveries.length === 2, 'subsequent event can be delivered');
  assert.equal(f.deliveries[1].events[0].notificationId, '2');
});

test('operator targets cannot be insecure or shared across principals and target changes revoke old access', () => {
  const target = { url: 'ws://localhost:1234', threadId: threadA };
  const alice = { id: 'alice', email: 'alice@example.com', password: 'secret', token: 'a'.repeat(32), appServer: target };
  const config = { agents: [alice] };
  const registry = new AgentRegistry({ baseUrl: 'http://localhost', readConfig: () => config });
  const old = registry.entries[0];
  alice.appServer = { ...target, threadId: threadB };
  registry.reload();
  assert.equal(old.revoked.signal.aborted, true);
  config.agents.push({ ...alice, id: 'bob', email: 'bob@example.com', token: 'b'.repeat(32) });
  assert.throws(() => registry.reload());
  assert.equal(registry.entries.length, 0);
  config.agents = [{ ...alice, appServer: { ...target, url: 'ws://remote.example' } }];
  assert.throws(() => registry.reload());
});

test('unavailable desktop retries its connection without opening or polling the forum feed', async t => {
  const f = await fixture(t);
  f.config.agents.splice(1);
  let attempts = 0;
  f.start({ clientFactory: () => ({
    async connect() { attempts++; throw new Error('Desktop unavailable'); },
    close() {},
  }) });
  await until(() => attempts >= 3, 'desktop connection retried');
  assert.equal(f.pageReads, 0);
  assert.equal(f.streamOpens, 0);
});
