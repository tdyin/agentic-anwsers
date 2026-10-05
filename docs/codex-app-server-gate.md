# Direct Codex App Server compatibility gate

**PASSED for the explicitly configured shared-server desktop path, 2026-10-04.** Synthetic events reached the actual desktop thread's model-visible context without forum reads, periodic polling, or automatic model-turn initiation. This permits implementing #6; it does not establish real Answer event coverage, production authorization/revocation, or recovery, which remain separate acceptance work.

## Tested configuration

- macOS 26.6.2, arm64; ChatGPT.app bundle `com.openai.codex`, desktop 26.930.41038; Codex mode with GPT-6.1 Sol Light.
- Installed CLI and managed App Server: 0.160.0. Generated the installed protocol with `codex app-server generate-json-schema --experimental --out /tmp/agentic-appserver-schema`; `ThreadInjectItemsParams` accepts `threadId` and raw `items`.
- Existing managed daemon, reached through its owner-local Unix control socket under `~/.codex/app-server-control/`. JSON-RPC messages use WebSocket framing over the socket, not JSONL. `codex app-server proxy` forwards bytes and is not a JSONL-to-WebSocket converter.
- Desktop and handler must connect to **the same App Server**. The default desktop spawned its own stdio server; attempts by the CLI daemon to resume that desktop-owned thread returned `already has an active writer`. No lock files were removed, no writer was forced, and the daemon was not restarted.
- The installed desktop contains a built-in `CODEX_APP_SERVER_WS_URL` connection setting. For this test it was relaunched with `ws+unix://localhost${HOME}/.codex/app-server-control/app-server-control.sock:/rpc`. Keeping `localhost` in this URL matters: an empty hostname triggered the desktop's nonlocal SOCKS-proxy selection and failed startup. Correcting the URL used the existing Unix socket directly.
- The launch setting is process-local, not a persistent application configuration edit or patched client. A normal future launch without it may restore the separate-server topology. The test desktop was left using the shared daemon. Production setup must explicitly preserve and verify the shared-server connection.
- No TCP/WSS listener, publicly reachable control endpoint, or companion service was introduced. The existing daemon runs externally to the forum, as the user's Codex runtime already did.

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes `thread/inject_items` as appending model-visible history without starting a turn, and documents Unix WebSocket transport. It labels WebSocket integration experimental/unsupported for production workloads. The installed desktop URL override is established by inspected installed code and this test, not a promise of compatibility across releases. Pin and retest versions before deployment.

## Actual desktop evidence

The disposable desktop conversation was **App Server context injection control**, thread `01a108b3-eb21-7be2-9d2f-8c95f3f1face`.

1. A first daemon-owned control injected marker `52a576fe-04a8-4821-b858-e6988a654410` without a model turn. The desktop subsequently recalled it exactly after a normal archive/unarchive handoff released that test thread's writer. This demonstrated persistence, not simultaneous live delivery.
2. With desktop and probe on the shared daemon, a fresh marker `f8291dd1-4dfd-43e9-8d56-88b3ca3a0183` was injected while the desktop conversation remained open. The probe observed ten seconds with zero `turn/started` notifications and final idle status. A manually entered desktop follow-up, withholding the marker and prohibiting tools, produced that exact marker. The desktop accessibility tree showed the response.
3. A single insertion carried a batch of 20 synthetic events. On a separate manual verification turn the desktop reported event count **20**, first ID `6de87709-4e00-4b43-9c99-624f0245575e`, and last ID `11b30988-5fed-4fe6-9bc0-4618091d05e7`, matching the probe. Zero automatic turns occurred during the observation window.
4. A timing control injected `4aa6ec99-7580-40db-bdab-00540bfab0b0`, then explicitly invoked one verification turn through `turn/start`. Its exact reply matched and appeared in the open desktop at 21:05:48 UTC. This explicit verifier is separate from notification delivery; it is not a proposed per-event wakeup behavior.

The first three verification turns' full persisted item lists contained only `userMessage` and `agentMessage`: no tool call, file read, or forum fetch. The prompts asked for metadata already in context and never supplied the expected marker. This provides model-context evidence beyond an RPC success or server log.

Injected events did not create a normal visible chat bubble before a user turn. Model visibility and desktop display are distinct: the exact marker became visibly demonstrable when the operator asked the model to recall it.

## Measured overhead and limits

