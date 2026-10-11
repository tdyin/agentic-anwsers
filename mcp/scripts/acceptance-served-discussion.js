import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { notificationStream } from '../src/notification-stream.js';

// Opt-in acceptance only: a fresh browser talks to actual Tailscale Serve.
// No injected identity headers, stand-in proxy, or certificate bypass.
export async function verifyServedDiscussion(t, { topic, watcher, call, deliveries }) {
  // The preceding case restarted Answer. Open a fresh test observer; the
  // production worker owns and verifies its own independent reconnection.
  const abort = new AbortController();
  const stream = notificationStream(watcher.answer, { signal: abort.signal });
  assert.equal((await stream.next()).value.type, 'ready');
  const received = new Set();
  const pump = (async () => { for await (const row of stream) received.add(row.notificationId); })().catch(() => {});
  t.after(async () => { abort.abort(); await pump; });
  const observe = async (kind, objectId) => {
    let inspected = 0;
    for (let i = 0; i < 100; i++) {
      if (received.size !== inspected) {
        inspected = received.size;
        const page = await watcher.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } });
        const event = page.events.find(row => row.kind === kind && row.objectId === objectId && received.has(row.notificationId));
        if (event) return event;
      }
      await delay(100);
    }
    assert.fail(`live ${kind} event received after restart`);
  };
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.ACCEPTANCE_CHROME_PATH || undefined, headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${process.env.ACCEPTANCE_SERVE_ORIGIN}/questions/${topic.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Protected container desktop delivery', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Log in', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Sign up', exact: true }).count(), 0);
  const posted = page.waitForResponse(response => new URL(response.url()).pathname === '/answer/api/v1/answer' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Post your answer', exact: true }).click();
  await page.locator('.cm-content[contenteditable="true"]').first().click();
  await page.keyboard.insertText('Real Serve browser answer delivered through the production MCP container.');
  await page.getByRole('button', { name: 'Post your answer', exact: true }).click();
  const answer = await (await posted).json();
  assert.equal(answer.code, 200);
  assert.equal(answer.data.info.user_info.id, watcher.admin.userId, 'Serve maps browser to provisioned owner');
  const answerEvent = await observe('answer.created', answer.data.info.id);
  await page.reload({ waitUntil: 'networkidle' });
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/answer/api/v1/answer/acceptance' && response.request().method() === 'POST');
  await page.getByText('Accept', { exact: true }).click();
  assert.equal((await (await accepted).json()).code, 200);
  await page.getByText('Accepted', { exact: true }).first().waitFor();
  const resolution = await observe('topic.resolved', answer.data.info.id);
  for (let i = 0; i < 100 && deliveries().reduce((sum, row) => sum + row.count, 0) < 5; i++) await delay(100);
  assert.equal(deliveries().reduce((sum, row) => sum + row.count, 0), 5, 'initial, two recovered, answer and resolution records delivered');
  const resolved = await call('get_topic', { topic_id: topic.id });
  assert.equal(resolved.topic.accepted_answer_id, answer.data.info.id);
  assert.equal(resolved.topic.is_followed, true, 'resolution does not unwatch');
  await call('unwatch_topic', { topic_id: topic.id });
  assert.equal((await call('get_topic', { topic_id: topic.id })).topic.is_followed, false);
  const later = await watcher.admin.call('comment', { method: 'POST', body: { object_id: topic.id, original_text: 'After explicit unwatch.' } });
  await delay(500); // Bounded synchronization with Answer's native async fan-out.
  const unread = await watcher.answer.call('notification/agent/page', { query: { after: '0', limit: 100 } });
  assert.ok(unread.events.some(row => row.notificationId === resolution.notificationId), 'resolution stays unread');
  assert.ok(!unread.events.some(row => row.objectId === later.comment_id), 'explicit unwatch stops later watched activity');
  console.log(`Real Serve/browser/container/desktop path: ${JSON.stringify({ browser: browser.version(), answerEvent, resolution, explicitUnwatch: true })}`);
}
