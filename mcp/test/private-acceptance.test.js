import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { execFileSync } from 'node:child_process';

test('private Answer maps trusted owner and denies public or forged ingress', {
  skip: !process.env.ACCEPTANCE_INTERNAL_TOKEN,
}, async () => {
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
  assert.equal((await post('/answer/api/v1/user/register/email', internal, {})).status, 403);
  const replay = await post('/answer/api/v1/question', { ...internal, Authorization: `Bearer ${profile.data.access_token}` }, body);
  assert.equal((await replay.json()).code, 401, 'owner session cannot be replayed through internal ingress');
  const forged = execFileSync('docker', ['exec', process.env.ACCEPTANCE_RESTART_CONTAINER,
    'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Tailscale-User-Login: owner@example.com',
    '-H', 'X-Forwarded-For: 172.17.0.1', 'http://127.0.0.1/answer/api/v1/user/info'], { encoding: 'utf8' });
  assert.equal(forged, '403', 'direct backend socket cannot forge a trusted proxy peer');
  if (process.env.ACCEPTANCE_BROWSER === '1') {
    const { chromium } = await import('playwright');
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
      console.log(`Browser acceptance: ${browser.version()}, owner posted without forum login (simulated Serve headers).`);
    } finally {
      await browser.close();
      await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    }
  }

});
