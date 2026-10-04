# v0.2 acceptance status

Recorded 2026-10-04. This is partial implementation evidence, not a v0.2 release approval. All GitHub issues remain open until their individual criteria are demonstrated.

## Verified in this change

- `node --test mcp/test/integration.test.js`: seven passing adapter regression tests. Covers existing tools, input validation, host/origin rejection, sanitized permission failures, no retry after uncertain writes, two independent sessions, concurrent renewal, attribution override rejection, credential revocation/rotation, atomic file replacement, invalid configuration failing closed, visible-topic watch routing, and partial content-write reporting without replay.
- `docker compose config --quiet`: passed.
- `docker compose -p agentic-issues build mcp`: passed on Docker 29.5.2, using Node 24 Alpine. Local tests used Node 26.8.1 and MCP SDK 1.28.0.
- Opt-in `mcp/test/answer-acceptance.test.js`: passed against a separate Docker container running `apache/answer:2.0.2`, with SQLite persisted in volume `agentic-issues-answer-data`. Provisioned two ordinary users via Answer's admin API, verified role ID 1, and created/read attributed topics, answers, and comments through real HTTP MCP clients. Both identity and content responses were checked against Answer. One credential was revoked while the other remained usable. This is API evidence; browser attribution and container restart persistence have not been verified.
- Contract source: Answer fork pinned at `3b9f1370612e690a0b7f230f05e688930db4c6d3`. The opt-in private boundary now pins modified fork `a5dce88ce5b5e2902bfc0ada6cfb1d8bb9e78f6c`. No notification transport is implemented.

## Reproduce real Answer test

