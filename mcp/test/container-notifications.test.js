import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptanceWatcher } from '../scripts/acceptance-watcher.js';
import { AppServerClient } from '../src/app-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer as createSocket } from 'node:net';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(200); }
  assert.fail(label);
}

test('production container delivers a real notification to the existing desktop through an SSH-forwarded Unix socket', {
  skip: !process.env.ACCEPTANCE_VM_SOCKET_DIR,
}, async t => {
  assert.ok(process.env.ACCEPTANCE_MCP_IMAGE && process.env.ACCEPTANCE_INTERNAL_TOKEN);
  const target = { url: process.env.ACCEPTANCE_APP_SERVER_URL, threadId: process.env.ACCEPTANCE_APP_SERVER_THREAD };
  const control = new AppServerClient({ target });
  t.after(() => control.close());
  await control.connect();
  const before = await control.request('thread/turns/list', { threadId: target.threadId, limit: 1 });
  const watcher = await acceptanceWatcher(t, { baseUrl: process.env.ACCEPTANCE_ANSWER_URL,
    internalToken: process.env.ACCEPTANCE_INTERNAL_TOKEN, label: 'ssh-container' });
  const directory = process.env.ACCEPTANCE_WORK_DIR;
  writeFileSync(join(directory, 'desktop-container.json'), JSON.stringify({ agents: [{ ...watcher.credentials,
    appServer: { url: 'unix:///run/codex/control.sock', threadId: target.threadId },
  }] }), { mode: 0o600 });
  const name = `${process.env.ACCEPTANCE_RESTART_CONTAINER}-desktop`;
  const reservation = createSocket();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  docker('run', '-d', '--name', name, '--network', process.env.ACCEPTANCE_NETWORK,
    '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop=ALL',
    '--mount', `type=bind,src=${process.env.ACCEPTANCE_VM_SOCKET_DIR},dst=/run/codex,readonly`,
    '-p', `127.0.0.1:${port}:3000`,
    '-v', `${directory}:/run/acceptance:ro`, '-e', 'ANSWER_BASE_URL=http://answer',
    '-e', 'MCP_AGENTS_FILE=/run/acceptance/desktop-container.json',
    '-e', 'ANSWER_INTERNAL_TOKEN_FILE=/run/acceptance/internal-token', process.env.ACCEPTANCE_MCP_IMAGE);
  t.after(() => docker('rm', '-f', '-v', name));
  const mcpUrl = `http://127.0.0.1:${port}`;
  await until(async () => { try { return (await fetch(`${mcpUrl}/healthz`)).ok; } catch { return false; } }, 'production MCP endpoint ready');
  const client = new Client({ name: 'protected-container-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${watcher.credentials.token}` } },
  }));
  t.after(() => client.close());
  const call = async (tool, args) => {
    const response = await client.callTool({ name: tool, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const topic = await watcher.admin.call('question', { method: 'POST', body: {
    title: 'Protected container desktop delivery', content: 'Disposable SSH socket acceptance.', tags: [{ slug_name: 'socket-test' }],
  } });
  await call('watch_topic', { topic_id: topic.id });
  const comment = await watcher.admin.call('comment', { method: 'POST', body: {
    object_id: topic.id, original_text: `Protected container event ${randomUUID()}`,
  } });
  const event = await watcher.event('comment.created', comment.comment_id);
  const deliveries = () => docker('logs', name).split('\n').flatMap(line => {
    try { const row = JSON.parse(line); return row.component === 'notifications' && row.agent === 'ssh-container' && row.status === 'delivered' ? [row] : []; }
    catch { return []; }
  });
  await until(() => deliveries().some(row => row.count === 1), 'production worker reports successful delivery');
  docker('stop', name);
  const offlineComment = await watcher.admin.call('comment', { method: 'POST', body: {
    object_id: topic.id, original_text: `Offline protected container event ${randomUUID()}`,
  } });
  const offlineEvent = await watcher.event('comment.created', offlineComment.comment_id);
  const priorDeliveries = deliveries().length;
  docker('restart', process.env.ACCEPTANCE_RESTART_CONTAINER);
  docker('start', name);
  await until(() => deliveries().slice(priorDeliveries).some(row => row.count === 2), 'fresh container recovers both persistent unread records into actual desktop');
  // Read through both the fresh production container and the surviving host
  // client, so expired optional-auth sessions cannot silently look anonymous.
  assert.equal((await call('get_topic', { topic_id: topic.id })).topic.is_followed, true, 'production MCP watch persists through both-container restart');
  assert.equal((await watcher.call('get_topic', { topic_id: topic.id })).topic.is_followed, true, 'surviving client renews its expired session');
  const recovered = await watcher.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } });
  assert.deepEqual(recovered.events.map(row => row.notificationId).sort(), [event.notificationId, offlineEvent.notificationId].sort(), 'restart preserves exact unread identities');
  if (process.env.ACCEPTANCE_SERVE_ORIGIN) {
    const { verifyServedDiscussion } = await import('../scripts/acceptance-served-discussion.js');
    await verifyServedDiscussion(t, { topic, watcher, call, deliveries });
  }
  const after = await control.request('thread/turns/list', { threadId: target.threadId, limit: 1 });
  assert.deepEqual(after.data.map(turn => turn.id), before.data.map(turn => turn.id), 'context delivery starts no model turn');
  const unread = await watcher.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } });
  assert.ok(unread.events.some(row => row.notificationId === event.notificationId), 'delivery leaves notification unread');
  assert.ok(unread.events.some(row => row.notificationId === offlineEvent.notificationId), 'restart preserves offline unread identity');
  console.log(`Protected container desktop verification required: ${JSON.stringify({ threadId: target.threadId, events: [event, offlineEvent], bothContainersRestarted: true })}`);
});

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
  const measure = process.env.ACCEPTANCE_MEASURE_OVERHEAD === '1';
  const targets = config.agents.map(agent => agent.appServer);
  if (measure) for (const agent of config.agents) delete agent.appServer;
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
  if (measure) {
    const ticksPerSecond = Number(docker('exec', name, 'getconf', 'CLK_TCK').trim());
    assert.ok(ticksPerSecond > 0);
    const sample = () => JSON.parse(docker('exec', name, 'node', '-e', `
      const fs=require('fs');
      const status=fs.readFileSync('/proc/1/status','utf8');
      const stat=fs.readFileSync('/proc/1/stat','utf8');
      const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/);
      const cpuTicks=Number(fields[11])+Number(fields[12]);
      const rows=fs.readFileSync('/proc/1/net/dev','utf8').trim().split('\\n').slice(2);
      const network=rows.reduce((total,row)=>{const v=row.split(':')[1].trim().split(/\\s+/).map(Number); return total+v[0]+v[8]},0);
      console.log(JSON.stringify({cpuTicks,rssKiB:Number(status.match(/VmRSS:\\s+(\\d+)/)[1]),networkBytes:network}));
    `));
    const window = async () => {
      const start = sample(); const began = performance.now();
      await delay(10000);
      const end = sample();
      return { elapsedMs: Math.round(performance.now() - began), cpuMs: (end.cpuTicks - start.cpuTicks) * 1000 / ticksPerSecond, rssKiB: end.rssKiB, networkBytes: end.networkBytes - start.networkBytes };
    };
    await delay(1000);
    const baseline = await window();
    config.agents.forEach((agent, i) => { agent.appServer = targets[i]; }); save();
    await until(() => logs().filter(row => row.fixture === 'connected').length >= 4, 'both workers pass intentional initial reconnect');
    await delay(2000);
    const notifications = await window();
    console.log(`Notification idle overhead sample: ${JSON.stringify({ principals: 2, baseline, notifications, rssDeltaKiB: notifications.rssKiB - baseline.rssKiB, scope: 'PID 1 CPU/RSS; container network including protocol fixture; single idle sample, not a service-level guarantee' })}`);
  }

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
  if (measure) console.log(`Notification payload samples: ${JSON.stringify(logs().filter(row => row.fixture === 'injection').map(row => ({ events: row.events.length, bytes: row.payloadBytes })))}`);
});
