# Private Answer access (implementation in progress)

The private overlay builds the checked-out Answer fork and adds an opt-in request boundary inside Answer. It does not add a gateway process. Real Tailscale/browser/device acceptance is still required before using this as a verified deployment.

1. Provision the owner and ordinary agent accounts with the local Answer installer and admin UI before enabling private mode. Keep installation bound to host loopback. Set the site URL to the intended HTTPS Serve URL.
2. Generate a random internal token (at least 32 characters) in `data/private/internal-token`. Restrict file access to the operator and the Answer/MCP container users. The file is mounted read-only into both containers; never distribute this token to agents. Their individual MCP bearer credentials remain in `data/mcp/agents.json`.
3. Configure these environment variables in ignored `.env`:

   - `ANSWER_TAILSCALE_OWNER`: exact Tailscale login supplied by Serve, such as the owner's email.
   - `ANSWER_OWNER_EMAIL`: email of the already provisioned Answer human account.
   - `ANSWER_TRUSTED_PROXY_CIDR`: exact source address of the host Serve proxy as seen by Answer's socket, normally a single Docker gateway `/32`. Do not use the whole container network, tailnet, or `0.0.0.0/0`. Determine this for the deployment's actual networking.
   - `ANSWER_PRIVATE_ORIGIN`: HTTPS origin of the Serve endpoint, without a trailing slash or path.
4. Run `docker compose -f compose.yaml -f compose.private.yaml up -d --build`. The explicit `agentic-answer:private` image selection is essential; updating source alone does not modify the published upstream image.
5. Configure the existing host Tailscale Serve to proxy the human HTTPS endpoint to the loopback Answer port, and a separately controlled endpoint to the MCP port. Restrict the human endpoint in tailnet policy to the approved personal device addresses and restrict the MCP endpoint to the intended agent devices. Remove any broader grant that would also allow those destinations. Joining the tailnet or having the owner's identity is not sufficient device policy.

