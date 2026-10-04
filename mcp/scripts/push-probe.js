// Disposable native-desktop compatibility probe. Never connects to Answer.
// Start this process, configure its loopback URL in the desktop, then type emit.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema,
  UnsubscribeRequestSchema, ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const uri = 'answer-probe://discussion/1';
const sessions = new Map();
let event = { text: 'No discussion event emitted yet.' };
const log = (kind, data = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), kind, ...data }));
const app = express();
app.use(express.json());
app.all('/mcp', async (req, res) => {
  if (req.headers.origin || !['127.0.0.1', 'localhost'].includes(req.hostname)) return res.sendStatus(403);
  log('request', { method: req.method, rpc: req.body?.method, protocol: req.headers['mcp-protocol-version'], ...(req.body?.method === 'initialize' ? { initialize: req.body.params } : {}) });
  let entry = sessions.get(req.headers['mcp-session-id']);
  if (!entry && req.method === 'POST' && req.body?.method === 'initialize') {
    const server = new Server({ name: 'answer-native-push-probe', version: '0.1.0' }, {
      capabilities: { resources: { subscribe: true }, tools: {}, logging: {} },
    });
    entry = { server, subscribed: false };
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { sessions.set(id, entry); log('session', { id }); },
    });
    entry.transport = transport;
    server.oninitialized = () => log('initialized', { client: server.getClientVersion(), capabilities: server.getClientCapabilities() });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri, name: 'Synthetic discussion', mimeType: 'application/json' }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async () => { log('resource-read'); return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(event) }] }; });
    server.setRequestHandler(SubscribeRequestSchema, async () => { entry.subscribed = true; log('subscribed'); return {}; });
    server.setRequestHandler(UnsubscribeRequestSchema, async () => { entry.subscribed = false; log('unsubscribed'); return {}; });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'probe_status', description: 'Confirm connection to the disposable Answer notification compatibility probe. Does not read discussion events.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => { log('status-tool'); return { content: [{ type: 'text', text: 'Connected to synthetic notification probe. Await an operator-emitted event.' }] }; });
    await server.connect(transport);
    transport.onclose = () => { sessions.delete(transport.sessionId); log('closed'); };
  }
  if (!entry) return res.sendStatus(404);
  try { await entry.transport.handleRequest(req, res, req.body); }
  catch (error) { log('error', { message: error.message }); if (!res.headersSent) res.sendStatus(500); }
});
const listener = app.listen(Number(process.env.PROBE_PORT || 19473), '127.0.0.1', () => log('listening', { url: `http://127.0.0.1:${listener.address().port}/mcp` }));
createInterface({ input: process.stdin }).on('line', async line => {
  if (line.trim() !== 'emit') return;
  event = { type: 'discussion.answer.created', marker: randomUUID(), topic: 'Synthetic compatibility discussion', text: 'A synthetic human reply is available.' };
  log('emit', { event });
  for (const { server, subscribed } of sessions.values()) {
    try {
      await server.sendLoggingMessage({ level: 'notice', logger: 'answer-push-probe', data: event });
      if (subscribed) await server.sendResourceUpdated({ uri });
      log('sent', { subscribed, evidence: 'Server send only; desktop context must be checked separately.' });
    } catch (error) { log('send-error', { message: error.message }); }
  }
});
