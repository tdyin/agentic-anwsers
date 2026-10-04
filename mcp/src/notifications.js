import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient, DeliveryUncertainError } from './app-server.js';
import { notificationStream } from './notification-stream.js';

const kinds = new Set(['answer.created', 'comment.created', 'mention', 'topic.resolved']);
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const numericId = /^(0|[1-9][0-9]{0,18})$/;

function checkPage(page, after, through) {
  if (!page || !Array.isArray(page.events) || page.events.length > 100 ||
    !numericId.test(page.after) || !numericId.test(page.through) || typeof page.hasMore !== 'boolean' ||
    (through !== undefined && page.through !== through) ||
    BigInt(page.after) < BigInt(after) || (page.hasMore && BigInt(page.after) <= BigInt(after))) {
    throw new Error('Invalid unread recovery page.');
  }
}

// One worker owns one principal and one fixed desktop target. Seen IDs are only
// connection-reconciliation memory: Answer alone owns durable unread/read state.
export async function runNotificationAgent(entry, {
  signal = entry.revoked.signal, clientFactory = options => new AppServerClient(options),
  streamFactory = notificationStream, batchMs = 100, retryMs = 1000,
  report = () => {},
} = {}) {
  const seen = new Set();
  const uncertain = new Set();
  let recoveryPaused = false;
  const remember = events => {
    for (const event of events) seen.add(event.notificationId);
    // Bounded reconciliation memory, not an exactly-once guarantee across restarts.
    while (seen.size > 10000) seen.delete(seen.values().next().value);
  };
  let failures = 0;
  while (!signal.aborted) {
    const lifetime = new AbortController();
    const sessionSignal = AbortSignal.any([signal, lifetime.signal]);
    const client = clientFactory({ target: entry.appServer, signal: sessionSignal });
    let pump;
    try {
      await client.connect(); // Do not query the forum while the desktop is unavailable.
      const connectionSignal = AbortSignal.any([sessionSignal, client.disconnected.signal]);
      const pending = new Set();
      let wake;
      let resolveReady;
      let rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      // Install the rejection handler before the stream can fail.
      ready.catch(() => {});
      let streamError;
      pump = (async () => {
        try {
          for await (const event of streamFactory(entry.answer, { signal: connectionSignal })) {
            if (event.type === 'ready') resolveReady();
            else {
              pending.add(event.notificationId);
              if (pending.size > 1000) throw new Error('Live notification backlog overflow.');
              wake?.();
            }
          }
          throw new Error('Notification stream ended.');
        } catch (error) {
          streamError = error;
          rejectReady(error);
          lifetime.abort();
          wake?.();
        }
      })();
      await ready;
      const deliver = async events => {
        const eligible = [];
        const visible = new Map();
        for (const event of events) {
          if (!event || !kinds.has(event.kind) ||
            !['notificationId', 'recipientId', 'actorId', 'topicId', 'objectId'].every(key => typeof event[key] === 'string' && identifier.test(event[key]))) {
            throw new Error('Invalid Answer event metadata.');
          }
          if (event.recipientId !== entry.answer.userId) throw new Error('Notification principal mismatch.');
          if (seen.has(event.notificationId) || uncertain.has(event.notificationId) || event.actorId === event.recipientId) continue;
          if (!visible.has(event.topicId)) {
            try {
              await entry.answer.call('question/info', { query: { id: event.topicId }, signal: connectionSignal });
              visible.set(event.topicId, true);
            } catch (error) {
              if (![403, 404].includes(error.status)) throw error;
              visible.set(event.topicId, false);
            }
          }
          if (visible.get(event.topicId)) eligible.push({ ...event, type: event.kind });
        }
        if (!eligible.length) return;
        connectionSignal.throwIfAborted();
        try { await client.deliver(eligible); }
        catch (error) {
          if (error instanceof DeliveryUncertainError) {
            // Keep these IDs out of automatic retries within this worker. Read
            // state remains untouched; a process restart can surface them again.
            for (const event of eligible) uncertain.add(event.notificationId);
            // Do not evict uncertain IDs and accidentally replay them. Stop this
            // configuration's worker if uncertainty exhausts its bounded budget.
            if (uncertain.size > 10000) recoveryPaused = true;
            report(entry.id, 'delivery_uncertain');
          }
          throw error;
        }
        remember(eligible);
        report(entry.id, 'delivered', eligible.length);
      };
      const recover = async (initialAfter = '0', initialThrough) => {
        let after = initialAfter;
        let through = initialThrough;
        for (;;) {
          connectionSignal.throwIfAborted();
          const page = await entry.answer.call('notification/agent/page', {
            query: { after, ...(through !== undefined ? { through } : {}), limit: 100 }, signal: connectionSignal,
          });
          checkPage(page, after, through);
          await deliver(page.events);
          if (!page.hasMore) break;
          after = page.after;
          through = page.through;
        }
      };
      await recover();
      failures = 0;
      while (!connectionSignal.aborted) {
        if (!pending.size) {
          await new Promise(resolve => {
            wake = resolve;
            connectionSignal.addEventListener('abort', resolve, { once: true });
          });
          connectionSignal.removeEventListener('abort', wake);
          wake = undefined;
        }
        connectionSignal.throwIfAborted();
        await delay(batchMs, undefined, { signal: connectionSignal });
        const ids = [...pending].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
        pending.clear();
        if (ids.length) await recover(String(BigInt(ids[0]) - 1n), ids.at(-1));
      }
      throw streamError || new Error('Notification connection closed.');
    } catch {
      if (!signal.aborted) report(entry.id, 'reconnecting');
    } finally {
      lifetime.abort();
      client.close();
      await pump;
    }
    if (recoveryPaused) { report(entry.id, 'uncertain_delivery_limit'); break; }
    if (signal.aborted) break;
    try { await delay(Math.min(30000, retryMs * 2 ** Math.min(failures++, 5)), undefined, { signal }); }
    catch { break; }
  }
}

// Reloading the credential file is independent of forum delivery. It ensures
// revocation takes effect even when no new MCP tool request arrives.
export function startNotifications(registry, { intervalMs = 1000, report = () => {}, ...workerOptions } = {}) {
  const workers = new Map();
  let closed = false;
  const reconcile = () => {
    if (closed) return;
    try { registry.reload(); }
    catch { report(undefined, 'configuration_unavailable'); return; }
    for (const entry of registry.entries) {
      if (!entry.appServer || workers.has(entry)) continue;
      const controller = new AbortController();
      const signal = AbortSignal.any([entry.revoked.signal, controller.signal]);
      const task = runNotificationAgent(entry, { ...workerOptions, signal, report })
        .catch(() => report(entry.id, 'worker_failed'))
        .finally(() => { if (signal.aborted) workers.delete(entry); });
      workers.set(entry, { controller, task });
    }
  };
  reconcile();
  const timer = setInterval(reconcile, intervalMs);
  timer.unref();
  return async () => {
    closed = true;
    clearInterval(timer);
    const active = [...workers.values()];
    for (const worker of active) worker.controller.abort();
    await Promise.all(active.map(worker => worker.task));
  };
}
