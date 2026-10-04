import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptanceWatcher } from '../scripts/acceptance-watcher.js';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(200); }
  assert.fail(label);
}

test('two notification workers retain routing and unread state across both-container restart and live revocation', {
  skip: !process.env.ACCEPTANCE_MCP_IMAGE || !process.env.ACCEPTANCE_INTERNAL_TOKEN,
}, async t => {
  const options = { baseUrl: process.env.ACCEPTANCE_ANSWER_URL, internalToken: process.env.ACCEPTANCE_INTERNAL_TOKEN };
  const alice = await acceptanceWatcher(t, { ...options, label: 'container-alice' });
  const bob = await acceptanceWatcher(t, { ...options, label: 'container-bob' });
  const principals = [alice, bob];
  const config = { agents: principals.map(w => ({ ...w.credentials, appServer: { url: 'ws://127.0.0.1:3456', threadId: randomUUID() } })) };
  const directory = process.env.ACCEPTANCE_WORK_DIR;
  const file = join(directory, 'container-notifications.json');
  const save = () => { writeFileSync(`${file}.next`, JSON.stringify(config), { mode: 0o600 }); renameSync(`${file}.next`, file); };
  save();
  copyFileSync(new URL('../scripts/acceptance-app-server.mjs', import.meta.url), join(directory, 'acceptance-app-server.mjs'));
  const name = `${process.env.ACCEPTANCE_RESTART_CONTAINER}-notifications`;
  docker('run', '-d', '--name', name, '--network', process.env.ACCEPTANCE_NETWORK,
    '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop=ALL',
    '-v', `${directory}:/run/acceptance:ro`, '-e', 'ANSWER_BASE_URL=http://answer',
    '-e', 'MCP_AGENTS_FILE=/run/acceptance/container-notifications.json',
    '-e', 'ANSWER_INTERNAL_TOKEN_FILE=/run/acceptance/internal-token',
    process.env.ACCEPTANCE_MCP_IMAGE, 'node', '--import', '/run/acceptance/acceptance-app-server.mjs', 'src/index.js');
  t.after(() => docker('rm', '-f', '-v', name));
  const logs = () => docker('logs', name).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  await until(() => logs().some(row => row.fixture === 'app-server-boot'), 'container starts');
  const firstBoot = logs().find(row => row.fixture === 'app-server-boot').boot;
  const topics = [];
  for (let i = 0; i < principals.length; i++) {
    const topic = await alice.admin.call('question', { method: 'POST', body: { title: `Container recovery topic ${i}`, content: 'Persistent notification routing test.', tags: [{ slug_name: 'container-recovery' }] } });
    topics.push(topic);
    await principals[i].call('watch_topic', { topic_id: topic.id });
  }
  const comment = i => alice.admin.call('comment', { method: 'POST', body: { object_id: topics[i].id, original_text: `Container recovery event ${randomUUID()}` } });
  const rows = (boot, thread) => logs().filter(row => row.fixture === 'injection' && row.boot === boot && row.thread === thread).flatMap(row => row.events);
  await comment(0); await comment(1);
  for (const [i, w] of principals.entries()) {
    await until(() => rows(firstBoot, config.agents[i].appServer.threadId).length === 1, 'initial isolated delivery');
    const [event] = rows(firstBoot, config.agents[i].appServer.threadId);
    assert.equal(event.topicId, topics[i].id);
    assert.equal(event.recipientId, w.answer.userId);
  }
  const consumed = rows(firstBoot, config.agents[0].appServer.threadId)[0];
  await alice.call('list_comments', { object_id: topics[0].id });
  await alice.call('acknowledge_notification', { notification_id: consumed.notificationId });
  docker('stop', name);
  await comment(0); await comment(1);
  // Wait for native asynchronous fan-out before restarting its database process.
  await until(async () => (await bob.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } })).events.length === 2, 'offline state persisted');
  docker('restart', process.env.ACCEPTANCE_RESTART_CONTAINER);
  docker('start', name);
  await until(() => logs().filter(row => row.fixture === 'app-server-boot').length === 2, 'fresh MCP process starts');
  const secondBoot = logs().filter(row => row.fixture === 'app-server-boot').at(-1).boot;
  assert.notEqual(secondBoot, firstBoot);
  for (const [i, w] of principals.entries()) {
    await until(() => rows(secondBoot, config.agents[i].appServer.threadId).length === i + 1, 'persistent unread recovery');
    const expected = (await w.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } })).events;
    const actual = rows(secondBoot, config.agents[i].appServer.threadId);
    assert.deepEqual(actual.map(e => e.notificationId).sort(), expected.map(e => e.notificationId).sort());
    assert.ok(actual.every(e => e.recipientId === w.answer.userId && e.topicId === topics[i].id));
    assert.ok(!actual.some(e => e.notificationId === consumed.notificationId));
    assert.equal((await w.call('get_topic', { topic_id: topics[i].id })).topic.is_followed, true);
  }
  const revokedThread = config.agents[0].appServer.threadId;
  const revokedConnection = logs().filter(row => row.fixture === 'injection' && row.boot === secondBoot && row.thread === revokedThread).at(-1).connection;
  assert.ok(logs().some(row => row.fixture === 'closed' && row.boot === secondBoot && row.thread === revokedThread && row.connection !== revokedConnection), 'earlier failed connection cannot stand in for revocation');
  assert.ok(!logs().some(row => row.fixture === 'closed' && row.connection === revokedConnection), 'delivering connection is still active before revocation');
  config.agents.shift(); save();
  await until(() => docker('exec', name, 'node', '-e', "try { const ids=JSON.parse(require('fs').readFileSync('/run/acceptance/container-notifications.json','utf8')).agents.map(a=>a.id); console.log(!ids.includes('container-alice')); } catch(e) { if(e.code !== 'ENOENT') throw e; }").trim() === 'true', 'revocation file visible inside container');
  await until(() => logs().some(row => row.fixture === 'closed' && row.boot === secondBoot && row.connection === revokedConnection), 'revocation closes the currently delivering App Server connection');
  await comment(0); await comment(1);
  await until(() => rows(secondBoot, config.agents[0].appServer.threadId).length === 3, 'other principal continues after revocation');
  assert.equal(rows(secondBoot, revokedThread).length, 1, `revoked live recipient gets no new injection: ${JSON.stringify(rows(secondBoot, revokedThread))}`);
});
