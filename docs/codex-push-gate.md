# Native Codex desktop compatibility gate

Status: **NOT PASSED — required desktop client unavailable in the inspected environment.** Recorded 2026-10-04 for issue #2. This is an environment failure report, not evidence that Codex universally lacks native notification support.

## Observed environment

- macOS 26.6.2 (25G83), arm64.
- `codex --version`: `codex-cli 0.160.0`.
- No Codex or ChatGPT desktop app found in `/Applications`, `~/Applications`, or a Spotlight query for `*Codex*.app` / the `com.openai.codex` bundle identifier.
- The installed Hermes app reports `com.nousresearch.hermes`, version `0.0.0`. It is a different client and was not substituted for Codex.
- Tailscale CLI reports 1.102.4; its backend is Running and the local device is online. This does not demonstrate remote access, approved-device policy, or notification delivery.

Reproduce the client availability check:

```sh
sw_vers
uname -m
codex --version
ls /Applications
ls "$HOME/Applications"
mdfind 'kMDItemFSName == "*Codex*.app"'
mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"'
```

No desktop MCP session was available to initialize. Consequently, no desktop version, negotiated capabilities, controlled event delivery, context-visible marker, acknowledgement contract, or model-turn initiation was observed. No SSE receipt or SDK result is substituted for that missing evidence. The existing adapter's stateless request/response transport is not claimed to deliver native push.

Current [official setup guidance](https://developers.openai.com/learn/developers-codex-plugin) points new desktop users to the ChatGPT desktop app, and the former Codex quickstart redirects to [ChatGPT Learn](https://learn.chatgpt.com/docs/quickstart). Those pages do not establish that the precise client required by issue #2 is installed here or accepts this forum's unsolicited events. The required installed client/location and intended target were requested from the operator; no answer has been received.

## Required rerun

With the intended desktop client available, record its exact version and configuration, connect a disposable compatibility endpoint, capture the actual initialize exchange and capabilities, then emit a uniquely identified synthetic discussion event after initialization without a client read-tool request. Verify whether the event becomes useful information in the desktop context. Record any resource subscription, read, and acknowledgement requirements, and distinguish event receipt from automatic initiation of a model turn. A server send log alone fails this test.

Only a documented PASSED desktop result can unblock issue #6. Issues #7–#9 depend on that path, and the complete deployment in #10 remains incomplete. There is no companion delivery process, polling fallback, selected production push protocol, or changed target in this implementation. Resolving the investigation administratively would not change this gate.
