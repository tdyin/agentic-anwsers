import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AnswerClient } from './answer.js';
import { createServer } from './tools.js';

export function createApp({ answer, authToken, allowedHosts = ['localhost', '127.0.0.1'] }) {
  if (!authToken || authToken.length < 32 || authToken.startsWith('replace-')) throw new Error('MCP_AUTH_TOKEN must be a random token of at least 32 characters.');
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use('/mcp', (req, res, next) => {
    if (!allowedHosts.includes(req.hostname)) return res.status(403).json({ error: 'Host not allowed' });
    if (req.headers.origin) return res.status(403).json({ error: 'Browser origins not supported' });
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${authToken}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: 'Invalid MCP bearer token' });
    }
    next();
  });
  app.post('/mcp', express.json({ limit: '256kb' }), async (req, res) => {
    const server = createServer(answer);
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
  const { ANSWER_BASE_URL = 'http://localhost:9080', ANSWER_AGENT_EMAIL, ANSWER_AGENT_PASSWORD, MCP_AUTH_TOKEN, MCP_ALLOWED_HOSTS = 'localhost,127.0.0.1' } = process.env;
  if (!ANSWER_AGENT_EMAIL || !ANSWER_AGENT_PASSWORD || ANSWER_AGENT_PASSWORD.startsWith('replace-')) throw new Error('Configure the Answer agent account credentials.');
  const answer = new AnswerClient({ baseUrl: ANSWER_BASE_URL, email: ANSWER_AGENT_EMAIL, password: ANSWER_AGENT_PASSWORD });
  const listener = createApp({ answer, authToken: MCP_AUTH_TOKEN, allowedHosts: MCP_ALLOWED_HOSTS.split(',').map(h => h.trim()) }).listen(3000, '0.0.0.0', () => console.log('Agentic Answers MCP listening on port 3000'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => listener.close(() => process.exit(0)));
}
