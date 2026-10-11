# Historical native MCP desktop compatibility test

Status: **NOT PASSED — the tested native MCP notification path did not deliver useful discussion information into desktop conversation context.** Recorded 2026-10-04 for issue #2. This replaces the earlier client-unavailable report. It is a scoped compatibility failure, not a claim that every present or future native extension is unsupported.

## Approved replacement, 2026-10-04

The owner subsequently authorized direct Codex App Server delivery with event handling inside the existing MCP service. Revised issue #2 now requires proving model-visible delivery in the intended desktop thread, without automatic model wakeup by default. That replacement gate subsequently **PASSED for the configured shared-server desktop path**; see [its separate evidence report](codex-app-server-gate.md). The native MCP failure below remains historical evidence; it neither passes nor fails the new approach. See [the revised specification](../SPEC.md#compatibility-and-acceptance-gates).

## Actual installed client and configuration

- macOS 26.6.2 (25G83), arm64.
- `/Applications/ChatGPT.app`, bundle `com.openai.codex`, version **26.930.41038**; UI in **Codex** mode, model **GPT-6.1 Sol Light**.
- Configuration UI reports workspace bundle **26.915.20218**. Actual MCP initialize identifies `codex-mcp-client`, title `Codex`, version **0.160.0**.
- The actual desktop opened the separate chat **Wait for discussion notification**. Accessibility permission was granted by the operator; enabling its `AXEnhancedUserInterface` attribute exposed the conversation and settings for inspection.
- A temporary `answer-native-push-probe` server was registered through `codex mcp add answer-native-push-probe --url http://127.0.0.1:19473/mcp`. It was removed after testing. No other MCP configuration was changed.
- Probe: [`mcp/scripts/push-probe.js`](../mcp/scripts/push-probe.js), MCP SDK **1.28.0**, stateful Streamable HTTP with a standalone SSE stream, loopback-only, synthetic content. This is a disposable test fixture, not the production adapter or a companion delivery process.

## Protocol and capabilities observed

The desktop sent `initialize` requesting **2025-06-18**, then `notifications/initialized`, `GET` for SSE, and `tools/list`, with subsequent requests carrying `MCP-Protocol-Version: 2025-06-18`. Multiple desktop discovery/session connections occurred; the active chat called `probe_status` once after the test operator approved that harmless connection check in the UI.

The raw desktop initialize advertised:

```json
{
  "elicitation": { "form": {}, "url": {} },
  "extensions": {
    "io.modelcontextprotocol/ui": {
      "mimeTypes": ["text/html;profile=mcp-app", "text/html+skybridge"]
    },
    "openai/elicitation": { "form": {} },
    "openai/form": {}
  }
}
```

Some discovery sessions advertised only `elicitation`. The SDK's parsed client-capabilities accessor retained `elicitation` and omitted the raw extension fields, so the raw initialize record is authoritative for those fields. None of these capabilities promises arbitrary discussion-event injection into model context.

The probe advertised `resources: { subscribe: true }`, `logging: {}`, and `tools: {}`. The actual desktop made **no `resources/subscribe` or `resources/read` request** during the test. There was no application-level acknowledgement of the event. The status tool returns a constant connection confirmation and cannot reveal the event marker.

## Controlled event and client-visible evidence

Observed sequence, UTC on 2026-10-04:

| Time | Observation |
| --- | --- |
| 17:45:42 | Actual desktop initialized and opened its SSE stream. |
| 17:45:57 | Desktop called `probe_status` once. The conversation then answered `ready`. |
| 17:46:08.558 | Operator emitted `discussion.answer.created`, marker `ea57a0b9-9043-47d8-ba0a-85610bc2542e`, topic `Synthetic compatibility discussion`, text `A synthetic human reply is available.` |
| 17:46:08.560–561 | Server sent `notifications/message` at `notice` level to the two remaining sessions. Neither had subscribed, so no resource-update notification was sent to those sessions. These send records alone are not delivery evidence. |
| After emission | Accessible desktop conversation still showed `ready`; no event marker or new automatic model turn appeared. |
| 17:46, manual follow-up | Asked the desktop to report any already-delivered marker without tools or resource reads. Its visible response was **`no notification in context`**. The probe recorded no further tool call or resource read for this check. |

Initial desktop prompt:

> Compatibility test only: call answer-native-push-probe probe_status once, then wait for a server-originated synthetic discussion notification. Do not read resources, poll, inspect files, use the shell, or call other tools. Report any discussion event marker only if it is delivered directly into your context. If no event has arrived, simply say ready.

Follow-up prompt (the marker was deliberately withheld):

> Without using any tools or reading resources, report the exact synthetic discussion event marker if a server-originated notification has been added to your context since your ready response. If none is present, say no notification in context. Do not guess.

The negative model response and inspected UI establish that useful context delivery was **not demonstrated**. They do not reveal every internal client buffer or prove universal impossibility. No automatic model-turn initiation was observed during this interval; the second response was explicitly user-triggered.

A subsequent, separately identified **SDK-only control** (`probe-control-sdk-only`, version `1`) connected, subscribed to `answer-probe://discussion/1`, and received both a logging message and `notifications/resources/updated` for a second marker, `0a122d27-faa7-4cc1-9c21-a2f7a69dc159`, emitted at 17:46:56.605. This verifies the fixture's notification transport, not desktop compatibility. The control negotiated 2025-11-25, unlike the desktop's 2025-06-18.

## Reproduce

1. Install dependencies in `mcp`, then run `node mcp/scripts/push-probe.js` in an interactive terminal. Optionally set `PROBE_PORT`; the default is 19473.
2. Register the loopback URL with the command above. Open a **new chat in the actual desktop**, in Codex mode. Run the initial prompt above and allow its single status tool call. Capture raw initialize capabilities and subsequent requests from the probe output.
3. After the desktop says `ready`, type `emit` in the probe terminal. Keep the resulting marker out of all desktop prompts. Inspect the desktop for delivery and any independent turn initiation.
4. Send the follow-up above. Record the exact response and whether any read, subscription, or tool call occurred. A send log, trace, or SDK receipt alone cannot pass the gate.
5. Remove the temporary configuration with `codex mcp remove answer-native-push-probe` and stop the probe with Ctrl-C. These cleanup steps were completed for this run.

## Downstream decision

No working native subscription/acknowledgement contract was established. The tested logging notification did not become useful context, and automatic resource subscription was absent. Elicitation was advertised but was not repurposed as a discussion inbox; no custom client extension was assumed or implemented.

The original issue #2 failure-report outcome was fulfilled. The owner has since made that separate product decision: revised issue #2 passed for a configured shared App Server. This PR wires the worker into the MCP service and completes configured-path implementation and acceptance for issues #6–#10; see [acceptance status](acceptance-status.md). The native MCP failure above remains historical evidence and does not describe the current configured App Server path.
