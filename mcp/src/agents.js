import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AnswerClient } from './answer.js';

const digest = value => createHash('sha256').update(value).digest();

// Configuration is operator-owned, never supplied through MCP. Re-read on each
// request so atomic file replacement revokes credentials without a restart.
export class AgentRegistry {
  constructor({ file, baseUrl, internalToken, readConfig = () => JSON.parse(readFileSync(file, 'utf8')) }) {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
    this.readConfig = readConfig;
    this.entries = [];
    this.reload();
  }

  reload() {
    try {
      const config = this.readConfig();
      if (!Array.isArray(config.agents)) throw new Error();
      const ids = new Set(), tokens = new Set(), emails = new Set();
      for (const agent of config.agents) {
        if (!agent || typeof agent.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(agent.id)
          || typeof agent.token !== 'string' || agent.token.length < 32 || agent.token.startsWith('replace-')
          || typeof agent.email !== 'string' || !agent.email.includes('@')
          || typeof agent.password !== 'string' || !agent.password || agent.password.startsWith('replace-')
          || ids.has(agent.id) || tokens.has(agent.token) || emails.has(agent.email.toLowerCase())) throw new Error();
        ids.add(agent.id); tokens.add(agent.token); emails.add(agent.email.toLowerCase());
      }
      const next = config.agents.map(config => {
        const signature = digest(JSON.stringify([config.id, config.token, config.email, config.password]));
        const previous = this.entries.find(entry => timingSafeEqual(entry.signature, signature));
        if (previous) return previous;
        const revoked = new AbortController();
        return {
          id: config.id, signature, tokenHash: digest(`Bearer ${config.token}`), revoked,
          answer: new AnswerClient({ baseUrl: this.baseUrl, internalToken: this.internalToken, email: config.email, password: config.password,
            assertActive: () => { if (revoked.signal.aborted) throw new Error('Agent credential revoked.'); } }),
        };
      });
      for (const entry of this.entries) if (!next.includes(entry)) entry.revoked.abort();
      this.entries = next;
    } catch {
      for (const entry of this.entries) entry.revoked.abort();
      this.entries = [];
      throw new Error('Invalid agent credential configuration.');
    }
  }

  authenticate(authorization) {
    this.reload();
    const candidate = digest(authorization || '');
    return this.entries.find(entry => timingSafeEqual(candidate, entry.tokenHash));
  }
}
