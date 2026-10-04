# v0.2 acceptance status

Updated 2026-10-04. The full v0.2 goal is **not complete**. PR #11 implements agent identities, watches, and an opt-in private Answer boundary. The historical native MCP test remains NOT PASSED; the owner-approved direct App Server replacement gate PASSED with a configured shared daemon and actual desktop context verification. Actual Tailscale Serve owner/browser acceptance passes on the serving Mac, and the operator confirmed access from a phone. Negative device-policy cases remain unverified.

## Current implementation and evidence

| Issue | Evidence and remaining requirements |
| --- | --- |
| #1 overall specification | In progress. All original requirements remain in scope; no v0.2 release approval. |
| #2 App Server context-delivery gate | **PASSED for the configured shared-server desktop path.** The actual desktop recalled a freshly injected marker and a 20-event batch without tools; context-only insertion started no model turn. [Configuration, evidence, overhead, and limits](codex-app-server-gate.md). Production per-agent routing and recovery remain downstream work. |
| #3 per-agent identities | Implemented and locally validated against real Answer and HTTP MCP, including browser attribution, concurrent renewal, restrictions, revocation, strict inputs, and uncertain-write behavior. Detailed mapping below. |
| #4 private browser access | Application boundary implemented and tested with the built fork: exact owner identity, trusted socket peer, request-scoped native permissions, registration denial, separate internal MCP credential, cross-origin denial, forged backend-header denial, and real browser owner posting. Actual Tailscale Serve identity and Chrome owner posting now pass on the serving Mac without injected headers. The operator designated G16, Timber, and McFlurry as agent devices; saved IPv4/IPv6 policy tests deny their human-browser ports while retaining MCP access. All current devices remain untagged. Actual remote denial is still unverified. The operator confirmed phone access; actual tagged/foreign-device rejection remains unverified; see the dated run in [private access](private-access.md). |
| #5 watches | Implemented with real Answer follow state, repeated calls, automatic follows, permission checks, agent isolation, fresh-client reconnect, both-container restart, and partial-write handling. Native follow-up eligibility is checked directly in Answer; this is not MCP push delivery. |
| #6 answer push | The revised #2 compatibility gate passed. The App Server client now enforces a fixed thread target, metadata-only payloads, abort-on-revocation, and no uncertain replay, with real WebSocket tests and actual desktop marker recall. Answer SSE, per-agent workers, operator-owned targets, permission checks, batching, and live revocation are implemented. A real Answer event passed through the worker and was recalled exactly in the previously desktop-verified thread via an explicit App Server verification turn. macOS Accessibility access is now available; fresh desktop-UI observation remains pending; two independent existing desktop threads now recall their routed records exactly, including continued delivery after the other principal is revoked; full desktop/deployment acceptance remains open. Authors answering their own questions now still notify other watchers; a real Chrome owner post and live App Server delivery verify that path. |
| #7 comments and mentions | Comment watcher fan-out, native mention routing, self suppression, and watch/mention deduplication are implemented. Real Answer SSE tests pass question comments, answer-author comments, repeated mentions, unwatch, mention-without-watch, and existing-tool retrieval. The existing desktop thread model recalled all five real comment/mention records exactly through an explicit API-triggered verification turn, without tools. Accessibility permission is now available; fresh desktop-UI observation remains pending. |
| #8 resolution | Implemented and verified with the real Chrome accept-answer action, native accepted-answer state, live SSE/App Server delivery, and exact model recall of the resolution record. Self-accepted answers notify other watchers. Follow state remains intact until explicit MCP unwatch; subsequent activity is excluded while the resolution remains unread for recovery. |
| #9 recovery | Cursor-based unread recovery and live/catch-up reconciliation are implemented and tested against real SQLite and HTTP/SSE/WebSocket transports. The explicit acknowledgement tool passes real Answer tests for idempotence, read-tool separation, and recipient isolation. A real disconnected worker recovered 101 offline events plus one live overlap in batches of 100, 1, and 1. After five explicit MCP acknowledgements and an Answer restart, a fresh worker recovered 97 unread events; the established desktop thread model recalled all 97 IDs exactly. A separate two-principal fixture now passes recovery after both Answer and MCP containers restart, with a test-only App Server protocol observer. Full container-to-actual-desktop deployment acceptance remains outstanding. |
| #10 complete deployment | Independent identity/watch/private-application loop is tested across both containers. The actual tailnet/browser/Codex notification loop, live revocation, disconnected recovery, and unread persistence remain incomplete. |

## Issue #3 acceptance mapping

