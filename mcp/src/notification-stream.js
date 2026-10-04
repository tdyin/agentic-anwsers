import { AnswerError } from './answer.js';

// A streaming connection, not a polling loop. Heartbeats carry no forum content.
export async function* notificationStream(answer, { signal, idleMs = 45000 } = {}) {
  const lifetime = new AbortController();
  const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => lifetime.abort(), idleMs);
    timer.unref?.();
  };
  let reader;
  try {
    if (!answer.token) await answer.login();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      answer.assertActive();
      arm();
      response = await answer.fetch(new URL('/answer/api/v1/notification/agent/events', answer.baseUrl), {
        signal: combined, redirect: 'error',
        headers: { Accept: 'text/event-stream', 'Accept-Encoding': 'identity',
          Authorization: `Bearer ${answer.token}`,
          ...(answer.internalToken ? { 'X-Answer-Internal-Token': answer.internalToken } : {}) },
      });
      if (response.status !== 401 || attempt !== 0) break;
      await response.body?.cancel();
      await answer.login();
    }
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await response.body?.cancel();
      throw new AnswerError(response.status, 'notification_stream_rejected');
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ready = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Answer notification stream disconnected.');
      answer.assertActive();
      arm();
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      if (buffer.length > 65536) throw new Error('Answer notification frame too large.');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let type;
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!type) continue;
        if (type === 'ready' && !ready) { ready = true; yield { type }; }
        else if (type === 'notification' && ready) {
          const payload = JSON.parse(data.join('\n'));
          if (!/^[1-9][0-9]{0,18}$/.test(payload.notificationId || '')) throw new Error('Invalid notification ID.');
          yield { type, notificationId: payload.notificationId };
        } else throw new Error('Unexpected notification stream event.');
      }
    }
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    await reader?.cancel().catch(() => {});
  }
}
