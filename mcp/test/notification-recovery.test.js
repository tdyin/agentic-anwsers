import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptanceWatcher } from '../scripts/acceptance-watcher.js';

async function until(predicate, label) {
  for (let attempt = 0; attempt < 300; attempt++) { if (predicate()) return; await delay(100); }
  assert.fail(label);
}
async function unread(answer) {
  let after = '0', through;
  const events = [];
  let pages = 0;
  for (;;) {
    const page = await answer.call('notification/agent/page', { query: { after, ...(through ? { through } : {}), limit: 100 } });
    pages++;
    events.push(...page.events);
    if (!page.hasMore) break;
    assert.notEqual(page.after, after);
    after = page.after;
    through = page.through;
    assert.ok(pages < 10, 'bounded recovery snapshot');
  }
  return { events, pages };
}

test('real Answer recovers multiple pages plus a live overlap, retains acknowledgements across restart, and rejects revoked reconnect', {
  skip: !process.env.ACCEPTANCE_INTERNAL_TOKEN,
}, async t => {
  const baseUrl = process.env.ACCEPTANCE_ANSWER_URL;
  const appServer = process.env.ACCEPTANCE_APP_SERVER_URL ? {
    url: process.env.ACCEPTANCE_APP_SERVER_URL, threadId: process.env.ACCEPTANCE_APP_SERVER_THREAD,
  } : undefined;
  const watcher = await acceptanceWatcher(t, { baseUrl, internalToken: process.env.ACCEPTANCE_INTERNAL_TOKEN, appServer, simulatedAppServer: !appServer, label: 'recovery' });
  const topic = await watcher.admin.call('question', { method: 'POST', body: {
    title: 'Recovery across multiple notification pages', content: 'A disposable recovery acceptance topic.', tags: [{ slug_name: 'recovery-test' }],
  } });
  await watcher.call('watch_topic', { topic_id: topic.id });
  await watcher.pauseDelivery(); // Closes the real App Server client and its Answer stream.
  const comment = index => watcher.admin.call('comment', { method: 'POST', body: {
    object_id: topic.id, original_text: `Recovery acceptance comment ${index}; preserve its individual notification identity.`,
  } });
  for (let index = 0; index < 101; index++) await comment(index);
  await until(() => watcher.received.length === 101, 'all offline events persisted and observed by test-only SSE observer');
  assert.equal(watcher.delivered.length, 0, 'disconnected recipient receives no context writes');
  const offline = await unread(watcher.answer);
  assert.equal(offline.events.length, 101);
  assert.equal(offline.pages, 2, 'exceeds the production 100-record recovery page');
  let overlapCreated = false;
  watcher.beforeBatch = async () => {
    if (overlapCreated) return;
    overlapCreated = true;
    await comment('during-catch-up');
    await until(() => watcher.received.length === 102, 'new event committed while the first recovery batch is in flight');
  };
  watcher.resumeDelivery();
  await until(() => watcher.delivered.length >= 102, 'complete recovery includes live overlap');
  const expected = await unread(watcher.answer);
  assert.equal(expected.events.length, 102, 'delivery alone preserves every unread event');
  assert.equal(watcher.delivered.length, 102);
  assert.equal(new Set(watcher.delivered.map(event => event.notificationId)).size, 102, 'catch-up/live overlap is not duplicated');
  assert.deepEqual(watcher.delivered.map(event => event.notificationId).sort(), expected.events.map(event => event.notificationId).sort());
  assert.equal(watcher.batches[0].length, 100);
  // Consume the referenced comments with real MCP reads before acknowledging.
  const readIds = new Set();
  for (let page = 1; page <= 3; page++) {
    const response = await watcher.call('list_comments', { object_id: topic.id, page, page_size: 50 });
    for (const row of response.list) readIds.add(row.comment_id);
  }
  const acknowledged = expected.events.slice(0, 5);
  for (const event of acknowledged) {
    assert.ok(readIds.has(event.objectId));
    await watcher.call('acknowledge_notification', { notification_id: event.notificationId });
  }
  await watcher.pauseDelivery();
  watcher.delivered.length = 0;
  const initialBatchSizes = watcher.batches.map(batch => batch.length);
  watcher.batches.length = 0;
  execFileSync('docker', ['restart', process.env.ACCEPTANCE_RESTART_CONTAINER], { stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(new URL('/healthz', baseUrl), { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'Answer restarts using the same persistent database');
  const persisted = await unread(watcher.answer);
  assert.equal(persisted.events.length, 97);
  const consumedIds = new Set(acknowledged.map(event => event.notificationId));
  assert.ok(persisted.events.every(event => !consumedIds.has(event.notificationId)), 'acknowledgements survive backend restart');
  watcher.resumeDelivery(); // New worker, with no retained delivery/cursor memory.
  await until(() => watcher.delivered.length >= 97, 'fresh worker recovers remaining unread state');
  assert.equal(watcher.delivered.length, 97);
  assert.deepEqual(watcher.delivered.map(event => event.notificationId).sort(), persisted.events.map(event => event.notificationId).sort());
  if (appServer) console.log(`Desktop recovery verification required: ${JSON.stringify({ count: 97, first: watcher.delivered[0], last: watcher.delivered.at(-1), initialBatchSizes })}`);
  watcher.revoke();
  await assert.rejects(watcher.call('get_topic', { topic_id: topic.id }), /401|Invalid MCP bearer/);
  await watcher.pauseDelivery();
  watcher.delivered.length = 0;
  watcher.resumeDelivery();
  await comment('after-revocation');
  await delay(250);
  assert.equal(watcher.delivered.length, 0, 'revoked principal cannot reconnect to delivery');
});
