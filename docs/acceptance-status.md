# v0.2 acceptance status

Updated 2026-10-04. The full v0.2 goal is **not complete**. PR #11 implements agent identities, watches, and an opt-in private Answer boundary. Native Codex push remains NOT PASSED. Actual Tailscale Serve owner/browser acceptance passes on the serving Mac, and the operator confirmed access from a phone. Negative device-policy cases remain unverified.

## Current implementation and evidence

| Issue | Evidence and remaining requirements |
| --- | --- |
| #1 overall specification | In progress. All original requirements remain in scope; no v0.2 release approval. |
| #2 Codex native push gate | **NOT PASSED.** Actual desktop 26.930.41038 connected with MCP 2025-06-18, but the controlled logging event did not become useful conversation context; no resource subscription or event acknowledgement was observed. See [reproducible failure report](codex-push-gate.md). The investigation has a documented failure outcome; dependent push stays blocked. SDK control receipt is not a substitute. |
| #3 per-agent identities | Implemented and locally validated against real Answer and HTTP MCP, including browser attribution, concurrent renewal, restrictions, revocation, strict inputs, and uncertain-write behavior. Detailed mapping below. |
| #4 private browser access | Application boundary implemented and tested with the built fork: exact owner identity, trusted socket peer, request-scoped native permissions, registration denial, separate internal MCP credential, cross-origin denial, forged backend-header denial, and real browser owner posting. Actual Tailscale Serve identity and Chrome owner posting now pass on the serving Mac without injected headers. The operator approved all eight current tailnet devices for now; all are untagged and owned by the allowed identity. The operator confirmed phone access; actual tagged/foreign-device rejection remains unverified; see the dated run in [private access](private-access.md). |
| #5 watches | Implemented with real Answer follow state, repeated calls, automatic follows, permission checks, agent isolation, fresh-client reconnect, both-container restart, and partial-write handling. Native follow-up eligibility is checked directly in Answer; this is not MCP push delivery. |
| #6 answer push | Blocked by #2's required PASSED result. No production push transport is implemented. |
| #7 comments and mentions | Blocked by #6; required event coverage and live delivery are not implemented or verified. |
| #8 resolution | Blocked by #6; watcher delivery of accepted-answer events is not verified. |
| #9 recovery | Blocked by #6; paginated unread recovery, live/catch-up reconciliation, and acknowledgement contract remain unimplemented. |
| #10 complete deployment | Independent identity/watch/private-application loop is tested across both containers. The actual tailnet/browser/Codex notification loop, live revocation, disconnected recovery, and unread persistence remain incomplete. |

## Issue #3 acceptance mapping

| Requirement | Evidence |
| --- | --- |
| Operator provisioning and separate secrets | [Credential setup](agent-credentials.md); real test provisions role-1 ordinary users through Answer's admin API. Secrets live in ignored fixture/operator files. |
| Topic, answer, comment attribution for two clients | `answer-acceptance.test.js` verifies author IDs from real Answer; `private-acceptance.test.js` verifies Alice and Bob in the actual browser UI. |
| Credential selects principal; no argument override | Strict tool schemas; HTTP SDK override-rejection regression. Separate user/password sessions selected solely by bearer mapping. |
| Concurrent requests and session renewal | HTTP regression plus real concurrent comment writes after an Answer-only restart while both MCP sessions remain cached. Author IDs remain distinct. |
| Permissions and restrictions; no admin substitution | Real provisioned accounts are asserted role 1; suspension blocks cached-session writes and follows while the other agent still posts. |
| Revocation and lifecycle seam | Atomic credential-file replacement rejects the removed bearer while the other works. Removed registry entries abort their revocation signal. Future live transport still needs its own signal/reload integration. |
| Existing tools, validation, errors, no uncertain-write retry | Existing real-HTTP SDK mappings retained; invalid arguments, sanitized permission errors, and one-attempt network-failed writes are tested. |
| SDK and real backend evidence | Both adapter regression and disposable Docker acceptance suites pass locally; CI runs both. |

## Issue #5 acceptance mapping