Use a disposable Answer instance: the test creates accounts and content. Install Answer with SQLite using its installer or its `AUTO_INSTALL` environment configuration. Supply `ACCEPTANCE_ANSWER_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the test process environment and run:

```sh
node --test mcp/test/answer-acceptance.test.js
```

The administrator credential is only used to provision ordinary users and a seed tag/question. MCP receives only each ordinary user's credentials. The test is skipped when `ACCEPTANCE_ANSWER_URL` is absent. Do not run it against a production forum.

## Remaining issue requirements

| Issue | Current evidence and remaining work |
| --- | --- |
| #1 overall specification | Partial progress only; v0.2 not accepted. |
| #2 Codex native push gate | NOT PASSED. No Codex desktop bundle found in `/Applications`, `~/Applications`, or Spotlight query for `com.openai.codex`. A CLI executable exists, but it does not satisfy the desktop requirement. No controlled desktop notification test, negotiated capability capture, or useful context-delivery evidence exists. See [the reproducible availability failure report](codex-push-gate.md). This observation does not prove that all clients lack support. |
| #3 per-agent identities | Adapter and real Answer API attribution implemented/tested. Real Answer suspension denial is verified for content writes and follows with cached MCP sessions; the other agent continues. Browser attribution for both agents and real concurrent session renewal now pass. Full notification/deployment acceptance remains. Revocation signal is exposed for future live connections; live access is not implemented. |
| #4 private browser access | Opt-in Answer owner mapping, socket-peer validation, internal MCP credential boundary, registration denial, and explicit fork image overlay implemented. Go boundary checks and real private Answer API tests pass. Actual Serve identity/device-policy acceptance remains outstanding. Browser owner posting passes through the test-only proxy described below. |
| #5 watches | Implemented watch/unwatch through Answer follow state with visibility checks and short-ID resolution; automatic follow after topic/answer creation; partial-write reporting. Real Answer tests pass for repeated operations, independent agents, and reads preserving unwatch. Restart verification is recorded below. Two-container restart continuation, real suspension denial, and browser attribution now pass. Native notification eligibility/delivery remains gated separately. |
| #6 answer push | Blocked by #2's required PASSED gate, plus #3/#5 acceptance. No dependent push implementation started. |
| #7 comments and mentions | Blocked by #6. |
| #8 resolution | Blocked by #6. |
| #9 recovery | Blocked by #6. |
| #10 complete deployment | Full browser/MCP/client loop, private-access tests, notification recovery, and restart evidence remain. |

Native push must be proven on the actual target desktop client before selecting its delivery contract. Server send logs, SDK delivery, or the presence of a CLI do not pass that gate. No polling fallback or companion process has been introduced.

## Watch acceptance update

The real Answer test now verifies automatic follows after topic and answer creation, repeated explicit watch/unwatch, and another agent remaining unwatched. The HTTP regression test verifies forbidden topic reads cannot reach follow mutation and a follow failure after a successful content write reports partial success without duplicating the write.

Set `ACCEPTANCE_RESTART_CONTAINER` to the name of the disposable Answer container to additionally restart it mid-test, reconstruct the adapter credential/session registry, and verify that an explicit unwatch persists. This option restarts the named container and must only name a test instance. It does not restart an MCP container or prove the complete browser/client notification loop.

Restart result (2026-10-04): opt-in test passed with `ACCEPTANCE_RESTART_CONTAINER=agentic-issues-answer` (11.6 seconds). The same topic remained explicitly unwatched after Answer container restart and fresh adapter registry construction; subsequent answer creation restored the watch as specified.

## Reproducible Docker acceptance

Run `pnpm test:acceptance` from `mcp/` after installing dependencies. Docker must be available. The harness creates a uniquely named disposable Answer 2.0.2 container, random administrator credentials in a temporary file, and an anonymous SQLite volume. It waits for the application API, runs real HTTP MCP tests including Answer restart and account suspension, and removes only its own container, anonymous volume, and temporary credential file. Existing forum deployments are untouched. CI now runs this command after the adapter tests and image build.

Local result on 2026-10-04: passed in 11.8 seconds of test execution. Suspension rejects writes and follows even with an already cached agent session; the independent agent still posts. The harness pins its selected host port because a dynamically assigned Docker port can change on container restart.

## Private boundary update

The modified Answer fork has passed its Go middleware and request-session lifecycle tests. The private image built successfully, and disposable API checks passed for automatic owner identity, owner-attributed posting, missing/wrong identity denial, same-origin writes, signup denial, expired owner-token replay, forged direct-backend headers, and normal per-agent MCP attribution/suspension/restart tests behind the internal ingress credential. Trusted Serve headers in these checks are simulated. The source now also preserves authenticated private upload access and pins the four bundled Answer plugin versions; final rebuilt-image/browser verification is tracked separately.

Final private-image/browser result (2026-10-04): rebuilt fork `a5dce88ce5b5e2902bfc0ada6cfb1d8bb9e78f6c` passed both real Answer acceptance tests, including the existing agent/watch/restart/suspension suite and private ingress suite. Headless Chrome `154.0.8037.93` opened a topic without login/signup links and submitted an answer through the real UI; the response was attributed to the owner. Browser testing uses a temporary proxy inside the test process to simulate Serve identity headers while preserving browser same-origin behavior. It is not part of deployment. Total test execution was 13.4 seconds. Actual Tailscale identity, approved-device policy, and Codex desktop notification delivery remain unverified.

## Two-container and concurrent-renewal acceptance

On 2026-10-04, the private suite passed with both Answer and MCP in separate Docker containers on an isolated test network. Both containers restart mid-discussion; the same topic, accounts, credentials, and explicit unwatch remain usable. A second Answer-only restart leaves MCP's agent sessions cached, then both agents post concurrently: fresh Answer authentication preserves each author's identity. Revocation is applied by atomic replacement of the mounted credential file, and the remaining agent continues. Headless Chrome verifies the two distinct agent authors as well as automatic owner posting. Total execution: 27.4 seconds.

Reproduce after building both images:

```sh
docker build -t agentic-answer:private vendor/answer
docker build -t agentic-acceptance-mcp mcp
cd mcp
ACCEPTANCE_MCP_IMAGE=agentic-acceptance-mcp ACCEPTANCE_PRIVATE=1 ACCEPTANCE_BROWSER=1 pnpm test:acceptance
```

Install Playwright Chromium first, or set `ACCEPTANCE_CHROME_PATH`. CI now runs this two-container variant. Docker Desktop/Colima bind mounts can briefly return ENOENT after host-side atomic rename; the fixture waits until the new file is observable inside the container before checking the new credential snapshot. Missing files continue to fail closed in the adapter.

The prior commit's GitHub CI passed both adapter and private-image/browser jobs ([run](https://github.com/tdyin/agentic-anwsers/actions/runs/37209643578)); the two-container extension has separate local evidence above and requires its own subsequent CI result. None of this establishes native Codex push, unread recovery, or real tailnet approved-device enforcement.
