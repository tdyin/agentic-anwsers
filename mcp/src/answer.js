export class AnswerError extends Error {
  constructor(status, reason) {
    super(`Answer request failed (${status}; ${String(reason || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100)}). Check account permissions, verification, or CAPTCHA settings.`);
    this.status = status;
  }
}

export class AnswerClient {
  constructor({ baseUrl, email, password, fetchImpl = fetch, assertActive = () => {}, internalToken }) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    this.fetch = fetchImpl;
    this.assertActive = assertActive;
    this.internalToken = internalToken;
  }

  async request(path, { method = 'GET', query = {}, body, token, signal } = {}) {
    this.assertActive();
    const url = new URL(`/answer/api/v1/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetch(url, {
        method, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
        headers: { Accept: 'application/json', ...(this.internalToken ? { 'X-Answer-Internal-Token': this.internalToken } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AnswerError(503, 'unreachable_or_timeout');
    }
    let payload;
    try { payload = await response.json(); } catch { throw new AnswerError(response.status, 'invalid_response'); }
    if (!response.ok || payload.code !== 200) throw new AnswerError(payload.code || response.status, payload.reason);
    return payload.data;
  }

  async login() {
    if (!this.loginPromise) {
      this.loginPromise = this.request('user/login/email', {
        method: 'POST', body: { e_mail: this.email, pass: this.password },
      }).then(data => {
        if (!data?.access_token) throw new AnswerError(401, 'missing_access_token');
        this.token = data.access_token;
        this.userId = data.id;
      }).finally(() => { this.loginPromise = undefined; });
    }
    await this.loginPromise;
  }

  async call(path, options = {}) {
    if (!this.token) await this.login();
    const usedToken = this.token;
    try { return await this.request(path, { ...options, token: usedToken }); }
    catch (error) {
      // Only a rejected authentication attempt is safe to retry automatically.
      if (error.status !== 401) throw error;
      if (this.token === usedToken) this.token = undefined;
      if (!this.token) await this.login();
      return this.request(path, { ...options, token: this.token });
    }
  }
}