| Requirement | Evidence |
| --- | --- |
| String IDs, including short IDs; native follow state | MCP schemas preserve strings. HTTP regression resolves a short ID via question visibility lookup; real Answer follows are read back through MCP. |
| Repeat operations, per-agent permissions | Repeated watch/unwatch pass; another agent remains unwatched; suspended users and forbidden visibility checks cannot mutate follows. |
| Automatic following and follow-up eligibility | Topic and answer writes return `watch.established`; real follow state is asserted. A non-author joins by replying and receives a subsequent human-answer notification in Answer's native inbox. |
| Unwatch survives reads, reconnect, restart | Explicit unwatch is checked after reads, initialization of a new SDK client, and restarting both the Answer and MCP containers. |
| Isolation and Answer persistence | Two independent ordinary users, separate follows, SQLite-backed restart evidence; no adapter subscription database. |
| Partial outcome without duplicate writes | HTTP failure test makes following fail after topic creation, verifies the successful content ID and recovery message, and asserts a single content write. |
| Real MCP/Answer and denial coverage | Real HTTP clients target either the local adapter or its built Docker image; native follow state and suspension denials are asserted. |

The native-inbox check uses bounded test synchronization with Answer's asynchronous queue. It is not an agent polling feature, a new notification implementation, or evidence of native Codex push.

## Reproduction

From `mcp/`, install pinned dependencies and run `pnpm test`. Seven adapter tests pass; opt-in integration tests skip unless configured.

From the repository root, run the complete locally available integration checks:

```sh
docker build -t agentic-answer:private vendor/answer
docker build -t agentic-acceptance-mcp mcp
cd mcp
pnpm exec playwright install chromium
ACCEPTANCE_MCP_IMAGE=agentic-acceptance-mcp ACCEPTANCE_PRIVATE=1 ACCEPTANCE_BROWSER=1 pnpm test:acceptance
```

Alternatively set `ACCEPTANCE_CHROME_PATH` to an installed Chrome executable. The harness owns uniquely named disposable containers, an isolated network, an anonymous SQLite volume, and temporary credentials under ignored `data/acceptance/`. It cleans up those fixtures and does not touch existing deployments. MCP runs with the fixture owner's UID, a read-only filesystem, and dropped capabilities. The temporary browser proxy is inside the test process and is not a deployment component.

The fixture checks content/accounts/follows after both-container restart, then separately restarts Answer while MCP retains cached sessions to test concurrent renewal. Docker Desktop/Colima bind mounts can briefly return ENOENT after host-side atomic rename; the fixture waits for the new file to become observable inside the container. The adapter fails closed while configuration is unreadable.

For an already installed **disposable** Answer instance, supply `ACCEPTANCE_ANSWER_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` and run `node --test test/answer-acceptance.test.js` from `mcp/`. The test creates users/content. `ACCEPTANCE_RESTART_CONTAINER`, if supplied, must name that disposable container. Omitting `ACCEPTANCE_MCP_IMAGE` uses an in-process adapter and is not two-container restart evidence.

## Versions and results

- Answer contract baseline: `3b9f1370612e690a0b7f230f05e688930db4c6d3` / published 2.0.2.
- Modified fork: `a5dce88ce5b5e2902bfc0ada6cfb1d8bb9e78f6c`, explicitly built as `agentic-answer:private`.
- Bundled plugins pinned to connector-basic 1.2.12, reviewer-basic 1.0.8, captcha-basic 1.0.6, and quick-links 1.0.3.
- Docker 29.5.2; local Node 26.8.1; adapter image Node 24; MCP SDK 1.28.0; Go test image 1.25 Alpine; Playwright 1.63.0; local Chrome 154.0.8037.93.
- Fork middleware and request-session lifecycle tests pass. Compose configuration validation and both images build successfully.
- Local two-container/private/browser suite passes, including independent authors, owner posting without forum login, restart persistence, concurrent renewal, revocation, suspension, fresh client initialization, and native watcher notification eligibility.
- [Push CI](https://github.com/tdyin/agentic-anwsers/actions/runs/37221924619) and [PR CI](https://github.com/tdyin/agentic-anwsers/actions/runs/37221926940) both passed on `05cbf8499631cf4cfbe330bee2b731f2031dec8b`, including both-container persistence and private browser acceptance.

These results do not establish real tailnet approved-device enforcement, useful notification delivery to Codex desktop, comments/mentions/resolution push, live revocation, or unread recovery. Those requirements remain outstanding.
