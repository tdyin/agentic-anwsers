import express from 'express';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AgentRegistry } from './agents.js';
import { createServer } from './tools.js';
import { startNotifications } from './notifications.js';

export function createApp({ agents, allowedHosts = ['localhost', '127.0.0.1'] }) {
  if (!agents) throw new Error('Configure an agent credential registry.');
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use('/mcp', (req, res, next) => {
    if (!allowedHosts.includes(req.hostname)) return res.status(403).json({ error: 'Host not allowed' });
    if (req.headers.origin) return res.status(403).json({ error: 'Browser origins not supported' });
    try {
      req.agent = agents.authenticate(req.headers.authorization);
    } catch {
      return res.status(503).json({ error: 'Agent authentication unavailable' });
    }
    if (!req.agent) return res.status(401).json({ error: 'Invalid MCP bearer token' });
    next();
  });
  app.post('/mcp', express.json({ limit: '256kb' }), async (req, res) => {
    const server = createServer(req.agent.answer);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP request failed' } });
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid request body' }));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ANSWER_BASE_URL = 'http://localhost:9080', MCP_AGENTS_FILE, ANSWER_INTERNAL_TOKEN_FILE, MCP_ALLOWED_HOSTS = 'localhost,127.0.0.1' } = process.env;
  if (!MCP_AGENTS_FILE) throw new Error('Set MCP_AGENTS_FILE to the operator-owned credential file.');
  const internalToken = ANSWER_INTERNAL_TOKEN_FILE ? readFileSync(ANSWER_INTERNAL_TOKEN_FILE, 'utf8').trim() : undefined;
  const agents = new AgentRegistry({ file: MCP_AGENTS_FILE, baseUrl: ANSWER_BASE_URL, internalToken });
  const stopNotifications = startNotifications(agents, { report: (agent, status, count) => console.log(JSON.stringify({ component: 'notifications', agent, status, ...(count === undefined ? {} : { count }) })) });
  const listener = createApp({ agents, allowedHosts: MCP_ALLOWED_HOSTS.split(',').map(h => h.trim()) }).listen(3000, '0.0.0.0', () => console.log('Agentic Answers MCP listening on port 3000'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    await stopNotifications();
    listener.close(() => process.exit(0));
  });
}