| Measurement | Observed result |
| --- | --- |
| Initial insertion on a newly created thread | 742.9 ms |
| Single insertion into the shared-server thread | 3.20 ms |
| 20-event batch, 3,196 UTF-8 bytes | 11.91 ms insertion RPC |
| Idle standalone Node probe RSS | 65,585,152 bytes, about 62.5 MiB |
| Probe CPU over ten idle seconds | 1,623 μs user + 308 μs system, about 0.019% of one core |
| Timing control, insertion RPC | 3.47 ms |
| Event submission to exact verified model response | 5,097 ms, including an explicitly started model turn |
| Automatic turns after context-only insertion | Zero during each ten-second observation |

These are individual local measurements, not percentiles or service-level guarantees. RPC completion is not an exact measurement of internal model-context availability; the 5.1-second verification result is an observed upper bound for useful model access and includes generation. The RSS is the entire separate test process, not the incremental memory of adding this handler to the existing MCP service. No container-to-host/remote network latency, server memory delta, large-scale sustained load, or future-model cost is established here.

## Reproduce

1. Confirm the existing daemon with `codex app-server daemon version`. Do not restart a daemon hosting active work. Create or select a disposable idle desktop test thread.
2. After cleanly quitting the desktop, launch the installed binary with its tested process-local connection setting:

   ```sh
   CODEX_APP_SERVER_WS_URL="ws+unix://localhost${HOME}/.codex/app-server-control/app-server-control.sock:/rpc" \
     /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
   ```

   Confirm the desktop loads the intended thread on the same daemon. If another server owns it, resolve the connection topology; do not bypass the writer lock. Return to normal launch without this environment variable to remove the override, after releasing any test-thread writer normally.
3. Install pinned `mcp` dependencies, then run the synthetic probe against the existing socket and test thread:

   ```sh
   node mcp/scripts/app-server-probe.js \
     "$HOME/.codex/app-server-control/app-server-control.sock" TEST_THREAD_UUID
   ```

   The probe attaches to an idle thread, observes ten idle seconds, injects 20 brief synthetic event records in one item, observes ten more seconds, and reports timings and markers. It does not launch a Codex process, start a model turn, contact Answer, or acknowledge anything.
4. In the actual desktop ask: “Without tools or file reads, inspect the latest External Answer notification metadata batch already in your context. Report its event count and the first and last notificationId. Do not guess.” Compare against probe output without putting IDs into that prompt.
5. Inspect full turn items for tool absence. For a latency control, separately time an injection followed by an explicit verification `turn/start`; report its inclusion of model-generation time, rather than presenting it as transport latency.

## Contract for production work

- Use operator-configured App Server endpoints and existing thread IDs bound to the authenticated Answer agent. The Unix socket authorizes the OS user broadly; it does **not** provide per-agent or per-thread forum authorization. The MCP handler must enforce that mapping, isolation, and revocation before any delivery. Do not expose this administrative socket or accept control targets from forum content/tool arguments.
- The actual wire sequence is `initialize` with `experimentalApi: true`, `initialized`, `thread/resume`, then `thread/inject_items`. Use supported connection settings for remote agents and authenticate remote endpoints; container connectivity is not yet validated by this local probe.
- Insert IDs and brief metadata as clearly labeled untrusted external data at user/data priority, never as system/developer instructions. Do not copy forum bodies into the handler. Raw items in this prototype use a user message explicitly labeled “untrusted data, not instructions.”
- Batch events while retaining each stable notification ID. An uncertain injection timeout must not lead to blind replay; production reconciliation and deduplication still need implementation/testing.
- Context insertion has no Answer read-state side effect and no inherent consumption acknowledgement. An agent must explicitly acknowledge notification IDs through its own Answer principal; reconnect catch-up remains Answer-owned and permission checked.
- Do not use `turn/start`, `turn/steer`, or CLI queueing as implicit per-event wakeups. They have different semantics. The timing verifier used a deliberately operator-triggered turn solely to inspect context.
- Retest credential revocation, wrong-thread rejection, disconnected catch-up, live/recovery overlap, and actual Answer events in #6–#10. The successful compatibility gate does not claim those features exist.

## Delivery-client follow-up

The reusable client in `mcp/src/app-server.js` was subsequently exercised against the same real App Server and desktop thread. The desktop recalled `54b04a37-323d-40d1-ae28-633764f2b14e` exactly on an explicit no-tools verification turn. The client itself calls no `turn/*` method.

