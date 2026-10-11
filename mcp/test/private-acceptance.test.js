import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptanceWatcher } from '../scripts/acceptance-watcher.js';

test('private Answer maps trusted owner and denies public or forged ingress', {
  skip: !process.env.ACCEPTANCE_INTERNAL_TOKEN,
}, async t => {
  const base = process.env.ACCEPTANCE_ANSWER_URL;
  const owner = { 'Tailscale-User-Login': 'owner@example.com' };
  const internal = { 'X-Answer-Internal-Token': process.env.ACCEPTANCE_INTERNAL_TOKEN };
  const get = (path, headers = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' });
  assert.equal((await get('/answer/api/v1/siteinfo')).status, 403);
  assert.equal((await get('/answer/api/v1/siteinfo', { 'Tailscale-User-Login': 'other@example.com' })).status, 403);
  assert.equal((await get('/users/login', owner)).status, 303);
  assert.equal((await get('/users/register', owner)).status, 303);
  const profile = await (await get('/answer/api/v1/user/info', owner)).json();
  assert.equal(profile.code, 200);
  assert.equal(profile.data.display_name, 'Owner');
  const post = (path, headers, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const body = { title: 'Trusted owner private discussion', content: 'Created without a forum login.', tags: [{ slug_name: 'private-test' }] };
  assert.equal((await post('/answer/api/v1/question', owner, body)).status, 403, 'writes require same origin');
  const created = await (await post('/answer/api/v1/question', { ...owner, Origin: 'https://forum.example.ts.net' }, body)).json();
  assert.equal(created.code, 200);
  const topic = await (await get(`/answer/api/v1/question/info?id=${created.data.id}`, owner)).json();
  assert.equal(topic.data.user_info.id, profile.data.id);
  const expiredRead = await (await get(`/answer/api/v1/question/info?id=${created.data.id}`, {
    ...internal, Authorization: 'Bearer expired-acceptance-session',
  })).json();
  assert.equal(expiredRead.code, 401, 'internal optional-auth reads reject expired sessions instead of returning an anonymous view');
  assert.equal((await post('/answer/api/v1/user/register/email', internal, {})).status, 403);
  const replay = await post('/answer/api/v1/question', { ...internal, Authorization: `Bearer ${profile.data.access_token}` }, body);
  assert.equal((await replay.json()).code, 401, 'owner session cannot be replayed through internal ingress');
  const forged = execFileSync('docker', ['exec', process.env.ACCEPTANCE_RESTART_CONTAINER,
    'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Tailscale-User-Login: owner@example.com',
    '-H', 'X-Forwarded-For: 172.17.0.1', 'http://127.0.0.1/answer/api/v1/user/info'], { encoding: 'utf8' });
  assert.equal(forged, '403', 'direct backend socket cannot forge a trusted proxy peer');
  if (process.env.ACCEPTANCE_BROWSER === '1') {
    const { chromium } = await import('playwright');
    const recipient = await acceptanceWatcher(t, { baseUrl: base, internalToken: process.env.ACCEPTANCE_INTERNAL_TOKEN,
      ...(process.env.ACCEPTANCE_APP_SERVER_URL ? { appServer: { url: process.env.ACCEPTANCE_APP_SERVER_URL, threadId: process.env.ACCEPTANCE_APP_SERVER_THREAD } } : {}),
    });
    await recipient.call('watch_topic', { topic_id: created.data.id });

    // A test-only Serve stand-in keeps the browser's actual same-origin behavior.
    // It is not a deployment component and does not prove tailnet policy.
    let proxyOrigin;
    const proxy = createServer((req, res) => {
      const headers = { ...req.headers, ...owner };
      if (headers.origin === proxyOrigin) headers.origin = 'https://forum.example.ts.net';
      const upstream = request(new URL(req.url, base), { method: req.method, headers }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
    const browser = await chromium.launch({ executablePath: process.env.ACCEPTANCE_CHROME_PATH || undefined, headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${proxyOrigin}/questions/${created.data.id}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: body.title, exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Log in', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Sign up', exact: true }).count(), 0);
      const answerText = 'Owner answer posted through the real browser without forum login.';
      await page.getByRole('button', { name: 'Post your answer', exact: true }).click();
      await page.locator('.cm-content[contenteditable="true"]').first().click();
      await page.keyboard.insertText(answerText);
      const posted = page.waitForResponse(response => response.url().endsWith('/answer/api/v1/answer') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Post your answer', exact: true }).click();
      const response = await posted.catch(async error => {
        console.error((await page.locator('body').innerText()).slice(-6000));
        throw error;
      });
      if (response.status() !== 200) {
        const h = await response.request().allHeaders();
        console.error({ status: response.status(), origin: h.origin, fetchSite: h['sec-fetch-site'], identity: h['tailscale-user-login'] });
      }
      assert.equal(response.status(), 200, 'browser answer request');
      const answerResponse = await response.json();
      assert.equal(answerResponse.code, 200);
      assert.equal(answerResponse.data.info.user_info.id, profile.data.id);
      await page.getByText(answerText, { exact: true }).first().waitFor();
      const answerEvent = await recipient.event('answer.created', answerResponse.data.info.id);
      assert.equal(answerEvent.topicId, created.data.id, 'owner answering own question still reaches watchers');
      await page.reload({ waitUntil: 'networkidle' });
      const acceptButton = page.getByText('Accept', { exact: true });
      await acceptButton.waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
        console.error('Resolution browser state:', (await page.locator('body').innerText()).slice(-6000));
        throw error;
      });
      const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/answer/api/v1/answer/acceptance' && response.request().method() === 'POST');
      await acceptButton.click();
      assert.equal((await (await accepted).json()).code, 200, 'real browser accepts answer');
      await page.getByText('Accepted', { exact: true }).first().waitFor();
      const resolution = await recipient.event('topic.resolved', answerResponse.data.info.id);
      assert.equal(resolution.topicId, created.data.id);
      const resolved = await recipient.call('get_topic', { topic_id: created.data.id });
      assert.equal(resolved.topic.accepted_answer_id, answerResponse.data.info.id, 'resolution is native accepted-answer state');
      assert.equal(resolved.topic.is_followed, true, 'resolution does not unsubscribe');
      await recipient.call('unwatch_topic', { topic_id: created.data.id });
      const unfollowed = await recipient.call('get_topic', { topic_id: created.data.id });
      assert.equal(unfollowed.topic.is_followed, false);
      const afterUnwatch = await (await post('/answer/api/v1/comment', { ...owner, Origin: 'https://forum.example.ts.net' }, {
        object_id: created.data.id, original_text: 'Activity after explicit resolution unwatch.',
      })).json();
      assert.equal(afterUnwatch.code, 200);

      const topicsResponse = await (await get('/answer/api/v1/question/page?page=1&page_size=20&order=newest', owner)).json();
      assert.equal(topicsResponse.code, 200);
      const agentTopics = topicsResponse.data.list.filter(topic => topic.title.startsWith('Agent '));
      assert.equal(agentTopics.length, 2, 'both agent topics exist in the fresh fixture');
      const visibleAuthors = new Set();
      for (const topic of agentTopics) {
        await page.goto(`${proxyOrigin}/questions/${topic.id}`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: topic.title, exact: true }).waitFor();
        const detail = await (await get(`/answer/api/v1/question/info?id=${topic.id}`, owner)).json();
        await page.getByText(detail.data.user_info.display_name, { exact: true }).first().waitFor();
        visibleAuthors.add(detail.data.user_info.display_name.split('-')[0]);
      }
      assert.deepEqual([...visibleAuthors].sort(), ['alice', 'bob']);
      await delay(250); // Bounded test synchronization with the asynchronous native queue.
      const unread = await recipient.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } });
      assert.ok(unread.events.some(event => event.notificationId === resolution.notificationId), 'resolution remains unread for recovery');
      assert.ok(!unread.events.some(event => event.objectId === afterUnwatch.data.comment_id), 'explicit unwatch stops subsequent watch activity');

      console.log(`Browser acceptance: ${browser.version()}, owner posted without forum login (simulated Serve headers).`);
    } finally {
      await browser.close();
      await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    }
  }

});
