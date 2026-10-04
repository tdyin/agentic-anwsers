import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createSocket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AnswerClient } from '../src/answer.js';
import { AgentRegistry } from '../src/agents.js';
import { createApp } from '../src/index.js';
import { startNotifications } from '../src/notifications.js';
import { AppServerClient } from '../src/app-server.js';

// Run only against a disposable Answer instance: this provisions users and content.
test('real Answer attributes MCP topic, answer and comment writes to distinct ordinary users', {
  skip: !process.env.ACCEPTANCE_ANSWER_URL,
}, async t => {
  const baseUrl = process.env.ACCEPTANCE_ANSWER_URL;
  const internalToken = process.env.ACCEPTANCE_INTERNAL_TOKEN;
  const internalHeaders = internalToken ? { 'X-Answer-Internal-Token': internalToken } : {};
  const admin = new AnswerClient({ baseUrl, internalToken, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  await admin.login();
  const suffix = randomBytes(4).toString('hex');
  const config = { agents: ['alice', 'bob'].map(id => ({ id, email: `${id}-${suffix}@example.com`, password: randomBytes(12).toString('hex'), token: randomBytes(32).toString('hex') })) };
  const identities = [];
  const usernames = [];
  for (const agent of config.agents) {
    const response = await fetch(new URL('/answer/admin/api/user', baseUrl), {
      method: 'POST', headers: { ...internalHeaders, Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: `${agent.id}-${suffix}`, email: agent.email, password: agent.password }),
    });
    assert.equal((await response.json()).code, 200, 'admin user provisioning');
    const principal = new AnswerClient({ baseUrl, internalToken, email: agent.email, password: agent.password });
    const info = await principal.request('user/login/email', { method: 'POST', body: { e_mail: agent.email, pass: agent.password } });
    assert.equal(info.role_id, 1, 'agent must not be administrator');
    identities.push(info.id);
    usernames.push(info.username);
  }
  assert.notEqual(identities[0], identities[1]);
  await admin.call('question', { method: 'POST', body: { title: `Acceptance seed ${suffix}`, content: 'Seed question for agent acceptance testing.', tags: [{ slug_name: 'discussion' }] } });
  let agents = new AgentRegistry({ baseUrl, internalToken, readConfig: () => config });
  const containerMode = Boolean(process.env.ACCEPTANCE_MCP_IMAGE);
  let mcpUrl;
  let mcpContainer;
  const saveConfig = () => {
    if (!containerMode) return;
    const file = join(process.env.ACCEPTANCE_WORK_DIR, 'agents.json');
    writeFileSync(`${file}.next`, JSON.stringify(config), { mode: 0o600 });
    renameSync(`${file}.next`, file);
  };
  if (containerMode) {
    saveConfig();
    const socket = createSocket();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    mcpContainer = `${process.env.ACCEPTANCE_RESTART_CONTAINER}-mcp`;
    // Match host ownership of the private fixture files, retaining non-root execution.
    const privateArgs = internalToken ? ['-e', 'ANSWER_INTERNAL_TOKEN_FILE=/run/acceptance/internal-token'] : [];
    execFileSync('docker', ['run', '-d', '--name', mcpContainer, '--network', process.env.ACCEPTANCE_NETWORK,
      '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop=ALL',
      '-p', `127.0.0.1:${port}:3000`, '-v', `${process.env.ACCEPTANCE_WORK_DIR}:/run/acceptance:ro`,
      '-e', 'ANSWER_BASE_URL=http://answer', '-e', 'MCP_AGENTS_FILE=/run/acceptance/agents.json',
      ...privateArgs, process.env.ACCEPTANCE_MCP_IMAGE], { stdio: 'pipe' });
    t.after(() => execFileSync('docker', ['rm', '-f', '-v', mcpContainer], { stdio: 'pipe' }));
    mcpUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { ready = (await fetch(`${mcpUrl}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, 'MCP container ready');
  } else {
    const app = createApp({ agents: { authenticate: header => agents.authenticate(header) } });
    const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    t.after(() => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }));
    mcpUrl = `http://127.0.0.1:${listener.address().port}`;
  }
  const clients = [];
  for (const agent of config.agents) {
    const client = new Client({ name: agent.id, version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agent.token}` } } }));
    clients.push(client);
    t.after(() => client.close());
  }
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const topicIds = [];
  for (const [index, initialClient] of clients.entries()) {
    let client = initialClient;
    const topic = await call(client, 'create_topic', { title: `Agent ${index} discussion ${suffix}`, content: 'A real independently attributed discussion.', tags: ['discussion'] });
    assert.equal(topic.watch.established, true);
    const topicId = topic.id;
    topicIds.push(topicId);
    assert.ok(topicId, 'question creation returns its ID');
    const read = await call(client, 'get_topic', { topic_id: topicId });
    assert.equal(read.topic.is_followed, true);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await call(client, 'unwatch_topic', { topic_id: topicId })).is_followed, false);
    }
    assert.equal((await call(client, 'get_topic', { topic_id: topicId })).topic.is_followed, false);
    await client.close();
    client = new Client({ name: `${config.agents[index].id}-reconnected`, version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.agents[index].token}` } },
    }));
    clients[index] = client;
    t.after(() => client.close());
    assert.equal((await call(client, 'get_topic', { topic_id: topicId })).topic.is_followed, false,
      'new MCP client initialization does not recreate an explicit unwatch');

    if (index === 0 && process.env.ACCEPTANCE_RESTART_CONTAINER) {
      execFileSync('docker', ['restart', process.env.ACCEPTANCE_RESTART_CONTAINER, ...(mcpContainer ? [mcpContainer] : [])], { stdio: 'ignore' });
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          ready = (await fetch(new URL('/healthz', baseUrl), { signal: AbortSignal.timeout(1000) })).ok;
          if (mcpContainer) ready = ready && (await fetch(`${mcpUrl}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch { ready = false; }
        if (ready) break;
        await delay(500);
      }
      assert.ok(ready, 'Answer recovered after restart');
      agents = new AgentRegistry({ baseUrl, internalToken, readConfig: () => config });
      assert.equal((await call(client, 'get_topic', { topic_id: topicId })).topic.is_followed, false,
        'explicit unwatch survives Answer restart and a fresh adapter registry/session');
    }

    assert.equal((await call(clients[1 - index], 'get_topic', { topic_id: topicId })).topic.is_followed, false);
    assert.equal(read.topic.user_info.id, identities[index]);
    const answer = await call(client, 'create_reply', { topic_id: topicId, content: 'An independently attributed real reply.' });
    assert.equal(answer.watch.established, true);
    assert.equal((await call(client, 'get_topic', { topic_id: topicId })).topic.is_followed, true);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await call(client, 'watch_topic', { topic_id: topicId })).is_followed, true);
    }
    const replies = await call(client, 'list_replies', { topic_id: topicId });
    assert.equal(replies.list.find(item => item.id === answer.info.id).user_info.id, identities[index]);
    await call(client, 'add_comment', { object_id: topicId, content: 'An independently attributed real comment.' });
    const comments = await call(client, 'list_comments', { object_id: topicId });
    assert.ok(comments.list.some(item => item.user_id === identities[index]));
  }
  if (process.env.ACCEPTANCE_RESTART_CONTAINER) {
    // Keep MCP sessions cached while Answer loses its in-memory sessions.
    execFileSync('docker', ['restart', process.env.ACCEPTANCE_RESTART_CONTAINER], { stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { ready = (await fetch(new URL('/healthz', baseUrl), { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, 'Answer recovered for concurrent renewal');
    await Promise.all(clients.map((client, index) => call(client, 'add_comment', {
      object_id: topicIds[index], content: `Concurrent renewed session for agent ${index}.`,
    })));
    for (const [index, client] of clients.entries()) {
      const comments = await call(client, 'list_comments', { object_id: topicIds[index] });
      const renewal = comments.list.find(comment => comment.original_text === `Concurrent renewed session for agent ${index}.`);
      assert.equal(renewal?.user_id, identities[index], 'renewed writes preserve attribution');
    }
  }
  const desktopDeliveries = [];
  if (process.env.ACCEPTANCE_APP_SERVER_URL) {
    assert.ok(!containerMode, 'desktop socket fixture runs inside the host MCP service');
    config.agents[0].appServer = { url: process.env.ACCEPTANCE_APP_SERVER_URL, threadId: process.env.ACCEPTANCE_APP_SERVER_THREAD };
    if (process.env.ACCEPTANCE_APP_SERVER_THREAD_B) config.agents[1].appServer = { url: process.env.ACCEPTANCE_APP_SERVER_URL, threadId: process.env.ACCEPTANCE_APP_SERVER_THREAD_B };
    const stop = startNotifications(agents, { clientFactory: options => {
      const client = new AppServerClient(options);
      const deliver = client.deliver.bind(client);
      client.deliver = async events => { await deliver(events); desktopDeliveries.push(...events); };
      return client;
    } });
    t.after(stop);
  }
  // Verify native Answer follow-up eligibility independently of any MCP push transport.
  const watchedReply = await call(clients[0], 'create_reply', { topic_id: topicIds[1], content: 'Agent joins this topic and automatically follows the discussion.' });
  assert.equal(watchedReply.watch.established, true);
  const watcher = new AnswerClient({ baseUrl, internalToken, email: config.agents[0].email, password: config.agents[0].password });
  let streamReader;
  let streamText = '';
  const streamDecoder = new TextDecoder();
  const readStreamUntil = async predicate => {
    while (!predicate(streamText)) {
      const chunk = await streamReader.read();
      assert.equal(chunk.done, false, 'notification stream stays connected');
      streamText += streamDecoder.decode(chunk.value, { stream: true });
    }
  };
  if (internalToken) {
    await watcher.login();
    const streamAbort = new AbortController();
    t.after(() => streamAbort.abort());
    const response = await fetch(new URL('/answer/api/v1/notification/agent/events', baseUrl), {
      headers: { ...internalHeaders, Authorization: `Bearer ${watcher.token}` },
      signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(120000)]),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    streamReader = response.body.getReader();
    await readStreamUntil(text => text.includes('event: ready'));
  }
  const humanAnswer = await admin.call('answer', { method: 'POST', body: {
    question_id: topicIds[1], content: 'Human follow-up for an independently subscribed watcher.',
  } });
  let followedEvent;
  // Bounded test synchronization with Answer's asynchronous queue, not a delivery implementation.
  for (let attempt = 0; attempt < 20; attempt++) {
    const inbox = await watcher.call('notification/page', { query: { type: 'inbox', page: 1, page_size: 50 } });
    followedEvent = inbox.list.find(item => item.object_info?.object_map?.answer === humanAnswer.info.id);
    if (followedEvent) break;
    await delay(250);
  }
  assert.ok(followedEvent, 'non-author watcher receives native Answer follow-up notification');
  if (streamReader) {
    await readStreamUntil(text => text.includes(`"notificationId":"${followedEvent.id}"`));
    let after = '0';
    let through;
    const events = [];
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await watcher.call('notification/agent/page', { query: { after, ...(through ? { through } : {}), limit: 2 } });
      if (through) assert.equal(page.through, through, 'snapshot boundary stays fixed');
      through = page.through;
      events.push(...page.events);
      if (!page.hasMore) break;
      assert.notEqual(page.after, after, 'cursor advances');
      after = page.after;
      assert.ok(pageIndex < 99, 'bounded catch-up completes');
    }
    const event = events.find(event => event.notificationId === followedEvent.id);
    assert.ok(event, 'live event is also recoverable from unread snapshot');
    assert.equal(event.recipientId, identities[0]);
    assert.equal(event.kind, 'answer.created');
    const eventTopic = await watcher.call('question/info', { query: { id: event.topicId } });
    assert.equal(eventTopic.id, topicIds[1], 'canonical event topic resolves through permissioned API');
    assert.ok(events.every(event => event.recipientId === identities[0]), 'feed contains only authenticated recipient');
    assert.equal(new Set(events.map(event => event.notificationId)).size, events.length, 'cursor does not duplicate IDs');
    const repeated = await watcher.call('notification/agent/page', { query: { after: '0', limit: 100 } });
    assert.ok(repeated.events.some(event => event.notificationId === followedEvent.id), 'delivery did not acknowledge event');
  }

  if (process.env.ACCEPTANCE_APP_SERVER_URL) {
    for (let attempt = 0; attempt < 100 && !desktopDeliveries.some(event => event.notificationId === followedEvent.id); attempt++) await delay(100);
    assert.ok(desktopDeliveries.some(event => event.notificationId === followedEvent.id), 'real Answer event accepted by designated App Server thread');
    console.log(`Desktop context verification required: ${JSON.stringify({ notificationId: followedEvent.id, recipientId: identities[0], topicId: topicIds[1], objectId: humanAnswer.info.id })}`);
  }
  // An explicit acknowledgement is scoped to the caller, never to supplied attribution.
  await call(clients[1], 'acknowledge_notification', { notification_id: followedEvent.id });
  const beforeOwnAck = await watcher.call('notification/page', { query: { type: 'inbox', page: 1, page_size: 50 } });
  assert.equal(beforeOwnAck.list.find(item => item.id === followedEvent.id)?.is_read, false, 'another agent cannot consume this notification');
  await call(clients[0], 'get_topic', { topic_id: topicIds[1] });
  const readOnlyInbox = await watcher.call('notification/page', { query: { type: 'inbox', page: 1, page_size: 50 } });
  assert.equal(readOnlyInbox.list.find(item => item.id === followedEvent.id)?.is_read, false, 'read tools alone do not acknowledge');
  await call(clients[0], 'acknowledge_notification', { notification_id: followedEvent.id });
  await call(clients[0], 'acknowledge_notification', { notification_id: followedEvent.id });
  const afterOwnAck = await watcher.call('notification/page', { query: { type: 'inbox', page: 1, page_size: 50 } });
  assert.equal(afterOwnAck.list.find(item => item.id === followedEvent.id)?.is_read, true, 'explicit consumption is idempotent in Answer');
  if (internalToken) {
    const unread = await watcher.call('notification/agent/page', { query: { after: '0', limit: 100 } });
    assert.ok(!unread.events.some(event => event.notificationId === followedEvent.id), 'acknowledged events leave unread recovery');
  }
  if (internalToken) {
    const commentEvent = async (comment, kind) => {
      let matched;
      for (let attempt = 0; attempt < 40; attempt++) {
        const page = await watcher.call('notification/agent/page', { query: { after: '0', limit: 100 } });
        matched = page.events.filter(event => event.objectId === comment.comment_id);
        if (matched.length) break;
        await delay(100);
      }
      assert.equal(matched?.length, 1, 'one persisted notification per recipient/activity');
      assert.equal(matched[0].kind, kind);
      await readStreamUntil(text => text.includes(`"notificationId":"${matched[0].notificationId}"`));
      if (process.env.ACCEPTANCE_APP_SERVER_URL) {
        for (let attempt = 0; attempt < 100 && !desktopDeliveries.some(event => event.notificationId === matched[0].notificationId); attempt++) await delay(100);
        assert.ok(desktopDeliveries.some(event => event.notificationId === matched[0].notificationId), 'comment/mention reached App Server');
        console.log(`Desktop comment context verification required: ${JSON.stringify(matched[0])}`);
      }
      return matched[0];
    };
    const humanComment = (object_id, content, mention_username_list = [], reply_comment_id) => admin.call('comment', {
      method: 'POST', body: { object_id, original_text: content, mention_username_list, ...(reply_comment_id ? { reply_comment_id } : {}) },
    });
    const questionComment = await humanComment(topicIds[1], 'Human comment on watched question.');
    await commentEvent(questionComment, 'comment.created');
    const answerComment = await humanComment(humanAnswer.info.id, 'Author comments on their own answer; other topic watchers still receive it.');
    await commentEvent(answerComment, 'comment.created');
    assert.ok(usernames[0], 'provisioned identity has a native mention username');
    const overlap = await humanComment(topicIds[1], `Mention @${usernames[0]} while watched.`, [usernames[0], usernames[0]]);
    await commentEvent(overlap, 'mention');
    await call(clients[0], 'unwatch_topic', { topic_id: topicIds[1] });
    const unwatched = await humanComment(topicIds[1], 'This watch-only comment must not reach the unsubscribed agent.');
    const bobComment = await call(clients[1], 'add_comment', { object_id: topicIds[1], content: 'Reply here while mentioning a different recipient.' });
    const mentioned = await humanComment(topicIds[1], `Explicit @${usernames[0]} without a watch while replying to Bob.`, [usernames[0]], bobComment.comment_id);
    await commentEvent(mentioned, 'mention');
    assert.equal((await call(clients[0], 'get_topic', { topic_id: topicIds[1] })).topic.is_followed, false, 'mention does not silently rewatch');
    await call(clients[0], 'watch_topic', { topic_id: topicIds[1] });
    const self = await call(clients[0], 'add_comment', { object_id: topicIds[1], content: 'My own activity must not notify me.' });
    const barrier = await humanComment(topicIds[1], 'Human comment after self-event to confirm the live path remains usable.');
    await commentEvent(barrier, 'comment.created');
    const native = await watcher.call('notification/page', { query: { type: 'inbox', page: 1, page_size: 50 } });
    assert.equal(native.list.filter(item => item.object_info?.object_map?.comment === overlap.comment_id).length, 1, 'watch/mention overlap creates only one native inbox item');
    assert.ok(!native.list.some(item => [unwatched.comment_id, self.comment_id].includes(item.object_info?.object_map?.comment)), 'unwatch and self suppression apply to persisted notification state');
    const readComments = await call(clients[0], 'list_comments', { object_id: humanAnswer.info.id });
    assert.ok(readComments.list.some(comment => comment.comment_id === answerComment.comment_id), 'changed comment can be retrieved through existing tools');
    const badgeBefore = await watcher.call('notification/status');
    assert.ok(badgeBefore.inbox > 0, 'other unread notifications remain');
    await call(clients[0], 'acknowledge_notification', { notification_id: followedEvent.id });
    const badgeAfter = await watcher.call('notification/status');
    assert.equal(badgeAfter.inbox, badgeBefore.inbox, 'repeated acknowledgement cannot consume another unread badge');

  }
  // Suspension must be enforced by Answer even with a cached adapter session.
  await admin.login();
  const suspended = await fetch(new URL('/answer/admin/api/user/status', baseUrl), {
    method: 'PUT', headers: { ...internalHeaders, Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: identities[0], status: 'suspended', suspend_duration: 'forever' }),
  });
  assert.equal((await suspended.json()).code, 200);
  if (streamReader) {
    // The heartbeat checks current account status without querying forum content.
    let done = false;
    while (!done) ({ done } = await streamReader.read());
    await assert.rejects(watcher.call('notification/agent/page'), 'suspended principal cannot recover notifications');
  }

  const denied = await clients[0].callTool({ name: 'create_reply', arguments: { topic_id: topicIds[1], content: 'Suspended account must not publish this.' } });
  assert.ok(denied.isError, 'Answer account suspension applies to cached MCP sessions');
  const deniedWatch = await clients[0].callTool({ name: 'watch_topic', arguments: { topic_id: topicIds[1] } });
  assert.ok(deniedWatch.isError, 'suspended users cannot establish follows');
  await call(clients[1], 'add_comment', { object_id: topicIds[1], content: 'Other agent continues after suspension.' });
  config.agents.splice(0, 1);
  saveConfig();
  if (mcpContainer) {
    // Desktop VM bind mounts can briefly return ENOENT after host rename.
    // Wait for publication in the container before testing the new snapshot.
    let published = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const ids = execFileSync('docker', ['exec', mcpContainer, 'node', '-e',
          "const fs=require('fs'); console.log(JSON.stringify(JSON.parse(fs.readFileSync('/run/acceptance/agents.json','utf8')).agents.map(a=>a.id)))"],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        published = ids.trim() === JSON.stringify(config.agents.map(agent => agent.id));
      } catch {}
      if (published) break;
      await delay(250);
    }
    assert.ok(published, 'replacement credential file visible inside MCP container');
  }
  await assert.rejects(clients[0].listTools(), /Invalid MCP bearer token/);
  await clients[1].listTools();
});