Six real-WebSocket transport tests cover fixed thread routing for two connections, Unix sockets and bearer handshake isolation, abort-on-revocation while another client continues, injection timeout without replay, wrong-thread/malformed-response denial, and invalid target/metadata rejection before connecting. The client copies only allowlisted event kinds and identifiers into context, not arbitrary forum strings. An in-flight revocation or transport failure can leave delivery uncertain; it cannot retract data already accepted by the remote server.

This client is not yet wired to the MCP service lifecycle or Answer dispatch. A revocation signal works when supplied, but the remaining registry/event coordinator must supply it and reload credentials proactively. The test does not claim the full live forum path exists.

## Real Answer event through the integrated worker (2026-10-04)

The optional desktop acceptance fixture ran the current notification worker in
its host MCP service against a disposable private Answer image built from fork
`bf4f4910`. It subscribed before catch-up, received a newly posted human answer
for Alice's watched topic, checked topic access as Alice, and inserted metadata
through the existing shared App Server socket. The fixture passed, including
Answer stream suspension and private-boundary tests; it then removed its forum
container, network, and credentials.

Source notification metadata was `notificationId=5`, `recipientId=2`,
`topicId=10010000000000025`, `objectId=10020000000000031`. An explicitly triggered
verification turn in the designated existing desktop thread
`01a108b3-eb21-7be2-9d2f-8c95f3f1face` returned exactly:

```json
{"notificationId":"5","recipientId":"2","topicId":"10010000000000025","objectId":"10020000000000031"}
```

The verification prompt supplied no expected IDs and prohibited tools/file reads.
App Server's full turn record `01a108da-d97b-7a42-9984-3a55900d7566` contains only
the verification user message and the model response, completed in 4,946 ms.
This explicit test turn is not an automatic notification wakeup. Unlike the
synthetic gate, the injected metadata originated in real Answer persistence and
live dispatch through the integrated worker.

macOS denied Accessibility automation again during this run, so verification was
triggered and inspected through the protected App Server API in the same
previously desktop-verified thread. A fresh desktop-UI observation of this real
forum event remains pending; API success alone is not claimed as that UI check.
Two-recipient isolation, visibility filtering, burst coalescing, missed-event
recovery, and hot revocation pass real HTTP/SSE/WebSocket transport regressions;
the complete two-agent actual-desktop deployment still requires acceptance.

Reproduce the opt-in host-service fixture only against a designated test thread:

```sh
ACCEPTANCE_PRIVATE=1 \
ACCEPTANCE_APP_SERVER_URL=unix:///absolute/path/to/app-server-control.sock \
ACCEPTANCE_APP_SERVER_THREAD=existing-test-thread-uuid \
node mcp/scripts/acceptance.js
```

The harness prints the source notification IDs for independent context
verification. Omit `ACCEPTANCE_MCP_IMAGE` for this host-socket fixture. This run is
not evidence that a macOS Unix socket is reachable from a Linux MCP container.

## Real comment and mention context (2026-10-04)

The expanded host-service fixture passed against Answer fork `0a5de61d`, also
running real Chrome owner posting and the atomic acknowledgement regression. It
covered question comments, an answer author's comment on their own answer,
watch/mention overlap with repeated mention names, a mention without a watch
while replying to a different user, explicit unwatch, and self suppression.

All five expected records were accepted by the App Server worker and independently
recalled by the model in thread `01a108b3-eb21-7be2-9d2f-8c95f3f1face`:

| Kind | Notification ID | Changed comment ID |
| --- | --- | --- |
| `comment.created` | `5` | `10070000000000032` |
| `comment.created` | `7` | `10070000000000033` |
| `mention` | `8` | `10070000000000034` |
| `mention` | `12` | `10070000000000037` |
| `comment.created` | `15` | `10070000000000039` |

Each had recipient `2` and topic `10010000000000025`. The verification prompt
supplied no expected IDs and requested existing context only. Turn
`01a108ef-7ddf-7ef0-8482-1a514796fcd4` contains only the test user message and the
exact five-record JSON response, completed in 7,652 ms. Before this explicitly
triggered verification, the most recent turn was still the previous test turn:
live Answer activity had not started any model turn automatically.

These are a new disposable Answer installation's local IDs, not globally unique
identifiers across separate forum installations. The comment/mention records
were new in this test thread; earlier real-event verification covered answers.
Fresh desktop-UI observation remains pending Accessibility permission. This run
establishes real forum-to-model delivery through the previously desktop-verified
shared server, not a new UI-observation claim or production deployment approval.

