# v0.2 acceptance status

Recorded 2026-10-04. This is partial implementation evidence, not a v0.2 release approval. All GitHub issues remain open until their individual criteria are demonstrated.

## Verified in this change

- `node --test mcp/test/integration.test.js`: six passing HTTP/SDK regression tests. Covers existing tools, input validation, host/origin rejection, sanitized permission failures, no retry after uncertain writes, two independent sessions, concurrent renewal, attribution override rejection, credential revocation/rotation, atomic file replacement, invalid configuration failing closed, visible-topic watch routing, and partial content-write reporting without replay.
- `docker compose config --quiet`: passed.
- `docker compose -p agentic-issues build mcp`: passed on Docker 29.5.2, using Node 24 Alpine. Local tests used Node 26.8.1 and MCP SDK 1.28.0.
- Opt-in `mcp/test/answer-acceptance.test.js`: passed against a separate Docker container running `apache/answer:2.0.2`, with SQLite persisted in volume `agentic-issues-answer-data`. Provisioned two ordinary users via Answer's admin API, verified role ID 1, and created/read attributed topics, answers, and comments through real HTTP MCP clients. Both identity and content responses were checked against Answer. One credential was revoked while the other remained usable. This is API evidence; browser attribution and container restart persistence have not been verified.
- Contract source: Answer fork pinned at `3b9f1370612e690a0b7f230f05e688930db4c6d3`. No fork modifications or new notification transport in this change.

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
| #2 Codex native push gate | NOT PASSED. No Codex desktop bundle found in `/Applications`, `~/Applications`, or Spotlight query for `com.openai.codex`. A CLI executable exists, but it does not satisfy the desktop requirement. No controlled desktop notification test, negotiated capability capture, or useful context-delivery evidence exists. This observation does not prove that all clients lack support. |
| #3 per-agent identities | Adapter and real Answer API attribution implemented/tested. Browser attribution, real account permission denial and suspension, and full deployment acceptance remain. Revocation signal is exposed for future live connections; live access is not implemented. |
| #4 private browser access | Tailscale mapping, private proxy boundary, device policy, signup removal, fork deployment, and real browser/device denial checks remain. |
| #5 watches | Implemented watch/unwatch through Answer follow state with visibility checks and short-ID resolution; automatic follow after topic/answer creation; partial-write reporting. Real Answer tests pass for repeated operations, independent agents, and reads preserving unwatch. Restart verification is recorded below. Full client/container continuation and permission acceptance remain. |
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
