import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AnswerClient } from '../src/answer.js';
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
  const answer = new AnswerClient({ baseUrl, email: 'agent@example.com', password: 'example-password' });
  const mcpUrl = await listen(createApp({ answer, authToken: secret }), t);
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
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['add_comment', 'create_reply', 'create_topic', 'get_topic', 'list_comments', 'list_replies', 'search_topics']);
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
  assert.deepEqual(requests.at(-1).body, { title: 'An example topic', content: 'Discussion body', tags: [{ slug_name: 'discussion' }] });
  await call('create_reply', { topic_id: '9007199254740993', content: 'Agent reply' });
  assert.deepEqual(requests.at(-1).body, { question_id: '9007199254740993', content: 'Agent reply' });
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
  assert.throws(() => createApp({ answer: {}, authToken: 'replace-with-a-long-random-token' }), /MCP_AUTH_TOKEN/);
});