## Browser acceptance and resolution delivery (2026-10-04)

Against fork `cde6ef8a`, Chrome posted the owner's answer on the owner's question
while a separate ordinary account watched it. The answer produced notification
`17`, proving the self-authored-answer path now still reaches other watchers.
Chrome then clicked the visible **Accept** control. The test observed a successful
`POST /answer/api/v1/answer/acceptance`, the rendered **Accepted** state, and the
same accepted-answer ID through the watcher's `get_topic` MCP tool.

The resolution event reached the live SSE subscriber and integrated App Server
worker. The watcher remained followed until an explicit `unwatch_topic` call;
a subsequent owner comment produced no notification for that watcher. The
resolution itself remained in Answer's unread feed after unwatch.

An explicit verification turn in the established desktop thread returned:

```json
{"type":"topic.resolved","notificationId":"18","recipientId":"4","actorId":"1","topicId":"10010000000000041","objectId":"10020000000000043"}
```

This exactly matched the persisted source event. Turn
`01a108fc-3034-7071-a46e-043d1f6c96e8` contains only the verification user message
and the model response; the prompt contained no expected IDs and prohibited
file reads/tools. It completed in 4,398 ms. Browser acceptance, follow persistence,
explicit unwatch, and model-context delivery therefore pass for this path. The
verification was API-triggered in the previously desktop-verified thread; no new
native desktop UI observation is claimed.

## Multi-page disconnected recovery (2026-10-04)

The private acceptance harness disconnected the actual App Server delivery worker,
created 101 real Answer comments, and then reconnected it. One more comment was
created while its first recovery batch was in flight. The worker delivered all
102 distinct notification IDs in measured batches of 100, 1, and 1, without
marking any read. MCP reads retrieved the comments before five notifications
were explicitly acknowledged. After restarting the disposable Answer container,
a fresh worker with no retained cursor/deduplication memory recovered exactly
97 remaining unread records. Revoking its credential blocked MCP calls and
subsequent notification reconnects.

Before an explicit verification turn, the target thread's latest turn was still
`01a108fc-3034-7071-a46e-043d1f6c96e8`: recovery itself had started no model turn.
Verification turn `01a1090a-1a9d-7331-96b1-237254395404` then recalled all 97 IDs,
`22` through `118` inclusive, in order. Its first and last records exactly matched
the source: recipient `4`, actor `1`, topic `10010000000000041`, comment objects
`10070000000000048` and `10070000000000144`. The prompt supplied no expected IDs
or count. The turn contained only the user prompt and model response, used no
tools, and completed in 11,256 ms.

Reproduce with `ACCEPTANCE_PRIVATE=1`, `ACCEPTANCE_APP_SERVER_URL` and
`ACCEPTANCE_APP_SERVER_THREAD` targeting the configured shared desktop server,
then run `node mcp/scripts/acceptance.js`. All three integration tests passed.
Without the App Server environment variables, this recovery test uses a real
WebSocket protocol fixture; that mode is transport regression evidence only.
This run proves Answer container persistence and fresh notification-worker
recovery, not a full MCP container restart or fresh native desktop UI observation.

## Two existing desktop threads (2026-10-04)

The real Answer fixture now configures independent ordinary principals against
threads `01a108b3-eb21-7be2-9d2f-8c95f3f1face` and
`01a10805-851d-7193-88df-cd0475e4d684`. Both were existing desktop-created test
threads on the shared App Server. Every delivered batch is checked against the
recipient bound to that target. After suspension and credential removal for the
first principal, a new human comment still reached the second target and produced
no additional delivery to the first.

Explicit no-tool verification turns returned the exact source records:

| Recipient | Latest notification | Comment object | Verification turn | Duration |
| --- | --- | --- | --- | --- |
| `2` | `15` | `10070000000000039` | `01a10913-7db9-7690-8ca2-5c7be3f155d8` | 5,601 ms |
| `3` | `17` | `10070000000000041` | `01a10913-7e48-70b2-a0d4-20e32df53e2d` | 3,689 ms |

Both records had type `comment.created`, actor `1`, and topic
`10010000000000025`. Each verification turn contained only its user prompt and
model response. Prompts contained no expected IDs. This verifies two independent
model-visible routes through the host worker; fresh native UI observation,
model-initiated MCP consumption, and complete container deployment remain separate.