[Tailscale Serve supplies identity headers and strips client-supplied copies](https://tailscale.com/docs/features/tailscale-serve#identity-headers). The Answer boundary checks the socket peer, not `X-Forwarded-For`, then checks the exact owner identity. Missing identities (including tagged agent devices), other owners, and untrusted socket peers are rejected. Host processes able to connect through the trusted proxy source remain trusted; loopback publication does not authenticate local processes. Do not run untrusted workloads on that host.

The owner receives a request-scoped native Answer session based on the current account record and role. Answer's existing UI startup fetch discovers the logged-in user. Each request maps again; a browser-supplied token cannot select another user. Suspended, inactive, or missing owners are denied. Writes require the configured same-origin `Origin` header; cross-site requests are denied. The login and signup pages redirect to the forum, human password-login API calls are rejected, and the public registration API is disabled even for internal callers.

The internal adapter credential bypasses only the private ingress boundary and never selects the human. Answer's normal per-agent password authentication and authorization still apply. Wrong internal tokens fail closed. Direct backend requests cannot become the owner by forging identity headers from an untrusted socket peer. Keep all published backend ports on loopback and inaccessible to tailnet/LAN callers. Rotate the internal token by replacing the file and recreating both services together.

Local application acceptance passed for owner UI startup/posting and signup/login behavior through a test-only Serve stand-in. Pending external acceptance: exercise missing/wrong identity, forged backend headers, cross-site writes, tagged agent devices, and non-approved personal devices; verify independent MCP credentials remain usable; record tested source revision and Tailscale policy evidence. A simulated trusted-header request does not prove Serve or device policy.

## Reproduce integration checks

Build with `docker build -t agentic-answer:private vendor/answer`, then run `ACCEPTANCE_PRIVATE=1 pnpm test:acceptance` from `mcp/`. This creates a disposable private Answer instance and checks owner mapping, internal per-agent access, origin enforcement, registration denial, and direct-backend header spoofing. Set `ACCEPTANCE_BROWSER=1` to also exercise the actual web UI with Playwright; install Chromium with `pnpm exec playwright install chromium` or supply `ACCEPTANCE_CHROME_PATH` for an installed Chrome executable. The browser test supplies simulated Serve headers. It proves application behavior, not Tailscale identity or approved-device policy.

## Actual Serve acceptance, 2026-10-04

The operator initially supplied the exact owner login and approved **all eight current tailnet devices for now** (superseded by the device split below). The Tailscale status snapshot showed all eight registered to that owner and untagged. This records the approved scope; it does not prove that every device can connect, grant access to future devices, or replace the exact owner check. Personal identifiers and generated credentials are kept in ignored local fixture files.

A disposable deployment of fork `a5dce88ce5b5e2902bfc0ada6cfb1d8bb9e78f6c` was started with its own Docker network and SQLite volume. The host's existing Tailscale Serve added HTTPS port 8444, forwarding to loopback port 19474. Existing forum/MCP endpoints on 443/8443 and the existing deployment were preserved. The private origin matched the real HTTPS endpoint; the trusted socket peer was the test network's gateway `/32`.

Chrome **154.0.8037.93** on the serving Mac opened this actual Serve URL with a fresh browser context and **no injected identity headers**. Verified:

- Native owner profile lookup and owner-attributed question/answer creation succeeded.
- The browser displayed the discussion and posted an answer without a forum login; login/signup links were absent.
- Login and registration pages returned 303 to `/`; registration API returned 403.
- A cross-origin question write returned 403, and a direct loopback request without identity returned 403.
- Supplying a forged `Tailscale-User-Login` to the actual Serve URL still resolved to the real owner, confirming Serve replaced the client-supplied identity.

The automated browser ran on the **serving Mac**. The operator subsequently confirmed that the temporary discussion also worked on their phone, providing user-observed cross-device browser-access evidence. The exact phone model/browser was not recorded. The backend still showed only the original automated test answer when checked, so a separate phone-created post is not claimed. No foreign-owner or tagged device was available in the inspected tailnet, so their actual network-path rejection has not been demonstrated. Application-level denials remain covered by the separate integration suite. Issue #4 is not yet claimed complete.

To repeat: provision a disposable owner account; configure private mode with the operator's exact login, matching HTTPS origin, internal-token file, and actual Docker gateway; add an unused Serve HTTPS port; open a fresh browser context on the real Serve hostname; create a discussion and post a browser reply; verify the resulting author ID against `/answer/api/v1/user/info`. Do not inject identity headers into the browser. Repeat from another approved device and test disallowed device classes before claiming device-policy acceptance.

After the phone confirmation, the temporary Serve mapping, owned container/anonymous volume, and test network were removed. For future runs, remove only the test Serve mapping (`tailscale serve --https=8444 off`), remove the owned `agentic-tailnet-probe` container with its anonymous volume and same-named network, and remove its ignored fixture directory under `data/acceptance/tailnet-owner-probe`. Do not reset all Serve mappings or remove existing deployment data.

## Agent device policy, 2026-10-04

The operator subsequently selected **G16, Timber, and McFlurry** as agent devices.
The saved tailnet policy excludes their IPv4 and IPv6 addresses from the human
allowlist. Big Mac's TCP 443 and temporary human-test TCP 8444 are allowed only
from the other five current devices. TCP 8443 remains reachable for MCP, whose
per-agent bearer authentication remains required. No device tags were changed.

Tailscale accepted the policy with seven validation tests: an IPv4 and IPv6 case
for each agent device checks denial on both human ports and continued permission
for MCP, SSH, and another current peer; a phone case checks permitted access.
The saved Tests UI was read back. These are policy checks, not observed remote
connection results. Actual remote negative tests and tagged-device identity
rejection remain outstanding.

The replacement removes the old all-destination grant and preserves other
connections within the current tailnet address prefixes. The inspected devices
had no subnet routes or exit nodes; future routed networks need explicit policy
review. Future personal devices also need explicit allowlisting.

A temporary, data-free connectivity probe on loopback 19475 is served on
8443 and 8444 for the remote test; both HTTPS URLs responded successfully on
Big Mac. It is not an MCP or Answer application test. Remove these temporary
Serve mappings after the check, and restore the real services before deployment.


Private internal reads with an expired supplied Answer bearer now return 401
instead of silently returning an anonymous view. This lets the adapter's existing
per-agent renewal restore correct follow state after an Answer restart. Internal
ingress authentication alone still does not select a user; tokenless installer
and health/site setup routes keep their existing behavior.

The temporary data-free 8443/8444 connectivity mappings were removed after the
operator declined further device tests. Their policy rules remain saved.


A subsequent combined run on fork `59855aab` repeated actual Serve owner browser
posting and accepted-answer resolution, then verified delivery through the
production MCP container into the existing Mac App Server. This removes the
previous separation between browser/Serve and container/desktop evidence; see
[the combined run](codex-app-server-gate.md#real-servebrowser-to-production-container-and-desktop-2026-10-04).
The test ran on the serving Mac and does not substitute for remaining remote
negative identity/device cases.
