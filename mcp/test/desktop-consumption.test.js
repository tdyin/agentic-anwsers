import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptanceWatcher } from '../scripts/acceptance-watcher.js';
import { AppServerClient } from '../src/app-server.js';

test('actual desktop thread consumes a pushed comment through MCP and explicitly acknowledges it', {
  skip: process.env.ACCEPTANCE_MODEL_TOOLS !== '1',
}, async t => {
  assert.ok(process.env.ACCEPTANCE_APP_SERVER_URL && process.env.ACCEPTANCE_APP_SERVER_THREAD);
  const target = { url: process.env.ACCEPTANCE_APP_SERVER_URL, threadId: process.env.ACCEPTANCE_APP_SERVER_THREAD };
  const watcher = await acceptanceWatcher(t, { baseUrl: process.env.ACCEPTANCE_ANSWER_URL, internalToken: process.env.ACCEPTANCE_INTERNAL_TOKEN, appServer: target, label: 'model-consumption' });
  const control = new AppServerClient({ target });
  t.after(async () => {
    try {
      await control.request('thread/archive', { threadId: target.threadId });
      await control.request('thread/unarchive', { threadId: target.threadId });
      await control.request('thread/resume', { threadId: target.threadId });
    } finally { control.close(); }
  });
  await control.connect();
  const topic = await watcher.admin.call('question', { method: 'POST', body: {
    title: 'Model consumption acceptance topic', content: 'Read the current comment through authenticated MCP tools.', tags: [{ slug_name: 'model-consumption' }],
  } });
  await watcher.call('watch_topic', { topic_id: topic.id });
  const marker = `comment-proof-${randomUUID()}`;
  const comment = await watcher.admin.call('comment', { method: 'POST', body: { object_id: topic.id, original_text: marker } });
  const event = await watcher.event('comment.created', comment.comment_id);
  await watcher.pauseDelivery();
  // Rejoining a loaded thread retains its MCP connections. Release only this
  // disposable test thread before resuming with test-only per-thread overrides.
  await control.request('thread/archive', { threadId: target.threadId });
  await control.request('thread/unarchive', { threadId: target.threadId });
  // No user config file or global server is modified.
  await control.request('thread/resume', { threadId: target.threadId, approvalPolicy: 'never', config: {
    'mcp_servers.answer_acceptance': { url: watcher.mcpUrl, http_headers: { Authorization: `Bearer ${watcher.credentials.token}` }, enabled_tools: ['list_comments', 'acknowledge_notification'],
      ...(process.env.ACCEPTANCE_ACK_APPROVED === '1' ? { tools: { acknowledge_notification: { approval_mode: 'approve' } } } : {}) },
  } });
  const inventory = await control.request('mcpServerStatus/list', { threadId: target.threadId, serverName: 'answer_acceptance' });
  assert.ok(inventory.data?.some(server => server.name === 'answer_acceptance' && Object.keys(server.tools || {}).length > 0), `test MCP tools available: ${JSON.stringify(inventory)}`);
  let finished;
  const onMessage = raw => { const message = JSON.parse(raw); if (message.method === 'turn/completed' && message.params.threadId === target.threadId) finished = message.params.turn; };
  control.ws.on('message', onMessage);
  t.after(() => control.ws.off('message', onMessage));
  const { turn } = await control.request('turn/start', { threadId: target.threadId, input: [{ type: 'text', text:
    'Acceptance verification: inspect the newest External Answer notification metadata in your context. Using only the answer_acceptance MCP server, call list_comments for its topic to read the referenced comment, then acknowledge only that notification with acknowledge_notification. Return the exact comment text you retrieved. Do not use files, shell, other servers, or guess. This is an explicit one-time request to consume that notification.' }] });
  for (let i = 0; i < 120 && finished?.id !== turn.id; i++) await delay(500);
  if (finished?.id !== turn.id) await control.request('turn/interrupt', { threadId: target.threadId, turnId: turn.id });
  assert.equal(finished?.id, turn.id, 'receive explicit terminal turn notification');
  const result = await control.request('thread/turns/list', { threadId: target.threadId, limit: 1, itemsView: 'full' });
  const completed = result.data.find(row => row.id === turn.id);
  assert.equal(completed?.status, 'completed', 'explicit verification turn completes');
  const calls = completed.items.filter(item => item.type === 'mcpToolCall');
  assert.ok(calls.some(item => item.tool === 'list_comments' && item.status === 'completed'), `model reads comment through MCP; item types: ${completed.items.map(i => i.type).join(',')}`);
  const acknowledgement = calls.find(item => item.tool === 'acknowledge_notification');
  assert.equal(acknowledgement?.status, 'completed', acknowledgement?.error?.message || 'model explicitly acknowledges through MCP');
  assert.equal(calls.filter(item => item.tool === 'acknowledge_notification').length, 1, 'exactly one approved acknowledgement');
  assert.deepEqual(acknowledgement.arguments, { notification_id: event.notificationId });
  assert.ok(completed.items.some(item => item.type === 'agentMessage' && item.text.includes(marker)), 'model recalls text available only through the tool');
  const unread = await watcher.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } });
  assert.ok(!unread.events.some(row => row.notificationId === event.notificationId), 'native unread state consumed');
  console.log(`Actual model consumption passed: ${JSON.stringify({ threadId: target.threadId, turnId: turn.id, notificationId: event.notificationId, commentId: comment.comment_id, marker, tools: calls.map(c => c.tool) })}`);
});