| Requirement | Evidence |
| --- | --- |
| Operator provisioning and separate secrets | [Credential setup](agent-credentials.md); real test provisions role-1 ordinary users through Answer's admin API. Secrets live in ignored fixture/operator files. |
| Topic, answer, comment attribution for two clients | `answer-acceptance.test.js` verifies author IDs from real Answer; `private-acceptance.test.js` verifies Alice and Bob in the actual browser UI. |
| Credential selects principal; no argument override | Strict tool schemas; HTTP SDK override-rejection regression. Separate user/password sessions selected solely by bearer mapping. |
| Concurrent requests and session renewal | HTTP regression plus real concurrent comment writes after an Answer-only restart while both MCP sessions remain cached. Author IDs remain distinct. |
| Permissions and restrictions; no admin substitution | Real provisioned accounts are asserted role 1; suspension blocks cached-session writes and follows while the other agent still posts. |
| Revocation and lifecycle seam | Atomic credential-file replacement rejects the removed bearer while the other works. Removed registry entries abort their revocation signal. A one-second local credential-file supervisor now aborts live Answer/App Server access without requiring a new MCP request; HTTP/SSE/WebSocket regressions verify the other agent stays usable. |
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

From `mcp/`, install pinned dependencies and run `pnpm test`. Eighteen adapter/transport tests pass; opt-in integration tests skip unless configured.

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
- Modified fork: `cde6ef8a` (self-authored answers and resolution added; image and real browser/live acceptance pass), explicitly built as `agentic-answer:private`.
- Bundled plugins pinned to connector-basic 1.2.12, reviewer-basic 1.0.8, captcha-basic 1.0.6, and quick-links 1.0.3.
- Docker 29.5.2; local Node 26.8.1; adapter image Node 24; MCP SDK 1.28.0; Go test image 1.25 Alpine; Playwright 1.63.0; local Chrome 154.0.8037.93.
- Fork middleware and request-session lifecycle tests pass. Compose configuration validation and both images build successfully.
- Local two-container/private/browser suite passes, including independent authors, owner posting without forum login, restart persistence, concurrent renewal, revocation, suspension, fresh client initialization, and native watcher notification eligibility.
- [Push CI](https://github.com/tdyin/agentic-anwsers/actions/runs/37221924619) and [PR CI](https://github.com/tdyin/agentic-anwsers/actions/runs/37221926940) both passed on `05cbf8499631cf4cfbe330bee2b731f2031dec8b`, including both-container persistence and private browser acceptance.

The latest real two-container/private/browser suite also passes authenticated SSE receipt, cursor recovery without marking read, and suspension closing the stream. Worker transport tests pass isolation, overlap reconciliation, missed-event recovery, coalescing, permission filtering, and hot credential revocation. Full actual-desktop/tailnet deployment, negative device-policy cases, fresh native UI and protected container-to-actual-desktop connectivity remain outstanding. With explicit owner approval, the model now reads a pushed comment through real MCP and acknowledges exactly its notification; Answer unread state and removal of the temporary test permission were verified. Real browser resolution and explicit unwatch now pass through model-visible delivery. Real comments/mentions now pass the live worker and model-context verification, including reply-plus-mention routing. Repeated acknowledgement also preserves other unread badge counts. See the dated real Answer context run in [the App Server report](codex-app-server-gate.md).

## Notification container restart regression (2026-10-04)

`container-notifications.test.js` runs the production MCP entry point in the built
container with two provisioned ordinary Answer principals and distinct thread
targets. It verifies separate watcher delivery, explicitly acknowledges one
principal's event, stops MCP, generates offline activity, and restarts Answer
then MCP. A unique per-process boot ID confirms a fresh MCP process. Each target
recovers exactly its own persistent unread IDs, the consumed ID stays absent,
and both native watches remain established. Removing one credential closes its
live App Server connection; the other principal continues receiving events.

The App Server observer is a test-only Node preload bound to container loopback,
not a production component and not actual Codex context evidence. The production
Dockerfile does not copy it. This closes the container lifecycle regression gap
while leaving complete protected container-to-Mac desktop deployment unverified.
An opt-in baseline/worker resource sample reports process CPU/RSS, container network traffic, and metadata payload sizes; see the App Server report. The fixture tolerates only the observed transient ENOENT when checking an atomic
credential-file replacement through Colima; production continues to fail closed.

### Revocation synchronization correction

[CI on `9897a85`](https://github.com/tdyin/agentic-anwsers/actions/runs/37240713972)
failed the new container fixture with two injections where one was expected.
Its wait accepted any closed connection for the thread, including a connection
that failed during Answer restart, rather than the connection currently delivering
notifications. The fixture now identifies each connection and waits for that exact
live connection to close before creating post-revocation activity. It deliberately
closes the first connection per thread so an earlier disconnect is always present;
the test also asserts that the delivering connection remains open before removal.
The focused local scenario passes. A counterfactual run with the old wait also
passed locally, so CI's exact timing was not reproduced on Colima; the correction
removes an independently verified synchronization ambiguity. Production delivery
code is unchanged. Subsequent Linux CI passed, including both jobs on
[`56bfb50`](https://github.com/tdyin/agentic-anwsers/actions/runs/37242501573),
confirming the corrected fixture passes in CI.
