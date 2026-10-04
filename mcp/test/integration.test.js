import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AnswerClient } from '../src/answer.js';
import { AgentRegistry } from '../src/agents.js';
import { createApp } from '../src/index.js';

const secret = 'integration-test-token-with-at-least-32-characters';
async function listen(app, t) {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('SDK client completes authenticated tool calls against Answer HTTP contract', async t => {
  const requests = [];
  let logins = 0;
  let rejectNext = false;
  let denied = false;
  const backend = express();
  backend.use(express.json());
  backend.use((req, res) => {
    if (req.path.endsWith('/user/login/email')) {
      logins++;
      assert.deepEqual(req.body, { e_mail: 'agent@example.com', pass: 'example-password' });
      return res.json({ code: 200, data: { access_token: `answer-token-${logins}` } });
    }
    assert.equal(req.headers.authorization, `Bearer answer-token-${logins}`);
    if (rejectNext) { rejectNext = false; return res.status(401).json({ code: 401, reason: 'Unauthorized' }); }
    requests.push({ path: req.path, method: req.method, query: { ...req.query }, body: req.body });
    if (denied) return res.status(403).json({ code: 403, reason: 'Forbidden', msg: 'secret-example-password' });
    res.json({ code: 200, data: { path: req.path, list: [{ id: '9007199254740993', content: 'human response' }] } });
  });
  const baseUrl = await listen(backend, t);
  const agents = new AgentRegistry({ baseUrl, readConfig: () => ({ agents: [{ id: 'agent', token: secret, email: 'agent@example.com', password: 'example-password' }] }) });
  const mcpUrl = await listen(createApp({ agents }), t);
  assert.equal((await fetch(`${mcpUrl}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${mcpUrl}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, Origin: 'http://evil.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${mcpUrl}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(`${mcpUrl}/mcp`, { headers: { Authorization: `Bearer ${secret}` } })).status, 405);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['add_comment', 'create_reply', 'create_topic', 'get_topic', 'list_comments', 'list_replies', 'search_topics', 'unwatch_topic', 'watch_topic']);
  assert.ok(tools.every(tool => !tool.annotations.destructiveHint));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  await call('search_topics', { query: 'persistent discussion', page: 2, page_size: 5 });
  assert.deepEqual(requests.at(-1).query, { q: 'persistent discussion is:question', page: '2', size: '5', order: 'relevance' });
  const topic = await call('get_topic', { topic_id: '9007199254740993' });
  assert.equal(topic.replies.list[0].content, 'human response');
  assert.equal(logins, 1);
  await call('create_topic', { title: 'An example topic', content: 'Discussion body', tags: ['discussion'] });
  assert.deepEqual(requests.findLast(r => r.path.endsWith('/question')).body, { title: 'An example topic', content: 'Discussion body', tags: [{ slug_name: 'discussion' }] });
  await call('create_reply', { topic_id: '9007199254740993', content: 'Agent reply' });
  assert.deepEqual(requests.findLast(r => r.path.endsWith('/answer')).body, { question_id: '9007199254740993', content: 'Agent reply' });
  await call('add_comment', { object_id: '9007199254740993', content: 'Agent comment', reply_comment_id: '12' });
  assert.deepEqual(requests.at(-1).body, { object_id: '9007199254740993', original_text: 'Agent comment', reply_comment_id: '12' });
  await call('list_comments', { object_id: '12', page: 3 });
  assert.equal(requests.at(-1).query.page, '3');
  await call('list_comments', { object_id: 'AbC123' });
  assert.equal(requests.at(-1).query.object_id, 'AbC123', 'Answer short IDs are passed through');
  rejectNext = true;
  await call('list_replies', { topic_id: '12' });
  assert.equal(logins, 2, 'expired sessions trigger reauthentication');
  const before = requests.length;
  const invalid = await client.callTool({ name: 'create_reply', arguments: { topic_id: '12', content: 'x' } });
  assert.ok(invalid.isError);
  assert.equal(requests.length, before, 'invalid inputs never reach Answer');
  denied = true;
  const forbidden = await client.callTool({ name: 'create_reply', arguments: { topic_id: '12', content: 'Valid content' } });
  assert.ok(forbidden.isError);
  assert.ok(!forbidden.content[0].text.includes('secret-example-password'));
  assert.equal(requests.length, before + 1, 'permission failures are not retried');
});

test('network failure on a write is never retried', async () => {
  let calls = 0;
  const client = new AnswerClient({ baseUrl: 'http://answer', fetchImpl: async () => { calls++; throw new Error('sensitive network details'); } });
  client.token = 'session';
  await assert.rejects(client.call('answer', { method: 'POST', body: { content: 'example' } }), /unreachable_or_timeout/);
  assert.equal(calls, 1);
});

test('placeholder MCP credentials fail closed', () => {
  assert.throws(() => new AgentRegistry({ readConfig: () => ({ agents: [{ id: 'agent', token: 'replace-with-a-long-random-token', email: 'a@example.com', password: 'password' }] }) }), /Invalid agent/);
});


test('independent agents retain attribution through concurrent renewal and hot revocation', async t => {
  const logins = { alice: 0, bob: 0 };
  const writes = [];
  let expire = false;
  const backend = express();
  backend.use(express.json());
  backend.use((req, res) => {
    if (req.path.endsWith('/user/login/email')) {
      const name = req.body.e_mail.split('@')[0];
      assert.equal(req.body.pass, `${name}-password`);
      logins[name]++;
      return res.json({ code: 200, data: { access_token: `${name}-${logins[name]}` } });
    }
    const session = req.headers.authorization.slice(7);
    const name = session.split('-')[0];
    if (expire && session.endsWith('-1')) return res.status(401).json({ code: 401 });
    if (req.body?.content === 'denied content') return res.status(403).json({ code: 403, reason: 'Forbidden' });
    writes.push({ name, body: req.body });
    res.json({ code: 200, data: { author: name } });
  });
  const baseUrl = await listen(backend, t);
  let config = { agents: ['alice', 'bob'].map(id => ({ id, email: `${id}@example.com`, password: `${id}-password`, token: `${secret}-${id}` })) };
  const agents = new AgentRegistry({ baseUrl, readConfig: () => config });
  const mcpUrl = await listen(createApp({ agents }), t);
  const clients = await Promise.all(config.agents.map(async agent => {
    const client = new Client({ name: agent.id, version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }));
    t.after(() => client.close());
    return client;
  }));
  const reply = client => client.callTool({ name: 'create_reply', arguments: { topic_id: '12', content: 'Valid content' } });
  for (let round = 0; round < 2; round++) {
    const results = await Promise.all(clients.flatMap(client => [reply(client), reply(client)]));
    assert.deepEqual(results.map(result => JSON.parse(result.content[0].text).author), ['alice', 'alice', 'bob', 'bob']);
    expire = true;
  }
  assert.deepEqual(logins, { alice: 2, bob: 2 });
  const before = writes.length;
  const spoof = await clients[0].callTool({ name: 'create_reply', arguments: { topic_id: '12', content: 'Valid content', user_id: 'bob' } });
  assert.ok(spoof.isError);
  assert.equal(writes.length, before);
  const denied = await clients[0].callTool({ name: 'create_reply', arguments: { topic_id: '12', content: 'denied content' } });
  assert.ok(denied.isError);
  assert.deepEqual(logins, { alice: 2, bob: 2 });
  const alice = agents.authenticate(`Bearer ${secret}-alice`);
  config = { agents: [config.agents[1]] };
  await assert.rejects(reply(clients[0]), /Invalid MCP bearer token/);
  assert.equal(alice.revoked.signal.aborted, true);
  await assert.rejects(alice.answer.call('question/info'), /revoked/);
  assert.equal(JSON.parse((await reply(clients[1])).content[0].text).author, 'bob');
  assert.equal(logins.bob, 2, 'unrelated agent keeps its session');
  config = { agents: [{ id: 'broken' }] };
  await assert.rejects(reply(clients[1]), /authentication unavailable/);
});

test('atomic credential file replacement revokes old tokens and rejects corrupt files', async t => {
  const { mkdtempSync, writeFileSync, renameSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'agentic-credentials-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'agents.json');
  const config = { agents: [{ id: 'alice', email: 'alice@example.com', password: 'test-password', token: secret }] };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const agents = new AgentRegistry({ file });
  const old = agents.authenticate(`Bearer ${secret}`);
  config.agents[0].token = `${secret}-rotated`;
  writeFileSync(`${file}.next`, JSON.stringify(config), { mode: 0o600 });
  renameSync(`${file}.next`, file);
  assert.equal(agents.authenticate(`Bearer ${secret}`), undefined);
  assert.ok(old.revoked.signal.aborted);
  assert.equal(agents.authenticate(`Bearer ${secret}-rotated`).id, 'alice');
  writeFileSync(file, '{');
  assert.throws(() => agents.authenticate(`Bearer ${secret}-rotated`), /Invalid agent/);
  assert.equal(agents.entries.length, 0);
});

test('watch tools resolve visible topics and report partial writes without replay', async t => {
  const calls = [];
  let forbidden = false;
  let failFollow = false;
  const backend = express();
  backend.use(express.json());
  backend.use((req, res) => {
    calls.push({ path: req.path, method: req.method, body: req.body });
    if (req.path.endsWith('/user/login/email')) return res.json({ code: 200, data: { access_token: 'session' } });
    if (req.path.endsWith('/question/info')) {
      if (forbidden) return res.status(403).json({ code: 403, reason: 'Forbidden' });
      return res.json({ code: 200, data: { id: '9007199254740993' } });
    }
    if (req.path.endsWith('/follow')) {
      if (failFollow) return res.status(503).json({ code: 503, reason: 'Unavailable' });
      return res.json({ code: 200, data: { is_followed: !req.body.is_cancel } });
    }
    res.json({ code: 200, data: { id: '9007199254740993' } });
  });
  const baseUrl = await listen(backend, t);
  const agents = new AgentRegistry({ baseUrl, readConfig: () => ({ agents: [{ id: 'agent', token: secret, email: 'agent@example.com', password: 'password' }] }) });
  const mcpUrl = await listen(createApp({ agents }), t);
  const client = new Client({ name: 'watch-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  t.after(() => client.close());
  for (const name of ['watch_topic', 'watch_topic', 'unwatch_topic', 'unwatch_topic']) {
    const result = await client.callTool({ name, arguments: { topic_id: 'ShortId' } });
    assert.ok(!result.isError);
    assert.deepEqual(calls.at(-1).body, { object_id: '9007199254740993', is_cancel: name === 'unwatch_topic' });
  }
  forbidden = true;
  const before = calls.filter(call => call.path.endsWith('/follow')).length;
  assert.ok((await client.callTool({ name: 'watch_topic', arguments: { topic_id: 'ShortId' } })).isError);
  assert.equal(calls.filter(call => call.path.endsWith('/follow')).length, before);
  forbidden = false;
  failFollow = true;
  const result = await client.callTool({ name: 'create_topic', arguments: { title: 'Partial success', content: 'Created only once', tags: ['discussion'] } });
  assert.ok(!result.isError, 'the content write succeeded');
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.id, '9007199254740993');
  assert.equal(data.watch.established, false);
  assert.match(data.watch.warning, /Do not repeat/);
  assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/question')).length, 1);
});