Reproduce with the shared-server environment from the preceding run, plus
`ACCEPTANCE_APP_SERVER_THREAD_B` set to the second existing test thread and
`ACCEPTANCE_TEST_PATTERN='real Answer attributes'`. The pattern selects the main
integration scenario; other integration files do not execute their test bodies.

## Protected endpoint investigation (2026-10-04)

The installed Tailscale Serve help supports proxying Unix sockets, but proxy
support alone does not establish authorization for the desktop administrative
socket. No Serve mapping or control-socket exposure was added. The installed
Codex CLI supports capability-token and signed-bearer WebSocket authentication.
[Official App Server documentation](https://learn.chatgpt.com/docs/app-server)
requires a bearer credential during the upgrade for configured WebSocket auth;
remote connections should use TLS. It also identifies this transport as
experimental. The currently verified desktop path remains the owner-local Unix
socket. Protected access from the Linux MCP container to that same desktop server
is still unverified; local and protocol-fixture successes do not satisfy it.

## Model-initiated MCP consumption attempt (2026-10-04)

`desktop-consumption.test.js` adds an explicit opt-in real-model gate. It creates
one ordinary recipient and a random comment in the disposable Answer database,
delivers only event metadata, and temporarily configures that test thread with
the authenticated MCP endpoint. The fixture archives and immediately unarchives
only the designated disposable thread before resuming: rejoining an already loaded
thread retains its old MCP connections. Cleanup resumes it without test overrides;
no global config file is edited. Use only a disposable test thread for this gate.

Turn `01a10917-00d4-7fc3-a8d6-600b57df8e0c` successfully invoked
`answer_acceptance.list_comments` for topic `10010000000000020`, read comment
`10070000000000022`, and returned its exact random text:
`comment-proof-603815ff-cc4b-49bb-ab67-7f7ddfe2a076`. That text was absent from the
injected metadata and verification prompt. The read completed in 10 ms.

The model then requested `acknowledge_notification` for notification `1`, but
Codex rejected the call before execution: **MCP tool call requires approval, but
approval policy is never**. Answer correctly retained its unread event. Thus
model-driven reading passes, but the combined read-and-acknowledge gate does not.
The denial was reported to the operator and approval requested; the fixture does
not bypass it or treat a failed tool call as acknowledgement evidence.

The gate is opt-in with `ACCEPTANCE_MODEL_TOOLS=1`,
`ACCEPTANCE_TEST_PATTERN='actual desktop thread consumes'`, and the private/shared
App Server environment. It waits for the actual `turn/completed` notification:
an early paginated history response can transiently show an interrupted status
while a newly started turn is still running, so history alone must not end the
fixture. Default CI skips this real-model gate and cannot certify it.

## Integrated worker overhead sample (2026-10-04)

The container recovery fixture can measure the same production MCP process first
with notification targets disabled, then with two targets enabled. Run:

```sh
ACCEPTANCE_MEASURE_OVERHEAD=1 \
ACCEPTANCE_TEST_PATTERN='two notification workers' \
ACCEPTANCE_MCP_IMAGE=agentic-acceptance-mcp ACCEPTANCE_PRIVATE=1 \
node mcp/scripts/acceptance.js
```

One local Node 24/Colima sample produced:

| Measurement | Workers disabled | Two workers enabled |
| --- | ---: | ---: |
| Observation window | 10,110 ms | 10,093 ms |
| MCP process CPU time | 10 ms | 40 ms |
| MCP process resident memory | 101,048 KiB | 104,776 KiB |
| Container received + sent bytes | 202 | 396 |

The observed memory difference was 3,728 KiB (3.64 MiB), and CPU time increased
by 30 ms over roughly ten seconds (about 0.3% of one core). CPU comes from PID 1's
user/system ticks in `/proc/1/stat`, converted using the container's `CLK_TCK`;
RSS comes from `/proc/1/status`. Network counters include all container interfaces
and the test-only loopback App Server observer. The observer is present in both
windows. Answer state and stream traffic are real; no model turns occur here.

Captured notification context text was 329 UTF-8 bytes for a single event and
470 bytes for two events in one batch. These sizes include the untrusted-data
preamble and event JSON, but exclude JSON-RPC/WebSocket/TLS framing. They are not
token counts or a measurement of the model's future inference cost.

This sequential single-run comparison includes allocation, JIT, and GC variation;
10-second network windows can also sample different phases of the 20-second SSE
heartbeat. It establishes a reproducible small-load observation, not a sustained
load estimate, percentile, hard resource budget, or the desktop App Server's
incremental resource use. The complete focused restart/revocation scenario also
passed in this measurement run.

## Approved model acknowledgement (2026-10-04)

The owner explicitly approved acknowledging one notification in the disposable
forum. The fixture applied a temporary per-tool `approval_mode = "approve"` only
to `answer_acceptance.acknowledge_notification`, using the supported
[per-tool MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).
It did not change global configuration or production credentials.

Turn `01a10929-d8bd-7541-a7bf-a91481e329fa` in desktop-created thread
`01a10805-851d-7193-88df-cd0475e4d684` successfully called `list_comments`, returned
`comment-proof-e61ba74e-d02a-468d-9d92-166c4fe79909`, and called
`acknowledge_notification` exactly once with notification ID `1`. The source
comment ID was `10070000000000022`. The test checked the actual MCP call arguments,
successful tool results, and absence of that event from Answer's unread feed.
The focused real-model scenario passed in 12,670 ms. Other integration scenarios
were excluded by the test-name pattern; this was not a new full-suite run.

Cleanup restored the test thread without the temporary MCP configuration. A
subsequent `mcpServerStatus/list` for `answer_acceptance` returned an empty list.
The earlier approval denial is historical; model-driven read and explicit
acknowledgement now pass with the owner's scoped approval. Fresh native desktop UI
observation and protected container-to-desktop deployment remain separate gates.

For an operator-approved repeat, add `ACCEPTANCE_ACK_APPROVED=1` to the opt-in
real-model command above. This flag is an operator assertion of permission, not
an automatic approval grant: use it only after explicit authorization for the
one-notification disposable test. Without it, the fixture retains normal policy.


## Actual MCP container through protected SSH socket (2026-10-04)

The existing Colima SSH ControlMaster accepted a temporary reverse Unix-socket
forward to the Mac's existing App Server control socket. No new daemon, app-server
process, TCP listener, or tailnet exposure was added. The VM directory was mode
0700 and the socket 0600, owned by UID 501. The built MCP image, running as UID
501 with a read-only filesystem and all capabilities dropped, connected through
a read-only bind mount. A separate UID 502 container received EACCES. Docker/VM
administrators and processes with the same UID remain trusted; this is an OS
boundary, not per-thread authorization. The MCP registry still enforces targets.

The new opt-in case in `container-notifications.test.js` provisions a disposable
ordinary recipient, watches a topic through MCP, and creates a real Answer
comment. The production MCP entry point in the container reports delivery to the
actual existing desktop thread. Its latest turn ID does not change during
delivery, and the notification stays unread. No simulated App Server or preload
is used in this case. The focused case passed, and all 18 unit tests passed.

An explicit, separate verification turn
`01a109a9-1053-7ef0-9b83-2c6de37da0af` in desktop thread
`01a108b3-eb21-7be2-9d2f-8c95f3f1face` completed in 4546 ms and returned the exact
record without tools: comment.created, notification 1, recipient 2, actor 1,
topic 10010000000000020, object 10070000000000022. The prompt supplied no IDs.
This proves model-visible delivery through the real container and protected
transport. The computer-control tool refused access to the Codex app for safety
reasons, so fresh native UI observation is still not claimed.

To reproduce, use the existing Colima SSH config and ControlMaster: create a
unique VM directory with mode 0700, then use `ssh -O forward -R
<VM-directory>/control.sock:<Mac-control-socket>`. Verify ownership and mode
before mounting it. Run the existing acceptance harness with
`ACCEPTANCE_VM_SOCKET_DIR` set to that directory, `ACCEPTANCE_MCP_IMAGE` set to
the production image, `ACCEPTANCE_PRIVATE=1`, the host-side
`ACCEPTANCE_APP_SERVER_URL` and existing disposable
`ACCEPTANCE_APP_SERVER_THREAD`, and
`ACCEPTANCE_TEST_PATTERN='production container delivers'`.
Cancel only that forward with `ssh -O cancel -R` and remove only the owned VM
directory after the disposable container is removed.

This closes the basic protected container-connectivity gap. The forward is
session-scoped: persistent provisioning and re-establishment after Colima/SSH
restart are not yet implemented or verified. The temporary test forward was
removed. Complete deployment lifecycle and native UI acceptance remain open.
