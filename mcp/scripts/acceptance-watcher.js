import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AnswerClient } from '../src/answer.js';
import { AgentRegistry } from '../src/agents.js';
import { AppServerClient } from '../src/app-server.js';
import { createApp } from '../src/index.js';
import { startNotifications } from '../src/notifications.js';
import { notificationStream } from '../src/notification-stream.js';

// Test-only ordinary recipient, real MCP tools, and live SSE observation. This is
// hosted inside the acceptance process and is never a deployment companion.
export async function acceptanceWatcher(t, { baseUrl, internalToken, appServer, label = 'resolution' }) {
  const admin = new AnswerClient({ baseUrl, internalToken, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  await admin.login();
  const suffix = randomBytes(6).toString('hex');
  const config = { id: label, email: `${label}-${suffix}@example.com`, password: randomBytes(16).toString('hex'), token: randomBytes(32).toString('hex'), ...(appServer ? { appServer } : {}) };
  const created = await fetch(new URL('/answer/admin/api/user', baseUrl), {
    method: 'POST', headers: { 'X-Answer-Internal-Token': internalToken, Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: `${label}-${suffix}`, email: config.email, password: config.password }),
  });
  assert.equal((await created.json()).code, 200, 'provision ordinary notification recipient');
  const registry = new AgentRegistry({ baseUrl, internalToken, readConfig: () => ({ agents: [config] }) });
  const answer = registry.entries[0].answer;
  const profile = await answer.request('user/login/email', { method: 'POST', body: { e_mail: config.email, pass: config.password } });
  assert.equal(profile.role_id, 1);
  const listener = await new Promise(resolve => { const server = createApp({ agents: registry }).listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
  const client = new Client({ name: `${label}-acceptance`, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.address().port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  }));
  t.after(() => client.close());
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const abort = new AbortController();
  const stream = notificationStream(answer, { signal: abort.signal });
  assert.equal((await stream.next()).value.type, 'ready');
  const received = [];
  const pump = (async () => { for await (const event of stream) received.push(event.notificationId); })().catch(() => {});
  t.after(async () => { abort.abort(); await pump; });
  const delivered = [];
  if (appServer) {
    const stop = startNotifications(registry, { clientFactory: options => {
      const target = new AppServerClient(options);
      const deliver = target.deliver.bind(target);
      target.deliver = async events => { await deliver(events); delivered.push(...events); };
      return target;
    } });
    t.after(stop);
  }
  return { answer, call, received, delivered, admin,
    async event(kind, objectId) {
      let inspected = -1;
      let found;
      for (let i = 0; i < 100; i++) {
        if (received.length !== inspected) {
          inspected = received.length;
          const page = await answer.call('notification/agent/page', { query: { after: '0', limit: 100 } });
          found = page.events.find(event => event.kind === kind && event.objectId === objectId);
        }
        if (found && received.includes(found.notificationId)) break;
        await delay(100);
      }
      assert.ok(found && received.includes(found.notificationId), `live ${kind} event received`);
      assert.equal(found.recipientId, profile.id);
      assert.notEqual(found.actorId, profile.id);
      if (appServer) {
        for (let i = 0; i < 100 && !delivered.some(event => event.notificationId === found.notificationId); i++) await delay(100);
        assert.ok(delivered.some(event => event.notificationId === found.notificationId), `${kind} accepted by App Server`);
        console.log(`Desktop ${label} context verification required: ${JSON.stringify(found)}`);
      }
      return found;
    },
  };
}
