import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AnswerClient } from '../src/answer.js';
import { AgentRegistry } from '../src/agents.js';
import { createApp } from '../src/index.js';

// Run only against a disposable Answer instance: this provisions users and content.
test('real Answer attributes MCP topic, answer and comment writes to distinct ordinary users', {
  skip: !process.env.ACCEPTANCE_ANSWER_URL,
}, async t => {
  const baseUrl = process.env.ACCEPTANCE_ANSWER_URL;
  const admin = new AnswerClient({ baseUrl, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  await admin.login();
  const suffix = randomBytes(4).toString('hex');
  const config = { agents: ['alice', 'bob'].map(id => ({ id, email: `${id}-${suffix}@example.com`, password: randomBytes(12).toString('hex'), token: randomBytes(32).toString('hex') })) };
  const identities = [];
  for (const agent of config.agents) {
    const response = await fetch(new URL('/answer/admin/api/user', baseUrl), {
      method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: `${agent.id}-${suffix}`, email: agent.email, password: agent.password }),
    });
    assert.equal((await response.json()).code, 200, 'admin user provisioning');
    const principal = new AnswerClient({ baseUrl, email: agent.email, password: agent.password });
    const info = await principal.request('user/login/email', { method: 'POST', body: { e_mail: agent.email, pass: agent.password } });
    assert.equal(info.role_id, 1, 'agent must not be administrator');
    identities.push(info.id);
  }
  assert.notEqual(identities[0], identities[1]);
  await admin.call('question', { method: 'POST', body: { title: `Acceptance seed ${suffix}`, content: 'Seed question for agent acceptance testing.', tags: [{ slug_name: 'discussion' }] } });
  const agents = new AgentRegistry({ baseUrl, readConfig: () => config });
  const app = createApp({ agents });
  const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  const clients = [];
  for (const agent of config.agents) {
    const client = new Client({ name: agent.id, version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }));
    clients.push(client);
    t.after(() => client.close());
  }
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  for (const [index, client] of clients.entries()) {
    const topic = await call(client, 'create_topic', { title: `Agent ${index} discussion ${suffix}`, content: 'A real independently attributed discussion.', tags: ['discussion'] });
    const topicId = topic.id;
    assert.ok(topicId, 'question creation returns its ID');
    const read = await call(client, 'get_topic', { topic_id: topicId });
    assert.equal(read.topic.user_info.id, identities[index]);
    const answer = await call(client, 'create_reply', { topic_id: topicId, content: 'An independently attributed real reply.' });
    const replies = await call(client, 'list_replies', { topic_id: topicId });
    assert.equal(replies.list.find(item => item.id === answer.info.id).user_info.id, identities[index]);
    await call(client, 'add_comment', { object_id: topicId, content: 'An independently attributed real comment.' });
    const comments = await call(client, 'list_comments', { object_id: topicId });
    assert.ok(comments.list.some(item => item.user_id === identities[index]));
  }
  config.agents.splice(0, 1);
  await assert.rejects(clients[0].listTools(), /Invalid MCP bearer token/);
  await clients[1].listTools();
});
